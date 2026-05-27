// ---------------------------------------------------------------------------
// Walker target contract — framework-specific lowering seams.
//
// The body walker traverses Loom's expression IR (closed primitive
// library: List/Detail/Form/MasterDetail/Stack/Toolbar/match/...,
// plus state := and block-body lambdas) and dispatches per-primitive
// rendering through the active design pack.  Most of that traversal
// is framework-neutral — pack templates own the framework-specific
// JSX/HEEx surface — but a small set of seams are fundamentally
// platform-shaped and cannot be expressed as templates:
//
//   1. State reads/writes — `step` vs `@step` vs `socket.assigns.step`
//   2. State mutation — `setStep(x)` vs `assign(socket, :step, x)`
//   3. API call lowering — React-Query hook hoisting
//      vs LiveView's direct context-function call
//   4. Helper imports — `import { fn } from "..."` vs Elixir `alias`
//   5. `match { ... }` — chained ternary vs HEEx `<%= case ... %>`
//   6. Cross-page navigation — `useNavigate()` vs `push_navigate(socket, to: ...)`
//
// `WalkerTarget` is the contract every framework-specific walker
// implements.  v0 wires the React (TSX) walker through `tsxTarget`
// and the Phoenix LiveView (HEEx) walker through `heexTarget`.  The
// walker itself takes a `WalkerTarget` parameter and consults it at
// each of the seams above; the rest (pack dispatch, attribute
// formatting, lambda traversal) stays in the shared walker.
//
// The contract has two implementations:
//
//   - `src/generator/react/walker/tsx-target.ts`            → `tsxTarget`
//   - `src/generator/phoenix-live-view/heex-target.ts`      → `heexTarget`
//
// Both validate the interface end-to-end through the cross-target
// conformance test.  The walkers (`body-walker.ts` for React,
// `heex-walker.ts` for Phoenix) inline their seam implementations
// directly; extracting them behind these targets is gated on the
// byte-identical fixture suite (React) and
// `mix compile --warnings-as-errors` (Phoenix).
//
// SCOPE DECISION (kept at 9 methods).  The contract covers the
// CROSS-FRAMEWORK lowering seams a new frontend (Vue / Svelte /
// Blazor) must implement to reuse the shared walker core.  Out of
// scope deliberately:
//
//   - Position-dependent `this`/`id` rendering — HEEx oddity; JSX
//     frameworks render identically in template + handler.
//   - Toast / put_flash — framework-private rendering surface.
//   - User-component invocation — handled inline per framework
//     (JSX <Comp /> vs LiveView functional component).
//   - Collection-op rendering (`xs.map(...)`, `xs.sum(...)`) —
//     React uses native JS collection methods; HEEx uses Enum.*
//     idioms.  No shared lowering, no contract.
//   - Lambda hoisting — JSX inlines lambdas; HEEx hoists to
//     handle_event clauses.  Framework-shaped.
//
// Adding any of the above to `WalkerTarget` would extend interface
// surface for zero new-frontend benefit (the 4 deferred items
// outside HEEx are all framework-private rendering details, not
// shared lowering decisions).  Honours the retro's "backends stay
// idiomatic" principle: shared semantics live in the IR + walker
// core; framework-flavoured emission stays in framework-flavoured
// code.
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR, TypeIR } from "../../ir/types/loom-ir.js";

/** Discriminator: where in the emitted module the walker is currently
 *  rendering.  Drives state-reference syntax — HEEx differentiates
 *  template position (`@step`) from handler position
 *  (`socket.assigns.step`).  TSX renders identically in both. */
export type RenderPosition = "template" | "handler";

/** A state field reference — produced by the walker when it
 *  encounters a `LooseName` resolving to a state field declared in
 *  the enclosing `state { ... }` block. */
export interface StateRef {
  field: StateFieldIR;
  /** Local name as written in source (matches `field.name`). */
  name: string;
}

/** A single API call site detected by the walker — the
 *  `Sales.Customer.create.mutate(args)` shape.  Carries the
 *  resolved api-handle / aggregate / op so the target can produce
 *  framework-correct output:
 *    TSX: hoist `useCreateCustomer()` at page top, rewrite call to
 *         `customerCreate.mutate(args)`.
 *    HEEx: emit `MyApp.Sales.create_customer!(args)` inline; no
 *          hoisting — LiveView reads in `mount/3` / `handle_event`. */
export interface ApiCallSite {
  /** The local UI api parameter name (e.g. "Sales"). */
  apiHandle: string;
  /** The aggregate accessed off the api handle (e.g. "Customer"). */
  aggregateName: string;
  /** The operation invoked (`create` / `update` / `delete` / `all`
   *  / `byId` / a custom finder name). */
  operation: string;
  /** Whether this is a read (`all`/`byId`/finder) or a mutation
   *  (`create`/`update`/`delete`/operation).  Drives hook choice. */
  kind: "query" | "mutation";
  /** Argument expressions, in source order.  Empty for `.all`. */
  args: ExprIR[];
  /** Pre-resolved hook variable name — when present, the target's
   *  hoisting uses this verbatim instead of recomputing from
   *  aggregate+op.  Required for shapes the formula can't capture
   *  (e.g. View hooks: `<viewCamel>View` is not aggregate-shaped). */
  varName?: string;
  /** Pre-resolved hook function name — same escape hatch as varName. */
  hookName?: string;
  /** Pre-rendered argument strings (the walker had a WalkContext at
   *  the time the args were detected; the target consumes the
   *  rendered list directly so refs to params/state propagate
   *  through the walker's `usedParams` / `usesState` side-effects). */
  argsRendered?: readonly string[];
}

