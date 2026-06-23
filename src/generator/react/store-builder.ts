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
// This module is React-only.  The fan-out frontends (Vue/Svelte/Angular) wire
// their own store-module emitters; their `WalkerTarget.renderStoreModule`
// throws loudly until ported (the IR validator already gates LiveView).
// ---------------------------------------------------------------------------

import type { ActionIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
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

/** Render the full Zustand store module for a `StoreIR`. */
export function renderZustandStoreModule(store: StoreIR): string {
  const fieldNames = new Set(store.state.map((f) => f.name));
  const stateType = upperFirst(store.name) + "State";
  const hook = storeHookName(store.name);

  // Whether any field is a money type — drives the `Decimal` import.
  const needsDecimal = store.state.some(
    (f) => f.type.kind === "primitive" && f.type.name === "money",
  );

  const interfaceLines = [
    ...store.state.map((f) => `  ${f.name}: ${storeFieldTsType(f.type)};`),
    ...store.actions.map((a) => {
      const param = a.params[0];
      const paramSig = param ? `${param.name}: ${storeFieldTsType(param.type)}` : "";
      return `  ${a.name}: (${paramSig}) => void;`;
    }),
  ];

  const bodyEntries = [
    ...store.state.map((f) => `  ${f.name}: ${storeFieldInit(f.type)},`),
    ...store.actions.map((a) => `  ${renderStoreAction(a, fieldNames)},`),
  ];

  return lines(
    `import { create } from "zustand";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (session-volatile) — Loom v1 stores carry no persistence.`,
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
