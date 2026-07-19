// ---------------------------------------------------------------------------
// Svelte store module emitter — `store Cart { … }` → a Svelte 5 runes
// (`$state`) module singleton at `src/lib/stores/<snake>.svelte.ts`
// (named-actions-and-stores.md §3 / frontend-state-management.md §4.1,
// Stage 5).  The Svelte sibling of `react/store-builder.ts`.
//
// CRITICAL: the file MUST carry the `.svelte.ts` suffix — `$state` only
// compiles inside a `.svelte` / `.svelte.ts` module.  A plain `.ts` file
// using `$state` fails `svelte-check`.
//
// The store's actions reuse the SAME `:=`/`+=`/`-=` statement lowering a
// page action does (shared `emitStmt`), but against a store-target whose
// state seam reads/writes `<storeVar>.<field>` instead of a page-local
// runes binding — so a store action and a page action lower identically
// except for the write seam.  Output shape:
//
//   export const cart = $state<{ lines: string[]; count: number }>({
//     lines: [],
//     count: 0,
//   });
//   export const add = (sku: string) => { cart.lines = [...cart.lines, sku]; cart.count = cart.count + 1; };
//   export const clear = () => { cart.lines = []; cart.count = 0; };
//
// A page/component body that reads `Cart.lines` binds `const lines =
// $derived(cart.lines)` in its `<script>`; a `Cart.clear()` call imports the
// bare `clear` export.  See `svelte/walker/page-shell.ts` `renderStoreWiring`.
// ---------------------------------------------------------------------------