/** Per-target lowering interface.  An implementation is selected by
 *  the deployable's framework: `tsxTarget` for `react`/`static`,
 *  `heexTarget` for `phoenixLiveView`. */
export interface WalkerTarget {
  /** Framework discriminator — informational; matches the IR's
   *  `DeployableIR.uiFramework` value (`"react"` / `"phoenixLiveView"`). */
  readonly framework: string;

  // --- State seam ---------------------------------------------------------

  /** Render a read of `state.<field>` at the given position.  TSX
   *  returns `step`; HEEx returns `@step` (template) or
   *  `socket.assigns.step` (handler). */
  renderStateRead(ref: StateRef, position: RenderPosition): string;

  /** Render a write to `state.<field>` from a `state.field := <expr>`
   *  statement encountered inside a block-body lambda.  TSX returns
   *  the React setter call (`setStep(value)`); HEEx returns the
   *  `assign(socket, :step, value)` form.  `value` is already
   *  rendered via `renderExpression`. */
  renderStateWrite(ref: StateRef, value: string): string;

  /** Render the initial-value expression for a state field's `mount`
   *  / `useState` initialiser.  `init` is the lowered IR or undefined
   *  (caller falls back to the type-default). */
  renderStateInit(field: StateFieldIR, init: ExprIR | undefined): string;

  // --- API binding seam ---------------------------------------------------

  /** Render an API call site as the framework's primary surface.
   *  The two shipped frameworks diverge structurally by design:
   *
   *  TSX rewrites the IR call site to the local hook variable
   *  (`customerCreate`).  React Query's `useXxx()` is hoisted ONCE
   *  per component (see `renderApiHoisting`); the resulting var is
   *  what every call site references.  The surrounding IR walk
   *  emits any chained property access (`.data` / `.mutate(args)` /
   *  `.isPending`) via standard member / method-call rendering —
   *  the contract returns only the var because that's the IR-node-
   *  level emission.
   *
   *  HEEx emits the direct Ash code-interface call
   *  (`create_customer!(args)`).  LiveView doesn't hoist; every IR
   *  site invokes the function in-place.  The walker prepends the
   *  `<App>.<Handle>.` module prefix at the call site after
   *  delegating to the target — the bare call shape is the target's
   *  output.
   *
   *  Caller passes pre-rendered args as a single string; target
   *  splices them into framework-appropriate positions.  When TSX
   *  ignores `renderedArgs` (var-only) the parameter is harmless. */
  renderApiCall(call: ApiCallSite, renderedArgs: string): string;

  /** Per-page hoisted bindings — TSX returns the React Query hook
   *  call lines (`const customerCreate = useCreateCustomer();`)
   *  emitted at page-component top; HEEx returns an empty array
   *  (LiveView reads inside `mount/3` / `handle_event`).  Called
   *  once per page after the body walk completes. */
  renderApiHoisting(uses: ApiCallSite[]): string[];

  // --- Helper-import seam -------------------------------------------------

  /** Produce the per-page import block for user `import helper X
   *  from "..."` declarations actually referenced by the page body.
   *  TSX returns JS `import { fn } from "path"` lines; HEEx returns
   *  Elixir `alias Path.To.Module` / `import Path.To.Module` lines.
   *  `decls` is the UI-level import declarations; `used` is the
   *  subset the walker actually encountered. */
  renderHelperImports(
    used: ReadonlySet<string>,
    decls: ReadonlyArray<{ name: string; path: string }>,
  ): string[];

  // --- Match expression seam ----------------------------------------------

  /** Render a `match { arm => expr, ..., else => expr }` expression.
   *  `arms` are pre-rendered (predicate + value strings); `elseArm`
   *  is the `else` branch's pre-rendered value, or undefined.
   *  TSX returns chained ternary (`a ? b : c ? d : fallback`);
   *  HEEx returns a `<%= cond do … end %>` block. */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
  ): string;

  // --- Navigation seam ----------------------------------------------------

  /** Render a cross-page navigation call — `navigate(<TargetPage>,
   *  { ...args })` from a block-body lambda.  TSX returns
   *  `navigate("/path", { state: args })`; HEEx returns
   *  `push_navigate(socket, to: ~p"/path")` with args interpolated
   *  into the route.  `routeTemplate` is the target page's route
   *  with `:param` placeholders; `args` is the rendered argument
   *  map.
   *
   *  `stateExpr` is an escape hatch for the case where the source's
   *  second `navigate(...)` arg is not an object literal that
   *  decomposes cleanly into `{name, value}` pairs (e.g.
   *  `navigate(Page, someRef)` where `someRef` resolves to a
   *  pre-built state object).  When supplied, the target embeds
   *  the pre-rendered expression directly and IGNORES `args` —
   *  TSX emits `navigate("/path", { state: <stateExpr> })`; HEEx
   *  falls back to the args-empty `push_navigate` (Phoenix routes
   *  can't interpolate an arbitrary expression into a `~p` sigil). */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    stateExpr?: string,
  ): string;

  // --- Type-default seam --------------------------------------------------

  /** Default initial value for a state field whose declaration omits
   *  `= <init>`.  TSX returns JS literals (`0`, `""`, `false`, `null`,
   *  `[]`, `{}`); HEEx returns Elixir literals (`0`, `""`, `false`,
   *  `nil`, `[]`, `%{}`). */
  defaultInitFor(type: TypeIR): string;
}
