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
//   3. API call lowering — Slice 11.24's React-Query hook hoisting
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
// PHASE 5 STATUS: this module DEFINES the contract.  The TSX walker
// (src/generator/react/body-walker.ts) currently inlines its own
// implementations of these seams — the byte-identical-output gate
// keeps that path unchanged.  Subsequent phases:
//
//   - Phase 7 implements `heexTarget` for Phoenix LiveView module
//     emission, which validates this interface against a real second
//     consumer before the React walker is refactored to delegate to
//     `tsxTarget`.
//   - A follow-up cleanup (post Phase 7) extracts the React walker's
//     inline seams into `tsxTarget` and switches `body-walker.ts` to
//     consume the abstract `WalkerTarget`.  Acceptance gate is still
//     byte-identical TSX output against the existing fixture suite.
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR, TypeIR } from "../../ir/loom-ir.js";

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

/** A single API call site detected by the walker — Slice 11.24's
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

  /** Render an API call site detected during walk.  TSX rewrites to
   *  the local hook variable (`customerCreate.mutate(...)`); HEEx
   *  emits the direct context-function call
   *  (`MyApp.Sales.create_customer!(...)`). */
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
  renderHelperImports(used: ReadonlySet<string>, decls: ReadonlyArray<{ name: string; path: string }>): string[];

  // --- Match expression seam ----------------------------------------------

  /** Render a `match { arm => expr, ..., else => expr }` expression.
   *  `arms` are pre-rendered (predicate + value strings); `elseArm`
   *  is the `else` branch's pre-rendered value, or undefined.
   *  TSX returns chained ternary (`a ? b : c ? d : fallback`);
   *  HEEx returns a `<%= cond do … end %>` block. */
  renderMatch(arms: ReadonlyArray<{ predicate: string; value: string }>, elseArm: string | undefined): string;

  // --- Navigation seam ----------------------------------------------------

  /** Render a cross-page navigation call — `navigate(<TargetPage>,
   *  { ...args })` from a block-body lambda.  TSX returns
   *  `navigate("/path", { state: args })`; HEEx returns
   *  `push_navigate(socket, to: ~p"/path")` with args interpolated
   *  into the route.  `routeTemplate` is the target page's route
   *  with `:param` placeholders; `args` is the rendered argument
   *  map. */
  renderNavigate(routeTemplate: string, args: ReadonlyArray<{ name: string; value: string }>): string;

  // --- Type-default seam --------------------------------------------------

  /** Default initial value for a state field whose declaration omits
   *  `= <init>`.  TSX returns JS literals (`0`, `""`, `false`, `null`,
   *  `[]`, `{}`); HEEx returns Elixir literals (`0`, `""`, `false`,
   *  `nil`, `[]`, `%{}`). */
  defaultInitFor(type: TypeIR): string;
}
