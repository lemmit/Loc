// ---------------------------------------------------------------------------
// HEEx `WalkerTarget` — Phoenix LiveView implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope.
//
// This module is the *standalone* impl: it lifts the seams the
// inline Phoenix walker (`heex-walker.ts`) already implements into the
// `WalkerTarget` interface.  The walker itself still inlines these
// seams; the extraction is gated on the
// `mix compile --warnings-as-errors` suite.
//
// Mapping (file:line at time of extraction):
//   renderStateRead   — heex-walker.ts:253-259 (this/id position branches)
//                       + line 366 (state-field ref-case path)
//   renderStateWrite  — heex-walker.ts:1565-1572 (case "assign")
//   renderApiCall     — heex-walker.ts:647-683 (direct context-function call)
//   renderApiHoisting — empty array (LiveView reads inline; no hoisting)
//   renderMatch       — heex-walker.ts:543-552 (renderMatch — cond do...end)
//   renderNavigate    — heex-walker.ts:690-715 (push_navigate + ~p sigil)
//   defaultInitFor    — Elixir literals per type
//
// `framework: "phoenixLiveView"` matches the IR enum.
// ---------------------------------------------------------------------------

import type { TypeIR } from "../../ir/types/loom-ir.js";
import { unreachableExprLeaves } from "../_walker/js-expr-leaves.js";
import type { ApiCallSite, RenderPosition, StateRef, WalkerTarget } from "../_walker/target.js";
import { escapeHeexText } from "./heex-walker-core.js";

