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

import type { ExprIR, LiteralKind, StateFieldIR, StoreIR, TypeIR } from "../../ir/types/loom-ir.js";
import type { DetectedApiCall } from "./api-hook-detector.js";
import type { WalkContext } from "./walker-core.js";

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

/** The data a target needs to render a sortable `Table` column header
 *  (M-T1.1 — the `renderSortableHeader` seam). */
export interface SortableHeaderSpec {
  /** Already-escaped header content (the column's display label). */
  header: string;
  /** Row property this column sorts by (`"name"`, `"id"`, …). */
  field: string;
  /** Page-state field holding the active sort column. */
  sortKey: StateRef;
  /** Page-state field holding the active direction (`"asc"` / `"desc"`). */
  sortDir: StateRef;
}

/** The data a target needs to render a pager control below a paged `Table`
 *  (M-T1.1 / M-T2.6 — the `renderPager` seam). */
export interface PagerSpec {
  /** Page-state field holding the current 1-based page number. */
  page: StateRef;
  /** Already-rendered expression for the total page COUNT — drives the
   *  "Page N of M" label and disables "Next" on the last page (`page >= M`).
   *  Client mode passes `Math.max(1, Math.ceil(rows.length / pageSize))`;
   *  server mode passes the envelope's `totalPages`.  Always ≥ 1. */
  totalPagesExpr: string;
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

/** One discriminant arm of a `variant-match` (async-actions-and-effects.md
 *  Stage 2).  The shared walker-core pre-renders each arm's body and resolves
 *  its wire tag; the target only assembles the framework-shaped `case`. */
export interface VariantMatchArm {
  /** The variant's wire discriminator (`variantTag(varType)`) — the value the
   *  discriminant `switch (result.type)` matches on (`"Order"`, `"Failed"`). */
  tag: string;
  /** The narrowed local the arm binds to the matched result
   *  (`Placed o => …` → `o`), or undefined for an unbound arm.  React emits
   *  `const <binding> = result;` at the top of the `case`. */
  binding?: string;
  /** The arm's already-rendered body statements (each `;`-terminated, via the
   *  shared `emitStmt` — state writes / navigate / …). */
  body: readonly string[];
}

/** Everything the shared walker-core resolves for a `variant-match` StmtIR —
 *  the async envelope + discriminant `switch` a frontend action body needs to
 *  handle the `or`-union Result of an awaited remote op
 *  (async-actions-and-effects.md Stage 2).  The framework-neutral work
 *  (detecting the awaited subject's mutation hook, classifying the error
 *  variant, pre-rendering every arm body) lives in walker-core; the target
 *  supplies only the framework-shaped skeleton. */
export interface VariantMatchSpec {
  /** The hoisted mutation-hook local (`orderPlaceOrder`) whose `mutateAsync`
   *  runs the awaited op.  walker-core registered it for hoisting; empty string
   *  when the subject was not a detected remote mutation (the target then has
   *  no mutation to await — a degenerate case it may render as a comment). */
  mutationVar: string;
  /** Already-rendered arguments spliced into `<mutationVar>.mutateAsync(<args>)`
   *  — the op's request payload built from the awaited call's args (or `{}`). */
  mutateArgs: string;
  /** The op's `or`-union response type name (`PlaceOrderOrderResponse`) — the
   *  discriminated union the frontend api-module emits, which the page-shell has
   *  been told to import.  A statically-typed target (TSX) annotates `result`
   *  with it so the `switch` narrows each arm cleanly; undefined when the
   *  subject wasn't a resolvable remote op (the target types `result` loosely). */
  resultType?: string;
  /** The discriminant arms, in source order. */
  arms: readonly VariantMatchArm[];
  /** The union's error variants, in source order — each `{ tag, uri }` pairing a
   *  wire tag with the RFC-7807 ProblemDetails `type` URI the backend stamps for
   *  it.  Present (length ≥ 1) ⇒ the target reifies a caught `ApiError` back into
   *  the variant: with one error it re-stamps the known tag; with N it maps the
   *  caught `type` URI to the matching tag (the tag is clobbered to the URI on the
   *  wire, but the fields survive).  Empty/undefined ⇒ no error variant, nothing
   *  to reify (the try/catch is omitted). */
  errorVariants?: readonly { tag: string; uri: string }[];
  /** Pre-rendered `else`-arm body statements (the `match … { … else => … }`
   *  fallthrough), or undefined when the source had no `else`. */
  elseBody?: readonly string[];
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

