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
// implements.  v1 wires the React (TSX) walker through `tsxTarget`
// and the Phoenix LiveView (HEEx) walker through `heexTarget`.  Each
// walker threads its target through its own `WalkContext` and the
// inline seams now delegate to a method on the target — adding a
// third backend would mean writing a new target, not a new walker.
//
// Note on coupling: a few seams are inherently shaped by the host
// walker's argument shapes (e.g. TSX navigate is invoked from
// inside `Action.then`, where the `navigate` call's args have
// already been emitted by `emitExpr`).  Where that's the case the
// target method takes the pre-rendered string fragments rather
// than re-rendering — keeps the seam interface platform-neutral
// without forcing each walker's emission order onto the contract.
// ---------------------------------------------------------------------------

import type { StateFieldIR, TypeIR } from "../../ir/loom-ir.js";

/** Discriminator: where in the emitted module the walker is currently
 *  rendering.  Drives state-reference syntax — HEEx differentiates
 *  template position (`@step`) from handler position
 *  (`socket.assigns.step`).  TSX renders identically in both. */
export type RenderPosition = "template" | "handler";

/** Per-target lowering interface.  An implementation is selected by
 *  the deployable's framework: `tsxTarget` for `react`/`static`,
 *  `heexTarget` for `phoenixLiveView`. */
export interface WalkerTarget {
  /** Framework discriminator — informational; matches the IR's
   *  `DeployableIR.uiFramework` value (`"react"` / `"phoenixLiveView"`). */
  readonly framework: string;

  // --- State seam ---------------------------------------------------------

  /** Render a read of `state.<field>` (or a page state field referenced
   *  bare) at the given position.  TSX returns `step` regardless of
   *  position; HEEx returns `@step` (template) or `socket.assigns.step`
   *  (handler).  Returns the identifier only — the caller adds JSX
   *  braces / HEEx `<%= … %>` wrappers based on context.
   *
   *  `name` is the source-side field name as written; targets snake-
   *  case as appropriate. */
  stateRead(name: string, position: RenderPosition): string;

  /** Render a `state.<field> := <value>` statement, where `value` is
   *  already rendered to the target's expression syntax by the
   *  caller (TSX: `value + 1`; HEEx: `value + 1`).  Returns a single
   *  statement with the target's terminator (`;` for TSX, none for
   *  HEEx — the HEEx walker pipes it as `|> assign(:x, v)`). */
  stateWrite(name: string, value: string): string;

  /** Render a compound state update — `state.<field> += <value>` or
   *  `state.<field> -= <value>` (op is `"+"` or `"-"`).  TSX returns
   *  `setX(name + v);` (the value is the right-hand side, not the new
   *  field value); HEEx returns the pipe analogue. */
  stateCompoundWrite(name: string, op: "+" | "-", value: string): string;

  // --- Navigation seam ----------------------------------------------------

  /** Render a cross-page navigation call.  `route` is the target page's
   *  route path (with `:param` placeholders for HEEx route sigils, or
   *  a literal `"/path"` for TSX).  `state` is the already-rendered
   *  state-argument expression (TSX: a JS object literal; HEEx ignores
   *  this), or undefined for a no-state navigation.  Returns the JS /
   *  Elixir call expression — `navigate("/page", { state: x })` for
   *  TSX, `push_navigate(socket, to: ~p"/page")` for HEEx.
   *
   *  Called from inside `Action.then: navigate(<Page>, …)` and from
   *  `Button(to: …)` lowering. */
  renderNavigate(route: string, state: string | undefined): string;

  // --- Match expression seam ----------------------------------------------

  /** Render a `match { p => v, …, else => f }` expression.  `arms` is
   *  the pre-rendered predicate/value pairs in source order; `elseArm`
   *  is the rendered `else` value, or undefined.  TSX returns a
   *  chained ternary (`a ? b : c ? d : fallback`); HEEx returns a
   *  `cond do … end` block — the caller wraps in `<%= … %>` if it's
   *  in template position. */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    position: RenderPosition,
  ): string;

  // --- Type-default seam --------------------------------------------------

  /** Default initial value for a state field whose declaration omits
   *  `= <init>`.  TSX returns JS literals (`0`, `""`, `false`, `null`,
   *  `[]`, `{}`); HEEx returns Elixir literals (`0`, `""`, `false`,
   *  `nil`, `[]`, `%{}`).
   *
   *  Currently only consumed by HEEx — the TSX walker reads through
   *  its own `defaultInitForField` in `walker/page-shell.ts` (the
   *  emit path also needs the TS-type form, which is a different
   *  concern).  Kept on the interface so future TSX consumers can
   *  delegate. */
  defaultInitFor(type: TypeIR): string;

  // --- State field default-init expression seam ---------------------------
  // Reserved for a future cleanup: today's TSX walker also needs the
  // TypeIR → TS-type form (`useState<T>(…)`).  That seam is not platform-
  // neutral enough to live on WalkerTarget without dragging TS-isms
  // (decimal → "Decimal", money → "Decimal", X id → "string") into the
  // contract.  See `walker/page-shell.ts::typeRefAsTsString` for the
  // current implementation.
}

// ---------------------------------------------------------------------------
// Deferred seams (documented; not promoted to WalkerTarget yet)
// ---------------------------------------------------------------------------
//
// A handful of seams *could* be expressed via WalkerTarget but each
// would force one of the two walkers into a less-natural shape; the
// payoff doesn't justify the cost yet:
//
// - API call lowering.  TSX detects `<param>.<aggregate>.<op>(args?)`
//   structurally inside `tryDetectApiHook` (api-hooks.ts) and rewrites
//   to a local hook variable, recording metadata on the walker's `Sink`
//   so the page shell emits per-page hook decls + imports.  HEEx
//   detects the same shape inside `renderMethodCall` and emits the
//   direct context-function call inline (no hook hoisting because
//   LiveView reads inside `mount/3` / `handle_event`).  The structures
//   differ enough that any WalkerTarget seam here would just be a thin
//   wrapper around each walker's detector — no clear win.
//
// - Helper imports.  Both walkers collect a `usedHelpers` set during
//   the walk and render `import { name } from "path"` (TSX) / `alias
//   Mod, as: Name` (HEEx) lines AFTER the walk completes — those
//   renderers (`renderHelperImports` in walker/import-lines.ts and
//   `elixirAliasForHelper` in heex-walker.ts) live outside the walk
//   loop and are invoked from different post-walk paths.  A
//   `renderHelperImports` seam on WalkerTarget would require
//   restructuring the shell-emission path; the current setup already
//   uses target-specific renderers cleanly.
//
// Both deferred seams stay inline; the WalkerTarget contract focuses
// on the state/navigation/match seams that share a true call-shape
// across both walkers.