export const heexTarget: WalkerTarget = {
  framework: "phoenixLiveView",

  // Expression-syntax leaves — HEEx runs a PARALLEL walker
  // (heex-walker-core.ts) and never calls the shared `emitExpr`, so these are
  // unreachable; they throw (fail-loud) if the fork invariant ever regresses,
  // rather than silently emitting JS into Elixir output.
  ...unreachableExprLeaves,

  // --- State seam ---------------------------------------------------------

  /** HEEx differentiates template (`@field`) from handler
   *  (`socket.assigns.field`).  Mirrors heex-walker.ts:253-259 and
   *  the ref-case branch at :366. */
  renderStateRead(ref: StateRef, position: RenderPosition): string {
    const snakeName = snakeLocal(ref.name);
    return position === "template" ? `@${snakeName}` : `socket.assigns.${snakeName}`;
  },

  /** Pipe step: `|> assign(:field, value)`.  The caller pipes the
   *  socket through these as part of handler-body composition.
   *  Mirrors `case "assign"` at heex-walker.ts:1566-1572. */
  renderStateWrite(ref: StateRef, value: string): string {
    return `|> assign(:${snakeLocal(ref.name)}, ${value})`;
  },

  /** Unreachable: the HEEx walker (heex-walker-core.ts) renders state
   *  mutation through its own engine, never the shared `stateWrite`. */
  renderNestedStateWrite(): never {
    throw new Error(
      "heexTarget.renderNestedStateWrite: HEEx renders state through its own engine; this should never be called.",
    );
  },

  // --- API binding seam ---------------------------------------------------

  /** Phoenix calls the context module's public function directly — no hook
   *  hoisting.  Shape: `<App>.<Context>.<op>_<aggregate_snake>(args)`.
   *  Naming convention matches `heex-walker.ts:647-683` (codeIntfFnName).
   *  The `<App>.<Context>` prefix is not visible to the contract —
   *  caller (the future delegating walker) prepends it from the
   *  `BoundedContextIR` in scope. */
  renderApiCall(call: ApiCallSite, renderedArgs: string): string {
    const fn = codeInterfaceFnName(call.aggregateName, call.operation);
    return renderedArgs.length === 0 ? `${fn}()` : `${fn}(${renderedArgs})`;
  },

  /** Empty — LiveView reads in `mount/3` and writes from
   *  `handle_event/3`; there's no per-page hoisted hook declaration. */
  renderApiHoisting(_uses: ApiCallSite[]): string[] {
    return [];
  },

  /** Unreachable for HEEx — Phoenix LiveView doesn't lower api calls
   *  to hoisted hooks (the heex-walker never invokes
   *  `tryDetectApiHook`).  Stays on the interface for cross-target
   *  uniformity; throwing documents the contract for future
   *  contributors who might hook this up by mistake. */
  buildHookUse(): never {
    throw new Error(
      "heexTarget.buildHookUse: Phoenix LiveView does not hoist api calls; this should never be called.",
    );
  },

  // --- Match expression seam ----------------------------------------------

  /** Elixir `cond do … true -> fallback end`.  Caller wraps in
   *  `<%= … %>` when in template position — this method emits the
   *  bare cond.  Mirrors `renderMatch` at heex-walker.ts:543-552
   *  (without the position-dependent wrap). */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
  ): string {
    const armLines = arms.map((a) => `      ${a.predicate} -> ${a.value}`).join("\n");
    const fallback = elseArm !== undefined ? `\n      true -> ${elseArm}` : "";
    return `cond do\n${armLines}${fallback}\n    end`;
  },

  /** Unreachable in practice (the parallel heex-walker owns match
   *  rendering); passthrough for contract completeness. */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    _depth: number,
  ): string {
    return heexTarget.renderMatch(arms, elseArm);
  },

  // --- Navigation seam ----------------------------------------------------

  /** `push_navigate(socket, to: ~p"/route?k=v")`.  Mirrors
   *  `renderNavigate` at heex-walker.ts:690-715.  Query-string
   *  composition is the contract's `args` set; the WalkerTarget
   *  expects them rendered already by the caller. */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    _stateExpr?: string,
  ): string {
    // HEEx cannot embed an arbitrary expression into a `~p` sigil's
    // query string — the sigil is compile-time interpolated against
    // a known route template.  When the contract supplies
    // `stateExpr` (TSX escape hatch), Phoenix falls back to the
    // args-empty `push_navigate`; the source's pre-built state
    // object is opaque to the route.  Callers needing a richer
    // shape route through `handle_event` instead.
    if (args.length === 0) {
      return `push_navigate(socket, to: ~p"${routeTemplate}")`;
    }
    const queryPairs = args.map((a) => `${snakeLocal(a.name)}=#{${a.value}}`).join("&");
    return `push_navigate(socket, to: ~p"${routeTemplate}?${queryPairs}")`;
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForHeex(type);
  },

  // --- Markup seams ---------------------------------------------------------
  //
  // The HEEx walker is a parallel sibling (heex-walker.ts) that never
  // routes through the shared markup walker, so these exist for
  // contract completeness.  `renderComment` / `renderStyleAttr` /
  // `escapeText` return the HEEx forms the inline walker uses;
  // `renderConditionalChild` is unreachable (the heex walker has its
  // own ternary path) and throws, mirroring `buildHookUse`.

  /** HEEx template comment. */
  renderComment(text: string): string {
    return `<%!-- ${text} --%>`;
  },

  /** Modern HEEx body interpolation (`{expr}`) — unreachable in
   *  practice (the parallel heex-walker emits `<%= %>` / `{}` forms
   *  inline); returned for contract completeness. */
  renderInterpolation(jsExpr: string): string {
    return `{${jsExpr}}`;
  },

  /** HEEx dynamic attribute (`attr={expr}`) — unreachable in
   *  practice, contract completeness. */
  renderAttrBinding(name: string, jsExpr: string): string {
    return ` ${name}={${jsExpr}}`;
  },

  /** Unreachable for HEEx — the parallel heex-walker renders
   *  conditional children through its own position-aware path. */
  renderConditionalChild(): never {
    throw new Error(
      "heexTarget.renderConditionalChild: the HEEx walker renders conditionals inline; this should never be called.",
    );
  },

  /** Unreachable for HEEx — the parallel heex-walker renders the
   *  `For` comprehension through `heex-primitives.ts:renderFor` (a
   *  `for … do … end` block), not this seam. */
  renderForEach(): never {
    throw new Error(
      "heexTarget.renderForEach: the HEEx walker renders For via renderFor; this should never be called.",
    );
  },

  /** Flat quoted CSS string — the HEEx spelling of the `style: {…}`
   *  escape hatch.  Behaviour-identical to the old body-walker
   *  `styleAttrHeex` helper: string-literal values verbatim, other
   *  values via their rendered expression, `"` entity-escaped so the
   *  attribute stays well-formed. */
  renderStyleAttr(
    entries: ReadonlyArray<{ key: string; rendered: string; literal?: string }>,
  ): string {
    if (entries.length === 0) return "";
    const css = entries
      .map(({ key, rendered, literal }) => `${key}: ${literal ?? rendered}`)
      .join("; ")
      .replace(/"/g, "&quot;");
    return ` style="${css}"`;
  },

  /** HEEx text escaping.  Delegates to the LIVE funnel the parallel
   *  heex-walker uses (`escapeHeexText`) so the contract-tested seam and
   *  the code path that actually renders can never disagree on escaping
   *  — the exact divergence audit finding 13 flagged (a standalone copy
   *  here would silently drift from `renderChild`/`renderInTemplate`). */
  escapeText(text: string): string {
    return escapeHeexText(text);
  },
};

