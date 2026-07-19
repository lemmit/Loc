// ---------------------------------------------------------------------------
// Vue store module emitter — `store Cart { … }` → a `reactive()` singleton
// at `src/stores/<snake>.ts` (named-actions-and-stores.md §3, Stage 5;
// frontend-state-management.md §4.1).
//
// Per the signed-off prototype, the in-memory Vue tier is a `reactive()`
// singleton with a `useCart()` accessor returning `{ state, <action>… }`:
//
//   import { reactive } from "vue";
//   export interface CartState { lines: string[]; count: number; }
//   const state = reactive<CartState>({ lines: [], count: 0 });
//   export const useCart = () => ({
//     state,
//     add: (sku: string) => { state.lines = [...state.lines, sku]; state.count = state.count + 1; },
//     clear: () => { state.lines = []; state.count = 0; },
//   });
//
// The store's actions reuse the SAME `:=`/`+=`/`-=` statement lowering a page
// action does (shared `emitStmt`), but against a `reactive()` state object —
// reads/writes resolve to `state.<field>` instead of a `ref` / Zustand `set`.
// So a store action and a page action lower identically except for the write
// seam (Vue mutates the reactive object in place; React spreads immutably).
//
// The `lifetime` ladder mirrors the React reference: `memory` (default) is the
// plain singleton above; `persistLocal` / `persistSession` hydrate it from web
// storage and mirror it back on a deep `watch`; `url` makes the query string the
// source of truth (router-agnostic `window.location` + `history.replaceState`).
//
// This module is Vue-only.  The other fan-out frontends (React/Svelte/Angular)
// wire their own store-module emitters; their `WalkerTarget.renderStoreModule`
// emits its own container (the IR validator already gates LiveView).
// ---------------------------------------------------------------------------

