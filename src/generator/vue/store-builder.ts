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
// This module is Vue-only.  The other fan-out frontends (React/Svelte/Angular)
// wire their own store-module emitters; their `WalkerTarget.renderStoreModule`
// emits its own container (the IR validator already gates LiveView).
// ---------------------------------------------------------------------------

import type { ActionIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
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

/** Render the full Vue `reactive()` store module for a `StoreIR`. */
export function renderVueStoreModule(store: StoreIR): string {
  const fieldNames = new Set(store.state.map((f) => f.name));
  const stateType = `${upperFirst(store.name)}State`;
  const hook = storeHookName(store.name);

  // Whether any field is a money type — drives the `Decimal` import.
  const needsDecimal = store.state.some(
    (f) => f.type.kind === "primitive" && f.type.name === "money",
  );

  const interfaceLines = store.state.map((f) => `  ${f.name}: ${storeFieldTsType(f.type)};`);
  const stateInit = store.state.map((f) => `${f.name}: ${storeFieldInit(f.type)}`).join(", ");
  const actionEntries = store.actions.map((a) => `  ${renderStoreAction(a, fieldNames)},`);

  return lines(
    `import { reactive } from "vue";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (session-volatile) — Loom v1 stores carry no persistence.`,
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