import type { ActionIR, StateFieldIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { defaultInitForJs } from "../_walker/js-target-helpers.js";
import type { StateRef, WalkerTarget } from "../_walker/target.js";
import { emitStmt, type WalkContext } from "../_walker/walker-core.js";
import { svelteTarget } from "./walker/svelte-target.js";

/** The module-level singleton variable a `store Cart` exports — `cart`. */
export function storeVarName(storeName: string): string {
  return lowerFirst(storeName);
}

/** The emitted module path for a `store Cart` — `src/lib/stores/cart.svelte.ts`.
 *  The `.svelte.ts` suffix is REQUIRED for `$state` to compile. */
export function storeModulePath(storeName: string): string {
  return `src/lib/stores/${snake(storeName)}.svelte.ts`;
}

/** The `$lib`-aliased import specifier for the store module — WITHOUT the
 *  `.ts` extension (svelte-kit resolves `$lib/stores/<snake>.svelte`). */
export function storeImportSpecifier(storeName: string): string {
  return `$lib/stores/${snake(storeName)}.svelte`;
}

/** Map a store-field `TypeIR` to its TS type annotation (the store-state
 *  object literal type).  Mirrors page-shell's `stateTypeAsTsString` (kept
 *  local so the store builder doesn't import upward into the page shell). */
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

/** A runes-flavoured `WalkerTarget` for rendering store-ACTION bodies.  Only
 *  the state seam diverges from `svelteTarget`: a read/write of `lines`
 *  resolves against the module singleton (`cart.lines`) rather than a
 *  page-local `$state` binding.  Everything else throws — a store action body
 *  is restricted (state writes + store-action calls + lets), so the markup /
 *  api / match seams are unreachable. */
function storeTarget(storeVar: string): WalkerTarget {
  // Spread the real Svelte target and override ONLY the state seam, so the
  // store action body lowers byte-for-byte like a page action everywhere else
  // (lets, store-action calls, expressions) and diverges solely at the write.
  return {
    ...svelteTarget,
    // A `+=`/`-=` compound reads the current value off the singleton.
    renderStateRead(ref: StateRef): string {
      return `${storeVar}.${ref.name}`;
    },
    // `$state` is deeply reactive — a member assignment triggers an update, so
    // the write is a plain `cart.lines = value` (no immutable spread).
    renderStateWrite(ref: StateRef, value: string): string {
      return `${storeVar}.${ref.name} = ${value}`;
    },
  };
}

/** Build the minimal `WalkContext` an action-body `emitStmt` needs, with the
 *  store's own fields registered as `stateNames` (so a bare `lines := …`
 *  resolves to a store-field write), the action's params bound so a body ref
 *  to one (`lines += sku`) resolves to the bare arg, and the runes store
 *  sub-target wired in. */
function storeActionCtx(
  storeVar: string,
  fieldNames: ReadonlySet<string>,
  paramNames: ReadonlySet<string>,
): WalkContext {
  return {
    target: storeTarget(storeVar),
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

/** Render one store action as a module-level arrow export:
 *  `export const add = (sku: string) => { cart.lines = [...cart.lines, sku]; … };` */
function renderStoreActionExport(
  action: ActionIR,
  storeVar: string,
  fieldNames: ReadonlySet<string>,
): string {
  const paramNames = new Set(action.params.map((p) => p.name));
  const ctx = storeActionCtx(storeVar, fieldNames, paramNames);
  const param = action.params[0];
  const paramSig = param ? `${param.name}: ${storeFieldTsType(param.type)}` : "";
  const stmts = action.body.map((s) => emitStmt(s, ctx));
  return `export const ${action.name} = (${paramSig}) => { ${stmts.join(" ")} };`;
}

/** The set of money-typed **top-level** field names — the keys a persisted or
 *  URL-synced store must revive back into `Decimal` (JSON/query strings carry
 *  them as plain strings).  Nested money (inside an array/entity) is a
 *  documented v1 limitation of the persisted/URL tiers.  Mirrors
 *  `react/store-builder.ts` `moneyFieldNames`. */
function moneyFieldNames(store: StoreIR): string[] {
  return store.state
    .filter((f) => f.type.kind === "primitive" && f.type.name === "money")
    .map((f) => f.name);
}

/** A URL query param decodes as an untrusted string → the field's typed value,
 *  defaulting on anything unparseable (frontend-state-management.md §3.1).  One
 *  decode expression per field, read from a `URLSearchParams` named `p`.  Byte
 *  identical to `react/store-builder.ts` `decodeFieldFromParam`. */
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
 *  Reads off `s` (the state slice arg) — byte identical to
 *  `react/store-builder.ts` `encodeFieldToParam`. */
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

/** Render the full Svelte runes store module for a `StoreIR`, honouring its
 *  lifetime (frontend-state-management.md §3.1 — the Svelte sibling of
 *  `react/store-builder.ts`):
 *   - `memory`  → a plain module-singleton `$state` rune.
 *   - `persistLocal` / `persistSession` → hydrate the rune from
 *     `localStorage` / `sessionStorage` on init and mirror every change back
 *     via a module-level `$effect.root` (money fields revived via a reviver).
 *   - `url` → a native SvelteKit-router sync: seed + follow the reactive `page`
 *     (`$app/state`) via a typed untrusted-input decoder, and mirror every
 *     change back through `goto(..., { replaceState: true })`. */
export function renderSvelteStoreModule(store: StoreIR): string {
  const storeVar = storeVarName(store.name);
  const fieldNames = new Set(store.state.map((f) => f.name));

  // Whether any field is a money type — drives the `Decimal` import.
  const needsDecimal = store.state.some(
    (f) => f.type.kind === "primitive" && f.type.name === "money",
  );

  const stateTypeName = `${upperFirst(store.name)}State`;
  const stateTypeLiteral = `{ ${store.state.map((f) => `${f.name}: ${storeFieldTsType(f.type)}`).join("; ")} }`;

  if (store.lifetime === "url") {
    return renderUrlStoreModule(
      store,
      storeVar,
      fieldNames,
      stateTypeName,
      stateTypeLiteral,
      needsDecimal,
    );
  }

  if (store.lifetime === "persistLocal" || store.lifetime === "persistSession") {
    return renderPersistStoreModule(
      store,
      storeVar,
      fieldNames,
      stateTypeName,
      stateTypeLiteral,
      needsDecimal,
    );
  }

  const stateEntries = store.state.map((f) => `  ${f.name}: ${storeFieldInit(f.type)},`);

  return lines(
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    needsDecimal ? "" : undefined,
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (\`persist: memory\`, the default) — survives navigation, dies on reload.`,
    `// The \`$state\` rune makes this module singleton deeply reactive; the`,
    `// \`.svelte.ts\` filename is REQUIRED for runes to compile in a module.`,
    `export const ${storeVar} = $state<${stateTypeLiteral}>({`,
    ...stateEntries,
    `});`,
    "",
    ...store.actions.map((a) => renderStoreActionExport(a, storeVar, fieldNames)),
    "",
  );
}

/** The `persistLocal` / `persistSession` lifetime: hydrate the rune from Web
 *  Storage on init, and mirror every change back through a module-level
 *  `$effect.root` (the only way to own a reactive effect outside a component —
 *  a plain `.svelte.ts` singleton has no component effect scope). */
function renderPersistStoreModule(
  store: StoreIR,
  storeVar: string,
  fieldNames: ReadonlySet<string>,
  stateTypeName: string,
  stateTypeLiteral: string,
  needsDecimal: boolean,
): string {
  const backing = store.lifetime === "persistLocal" ? "localStorage" : "sessionStorage";
  const persistLabel = store.lifetime === "persistLocal" ? "local" : "session";
  const survives =
    store.lifetime === "persistLocal" ? "a browser restart" : "reload, cleared with the tab";
  const moneyKeys = moneyFieldNames(store);

  // Money fields serialise to strings in JSON; a keyed reviver reconstructs the
  // `Decimal` on load (top-level money fields — nested money is a documented v1
  // limitation of the persisted tier).
  const parseLines = needsDecimal
    ? [
        `    // Money fields serialise to strings in JSON; a keyed reviver reconstructs`,
        `    // the \`Decimal\` on load (top-level money fields — nested money is a`,
        `    // documented v1 limitation of the persisted tier).`,
        `    const parsed = JSON.parse(raw, (key, value) =>`,
        `      ${JSON.stringify(moneyKeys)}.includes(key) && typeof value === "string"`,
        `        ? new Decimal(value)`,
        `        : value,`,
        `    ) as Partial<${stateTypeName}>;`,
        `    return { ...defaults, ...parsed };`,
      ]
    : [
        `    const parsed = JSON.parse(raw) as Partial<${stateTypeName}>;`,
        `    return { ...defaults, ...parsed };`,
      ];

  return lines(
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    needsDecimal ? "" : undefined,
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// Persisted to ${backing} (\`persist: ${persistLabel}\`) — survives ${survives}.`,
    `// The \`$state\` rune makes this module singleton deeply reactive; the`,
    `// \`.svelte.ts\` filename is REQUIRED for runes to compile in a module.`,
    `type ${stateTypeName} = ${stateTypeLiteral};`,
    "",
    `const STORAGE_KEY = ${JSON.stringify(`loom.store.${store.name}`)};`,
    "",
    `function loadInitial(): ${stateTypeName} {`,
    `  const defaults: ${stateTypeName} = {`,
    ...store.state.map((f) => `    ${f.name}: ${storeFieldInit(f.type)},`),
    `  };`,
    `  if (typeof ${backing} === "undefined") return defaults;`,
    `  const raw = ${backing}.getItem(STORAGE_KEY);`,
    `  if (raw === null) return defaults;`,
    `  try {`,
    ...parseLines,
    `  } catch {`,
    `    return defaults;`,
    `  }`,
    `}`,
    "",
    `export const ${storeVar} = $state<${stateTypeName}>(loadInitial());`,
    "",
    `// store → ${backing}: mirror every change back on write (a module-level`,
    `// \`$effect.root\` owns the effect outside any component scope).`,
    `$effect.root(() => {`,
    `  $effect(() => {`,
    `    if (typeof ${backing} !== "undefined") {`,
    `      ${backing}.setItem(STORAGE_KEY, JSON.stringify(${storeVar}));`,
    `    }`,
    `  });`,
    `});`,
    "",
    ...store.actions.map((a) => renderStoreActionExport(a, storeVar, fieldNames)),
    "",
  );
}

/** The `url` lifetime: the query string is the source of truth, bound through
 *  SvelteKit's own router.  `page` (from `$app/state`) is reactive, so an
 *  `$effect` reading `page.url` re-runs on EVERY navigation (links, `goto`,
 *  back/forward) — no raw `popstate`, and no conflict with SvelteKit's history.
 *  A second `$effect` mirrors each store change back with `goto(..., {
 *  replaceState: true })`; a URL-diff guard breaks the page → store → URL
 *  cycle.  All client-only (`browser`-guarded) — SSR renders the defaults. */
function renderUrlStoreModule(
  store: StoreIR,
  storeVar: string,
  fieldNames: ReadonlySet<string>,
  stateTypeName: string,
  stateTypeLiteral: string,
  needsDecimal: boolean,
): string {
  return lines(
    `import { browser } from "$app/environment";`,
    `import { goto } from "$app/navigation";`,
    `import { page } from "$app/state";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// Synced to the URL query string (\`persist: url\`) — shareable, deep-linkable,`,
    `// back/forward-navigable — through SvelteKit's router.  The URL is untrusted`,
    `// input: each field is decoded through its declared type and defaulted on`,
    `// anything unparseable.  The \`.svelte.ts\` filename is REQUIRED for the runes`,
    `// below to compile in a module.`,
    `type ${stateTypeName} = ${stateTypeLiteral};`,
    "",
    `function decodeFrom(p: URLSearchParams): ${stateTypeName} {`,
    `  return {`,
    ...store.state.map((f) => `    ${f.name}: ${decodeFieldFromParam(f)},`),
    `  };`,
    `}`,
    "",
    `// Merge the store's fields into the CURRENT query string (preserving any`,
    `// unrelated params) and return the serialised query.`,
    `function toQuery(s: ${stateTypeName}): string {`,
    `  const p = new URLSearchParams(browser ? window.location.search : "");`,
    ...store.state.map((f) => `  ${encodeFieldToParam(f)}`),
    `  return p.toString();`,
    `}`,
    "",
    `export const ${storeVar} = $state<${stateTypeName}>(`,
    `  decodeFrom(new URLSearchParams(browser ? window.location.search : "")),`,
    `);`,
    "",
    `if (browser) {`,
    `  $effect.root(() => {`,
    `    // URL → store: \`page.url\` is reactive, so this re-runs on every`,
    `    // navigation — links, \`goto\`, back/forward, manual edits.`,
    `    $effect(() => {`,
    `      Object.assign(${storeVar}, decodeFrom(page.url.searchParams));`,
    `    });`,
    `    // store → URL: mirror each change back through SvelteKit's router. The`,
    `    // URL-diff guard stops the page → store → URL cycle.`,
    `    $effect(() => {`,
    `      const qs = toQuery(${storeVar});`,
    `      if (qs !== new URLSearchParams(window.location.search).toString()) {`,
    `        goto(qs ? \`?\${qs}\` : window.location.pathname, {`,
    `          replaceState: true,`,
    `          keepFocus: true,`,
    `          noScroll: true,`,
    `        });`,
    `      }`,
    `    });`,
    `  });`,
    `}`,
    "",
    ...store.actions.map((a) => renderStoreActionExport(a, storeVar, fieldNames)),
    "",
  );
}