import type { ActionIR, StateFieldIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { defaultInitForJs, storeHookName } from "../_walker/js-target-helpers.js";
import type { StateRef, WalkerTarget } from "../_walker/target.js";
import { emitStmt, type WalkContext } from "../_walker/walker-core.js";
import { vueTarget } from "./walker/vue-target.js";

export { storeHookName };

/** Map a store-field `TypeIR` to its TS type annotation (the store-state
 *  interface).  Mirrors React's `storeFieldTsType` (kept local so the Vue
 *  store builder doesn't import across into the React generator). */
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

/** A `reactive()`-flavoured `WalkerTarget` for rendering store-ACTION bodies.
 *  Only the state seam diverges from `vueTarget`: a write `lines := v` becomes
 *  `state.lines = v` and a `+=`/`-=` current-value read reads `state.lines`
 *  (the singleton's reactive object).  Everything else stays `vueTarget` — a
 *  store action body is restricted (state writes + store-action calls + lets),
 *  so the markup / api / match seams are unreachable. */
function reactiveTarget(): WalkerTarget {
  // Spread the real Vue target and override ONLY the state seam, so the store
  // action body lowers byte-for-byte like a page action everywhere else (lets,
  // store-action calls, expressions) and diverges solely at the write.
  return {
    ...vueTarget,
    // The store action body runs in the action arrow (script position), where
    // the reactive object is read/written by member access — no `.value`
    // (the singleton is a `reactive`, not a `ref`).
    renderStateRead(ref: StateRef): string {
      return `state.${ref.name}`;
    },
    renderStateWrite(ref: StateRef, value: string): string {
      return `state.${ref.name} = ${value}`;
    },
  };
}

/** Build the minimal `WalkContext` an action-body `emitStmt` needs, with the
 *  store's own fields registered as `stateNames` (so a bare `lines := …`
 *  resolves to a store-field write), the action's params bound so a body ref
 *  to one (`lines += sku`) resolves to the bare arg, and the `reactive()`
 *  sub-target wired in. */
function storeActionCtx(
  fieldNames: ReadonlySet<string>,
  paramNames: ReadonlySet<string>,
): WalkContext {
  return {
    target: reactiveTarget(),
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

/** Render one store action as a `useCart()` object property:
 *  `add: (sku: string) => { state.lines = [...state.lines, sku]; … }`. */
function renderStoreAction(action: ActionIR, fieldNames: ReadonlySet<string>): string {
  const paramNames = new Set(action.params.map((p) => p.name));
  const ctx = storeActionCtx(fieldNames, paramNames);
  const param = action.params[0];
  const paramSig = param ? `${param.name}: ${storeFieldTsType(param.type)}` : "";
  const stmts = action.body.map((s) => emitStmt(s, ctx));
  return `${action.name}: (${paramSig}) => { ${stmts.join(" ")} }`;
}

/** The set of money-typed **top-level** field names — the keys a persisted or
 *  URL-synced store must revive back into `Decimal` (JSON/query strings carry
 *  them as plain strings).  Nested money (inside an array/entity) is a
 *  documented v1 limitation of the persisted/URL tiers.  Mirrors React's
 *  `moneyFieldNames` so cross-frontend revival is identical. */
function moneyFieldNames(store: StoreIR): string[] {
  return store.state
    .filter((f) => f.type.kind === "primitive" && f.type.name === "money")
    .map((f) => f.name);
}

/** A URL query param decodes as an untrusted string → the field's typed value,
 *  defaulting on anything unparseable (frontend-state-management.md §3.1).  One
 *  decode expression per field, read from a `URLSearchParams` named `p`.  Kept
 *  byte-for-byte identical to React's `decodeFieldFromParam` so the two
 *  frontends coerce the same garbage to the same value. */
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
 *  by the field name; empty/default values are dropped so the URL stays clean.
 *  Reads off the passed-in state slice `s` (matches React's `encodeFieldToParam`). */
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

/** Render the full Vue `reactive()` store module for a `StoreIR`, honouring its
 *  lifetime (frontend-state-management.md §3.1):
 *   - `memory`  → a plain `reactive()` singleton.
 *   - `persistLocal` / `persistSession` → the same singleton, hydrated from
 *     `localStorage` / `sessionStorage` on init and mirrored back on every
 *     change via a deep `watch` (money fields revived via a keyed JSON reviver).
 *   - `url` → a router-agnostic bidirectional sync: seed from the query string
 *     via a typed untrusted-input decoder, and mirror every change back with
 *     `history.replaceState`, re-decoding on `popstate`. */
export function renderVueStoreModule(store: StoreIR): string {
  const fieldNames = new Set(store.state.map((f) => f.name));
  const stateType = `${upperFirst(store.name)}State`;
  const hook = storeHookName(store.name);

  // Whether any field is a money type — drives the `Decimal` import.
  const needsDecimal = store.state.some(
    (f) => f.type.kind === "primitive" && f.type.name === "money",
  );
  const moneyKeys = moneyFieldNames(store);

  const interfaceLines = store.state.map((f) => `  ${f.name}: ${storeFieldTsType(f.type)};`);
  const stateInit = store.state.map((f) => `${f.name}: ${storeFieldInit(f.type)}`).join(", ");
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

  if (store.lifetime === "persistLocal" || store.lifetime === "persistSession") {
    return renderPersistStoreModule(
      store,
      stateType,
      hook,
      needsDecimal,
      moneyKeys,
      interfaceLines,
      stateInit,
      actionEntries,
    );
  }

  return lines(
    `import { reactive } from "vue";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (\`persist: memory\`, the default) — survives navigation, dies on reload.`,
    `export interface ${stateType} {`,
    ...interfaceLines,
    `}`,
    "",
    `const state = reactive<${stateType}>({ ${stateInit} });`,
    "",
    `export const ${hook} = () => ({`,
    `  state,`,
    ...actionEntries,
    `});`,
    "",
  );
}

/** The `persistLocal` / `persistSession` lifetime: the `reactive()` singleton is
 *  hydrated from web storage on module init and written back on every change via
 *  a deep `watch`.  Money fields serialise to strings in JSON; a keyed reviver
 *  reconstructs the `Decimal` on load (top-level money fields — nested money is
 *  a documented v1 limitation of the persisted tier). */
function renderPersistStoreModule(
  store: StoreIR,
  stateType: string,
  hook: string,
  needsDecimal: boolean,
  moneyKeys: string[],
  interfaceLines: string[],
  stateInit: string,
  actionEntries: string[],
): string {
  const backing = store.lifetime === "persistLocal" ? "localStorage" : "sessionStorage";
  const persistWord = store.lifetime === "persistLocal" ? "local" : "session";
  const survivesWord =
    store.lifetime === "persistLocal" ? "a browser restart" : "reload, cleared with the tab";
  const storageKey = JSON.stringify(`loom.store.${store.name}`);
  // The JSON.parse reviver reconstructs top-level money fields back into
  // `Decimal` (they serialise to strings) — same keyed reviver React feeds the
  // Zustand `persist` middleware.
  const reviver = needsDecimal
    ? [
        `    const parsed = JSON.parse(raw, (key, value) =>`,
        `      ${JSON.stringify(moneyKeys)}.includes(key) && typeof value === "string"`,
        `        ? new Decimal(value)`,
        `        : value,`,
        `    );`,
      ]
    : [`    const parsed = JSON.parse(raw);`];
  return lines(
    `import { reactive, watch } from "vue";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// Persisted to ${backing} (\`persist: ${persistWord}\`) — survives ${survivesWord}.`,
    `export interface ${stateType} {`,
    ...interfaceLines,
    `}`,
    "",
    `const STORAGE_KEY = ${storageKey};`,
    "",
    `function loadState(): ${stateType} {`,
    `  const defaults: ${stateType} = { ${stateInit} };`,
    `  if (typeof window === "undefined") return defaults;`,
    `  const raw = ${backing}.getItem(STORAGE_KEY);`,
    `  if (raw === null) return defaults;`,
    `  try {`,
    ...reviver,
    `    return { ...defaults, ...parsed };`,
    `  } catch {`,
    `    return defaults;`,
    `  }`,
    `}`,
    "",
    `const state = reactive<${stateType}>(loadState());`,
    "",
    `// state → storage: mirror every change back (deep watch over the singleton).`,
    `if (typeof window !== "undefined") {`,
    `  watch(`,
    `    state,`,
    `    (s) => ${backing}.setItem(STORAGE_KEY, JSON.stringify(s)),`,
    `    { deep: true },`,
    `  );`,
    `}`,
    "",
    `export const ${hook} = () => ({`,
    `  state,`,
    ...actionEntries,
    `});`,
    "",
  );
}

/** The `url` lifetime: the query string is the source of truth, decoded through
 *  a typed untrusted-input decoder and mirrored back on every change.  Deliberately
 *  router-agnostic (reads `window.location`, writes `history.replaceState`) — a
 *  module-level singleton can't call `useRoute()`/`useRouter()` composables, and
 *  this matches the React reference exactly. */
function renderUrlStoreModule(
  store: StoreIR,
  stateType: string,
  hook: string,
  needsDecimal: boolean,
  interfaceLines: string[],
  actionEntries: string[],
): string {
  return lines(
    `import { reactive, watch } from "vue";`,
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
    `function decodeFromUrl(): ${stateType} {`,
    `  const p = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);`,
    `  return {`,
    ...store.state.map((f) => `    ${f.name}: ${decodeFieldFromParam(f)},`),
    `  };`,
    `}`,
    "",
    `function encodeToUrl(s: ${stateType}): void {`,
    `  if (typeof window === "undefined") return;`,
    `  const p = new URLSearchParams(window.location.search);`,
    ...store.state.map((f) => `  ${encodeFieldToParam(f)}`),
    `  const qs = p.toString();`,
    `  window.history.replaceState(null, "", qs ? \`?\${qs}\` : window.location.pathname);`,
    `}`,
    "",
    `const state = reactive<${stateType}>(decodeFromUrl());`,
    "",
    `export const ${hook} = () => ({`,
    `  state,`,
    ...actionEntries,
    `});`,
    "",
    `// state → URL: mirror every change back (replaceState, no history spam).`,
    `// URL → state: re-decode on back/forward and manual address edits.`,
    `if (typeof window !== "undefined") {`,
    `  watch(state, (s) => encodeToUrl(s), { deep: true });`,
    `  window.addEventListener("popstate", () => Object.assign(state, decodeFromUrl()));`,
    `}`,
    "",
  );
}
