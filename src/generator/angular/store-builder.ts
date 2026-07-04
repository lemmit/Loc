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
  if (lit !== undefined) {
    // A money field lowers to `Decimal`, so a numeric `= 0.00` literal must be
    // constructed, not assigned raw (a bare number would be a TS2322 against
    // the `signal<Decimal>`).
    if (field.type.kind === "primitive" && field.type.name === "money") {
      return `new Decimal(${JSON.stringify(lit)})`;
    }
    return lit;
  }
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

/** Type zero for a store field — `[]` for arrays, `defaultInitForJs` otherwise.
 *  Mirrors React's TYPE-based `storeFieldInit` (distinct from this module's
 *  `storeFieldInit(field)`, which honours a declared `= init` literal).  The
 *  URL decoder defaults to the type zero, not the literal — byte-for-byte with
 *  React's `decodeFieldFromParam`. */
function storeZeroForType(type: TypeIR): string {
  if (type.kind === "array") return "[]";
  return defaultInitForJs(type);
}

/** The money-typed **top-level** field names — the keys a persisted or
 *  URL-synced store must revive back into `Decimal` (JSON / query strings carry
 *  them as plain strings).  Byte-for-byte with React's `moneyFieldNames`.
 *  Nested money (inside an array/entity) is a documented v1 limitation of the
 *  persisted/URL tiers. */
function moneyFieldNames(store: StoreIR): string[] {
  return store.state
    .filter((f) => f.type.kind === "primitive" && f.type.name === "money")
    .map((f) => f.name);
}

/** A URL query param decodes as an untrusted string → the field's typed value,
 *  defaulting on anything unparseable (frontend-state-management.md §3.1).  One
 *  decode expression per field, read from a `URLSearchParams` named `p`.
 *  Byte-for-byte with React's `decodeFieldFromParam`. */
function decodeFieldFromParam(field: StateFieldIR): string {
  const key = JSON.stringify(field.name);
  const t = field.type;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return `p.has(${key}) && Number.isFinite(Number(p.get(${key}))) ? Number(p.get(${key})) : ${storeZeroForType(t)}`;
      case "money":
        return `p.has(${key}) && p.get(${key})!.match(/^-?\\d+(\\.\\d+)?$/) ? new Decimal(p.get(${key})!) : ${storeZeroForType(t)}`;
      case "bool":
        return `p.get(${key}) === "true"`;
      default:
        return `p.get(${key}) ?? ${storeZeroForType(t)}`;
    }
  }
  // ids/enums decode as bare strings (enum membership is not re-checked here;
  // an off-set value is harmless client filter state, re-validated server-side).
  if (t.kind === "id" || t.kind === "enum") return `p.get(${key}) ?? ${storeZeroForType(t)}`;
  // Arrays / entities / anything structural are not URL-encodable in v1 — the
  // validator (loom.store-url-field-unsupported) blocks them, so this is a
  // defensive default only.
  return storeZeroForType(t);
}

/** Serialise a field back into the query string (`p.set` / `p.delete`), keyed
 *  by the field name; empty/default values are dropped so the URL stays clean.
 *  Reads the signal directly (`this.<f>()`) — the effect that calls the encoder
 *  reads the signal synchronously, so the write is tracked.
 *
 *  Runtime-equivalent to React's `encodeFieldToParam`, but SPLIT by type where
 *  React's uniform `s.<f> !== ""` guard would not typecheck under Angular's
 *  strict tsc: comparing a `number` field to `""` is TS2367 ("no overlap").  A
 *  number is never the empty string, so numbers always serialise — which is
 *  exactly React's runtime behaviour (a `0` is written, not dropped). */
function encodeFieldToParamAngular(field: StateFieldIR): string {
  const key = JSON.stringify(field.name);
  const t = field.type;
  const ref = `this.${field.name}()`;
  if (t.kind === "primitive" && t.name === "money") {
    return `if (${ref} != null) p.set(${key}, ${ref}.toString()); else p.delete(${key});`;
  }
  if (t.kind === "primitive" && t.name === "bool") {
    return `if (${ref}) p.set(${key}, "true"); else p.delete(${key});`;
  }
  if (t.kind === "primitive" && (t.name === "int" || t.name === "long" || t.name === "decimal")) {
    return `p.set(${key}, String(${ref}));`;
  }
  // string / id / enum — drop the empty-string default.
  return `if (${ref} !== "") p.set(${key}, ${ref}); else p.delete(${key});`;
}

/** Render the full injectable signal-store module for a `StoreIR`, honouring
 *  its lifetime (frontend-state-management.md §3.1):
 *   - `memory`  → a plain `providedIn: "root"` signal service.
 *   - `persistLocal` / `persistSession` → hydrate the signals from
 *     `localStorage` / `sessionStorage` in the constructor and mirror every
 *     change back via an `effect` (money fields revived from string on load).
 *   - `url` → a router-agnostic bidirectional sync: seed the signals from the
 *     query string via a typed untrusted-input decoder, mirror every change
 *     back with `history.replaceState`, and re-decode on `popstate`. */
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

  if (store.lifetime === "url") {
    return renderUrlStoreModule(store, className, needsDecimal, fieldLines, methodLines);
  }
  if (store.lifetime === "persistLocal" || store.lifetime === "persistSession") {
    return renderPersistStoreModule(store, className, needsDecimal, fieldLines, methodLines);
  }

  return lines(
    `import { Injectable, signal } from "@angular/core";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// In-memory (\`persist: memory\`, the default) — survives navigation, dies on reload.`,
    `@Injectable({ providedIn: "root" })`,
    `export class ${className} {`,
    ...fieldLines,
    ...methodLines,
    `}`,
    "",
  );
}

