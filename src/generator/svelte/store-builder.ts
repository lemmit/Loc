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

import type { ActionIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, snake } from "../../util/naming.js";
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

/** Render the full Svelte runes store module for a `StoreIR`. */
export function renderSvelteStoreModule(store: StoreIR): string {
  const storeVar = storeVarName(store.name);
  const fieldNames = new Set(store.state.map((f) => f.name));

  // Whether any field is a money type — drives the `Decimal` import.
  const needsDecimal = store.state.some(
    (f) => f.type.kind === "primitive" && f.type.name === "money",
  );

  const stateType = `{ ${store.state.map((f) => `${f.name}: ${storeFieldTsType(f.type)}`).join("; ")} }`;
  const stateEntries = store.state.map((f) => `  ${f.name}: ${storeFieldInit(f.type)},`);

  return lines(
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    needsDecimal ? "" : undefined,
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (session-volatile) — Loom v1 stores carry no persistence.`,
    `// The \`$state\` rune makes this module singleton deeply reactive; the`,
    `// \`.svelte.ts\` filename is REQUIRED for runes to compile in a module.`,
    `export const ${storeVar} = $state<${stateType}>({`,
    ...stateEntries,
    `});`,
    "",
    ...store.actions.map((a) => renderStoreActionExport(a, storeVar, fieldNames)),
    "",
  );
}
