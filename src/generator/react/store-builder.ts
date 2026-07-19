// ---------------------------------------------------------------------------
// React store module emitter — `store Cart { … }` → a Zustand store at
// `web/src/stores/<snake>.ts` (named-actions-and-stores.md §3, Stage 5).
//
// The store's actions reuse the SAME `:=`/`+=`/`-=` statement lowering a page
// action does (shared `emitStmt`), but against a Zustand `set(...)` sub-target
// instead of a `useState` setter — so a store action and a page action lower
// identically except for the write seam.  Output shape:
//
//   import { create } from "zustand";
//   interface CartState {
//     lines: OrderLine[];
//     add: (l: OrderLine) => void;
//     clear: () => void;
//   }
//   export const useCart = create<CartState>((set) => ({
//     lines: [],
//     add: (l) => set((s) => ({ lines: [...s.lines, l] })),
//     clear: () => set(() => ({ lines: [] })),
//   }));
//
// This module is React-only.  The other frontends (Vue/Svelte/Angular) wire
// their own store-module emitters with the same lifetime ladder; LiveView is
// memory-only (gated by `loom.store-lifetime-liveview-unsupported`).
//
// The `lifetime` ladder (frontend-state-management.md §3.1): `memory` (default)
// is the plain `create(...)` below; `persistLocal`/`persistSession` wrap it in
// the Zustand `persist` middleware over `localStorage`/`sessionStorage`; `url`
// makes the query string the source of truth via a typed untrusted-input
// decoder + `history.replaceState` mirror + `popstate` re-decode.
// ---------------------------------------------------------------------------

import type { ActionIR, StateFieldIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { defaultInitForJs, storeHookName } from "../_walker/js-target-helpers.js";
import type { StateRef, WalkerTarget } from "../_walker/target.js";
import { emitStmt, type WalkContext } from "../_walker/walker-core.js";
import { tsxTarget } from "./walker/tsx-target.js";

export { storeHookName };

/** Map a store-field `TypeIR` to its TS type annotation (the store-state
 *  interface).  Mirrors page-shell's `stateTypeAsTsString` (kept local so the
 *  store builder doesn't import upward into the page shell). */
function storeFieldTsType(type: TypeIR): string {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "int":
        case "long":
        case "decimal":
          return "number";
        case "money":
          return "Decimal";
        case "bool":
          return "boolean";
        default:
          return "string";
      }
    case "id":
    case "enum":
      return "string";
    case "entity":
    case "valueobject":
      return type.name;
    case "array":
      return `${storeFieldTsType(type.element)}[]`;
    case "optional":
      return `${storeFieldTsType(type.inner)} | undefined`;
    default:
      return "any";
  }
}

/** Initial value for a store field — its declared `= init`, else the type's
 *  zero value (`[]` for arrays, `defaultInitForJs` for scalars). */
function storeFieldInit(type: TypeIR): string {
  if (type.kind === "array") return "[]";
  return defaultInitForJs(type);
}

/** A Zustand-flavoured `WalkerTarget` for rendering store-ACTION bodies.  Only
 *  the state seam diverges from `tsxTarget`: a write `lines := v` becomes
 *  `set(() => ({ lines: v }))` and a read inside a `+=`/`-=` rewrite reads
 *  `s.lines` (the `set` callback's draft).  Everything else throws — a store
 *  action body is restricted (state writes + store-action calls + lets), so
 *  the markup / api / match seams are unreachable. */
function zustandTarget(): WalkerTarget {
  // Spread the real TSX target and override ONLY the state seam, so the store
  // action body lowers byte-for-byte like a page action everywhere else (lets,
  // store-action calls, expressions) and diverges solely at the write.
  return {
    ...tsxTarget,
    // Inside a `set((s) => ({ … }))` callback the current value reads off the
    // draft `s`; `emitStmt` only reads state in the `+=`/`-=` compound path.
    renderStateRead(ref: StateRef): string {
      return `s.${ref.name}`;
    },
    renderStateWrite(ref: StateRef, value: string): string {
      // Reference `s` only when the value does (a plain `:=` ignores the draft);
      // an unused arrow param would trip lint, so pick `() =>` vs `(s) =>`.
      const param = value.includes("s.") ? "(s)" : "()";
      return `set(${param} => ({ ${ref.name}: ${value} }))`;
    },
  };
}