/** The `persistLocal` / `persistSession` lifetimes: hydrate the signals from
 *  Web Storage in the constructor and write the whole snapshot back on any
 *  change via an `effect`.  Storage key `"loom.store.<Name>"`; money fields
 *  serialise to strings in JSON and are revived to `Decimal` on load (mirrors
 *  React's keyed reviver over the top-level money field names). */
function renderPersistStoreModule(
  store: StoreIR,
  className: string,
  needsDecimal: boolean,
  fieldLines: string[],
  methodLines: string[],
): string {
  const backing = store.lifetime === "persistLocal" ? "localStorage" : "sessionStorage";
  const storageKey = JSON.stringify(`loom.store.${store.name}`);
  const snapshot = `{ ${store.state.map((f) => `${f.name}: this.${f.name}()`).join(", ")} }`;
  const hydrateLines = store.state.map((f) => hydrateFieldLine(f));

  return lines(
    `import { effect, Injectable, signal } from "@angular/core";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// Persisted to ${backing} (\`persist: ${store.lifetime === "persistLocal" ? "local" : "session"}\`) — survives ${store.lifetime === "persistLocal" ? "a browser restart" : "reload, cleared with the tab"}.`,
    `@Injectable({ providedIn: "root" })`,
    `export class ${className} {`,
    ...fieldLines,
    "",
    `  constructor() {`,
    `    this.hydrate();`,
    `    effect(() => {`,
    `      const raw = JSON.stringify(${snapshot});`,
    `      if (typeof ${backing} !== "undefined") ${backing}.setItem(${storageKey}, raw);`,
    `    });`,
    `  }`,
    "",
    `  private hydrate(): void {`,
    `    if (typeof ${backing} === "undefined") return;`,
    `    const raw = ${backing}.getItem(${storageKey});`,
    `    if (raw === null) return;`,
    `    let parsed: Record<string, unknown>;`,
    `    try {`,
    `      parsed = JSON.parse(raw) as Record<string, unknown>;`,
    `    } catch {`,
    `      return;`,
    `    }`,
    ...hydrateLines,
    `  }`,
    ...methodLines,
    `}`,
    "",
  );
}

/** One hydration statement per field, read out of the parsed `Record<string,
 *  unknown>`.  Money fields carry as JSON strings and are revived to `Decimal`
 *  (mirrors React's keyed reviver: string → `new Decimal(v)`, else use the raw
 *  value); every other field is set with a checked cast to its declared type. */
function hydrateFieldLine(field: StateFieldIR): string {
  const key = JSON.stringify(field.name);
  const t = field.type;
  if (t.kind === "primitive" && t.name === "money") {
    return `    if (${key} in parsed) { const v = parsed.${field.name}; this.${field.name}.set(typeof v === "string" ? new Decimal(v) : (v as Decimal)); }`;
  }
  return `    if (${key} in parsed) this.${field.name}.set(parsed.${field.name} as ${storeFieldTsType(t)});`;
}

/** The `url` lifetime: the query string is the source of truth, decoded through
 *  a typed untrusted-input decoder and mirrored back on every change.  Kept
 *  router-agnostic (reads `window.location.search`, writes via
 *  `history.replaceState`) for parity with React — Angular services CAN inject
 *  `Router`/`ActivatedRoute`, but the window approach matches React exactly. */
function renderUrlStoreModule(
  store: StoreIR,
  className: string,
  needsDecimal: boolean,
  fieldLines: string[],
  methodLines: string[],
): string {
  const decodeLines = store.state.map((f) => `    this.${f.name}.set(${decodeFieldFromParam(f)});`);
  const encodeLines = store.state.map((f) => `    ${encodeFieldToParamAngular(f)}`);

  return lines(
    `import { effect, Injectable, signal } from "@angular/core";`,
    needsDecimal ? `import Decimal from "decimal.js";` : undefined,
    "",
    `// Shared client-side state container generated from \`store ${store.name}\`.`,
    `// Synced to the URL query string (\`persist: url\`) — shareable, deep-linkable,`,
    `// back/forward-navigable.  The URL is untrusted input: each field is decoded`,
    `// through its declared type and defaulted on anything unparseable.`,
    `@Injectable({ providedIn: "root" })`,
    `export class ${className} {`,
    ...fieldLines,
    "",
    `  constructor() {`,
    `    this.decodeFromUrl();`,
    `    if (typeof window !== "undefined") {`,
    `      window.addEventListener("popstate", () => this.decodeFromUrl());`,
    `    }`,
    `    // store → URL: mirror every change back (replaceState, no history spam).`,
    `    effect(() => this.encodeToUrl());`,
    `  }`,
    "",
    `  private decodeFromUrl(): void {`,
    `    const p = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);`,
    ...decodeLines,
    `  }`,
    "",
    `  private encodeToUrl(): void {`,
    `    if (typeof window === "undefined") return;`,
    `    const p = new URLSearchParams(window.location.search);`,
    ...encodeLines,
    `    const qs = p.toString();`,
    `    window.history.replaceState(null, "", qs ? \`?\${qs}\` : window.location.pathname);`,
    `  }`,
    ...methodLines,
    `}`,
    "",
  );
}