  /** Render a `currentUser.<claim>` access in a body expression (D-AUTH-OIDC,
   *  the read-side of the auth gate) — the whole member access, since the
   *  session user may be loosely / optionally bound.  Optional: a target that
   *  leaves it undefined falls through to the plain member emit (the JSX
   *  frontends today, whose session user is a shell-bound `currentUser` local —
   *  handled there rather than here).  Feliz binds the decoded claims on the
   *  Model (`model.CurrentUser : CurrentUser option`), so it renders an
   *  option-match against the pascal-cased record field.  `memberType` is the
   *  claim's declared type (for the None-branch zero value). */
  renderCurrentUserAccess?(field: string, memberType: TypeIR): string;

  /** Render a write to `state.<field>` from a `state.field := <expr>`
   *  statement encountered inside a block-body lambda.  TSX returns
   *  the React setter call (`setStep(value)`); HEEx returns the
   *  `assign(socket, :step, value)` form.  `value` is already
   *  rendered via `renderExpression`. */
  renderStateWrite(ref: StateRef, value: string): string;

  /** Render a write to a MULTI-SEGMENT state target (`order.shipping.zip
   *  := v`, `cart.items += x`).  `segments` is the full dotted path (its
   *  root is a `state` field); `valueJs` is the already-rendered RHS.
   *  React state is immutable, so TSX builds a nested-spread update +
   *  setter (`setOrder({ ...order, shipping: { ...order.shipping, zip: v }})`);
   *  Vue refs and Svelte `$state` are mutated in place
   *  (`order.shipping.zip = v`).  Single-segment writes go through
   *  `renderStateWrite`; HEEx renders state through its own engine and
   *  never reaches this seam. */
  renderNestedStateWrite(segments: readonly string[], valueJs: string): string;

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
   *  HEEx emits the direct context-function call
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
   *  `depth` drives indentation and (TSX) the brace wrap.
   *
   *  `emptyBody` (the optional `empty:` arm, pre-rendered markup) is the
   *  fallback when `coll` is empty.  When omitted the output is
   *  byte-identical to the un-`empty:` form; when present each target
   *  reaches for its native idiom — Svelte's `{:else}`, a TSX
   *  `coll.length === 0 ? (emptyBody) : (.map(…))` ternary, a Vue
   *  `v-if="!coll.length"` sibling `<template>`.  (HEEx renders `For`
   *  through its own engine, not this seam.) */
  renderForEach(
    coll: string,
    itemVar: string,
    indexVar: string,
    keyExpr: string,
    body: string,
    depth: number,
    emptyBody?: string,
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
   *  JS — the target only supplies the delimiters.
   *
   *  `exprType` is supplied only when the value is *provably* a given
   *  type from its own structure (via `provableStringType`).  The
   *  JSX-family targets ignore it (interpolation auto-coerces to text);
   *  Feliz reads it to drop a redundant `string (…)` coercion when the
   *  value is already a `string` (`Html.text` needs a string, so
   *  non-string leaves keep the wrap).  Optional — an omitted/unknown
   *  type means "coerce". */
  renderInterpolation(jsExpr: string, exprType?: TypeIR): string;

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

  /** OPTIONAL — assemble a lambda event-handler body (a `Button`'s
   *  `onClick:` etc.) from its already-rendered pieces.  The JSX-family
   *  frameworks (TSX / Vue / Svelte) bind a function VALUE in event
   *  position — `onClick={() => { … }}` / `@click="() => { … }"` — so
   *  the omitted default returns the arrow form.  Angular `(click)`
   *  binds a STATEMENT, not a function (an arrow there is created and
   *  immediately discarded — a silent no-op), so its target inlines the
   *  statements (`count.set(count() + 1)`).  `statements` is the
   *  block-body form (each entry already `;`-terminated); `expr` the
   *  expression-body form; both undefined means an empty handler. */
  renderEventHandler?(statements: readonly string[] | undefined, expr: string | undefined): string;

  /** OPTIONAL — how a QueryView read handle's data is dereferenced.  The
   *  shared QueryView walker binds the `data:` lambda param to the handle's
   *  data (`<handle>.data`), the TanStack-result shape the TSX/Vue/Svelte
   *  packs read directly — so the omitted default returns `${handle}.data`.
   *  Angular's read handle exposes `data` as a SIGNAL, so its target returns
   *  `${handle}.data()` (signals are called to read).  The QueryView template
   *  itself owns the `isLoading` / `isError` reads; this seam is only the
   *  data-lambda binding the walker injects.  `single` is set for byId reads
   *  (`T | null` data) so a target can non-null-assert inside the truthy
   *  guard — Angular's template typechecker won't narrow a `data()` call.
   *  `autoPaged` marks a hand-written QueryView over a paged `.all` that
   *  wasn't opted into `paged:` — the target unwraps to the `.items` array so
   *  the body keeps bare-array semantics (Feliz already decodes to a list, so
   *  it ignores the flag). */
  renderQueryDataAccess?(
    handle: string,
    single?: boolean,
    paged?: boolean,
    autoPaged?: boolean,
  ): string;

  /** OPTIONAL — set when the target decodes a paged `.all` straight to a
   *  list (Feliz: the Elmish decoder pulls `items` out of the envelope, so
   *  the Model holds a `'T list`).  The scaffold's `rows.items` unwrap is then
   *  a no-op — the shared member walk strips it.  Omitted (falsy) on every
   *  JSX target, which keeps the `Paged<T>` envelope and reads `.items`. */
  pagedDataIsList?: boolean;

  /** OPTIONAL — the in-scope accessor for the magic route `id` identifier
   *  (`{ kind: "id" }`, e.g. `Order.byId(id)` on a `/orders/:id` page).  The
   *  shared `emitExpr` sets `ctx.usesRouteId` and returns this; the page-shell
   *  binds a matching local `id` from the route param (`useParams` /
   *  `route.params` / `$page.params` / the Angular `ActivatedRoute` snapshot).
   *  A target that omits it leaves the old `unsupported expr` placeholder. */
  renderRouteId?(): string;

  /** OPTIONAL — whole-primitive override for `CreateForm(of: <Agg>)`.  The
   *  shared `emitCreateForm` delegates here first; a non-null return is used
   *  verbatim and the RHF/react-query `emitFormOfAggregate` path is skipped.
   *  Angular forks here to emit idiomatic typed Reactive Forms (a
   *  `[formGroup]`/`(ngSubmit)` shell) and records its `FormGroup` + submit
   *  wiring on `ctx.angularForms` for the page-shell; the other frameworks
   *  omit it and keep the shared react-hook-form pipeline. */
  renderCreateForm?(call: ExprIR, ctx: WalkContext, depth: number): string | null;

  /** OPTIONAL — whole-primitive override for `Action(inst.op)`.  The shared
   *  `emitAction` delegates here first; a non-null return is used verbatim and
   *  the default (React-shaped `() => void <hook>.mutateAsync({})`) is skipped.
   *  Angular renders an inline `(click)="<var>.mutate(<id>, {})"` button and
   *  records the `use<Op><Agg>()` hoist on `ctx.angularActions`; returning null
   *  (e.g. a `then:` effect it can't express inline) falls back to the shared
   *  path, which records an `actionMutations` entry and stubs the page. */
  renderAction?(call: ExprIR, ctx: WalkContext, depth: number): string | null;

  /** OPTIONAL — whole-primitive override for `OperationForm(...)` and `Modal {
   *  … }`.  The shared `emitOperationForm` / `emitModal` delegate here first; a
   *  non-null return is used verbatim and the RHF/`field-input-*` path is
   *  skipped.  Angular forks both to idiomatic typed Reactive Forms — a
   *  standalone `OperationForm` renders an always-visible `[formGroup]` shell,
   *  and `Modal { OperationForm(…) }` renders a signal-toggled inline form —
   *  so neither dispatches a `field-input-*` template the inline-forms pack
   *  doesn't ship. */
  renderOperationForm?(call: ExprIR, ctx: WalkContext, depth: number): string | null;
  renderModal?(call: ExprIR, ctx: WalkContext, depth: number): string | null;

  /** OPTIONAL — whole-primitive override for `WorkflowForm(runs: <Wf>)`.  The
   *  shared `emitWorkflowForm` delegates here first; a non-null return is used
   *  verbatim and the RHF `emitFormRuns` path (which records a `formOfs` sink)
   *  is skipped.  Angular forks here to emit a typed Reactive Form posting the
   *  workflow command (`use<Wf>Workflow`) and records its `FormGroup` + submit
   *  wiring on `ctx.angularForms` for the page-shell. */
  renderWorkflowForm?(call: ExprIR, ctx: WalkContext, depth: number): string | null;

  /** OPTIONAL — whole-primitive override for invoking a user-defined /
   *  `extern` component (a `call` whose name is a known component).  The
   *  shared `emitUserComponent` emits a JSX-family element (`<Name prop={…}
   *  />`) that every JSX/markup frontend consumes; the JSX frontends leave
   *  this undefined so the walker uses that path verbatim (byte-identical).
   *  Angular has no PascalCase component tag and must register the component
   *  in its standalone `imports: []`, so `angularTarget` overrides here to
   *  render `<ng-container [ngComponentOutlet]="<Name>"
   *  [ngComponentOutletInputs]="{ … }">` (v0: extern components, data props).
   *  A non-null return is used verbatim; a null return falls back to the
   *  shared `emitUserComponent`. Implementations must `ctx.usedUserComponents
   *  .add(call.name)` so the shell wires the class import + directive. */
  renderUserComponent?(call: ExprIR, ctx: WalkContext, depth: number): string | null;

  /** OPTIONAL — whole-primitive override for `DestroyForm(of: <Agg>)`.  The
   *  shared `emitDestroyForm` delegates here first; a non-null return is used
   *  verbatim and the shared path (which records an `actionMutations` sink +
   *  emits a `window.confirm` `primitive-button`) is skipped.  Angular forks
   *  here to emit a confirm-delete button wired to its `useDelete<Agg>` mutation
   *  and records the delete-mutation hoist on `ctx.angularDestroyForms` for the
   *  page-shell. */
  renderDestroyForm?(call: ExprIR, ctx: WalkContext, depth: number): string | null;

  /** OPTIONAL — the navigate CALL for a `Button(to:)` shorthand, given the
   *  already-rendered destination arg.  The JSX family omits it (default
   *  `navigate(<to>)`, wrapped in the arrow handler); Angular returns
   *  `router.navigateByUrl(<to>)`, which `renderEventHandler` then binds as a
   *  statement.  Distinct from `renderNavigate` (raw-route, for `then:`/Anchor)
   *  — this takes the pre-rendered arg the button already resolved. */
  renderNavigateExpr?(toArg: string): string;

  /** OPTIONAL — declare a named `action` as a hoisted handler function at the
   *  page/component top (named-actions-and-stores.md, Proposal A Stage 1).
   *  `name` is the action's identifier (the same name a bare handler-arg
   *  reference binds); `param` is the single declared payload param name (or
   *  undefined for a nullary action); `bodyStmts` are the already-rendered
   *  statement strings (each `;`-terminated, via the shared `emitStmt`).  The
   *  JSX/markup family (React/Vue/Svelte) declares an arrow const
   *  (`const <name> = (<param>?) => { <stmts> };`) — the omitted default — so
   *  a call site can bind the bare value.  Angular overrides to a class method
   *  (`<name>(<param>?) { <stmts> }`).  Returned verbatim as one or more
   *  source lines spliced into the shell's declaration region.
   *
   *  `opts.async` is set when the body contains an awaited effect (a
   *  `variant-match` over `await <op>()` — async-actions-and-effects.md
   *  Stage 2); the JSX default then emits an `async` arrow so the body may
   *  `await`.  A target that ignores it produces a synchronous handler
   *  (correct for frameworks that don't await inline). */
  renderNamedHandler?(
    name: string,
    param: string | undefined,
    bodyStmts: readonly string[],
    opts?: { async?: boolean },
  ): string;

  /** OPTIONAL — render a `variant-match` StmtIR in action-body position
   *  (async-actions-and-effects.md Stage 2): the async envelope that awaits an
   *  `or`-union-returning remote op and a discriminant `switch` over its result.
   *  The shared walker-core does the framework-neutral work — detect the awaited
   *  subject's mutation hook (registered for hoisting via `buildHookUse` /
   *  `registerApiHook`), classify the error variant, and pre-render every arm's
   *  body — and hands the target a fully-resolved `VariantMatchSpec`.  The
   *  target supplies ONLY the framework-shaped skeleton: React returns an async
   *  `try/catch` (reifying a caught `ApiError` into the error variant) + a
   *  `switch (result.type)` binding each arm's narrowed local; Angular would
   *  emit a method with signal writes.  A target that omits this method makes
   *  walker-core fall back to `unsupportedPageStmt` (fail-loud) — so the
   *  `variant-match` can never be silently dropped on an un-ported frontend. */
  renderVariantMatch?(spec: VariantMatchSpec): string;

  // --- Store seam (named-actions-and-stores.md §3, Stage 5) ---------------
  //
  // CONTRACT FOR FAN-OUT FRONTENDS (Vue / Svelte / Angular):
  // A `store Cart { state {…} action …}` is a shared client-side state
  // container referenced by DOTTED name from page/component bodies
  // (`Cart.lines` read, `Cart.clear()` call).  Three seam methods cover the
  // two halves — USE SITE (the page/component reading/calling) and MODULE
  // (the store's own emitted file).  The React reference (`tsx-target.ts`)
  // implements all three against Zustand:
  //
  //   1. `renderStoreFieldRead({ storeName, field })` — a `Cart.lines` read.
  //      React: `useCart((s) => s.lines)`.  The walker records the use in
  //      `ctx.usedStores` so the shell hoists `const lines =
  //      useCart((s) => s.lines)` ONCE and the body references the bare
  //      local — so this method returns the SELECTOR EXPRESSION the shell
  //      binds, while the body emits the bare member name (see `usedStores`).
  //   2. `renderStoreActionCall({ storeName, action }, args)` — a
  //      `Cart.clear()` call.  React: the shell hoists `const clear =
  //      useCart((s) => s.clear)` and the call site emits `clear(args)`.
  //   3. `renderStoreModule(store, ctx)` — the per-store FILE.  React emits a
  //      Zustand `create<…State>((set) => ({ …fields, …actions }))` whose
  //      action bodies reuse the SAME `:=`/`+=` statement lowering as page
  //      actions (targeting `set(...)` instead of a `useState` setter).
  //      Vue → a Pinia `defineStore`; Svelte → a `$state` rune module store;
  //      Angular → an injectable signal store.  v1 stubs throw loudly so a
  //      store on those frontends fails LOUD, never silent.
  //
  // The use-site methods are OPTIONAL on the interface so a frontend that
  // hasn't wired stores yet still typechecks; the module emitter throws for an
  // un-implemented frontend so a store can never be silently dropped.  Phoenix
  // LiveView implements the store seam through its PARALLEL heex walker (a
  // dedicated `<App>Web.Stores.<Store>` module + per-page assign), NOT these
  // shared-`walkBody` methods — see `src/generator/elixir/store-emit.ts` and
  // the store seams in `heex-target.ts`.

  /** Render the SELECTOR for a `<Store>.<field>` read (Stage 5).  React
   *  returns `use<Store>((s) => s.<field>)`; the shell binds it to a local
   *  named `<field>` and the body references the bare name.  `field` is the
   *  field identifier, `storeName` the declaring store. */
  renderStoreFieldRead?(ref: { storeName: string; field: string }): string;

  /** Render a `<Store>.<action>(args)` call (Stage 5).  React binds the
   *  action via `useStore` in the shell and returns the bound-local call
   *  `<local>(args)`.  `local` is the shell-bound local name (collision-resolved
   *  by walker-core — usually `action`, store-qualified when it clashes with a
   *  page binding); `renderedArgs` is the already-rendered arg list.  Angular
   *  ignores `local` and calls the injected member `this.<store>.<action>(…)`. */
  renderStoreActionCall?(
    ref: { storeName: string; action: string; local: string },
    renderedArgs: string,
  ): string;

  /** Render the per-store MODULE file (Stage 5).  Returns `{ path, content }`
   *  — `path` relative to the generated project root (React:
   *  `web/src/stores/<store-snake>.ts`).  React emits a Zustand store; the
   *  fan-out frontends throw `Error("store: <frontend> not yet implemented")`
   *  until ported.  `renderStmt` is the body-statement renderer the action
   *  bodies reuse (so `:=`/`+=` lower identically to a page action). */
  renderStoreModule?(store: StoreIR): { path: string; content: string };

  // --- Interactive-table seam (M-T1.1) ------------------------------------
  //
  // A `Table` gains client-side column sort when it carries `sortKey:` /
  // `sortDir:` state refs and one or more `Column(..., sortable: true)`.  The
  // shared table primitive (`primitives/table.ts`) delegates the two
  // framework-shaped pieces here — the clickable header markup and the sorted
  // rows expression.  Both are OPTIONAL: a target that omits them renders the
  // plain header + unsorted rows (byte-identical to a table with no sort args),
  // so the feature degrades gracefully instead of emitting broken framework
  // syntax on a target that hasn't been ported yet.

  /** Render a sortable column header.  React returns a clickable
   *  `<span onClick=…>` that toggles `sortDir` when the column is already
   *  active, else sets `sortKey` to this column and `sortDir` to `"asc"`, plus
   *  a ↑/↓ indicator when active.  `header` is the already-escaped header
   *  content; `field` is the row property this column sorts by. */
  renderSortableHeader?(spec: SortableHeaderSpec): string;

  /** Wrap a `Table`'s already-rendered `rows` expression in a client-side
   *  sort by the active `sortKey` / `sortDir` state fields.  React returns a
   *  `[...(rows)].sort((a, b) => …)` chain; omitted → rows render unsorted. */
  renderSortedRows?(rowsExpr: string, sortKey: StateRef, sortDir: StateRef): string;

  /** Render the client-side pager control emitted below a paged `Table` — a
   *  "Prev" / "Next" pair around a "Page N" label, wired to the `page` state
   *  field (writes clamp to `[1, ceil(total/pageSize)]`).  Framework-shaped
   *  (button markup, disabled-attr syntax, click/state-write idiom), so it's a
   *  seam; the `.slice(...)` windowing itself is built generically from
   *  `renderStateRead`.  Omitted → the table renders unpaged (all rows). */
  renderPager?(spec: PagerSpec): string;

  // --- Expression-syntax seam (fable-elmish-frontend.md) -------------------
  //
  // `emitExpr` renders the pure-syntax `ExprIR` arms (operators, literals,
  // list/object spelling, the `convert` cast) by delegating to these leaf
  // formatters — the frontend twin of the backend `ExprTarget`
  // (src/generator/_expr/target.ts).  The JSX-family frontends
  // (React/Vue/Svelte/Angular) all embed JAVASCRIPT, so they share ONE leaf
  // table, `jsExprLeaves` (src/generator/_walker/js-expr-leaves.ts), spread in.
  // Feliz — the first frontend whose embedded language is F#, not JS — supplies
  // its own F# leaves (`FS_LEAVES`).  Sub-expressions arrive already rendered,
  // so each leaf is a pure formatter.  REQUIRED: a new frontend must decide its
  // expression syntax (the exhaustive delegation in `emitExpr` has no JS
  // fallback — one dispatcher, one leaf table per embedded language).

  /** Literal formatter — `null` → `null` on JS, `None` on F#. */
  exprLiteral(lit: LiteralKind, value: string): string;
  /** Binary op — operator spelling (`==` → `===` on JS, `=` on F#). */
  exprBinary(left: string, right: string, op: string): string;
  /** Unary op — `(!x)` on JS, `(not x)` on F#. */
  exprUnary(op: string, operand: string): string;
  /** Ternary — `(c ? t : e)` on JS, `(if c then t else e)` on F#. */
  exprTernary(cond: string, then: string, otherwise: string): string;
  /** `convert` cast — `String(x)` on JS vs `string x` / `int x` on F#. */
  exprConvert(value: string, target: string, from: string | undefined): string;
  /** List literal — `[a, b]` on JS vs `[ a; b ]` on F#. */
  exprList(elements: string[]): string;
  /** Object literal — JS `{ n: v }` vs F# anonymous record `{| n = v |}`. */
  exprObject(fields: ReadonlyArray<{ name: string; value: string }>): string;
}