/** Build the minimal `WalkContext` an action-body `emitStmt` needs, with the
 *  store's own fields registered as `stateNames` (so a bare `lines := …`
 *  resolves to a store-field write), the action's params bound so a body ref
 *  to one (`lines += l`) resolves to the bare arg, and the Zustand sub-target
 *  wired in. */
function storeActionCtx(
  fieldNames: ReadonlySet<string>,
  paramNames: ReadonlySet<string>,
): WalkContext {
  return {
    target: zustandTarget(),
    imports: new Map(),
    pack: {} as LoadedPack,
    paramNames,
    usedParams: new Set(),
    usesNavigate: false,
    stateNames: fieldNames,
    derivedNames: new Set(),
    authUi: false,
    usesState: false,
    usesCurrentUser: false,
    usesRouterLink: false,
    usesRouteId: false,
    userComponents: new Map(),
    usedUserComponents: new Set(),
    usesChildren: false,
    apiParamNames: new Map(),
    usedApiHooks: new Map(),
    lambdaParams: new Map(),
    shellLocals: new Set(),
    aggregatesByName: new Map(),
    bcByAggregate: new Map(),
    workflowsByName: new Map(),
    bcByWorkflow: new Map(),
    formOfs: [],
    actionMutations: [],
    collectedTestids: new Set(),
    usesCodeBlock: false,
    usesFileUpload: false,
    usedStores: new Map(),
  };
}

/** Render one store action as a Zustand action property:
 *  `add: (l) => set((s) => ({ lines: [...s.lines, l] }))`.  A single-statement
 *  body renders inline; a multi-statement body uses a block + `set` per write. */
function renderStoreAction(action: ActionIR, fieldNames: ReadonlySet<string>): string {
  const paramNames = new Set(action.params.map((p) => p.name));
  const ctx = storeActionCtx(fieldNames, paramNames);
  const param = action.params[0]?.name ?? "";
  const stmts = action.body.map((s) => emitStmt(s, ctx));
  if (stmts.length === 1) {
    // Single write/call — drop the trailing `;` so it reads as an arrow value.
    const single = stmts[0]!.replace(/;\s*$/, "");
    return `${action.name}: (${param}) => ${single}`;
  }
  return `${action.name}: (${param}) => { ${stmts.join(" ")} }`;
}

/** The set of money-typed **top-level** field names — the keys a persisted or
 *  URL-synced store must revive back into `Decimal` (JSON/query strings carry
 *  them as plain strings).  Nested money (inside an array/entity) is a
 *  documented v1 limitation of the persisted/URL tiers. */
function moneyFieldNames(store: StoreIR): string[] {
  return store.state
    .filter((f) => f.type.kind === "primitive" && f.type.name === "money")
    .map((f) => f.name);
}

/** A URL query param decodes as an untrusted string → the field's typed value,
 *  defaulting on anything unparseable (frontend-state-management.md §3.1).  One
 *  decode expression per field, read from a `URLSearchParams` named `p`. */