// ---------------------------------------------------------------------------
// Store seam (Stage 5) — HEEx-specific.
//
// The cross-framework `WalkerTarget.renderStoreFieldRead`/`…ActionCall`
// signatures are shaped for the SHARED `walkBody` engine (`{ storeName,
// field }` / a shell-bound `local`), which the JSX/markup frontends drive.
// Phoenix LiveView runs the PARALLEL heex-walker engine and needs a
// position-aware read + an `update/3` call form, so the store seams live as
// standalone helpers the heex walker calls directly (the same way HEEx owns
// its parallel match / For rendering).  Keeping them off the `WalkerTarget`
// object keeps `heexTarget` byte-conformant to the shared contract.
//
// A `store Cart { … }` mounted on a LiveView page is seeded as one per-page
// assign — `assign(:cart, %Cart{})` — and rendered as a dedicated
// `<App>Web.Stores.Cart` module (defstruct + pure action fns).  The seams:
//
//   - read,  template position: `@cart.count`
//   - read,  handler  position: `socket.assigns.cart.count`
//   - call,  0 args: `update(socket, :cart, &Cart.clear/1)`
//   - call,  N args: `update(socket, :cart, fn c -> Cart.add(c, sku) end)`
//
// Namespaced through the `:<store_snake>` assign so a page `state { count }`
// and a `Cart.count` read never collide — there is no flat `@count`.

/** `Cart.count` read → `@cart.count` (template) / `socket.assigns.cart.count`
 *  (handler).  `store` is the PascalCase store name; the assign key is its
 *  snake form. */
export function renderHeexStoreFieldRead(
  store: string,
  field: string,
  position: RenderPosition,
): string {
  const assign = snakeLocal(store);
  const f = snakeLocal(field);
  return position === "template" ? `@${assign}.${f}` : `socket.assigns.${assign}.${f}`;
}

/** `Cart.clear()` / `Cart.add(sku)` call → an `update/3` over the store's
 *  per-page assign applying the store module's pure fn.  0 args → a captured
 *  `&Cart.clear/1`; N args → a `fn c -> … end` so the draft struct flows in
 *  as the first argument.  Emits handler-position Elixir (a `handle_event`
 *  body) — it pipes/returns a new socket. */
export function renderHeexStoreActionCall(
  store: string,
  action: string,
  renderedArgs: string,
): string {
  const assign = snakeLocal(store);
  const module = upperFirstLocal(store);
  const fn = snakeLocal(action);
  if (renderedArgs.length === 0) {
    return `update(socket, :${assign}, &${module}.${fn}/1)`;
  }
  return `update(socket, :${assign}, fn c -> ${module}.${fn}(c, ${renderedArgs}) end)`;
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/** Elixir literal-zero per type.  HEEx walker doesn't have a
 *  centralized version of this today (state inits in Phoenix are
 *  rare — `state {}` blocks lower into `mount/3` assigns).  Values
 *  match the spec §6 zero-value table in Elixir flavour. */
function defaultInitForHeex(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
        return "0";
      case "decimal":
      case "money":
        // Both are Decimal structs — zero is `Decimal.new("0")`, not `0`.
        return 'Decimal.new("0")';
      case "bool":
        return "false";
      case "string":
      case "datetime":
      case "guid":
        return '""';
    }
  }
  if (type.kind === "id" || type.kind === "enum") return '""';
  if (type.kind === "optional") return "nil";
  if (type.kind === "array") return "[]";
  return "nil";
}

/** Context module function name: `<op>_<aggregate_snake>!` (plural for
 *  list ops, singular otherwise).  Matches `renderApiCall` at
 *  `heex-walker.ts:693-712` byte-for-byte — same crude `<single>s`
 *  pluralisation, same `delete`/`destroy` aliasing, same `!` suffix
 *  on every non-list op. */
function codeInterfaceFnName(aggregate: string, op: string): string {
  const single = snakeLocal(aggregate);
  if (op === "create") return `create_${single}!`;
  if (op === "update") return `update_${single}!`;
  if (op === "delete" || op === "destroy") return `destroy_${single}!`;
  if (op === "all") return `list_${single}s!`; // crude plural — matches walker
  if (op === "byId") return `get_${single}!`;
  return `${snakeLocal(op)}_${single}!`;
}

// Self-contained naming helpers — same behaviour as util/naming.ts
// for the inputs the walker produces; keeps the target file
// independent of the wider toolchain.
function snakeLocal(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** PascalCase the first character — the Elixir module-name spelling of a
 *  store (`cart` / `Cart` → `Cart`).  Store names are already PascalCase in
 *  source, so this is just a defensive upper-first. */
function upperFirstLocal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
