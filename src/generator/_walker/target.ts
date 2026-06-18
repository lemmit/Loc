// ---------------------------------------------------------------------------
// Walker target contract — framework-specific lowering seams.
//
// The body walker traverses Loom's expression IR (closed primitive
// library: Stack/Toolbar/Table/QueryView/CreateForm/match/...,
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
//   - `src/generator/elixir/heex-target.ts`      → `heexTarget`
//
// Both validate the interface end-to-end through the cross-target
// conformance test.  The walkers (`body-walker.ts` for React,
// `heex-walker.ts` for Phoenix) inline their seam implementations
// directly; extracting them behind these targets is gated on the
// byte-identical fixture suite (React) and
// `mix compile --warnings-as-errors` (Phoenix).
//
// SCOPE DECISION (13 methods: the 9 lowering seams + 4 markup
// seams).  The contract covers the CROSS-FRAMEWORK seams a new
// frontend (Vue / Svelte / Blazor) must implement to reuse the
// shared walker core.  The markup seams (renderComment /
// renderConditionalChild / renderStyleAttr / escapeText) joined for
// the Svelte port: Svelte 5 shares JSX's `{expr}` interpolation and
// `<Comp x={y}/>` invocation syntax (those stay hardcoded in the
// shared walker), but diverges on comments (`<!-- -->` vs
// `{/* */}`), conditional CHILD rendering (`{#if}` blocks vs
// ternaries returning markup), the style attribute (CSS string vs
// JSX object), and text escaping.  Out of scope deliberately:
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
import type { DetectedApiCall } from "./api-hook-detector.js";

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

/** A framework-specific hook-use record produced by
 *  `WalkerTarget.buildHookUse`.  Carries the names + import path the
 *  page-shell needs to hoist the hook (TSX: a `const x = useY(args)`
 *  line; future Vue: a Pinia composable invocation; future Svelte: a
 *  runes-flavoured `$state` derivation).  HEEx doesn't lower api
 *  calls to hooks so its `buildHookUse` is unreachable in practice
 *  (the heex-walker never calls `tryDetectApiHook`); the interface
 *  shape stays uniform so a future LiveView-class consumer can
 *  decide its own answer without adding a contract slot. */
export interface TargetHookUse {
  /** Local variable name in the generated file
   *  (e.g. `customerCreate`, `activeOrdersView`). */
  varName: string;
  /** Hook function name to import + call
   *  (e.g. `useCreateCustomer`, `useActiveOrdersView`). */
  hookName: string;
  /** Module-relative import path
   *  (e.g. `../api/customer`, `../api/views`). */
  importFrom: string;
  /** Pre-rendered argument strings for parameterised hooks
   *  (`useCustomerById(id)`).  Empty for paramless reads. */
  argsRendered: readonly string[];
  /** True for a parameterised `find` query (object-shaped filter arg).
   *  Reactive-framework targets (Vue) wrap the arg in a getter so the
   *  query live-refetches when a bound filter input changes; React
   *  ignores it (re-render passes fresh args every render). */
  reactiveQuery?: boolean;
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

  // --- API binding seam ---------------------------------------------------

  /** Turn a framework-agnostic `DetectedApiCall` (produced by the
   *  shared `tryDetectApiHook` detector in
   *  `src/generator/_walker/api-hook-detector.ts`) into the per-
   *  framework hook-use record.  TSX produces React-Query naming
   *  (`useCreateCustomer` + `../api/customer` import); a future Vue
   *  target produces Pinia / composable naming; HEEx's
   *  implementation is unreachable in practice (the heex-walker
   *  never calls the detector) and throws.
   *
   *  `renderArg` is the caller's walker-context-aware expression
   *  renderer — preserved as a callback so any param/state refs
   *  inside parameterised-query args (`Customer.byId(id)`) propagate
   *  to the walker's `usedParams` / `usesState` side-effects.
   *  Identity-equal to `emitExpr(_, ctx)` at the caller's WalkContext.
   *  The target invokes it on each entry of `detected.args` in
   *  source order. */
  buildHookUse(detected: DetectedApiCall, renderArg: (e: ExprIR) => string): TargetHookUse;

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