function decodeFieldFromParam(field: StateFieldIR): string {
  const key = JSON.stringify(field.name);
  const t = field.type;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return `p.has(${key}) && Number.isFinite(Number(p.get(${key}))) ? Number(p.get(${key})) : ${storeFieldInit(t)}`;
      case "money":
        return `p.has(${key}) && p.get(${key})!.match(/^-?\\d+(\\.\\d+)?$/) ? new Decimal(p.get(${key})!) : ${storeFieldInit(t)}`;
      case "bool":
        return `p.get(${key}) === "true"`;
      default:
        return `p.get(${key}) ?? ${storeFieldInit(t)}`;
    }
  }
  // ids/enums decode as bare strings (enum membership is not re-checked here;
  // an off-set value is harmless client filter state, re-validated server-side).
  if (t.kind === "id" || t.kind === "enum") return `p.get(${key}) ?? ${storeFieldInit(t)}`;
  // Arrays / entities / anything structural are not URL-encodable in v1 — the
  // validator (loom.store-url-field-unsupported) blocks them, so this is a
  // defensive default only.
  return storeFieldInit(t);
}

/** Serialise a field back into the query string (`p.set` / `p.delete`), keyed
 *  by the field name; empty/default values are dropped so the URL stays clean. */
function encodeFieldToParam(field: StateFieldIR): string {
  const key = JSON.stringify(field.name);
  const t = field.type;
  const ref = `s.${field.name}`;
  if (t.kind === "primitive" && t.name === "money") {
    return `if (${ref} != null) p.set(${key}, ${ref}.toString()); else p.delete(${key});`;
  }
  if (t.kind === "primitive" && t.name === "bool") {
    return `if (${ref}) p.set(${key}, "true"); else p.delete(${key});`;
  }
  if (t.kind === "primitive" && (t.name === "int" || t.name === "long" || t.name === "decimal")) {
    // A number always serialises — `0` is a real value, not "empty".  (A
    // `!== ""` guard here would be a `number`-vs-`string` TS2367 comparison.)
    return `p.set(${key}, String(${ref}));`;
  }
  // string / id / enum — drop the param when empty so the URL stays clean.
  return `if (${ref} !== "") p.set(${key}, ${ref}); else p.delete(${key});`;
}

/** Render the full Zustand store module for a `StoreIR`, honouring its
 *  lifetime (frontend-state-management.md §3.1):
 *   - `memory`  → a plain `create(...)`.
 *   - `persistLocal` / `persistSession` → the Zustand `persist` middleware over
 *     `localStorage` / `sessionStorage` (money fields revived via a reviver).
 *   - `url` → a router-agnostic bidirectional sync: seed from the query string
 *     via a typed untrusted-input decoder, and mirror every change back with
 *     `history.replaceState`, re-decoding on `popstate`. */
