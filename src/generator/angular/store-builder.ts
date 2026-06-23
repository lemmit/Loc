// ---------------------------------------------------------------------------
// Angular store module emitter — `store Cart { … }` → an injectable signal
// service at `src/app/stores/<dasherized>.store.ts` (named-actions-and-
// stores.md §3, Stage 5; frontend-state-management.md §4.1).
//
// The Angular analogue of React's Zustand module (`react/store-builder.ts`):
// a `@Injectable({ providedIn: "root" })` class whose state fields are
// `signal()`s and whose actions are class METHODS.  An action body reuses the
// SAME `:=`/`+=`/`-=` statement lowering a page action does (shared
// `emitStmt`), but against a SIGNAL-store sub-target — a read is `this.<f>()`
// and a write is `this.<f>.set(v)` — so a store action and a page action lower
// identically except for the write seam.  Output shape:
//
//   import { Injectable, signal } from "@angular/core";
//
//   @Injectable({ providedIn: "root" })
//   export class CartStore {
//     readonly lines = signal<string[]>([]);
//     readonly count = signal<number>(0);
//     add(sku: string) { this.lines.set([...this.lines(), sku]); this.count.set(this.count() + 1); }
//     clear() { this.lines.set([]); this.count.set(0); }
//   }
//
// This module is Angular-only.  The other frontends (React/Vue/Svelte) wire
// their own store-module emitters; an unimplemented frontend's
// `WalkerTarget.renderStoreModule` throws loudly (the IR validator already
// gates LiveView).
// ---------------------------------------------------------------------------

import type { ActionIR, StateFieldIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { defaultInitForJs } from "../_walker/js-target-helpers.js";
import type { StateRef, WalkerTarget } from "../_walker/target.js";
import { emitStmt, type WalkContext } from "../_walker/walker-core.js";
import { angularTarget } from "./walker/angular-target.js";

/** PascalCase store-service class name (`Cart` → `CartStore`). */
export function storeClassName(storeName: string): string {
  return `${upperFirst(storeName)}Store`;
}

/** Dasherized store-file slug (`Cart` → `cart`, `ShoppingCart` →
 *  `shopping-cart`).  Mirrors the page-shell's `pageSlug` kebab transform so
 *  every Angular source file follows the same dasherized convention. */
export function storeFileSlug(storeName: string): string {
  return storeName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

/** The import path a consuming page/component resolves a store from, relative
 *  to a `src/app/pages/<slug>.component.ts` or `src/app/components/…` file
 *  (one hop up into `stores/`).  `Cart` → `../stores/cart.store`. */
export function storeImportPath(storeName: string): string {
  return `../stores/${storeFileSlug(storeName)}.store`;
}

/** Map a store-field `TypeIR` to its TS type annotation (the `signal<T>(…)`
 *  generic).  Mirrors React's `storeFieldTsType` (kept local so the store
 *  builder doesn't import upward into the page shell). */
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
      return "unknown";
  }
}

/** Initial value for a store field — its declared `= init` (a literal), else
 *  the type's zero value (`[]` for arrays, `defaultInitForJs` for scalars). */
function storeFieldInit(field: StateFieldIR): string {
  const lit = field.init !== undefined ? renderInitLiteral(field.init) : undefined;
  if (lit !== undefined) return lit;
  if (field.type.kind === "array") return "[]";
  return defaultInitForJs(field.type);
}

/** Render a store-field `= <init>` literal (string / number / bool / null or a
 *  list of literals); undefined for anything non-literal (init expressions
 *  evaluate before the store exists, so they can't reference state). */
function renderInitLiteral(e: StateFieldIR["init"]): string | undefined {
  if (e === undefined) return undefined;
  if (e.kind === "literal") {
    if (e.lit === "string") return JSON.stringify(e.value);
    if (e.lit === "null") return "null";
    return e.value;
  }
  if (e.kind === "list") {
    const els = e.elements.map(renderInitLiteral);
    return els.every((x): x is string => x !== undefined) ? `[${els.join(", ")}]` : undefined;
  }
  return undefined;
}

/** An Angular-signal-flavoured `WalkerTarget` for rendering store-ACTION
 *  bodies.  Only the state seam diverges from `angularTarget`: inside the
 *  store CLASS the action body resolves a read `lines` to `this.lines()` and a
 *  write `lines := v` to `this.lines.set(v)`.  Everything else throws — a store
 *  action body is restricted (state writes + store-action calls + lets), so the
 *  markup / api / form seams are unreachable. */
function angularSignalStoreTarget(): WalkerTarget {
  return {
    ...angularTarget,
    // The action body is a CLASS method, so a state read resolves against
    // `this` (the template scope's bare `name()` becomes `this.name()`).
    renderStateRead(ref: StateRef): string {
      return `this.${ref.name}()`;
    },
    renderStateWrite(ref: StateRef, value: string): string {
      return `this.${ref.name}.set(${value})`;
    },
  };
}

/** Build the `WalkContext` a store-action-body `emitStmt` needs: the store's
 *  own fields registered as `stateNames` (so a bare `lines := …` resolves to a
 *  store-field write), the action's params bound, and the signal-store
 *  sub-target wired in. */
function storeActionCtx(
  pack: LoadedPack,
  fieldNames: ReadonlySet<string>,
  paramNames: ReadonlySet<string>,
): WalkContext {
  return {
    target: angularSignalStoreTarget(),
    imports: new Map(),
    pack,
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

/** Render one store action as a class method:
 *  `add(sku: string) { this.lines.set([...this.lines(), sku]); … }`. */
function renderStoreActionMethod(action: ActionIR, fieldNames: ReadonlySet<string>): string {
  const paramNames = new Set(action.params.map((p) => p.name));
  // A store action body is restricted (state writes + store-action calls +
  // lets), so it never renders a primitive — an empty pack stub suffices, as
  // in React's `storeActionCtx`.
  const ctx = storeActionCtx({} as LoadedPack, fieldNames, paramNames);
  const param = action.params[0];
  const paramSig = param ? `${param.name}: ${storeFieldTsType(param.type)}` : "";
  const stmts = action.body.map((s) => emitStmt(s, ctx));
  return `  ${action.name}(${paramSig}) { ${stmts.join(" ")} }`;
}

/** Render the full injectable signal-store module for a `StoreIR`. */
export function renderAngularStoreModule(store: StoreIR): string {
  const fieldNames = new Set(store.state.map((f) => f.name));
  const className = storeClassName(store.name);

  // Whether any field is a money type — drives the `Decimal` import.
  const needsDecimal = store.state.some(
    (f) => f.type.kind === "primitive" && f.type.name === "money",
  );

  const fieldLines = store.state.map(
    (f) => `  readonly ${f.name} = signal<${storeFieldTsType(f.type)}>(${storeFieldInit(f)});`,
  );
  const methodLines = store.actions.map((a) => renderStoreActionMethod(a, fieldNames));

  return lines(
    `import { Injectable, signal } from "@angular/core";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (session-volatile) — Loom v1 stores carry no persistence.`,
    `@Injectable({ providedIn: "root" })`,
    `export class ${className} {`,
    ...fieldLines,
    ...methodLines,
    `}`,
    "",
  );
}