  /** Render a `match` whose arms are MARKUP (child position — the
   *  page-metamodel §7 predicate-arms conditional).  TSX wraps the
   *  flat `renderMatch` ternary chain in braces at depth > 0; Vue
   *  renders a structural `<template v-if>` / `v-else-if` / `v-else`
   *  chain (template expressions cannot evaluate to markup); HEEx's
   *  parallel walker never reaches this. */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    depth: number,
  ): string;

  // --- List-comprehension seam --------------------------------------------

  /** Render a `For { each: <coll>, <item> => <markup> }` list
   *  comprehension in markup-child position.  This is the structural
   *  iteration seam — distinct from the DOMAIN collection ops
   *  (`xs.map(...)` / `xs.sum(...)`) the walker leaves to each
   *  backend's expression renderer; here the per-item lambda body is
   *  MARKUP, so the output topology is framework-shaped exactly like
   *  `renderMatchChild` / `renderConditionalChild`.
   *
   *    TSX:    `coll.map((item, idx) => (<Fragment key={key}>body</Fragment>))`
   *            — brace-wrapped below depth 0 (JSX-child syntax); the
   *            keyed Fragment satisfies `useJsxKeyInIterable` without
   *            wrapping a DOM node, and the caller flags `usesFragment`
   *            so the shell imports `Fragment`.
   *    Vue:    `<template v-for="(item, idx) in coll" :key="key">body</template>`.
   *    Svelte: `{#each coll as item, idx (key)}body{/each}`.
   *
   *  `coll` / `keyExpr` are pre-rendered JS expressions; `itemVar` is
   *  the emitted iteration identifier (the source lambda param);
   *  `indexVar` is the synthesised index identifier — emit it as a
   *  loop binding ONLY when `keyExpr` or `body` references it (unused
   *  bindings trip `noUnusedFunctionParameters` / framework warnings).
   *  `depth` drives indentation and (TSX) the brace wrap. */
  renderForEach(
    coll: string,
    itemVar: string,
    indexVar: string,
    keyExpr: string,
    body: string,
    depth: number,
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

  // --- Markup seams ---------------------------------------------------------
  //
  // The shared markup walker (src/generator/_walker — the walker the
  // TSX and Svelte frontends share) emits framework markup through
  // pack templates plus a few inline forms.  Most inline forms are
  // identical across JSX-family frameworks (`{expr}` interpolation,
  // `<Comp x={y}/>`, `data-testid={expr}`) and stay hardcoded; the
  // four below diverge.  HEEx has its own parallel walker
  // (heex-walker.ts) that never reaches these — its impls exist for
  // contract completeness (renderConditionalChild throws unreachable,
  // mirroring buildHookUse).

  /** Render an inline placeholder/diagnostic comment in markup-child
   *  position.  TSX: `{/* text *​/}`; Svelte: `<!-- text -->`;
   *  HEEx: `<%!-- text --%>`. */
  renderComment(text: string): string;

  /** Render a JS expression in markup TEXT/child position — the
   *  framework's inline interpolation.  TSX and Svelte share JSX's
   *  `{expr}`; Vue uses the mustache `\{\{ expr \}\}`; HEEx's own
   *  walker never reaches this (modern HEEx `{expr}` returned for
   *  contract completeness).  The expression is already rendered
   *  JS — the target only supplies the delimiters. */
  renderInterpolation(jsExpr: string): string;

  /** Render a DYNAMIC attribute bound to a JS expression, leading
   *  space included (` name={expr}` on TSX/Svelte; ` :name="expr"`
   *  on Vue — Vue quotes the expression, so the target picks a
   *  quote character the rendered JS doesn't collide with).
   *  Static string-literal attributes don't come through here —
   *  every framework spells those ` name="value"` and the call
   *  sites keep them inline. */
  renderAttrBinding(name: string, jsExpr: string): string;

  /** Render a conditional CHILD — a ternary whose arms are markup
   *  (`body: cond ? Stack(…) : Empty(…)`).  `cond` is a rendered JS
   *  expression; `thenS` / `elseS` are rendered markup fragments.
   *  `depth` is the walk depth (drives indentation and, for TSX,
   *  whether the ternary needs a brace wrap — depth 0 sits inside the
   *  component's `return (…)` parens).  TSX returns the
   *  parenthesised ternary; Svelte returns an `{#if}{:else}{/if}`
   *  block (Svelte template expressions cannot evaluate to markup). */
  renderConditionalChild(cond: string, thenS: string, elseS: string, depth: number): string;

  /** Render the `style: { … }` named arg as a markup attribute
   *  fragment (leading space included; empty string for no entries).
   *  Each entry carries the source CSS key plus the rendered value
   *  expression (`rendered`) and, when the source value was a string
   *  literal, its raw text (`literal`).  TSX camel-cases keys into a
   *  JSX object (` style={{ backgroundColor: v }}`); Svelte emits a
   *  CSS string with `{expr}` interpolation; HEEx emits the flat
   *  quoted CSS string (lifted from the old styleAttrHeex helper). */
  renderStyleAttr(
    entries: ReadonlyArray<{ key: string; rendered: string; literal?: string }>,
  ): string;

  /** Escape raw text for markup TEXT position.  TSX escapes JSX's
   *  significant punctuation (`&`, `{`, `}`, `<`, `>`) as HTML
   *  entities; Svelte's template grammar shares the same significant
   *  set, so the entity escape carries over; HEEx escapes its own. */
  escapeText(text: string): string;

  /** OPTIONAL — page-side import lines the form runtime needs.
   *  Omitted targets fall back to the react-hook-form import set
   *  (TSX's `useForm` / `Controller`); Svelte returns `[]` — the
   *  runes `createForm` import rides the pack templates. */
  formRuntimeImports?(
    useController: boolean,
  ): ReadonlyArray<{ from: string; named: readonly string[] }>;

  /** OPTIONAL — children-slot spelling for the `Slot()` primitive.
   *  Omitted targets fall back to the JSX `{children}` idiom (TSX,
   *  Vue's render path); Svelte 5 overrides with
   *  `{@render children?.()}` (snippets aren't interpolatable). */
  renderChildrenSlot?(): string;
}