export function renderZustandStoreModule(store: StoreIR): string {
  const fieldNames = new Set(store.state.map((f) => f.name));
  const stateType = upperFirst(store.name) + "State";
  const hook = storeHookName(store.name);
  const needsDecimal = moneyFieldNames(store).length > 0;
  const moneyKeys = moneyFieldNames(store);

  const interfaceLines = [
    ...store.state.map((f) => `  ${f.name}: ${storeFieldTsType(f.type)};`),
    ...store.actions.map((a) => {
      const param = a.params[0];
      const paramSig = param ? `${param.name}: ${storeFieldTsType(param.type)}` : "";
      return `  ${a.name}: (${paramSig}) => void;`;
    }),
  ];
  const actionEntries = store.actions.map((a) => `  ${renderStoreAction(a, fieldNames)},`);

  if (store.lifetime === "url") {
    return renderUrlStoreModule(
      store,
      stateType,
      hook,
      needsDecimal,
      interfaceLines,
      actionEntries,
    );
  }

  const stateEntries = store.state.map((f) => `  ${f.name}: ${storeFieldInit(f.type)},`);
  const bodyEntries = [...stateEntries, ...actionEntries];

  if (store.lifetime === "persistLocal" || store.lifetime === "persistSession") {
    const backing = store.lifetime === "persistLocal" ? "localStorage" : "sessionStorage";
    // Money fields serialise to strings in JSON; a keyed reviver reconstructs
    // the `Decimal` on load (top-level money fields — nested money is a
    // documented v1 limitation of the persisted tier).
    const storageArg = needsDecimal
      ? [
          `      storage: createJSONStorage(() => ${backing}, {`,
          `        reviver: (key, value) =>`,
          `          ${JSON.stringify(moneyKeys)}.includes(key) && typeof value === "string"`,
          `            ? new Decimal(value)`,
          `            : value,`,
          `      }),`,
        ]
      : [`      storage: createJSONStorage(() => ${backing}),`];
    return lines(
      `import { create } from "zustand";`,
      `import { persist, createJSONStorage } from "zustand/middleware";`,
      needsDecimal ? `import Decimal from "decimal.js";` : undefined,
      "",
      `// Shared client-side state container generated from \`store ${store.name}\`.`,
      `// Persisted to ${backing} (\`persist: ${store.lifetime === "persistLocal" ? "local" : "session"}\`) — survives ${store.lifetime === "persistLocal" ? "a browser restart" : "reload, cleared with the tab"}.`,
      `export interface ${stateType} {`,
      ...interfaceLines,
      `}`,
      "",
      `export const ${hook} = create<${stateType}>()(`,
      `  persist(`,
      `    (set) => ({`,
      ...bodyEntries.map((l) => `    ${l}`),
      `    }),`,
      `    {`,
      `      name: ${JSON.stringify(`loom.store.${store.name}`)},`,
      ...storageArg,
      `    },`,
      `  ),`,
      `);`,
      "",
    );
  }

  return lines(
    `import { create } from "zustand";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (\`persist: memory\`, the default) — survives navigation, dies on reload.`,
    `export interface ${stateType} {`,
    ...interfaceLines,
    `}`,
    "",
    `export const ${hook} = create<${stateType}>((set) => ({`,
    ...bodyEntries,
    `}));`,
    "",
  );
}

/** The `url` lifetime: the query string is the source of truth, decoded through
 *  a typed untrusted-input decoder and mirrored back on every change. */
function renderUrlStoreModule(
  store: StoreIR,
  stateType: string,
  hook: string,
  needsDecimal: boolean,
  interfaceLines: string[],
  actionEntries: string[],
): string {
  const stateFieldNames = store.state.map((f) => f.name);
  const stateSlice = `Pick<${stateType}, ${stateFieldNames.map((n) => JSON.stringify(n)).join(" | ")}>`;
  return lines(
    `import { create } from "zustand";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// Synced to the URL query string (\`persist: url\`) — shareable, deep-linkable,`,
    `// back/forward-navigable.  The URL is untrusted input: each field is decoded`,
    `// through its declared type and defaulted on anything unparseable.`,
    `export interface ${stateType} {`,
    ...interfaceLines,
    `}`,
    "",
    `function decodeFromUrl(): ${stateSlice} {`,
    `  const p = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);`,
    `  return {`,
    ...store.state.map((f) => `    ${f.name}: ${decodeFieldFromParam(f)},`),
    `  };`,
    `}`,
    "",
    `function encodeToUrl(s: ${stateSlice}): void {`,
    `  if (typeof window === "undefined") return;`,
    `  const p = new URLSearchParams(window.location.search);`,
    ...store.state.map((f) => `  ${encodeFieldToParam(f)}`),
    `  const qs = p.toString();`,
    `  window.history.replaceState(null, "", qs ? \`?\${qs}\` : window.location.pathname);`,
    `}`,
    "",
    `export const ${hook} = create<${stateType}>((set) => ({`,
    `  ...decodeFromUrl(),`,
    ...actionEntries,
    `}));`,
    "",
    `// store → URL: mirror every change back (replaceState, no history spam).`,
    `${hook}.subscribe((s) => encodeToUrl(s));`,
    `// URL → store: re-decode on back/forward and manual address edits.`,
    `if (typeof window !== "undefined") {`,
    `  window.addEventListener("popstate", () => ${hook}.setState(decodeFromUrl()));`,
    `}`,
    "",
  );
}
