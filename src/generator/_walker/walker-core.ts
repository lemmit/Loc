// Recursive body walker.
//
// Walks a page's body `ExprIR` and emits TSX for hand-written
// custom layouts that don't dispatch to one of the scaffold
// archetypes (List / Detail / Form / etc.).  Unlocks pages like:
//
//   page Welcome {
//     route: "/welcome"
//     body: Stack(
//       Heading("Welcome to Acme"),
//       Text("Pick a destination from the sidebar."),
//       Button("Go to orders")
//     )
//   }
//
// v0 stdlib (closed set):
//
//   Stack(...children)            → Mantine <Stack>...</Stack>
//   Heading("text", level: N)     → Mantine <Title order={N}>text</Title>
//   Text("text")                  → Mantine <Text>text</Text>
//   Button("label", ...)          → Mantine <Button>label</Button>
//   Card("title", content)        → Mantine <Card> with optional title
//                                    + <Card.Section>{content}</Card.Section>
//
// Each emitter follows the contract:
//   - First positional arg is the component's primary content (text /
//     label / title), unwrapped from its `ExprIR { kind: "literal" }`
//     when it's a string literal.
//   - Subsequent positional args are children (rendered recursively).
//   - Named args are picked off by hand per emitter (e.g. Heading
//     reads `level`).
//
// What v0 does NOT cover:
//   - Event handlers (onClick: () => navigate(...)).  Buttons emit
//     unwired in v0; click handling lands with the action / state
//     IR threading work.
//   - Nested arrays as children (e.g. `items: [...]`).  Spec syntax
//     is positional-only at this layer.
//   - Per-pack rendering.  v0 hardcodes Mantine output; a future
//     change opens this through the template-pack layer (one
//     stdlib emitter per pack).
//
// What this module exports:
//   - `walkBody(body, target, pack, …)` — { tsx, imports } where
//     `tsx` is the markup expression and `imports` the per-source
//     named-import map the page file needs.  Framework-divergent
//     emission routes through the WalkerTarget; the react entry
//     (`walkBodyToTsx` in src/generator/react/body-walker.ts)
//     threads `tsxTarget`, the svelte generator threads
//     `svelteTarget`.
//   - `isWalkableLayoutBody(body)` — predicate the page emitter
//     uses to decide whether to dispatch to the walker.

import { pagedReturn } from "../../ir/stdlib/generics.js";
import { variantTag } from "../../ir/stdlib/unions.js";
import type {
  ActionIR,
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  OperationIR,
  ParamIR,
  StmtIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { errorTypeUri } from "../../util/error-defaults.js";
import { provableStringType } from "../../util/expr-body-type.js";
import { WALKER_LAYOUT_PRIMITIVES } from "../../util/walker-primitive-names.js";
import type { LoadedPack } from "../_packs/loader.js";
import { tryDetectApiHook } from "./api-hook-detector.js";
import { registerApiHook } from "./api-hook-register.js";
import { storeMemberLocal, upperFirstName } from "./js-target-helpers.js";
import { emitUserComponent } from "./primitives/controls.js";
import { WALKER_PRIMITIVES } from "./registry.js";
import { describeReceiver, positionalArgs } from "./shared/args.js";
import type { WalkerTarget } from "./target.js";

/** Per-source named-import map — `from` module → set of named
 *  exports the page needs from it.  Replaces the old single-source
 *  `Set<MantineImport>` so primitives ported through the pack
 *  contract can declare their own imports (shadcn pulls
 *  `@/components/ui/button`, lucide-react, etc., not just Mantine).
 *
 *  Existing emit functions that haven't yet been ported to the
 *  pack contract use `addMantineImport` (below) which appends to
 *  this map keyed by `"@mantine/core"`.  The page-shell consumer
 *  iterates the map and emits one `import` line per source. */
export type ImportMap = Map<string, Set<string>>;

// The page-top import-block renderers (renderImportLines,
// renderApiHookImports) live in walker/import-lines.ts.

export interface WalkResult {
  tsx: string;
  /** Extern functions called from the body — the shell emits one
   *  conformance-shim import line per name. */
  usedExternFunctions?: Set<string>;
  /** Named page/component `action`s referenced from the body — the shell
   *  emits one hoisted handler function per name from the IR's `actions`
   *  list (named-actions-and-stores.md, Proposal A Stage 1). */
  usedActions?: Set<string>;
  /** Stores referenced from this body, keyed by store name to the set of
   *  members (state fields read + actions called) actually used (named-
   *  actions-and-stores.md §3, Stage 5).  The page/component shell reads
   *  this to import each used store's hook (`import { useCart } from
   *  "../stores/cart"`) and hoist one selector binding per used member
   *  (`const lines = useCart((s) => s.lines)`). */
  usedStores?: Map<string, Set<string>>;
  /** True when a `For { … }` comprehension emitted a keyed React
   *  `<Fragment>` (TSX target only).  The React shell adds `Fragment`
   *  to its `react` import line when set. */
  usesFragment?: boolean;
  imports: ImportMap;
  /** Names of route params the walker actually used
   *  while emitting (e.g. `Heading(name)` referenced `name`).  The
   *  page-shell generator destructures only the used names from
   *  `useParams()` so unused declarations don't trigger TS warnings. */
  usedParams: Set<string>;
  /** True when any walked node emitted JSX that
   *  references the `navigate` symbol (e.g. `Button("…", to: …)`).
   *  The page-shell adds `import { useNavigate }` and a
   *  `const navigate = useNavigate();` line when set. */
  usesNavigate: boolean;
  /** True when any walked node emitted JSX that needs
   *  a `useState` hook in scope (state-field refs in the body or
   *  `setX(...)` calls in event handlers).  The shell emits a
   *  `useState` import + per-field `const [x, setX] = useState(...)`
   *  declarations when set. */
  usesState: boolean;
  /** True when any walked node emitted a currentUser-gated
   *  action button (an `Action(<instance>.<op>)` whose operation's
   *  `requires` predicate is wholly client-evaluable).  The React page
   *  shell binds `const currentUser = useSession().user` + imports
   *  `useSession` when set, so the body's button gates resolve it. */
  usesCurrentUser: boolean;
  /** True when any walked node emitted JSX that
   *  references React Router's `Link` component (e.g.
   *  `Anchor("…", to: …)` → `<Anchor component={RouterLink}>`).
   *  The shell adds `Link as RouterLink` to the existing
   *  react-router-dom import — the alias keeps the slot free for
   *  design packs whose own primitive is named `Link` (MUI,
   *  chakra) without an identifier collision. */
  usesRouterLink: boolean;
  /** True when any walked node referenced the magic route `id`
   *  identifier (`{ kind: "id" }` — e.g. `Sales.Order.byId(id)` on a
   *  `/orders/:id` detail page).  The page-shell binds a local `id`
   *  from the route's `:id` param (each frontend its own way:
   *  `useParams` / `route.params` / `$page.params` / the Angular
   *  `ActivatedRoute` snapshot) so the reference resolves. */
  usesRouteId: boolean;
  /** True when a `Table` emitted a client-side sort via the
   *  `renderSortedRows` seam that references the shared `sortRows`
   *  helper (M-T1.1).  The page-shell adds `import { sortRows } from
   *  "../lib/table-sort"` when set — targets whose `renderSortedRows`
   *  inlines the sort (React) leave it false. */
  usesTableSort: boolean;
  /** Names of user-defined components the walker
   *  invoked while emitting (e.g. `WelcomeBox("Alice")` →
   *  `<WelcomeBox name="Alice" />`).  The shell emits per-name
   *  imports from `@/components/<Name>`. */
  usedUserComponents: Set<string>;
  /** True when the walked tree referenced `Slot()`
   *  (the children-prop placeholder).  Component shells with this
   *  set add a `children?: React.ReactNode` prop to their typed
   *  Props interface. */
  usesChildren: boolean;
  /** Collected api-hook usages.  Each unique
   *  `<paramName>.<aggregate>.<op>` reference in the body becomes
   *  one entry — the shell emits a `const <varName> = use<Op>()`
   *  declaration at page-top + an import.  Body refs are
   *  rewritten to use the local var. */
  usedApiHooks: Map<string, ApiHookUse>;
  /** Non-null when the body contained a `CreateForm(of: <Agg>)`
   *  primitive.  Shell consumes this to emit `useForm` / `Controller`
   *  imports, mutation hook, `defaultValues`, and the `onSubmit`
   *  handler that wraps the form's `<form onSubmit={…}>`. */
  formOfs: FormOfState[];
  /** OPTIONAL opaque per-target sink.  A target that needs to hand
   *  richly-typed per-primitive metadata to its own page-shell parks it here
   *  (typed `unknown` so the shared core stays framework-neutral) and casts it
   *  back on the read side.  Today only the Angular target uses it — its
   *  render seams accumulate the six per-primitive form/action spec lists into
   *  an `AngularWalkerSink` (`angular/walker/sink.ts`), which the Angular
   *  page-shell drains.  Other frameworks leave it `undefined`. */
  sink?: unknown;
  /** Every static `testid:` literal encountered while
   *  walking the body, plus the synthesised testid bases the walker
   *  generates on the user's behalf (e.g. `<form-namespace>-input-
   *  <field>` for each `CreateForm(of:)` field, `<form-namespace>-submit`
   *  for the submit button).  The walker-side page-object emitter
   *  reads this set to surface one typed `Locator` getter per
   *  testid in the generated `e2e/pages/<page-snake>.ts` class. */
  collectedTestids: Set<string>;
  /** `Action(<instance>.<op>)` mutation wiring.  Each entry tells the
   *  shell to declare `const <localVar> = <hookName>(<idExpr>)` at
   *  function top and import the hook from `<prefix>api/<aggCamel>`. */
  actionMutations: ActionMutationState[];
  /** True when any walked node emitted a `CodeBlock`
   *  primitive.  The React generator's orchestrator aggregates this
   *  across every page in the deployable and threads the result into
   *  the shell's `index.html` template, which conditionally injects
   *  the highlight.js CDN + auto-init script.  Pages without
   *  CodeBlock skip the CDN payload entirely. */
  usesCodeBlock: boolean;
}

/** `Action(<instance>.<op>, then?)` — a button bound to an aggregate
 *  operation invoked on an in-scope instance.  `emitAction` records
 *  the mutation hook here; both page and component shells declare it
 *  at function top (the hook must be called at component scope, not
 *  inside the onClick handler). */
export interface ActionMutationState {
  /** Local variable bound to the mutation hook (e.g. `confirmOrder`),
   *  referenced by the button's onClick. */
  localVar: string;
  /** Mutation hook name (e.g. `useConfirmOrder`). */
  hookName: string;
  /** camelCase aggregate name — the api module to import from
   *  (`<prefix>api/<aggCamel>`). */
  aggCamel: string;
  /** JS expression for the instance id to mutate (e.g. `order.id`). */
  idExpr: string;
}

/** A single auto-injected React Query hook call.  Generated when
 *  the walker detects `<param>.<aggregate>.<op>(args?)` in body
 *  position; consumed by `renderCustomLayoutPage` / `renderUserComponentFile`
 *  to emit the per-page hook plumbing. */
export interface ApiHookUse {
  /** Local variable name in the generated React file
   *  (e.g. `customerAll`, `customerById`). */
  varName: string;
  /** React Query hook function name to import + call
   *  (e.g. `useAllCustomers`, `useCustomerById`). */
  hookName: string;
  /** Module-relative import path (e.g. `../api/customer`). */
  importFrom: string;
  /** Pre-rendered args to pass to the hook call (only set for
   *  parameterized queries like `byId(id)` — emitted at
   *  hook-decl time at page-top).  Rendered eagerly via the main
   *  WalkContext so any param/state refs in the args propagate
   *  to `usedParams` / `usesState` for the shell. */
  argsRendered: readonly string[];
  /** True for a parameterised `find` query — the Vue shell wraps the
   *  arg in a getter so a bound filter input live-refetches. */
  reactiveQuery?: boolean;
}

/** Component names the React walker accepts as the TOP-LEVEL `body:`
 *  of a page or component.  Used by `isWalkableLayoutBody` to fast-
 *  fail dispatch when a body is neither a scaffold archetype nor a
 *  layout primitive — those pages stay silent.  Exported so the
 *  conformance completeness guard
 *  (`test/conformance/showcase-completeness.test.ts`) can assert the
 *  showcase fixture exercises every walker primitive.
 *
 *  Note: this is a STRICT SUBSET of the registry's layout-group TSX
 *  renderers — `Action` and `For` are child primitives, not meaningful
 *  as top-level page bodies (Action is a button child of a Toolbar; For
 *  renders as JSX children).  Kept as a hand-list so editing one
 *  primitive in the registry doesn't accidentally promote it to
 *  page-body-eligible.  The completeness test
 *  (`test/language/walker-stdlib-completeness.test.ts`) pins the
 *  language-side admissibility sets against the registry; this set
 *  is a different concern (page-body eligibility) and stays here as
 *  a filtered view of `WALKER_LAYOUT_PRIMITIVES` — the exclusion list
 *  below is the load-bearing piece, not the included names. */
const NON_PAGE_BODY_LAYOUT_PRIMITIVES: ReadonlySet<string> = new Set<string>([
  // Action — single-button operation invocation; child of Toolbar, not
  // a page body root.
  "Action",
  // For — list-comprehension; renders as JSX children, not a page body.
  "For",
  // (MultilineField / SelectField used to sit here while they had no
  // renderer; they are real controlled inputs now — page-body-eligible
  // exactly like Field / Toggle.  `Switch` left the stdlib entirely:
  // page-metamodel.md subsumed it under `match`, Toggle is the bool
  // input.)
]);

export const STDLIB_LAYOUT_COMPONENTS: ReadonlySet<string> = new Set(
  [...WALKER_LAYOUT_PRIMITIVES].filter((n) => !NON_PAGE_BODY_LAYOUT_PRIMITIVES.has(n)),
);

export function isWalkableLayoutBody(
  body: ExprIR | undefined,
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
): boolean {
  if (!body) return false;
  if (body.kind === "call") {
    if (STDLIB_LAYOUT_COMPONENTS.has(body.name)) return true;
    // Calls to user-defined components are walker-
    // eligible too (resolved via the supplied map).
    return userComponents.has(body.name);
  }
  // Top-level conditional bodies dispatch through the
  // walker as long as either branch is walkable.  Powers patterns
  // like `body: loading ? Empty("…") : Stack(…)`.
  if (body.kind === "ternary") {
    return (
      isWalkableLayoutBody(body.then, userComponents) ||
      isWalkableLayoutBody(body.otherwise, userComponents)
    );
  }
  return false;
}

export function walkBody(
  body: ExprIR,
  /** Framework target the walk renders against — owns every
   *  framework-divergent seam (state / api / match / navigate +
   *  markup).  `walkBodyToTsx` (src/generator/react/body-walker.ts)
   *  threads `tsxTarget`; the Svelte walker threads `svelteTarget`. */
  target: WalkerTarget,
  /** Loaded design pack — drives per-pack rendering for primitives
   *  ported through the pack contract.  Emits not yet ported still
   *  call `addMantineImport` directly; the pack reference is unused
   *  by them and harmless to thread through. */
  pack: LoadedPack,
  /** Names of the page's route params; refs to these
   *  names emit as `{name}` JSX expressions (resolved by
   *  `useParams()` at render time). */
  paramNames: ReadonlySet<string> = new Set(),
  /** Names of the page's `state {}` fields; refs in
   *  body position emit as `{name}` JSX expressions (resolved by
   *  `useState` in the shell), and `:=` assignments in event-
   *  handler lambdas lower to the React `setX(...)` setter. */
  stateNames: ReadonlySet<string> = new Set(),
  /** User-defined components known to this UI.  When
   *  the walker sees a `call` whose name matches a key here, it
   *  emits `<Name prop1={arg1} … />` (mapping positional args to
   *  the component's declared param names) instead of the
   *  "unknown component" placeholder.  Required for cross-component
   *  composition (one component invoking another). */
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  /** UI api parameters.  Each entry maps a local
   *  handle (e.g. `Sales`) to an api name (e.g. `SalesApi`).
   *  Body refs of the form `<paramName>.<aggregate>.<op>` get
   *  detected by the walker, hoisted to a hook call at page top,
   *  and rewritten to the local hook variable. */
  apiParams: ReadonlyArray<UiApiParamIR> = [],
  /** Aggregates reachable from this UI's deployable.
   *  `CreateForm(of: <Agg>)` and `IdLink(of: <Agg>)` look up the
   *  aggregate's IR here (field list for form dispatch; display-
   *  marked field for IdLink's link text). */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Bounded-context map keyed by aggregate name.  The
   *  form-field preparer needs the BC to resolve enum / value-
   *  object types declared alongside the aggregate. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Workflows reachable from this UI's deployable.
   *  `WorkflowForm(runs: <wf>)` looks up the workflow's IR here (param
   *  list for form dispatch, owning BC for enum resolution). */
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  /** Owning bounded context per workflow (the form-
   *  field preparer needs the BC to resolve enums / value-objects
   *  referenced by workflow params). */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** In-scope instance variable → aggregate name (current body's
   *  aggregate-typed params), powering `Action(<instance>.<op>)`. */
  paramTypes: ReadonlyMap<string, string> = new Map(),
  /** Page name → route path, for `Action`'s `then: navigate(<Page>)`. */
  pageRoutes: ReadonlyMap<string, string> = new Map(),
  /** Extern frontend function names declared on this ui. */
  externFunctions: ReadonlySet<string> = new Set(),
  /** Page/component `derived` binding names — refs resolve to the hoisted
   *  computed (read like state); the shell hoists each as
   *  `useMemo`/`computed`/`$derived`. */
  derivedNames: ReadonlySet<string> = new Set(),
  /** True when the hosting frontend deployable has `auth: ui` — the
   *  verified session user is available client-side, so currentUser-only
   *  operation `requires` gates can hide their action buttons.  False (the
   *  default, and Svelte's omitted arg) → no button is gated and output
   *  stays byte-identical. */
  authUi = false,
): WalkResult {
  const apiParamNames = new Map<string, string>();
  for (const p of apiParams) apiParamNames.set(p.name, p.apiName);
  const ctx: WalkContext = {
    target,
    imports: new Map(),
    pack,
    paramNames,
    paramTypes,
    pageRoutes,
    authUi,
    usedParams: new Set(),
    usesNavigate: false,
    usesTableSort: false,
    stateNames,
    derivedNames,
    usesState: false,
    usesCurrentUser: false,
    usesRouterLink: false,
    usesRouteId: false,
    userComponents,
    usedUserComponents: new Set(),
    usesChildren: false,
    apiParamNames,
    usedApiHooks: new Map(),
    lambdaParams: new Map(),
    shellLocals: new Set(),
    aggregatesByName,
    bcByAggregate,
    workflowsByName,
    bcByWorkflow,
    formOfs: [],
    // Shared opaque per-target sink.  Created ONCE on the root context (an
    // empty container the walker never inspects) so child contexts — built by
    // `{ ...ctx }` spread — carry the same object reference; a target seam that
    // fills it from a nested walk therefore lands in the sink the root's
    // `WalkResult` returns.  Only the target knows the shape (Angular fills an
    // `AngularWalkerSink`).
    sink: {},
    actionMutations: [],
    collectedTestids: new Set(),
    usesCodeBlock: false,
    usesFragment: false,
    externFunctions,
    usedExternFunctions: new Set(),
    usedActions: new Set(),
    usedStores: new Map(),
  };
  const tsx = walk(body, ctx, 0);
  return {
    tsx,
    imports: ctx.imports,
    usedParams: ctx.usedParams,
    usesNavigate: ctx.usesNavigate,
    usesTableSort: ctx.usesTableSort ?? false,
    usesState: ctx.usesState,
    usesCurrentUser: ctx.usesCurrentUser,
    usesRouterLink: ctx.usesRouterLink,
    usesRouteId: ctx.usesRouteId,
    usedUserComponents: ctx.usedUserComponents,
    usesChildren: ctx.usesChildren,
    usedApiHooks: ctx.usedApiHooks,
    formOfs: ctx.formOfs,
    sink: ctx.sink,
    actionMutations: ctx.actionMutations,
    collectedTestids: ctx.collectedTestids,
    usesCodeBlock: ctx.usesCodeBlock,
    usesFragment: ctx.usesFragment,
    usedExternFunctions: ctx.usedExternFunctions ?? new Set(),
    usedActions: ctx.usedActions ?? new Set(),
    usedStores: ctx.usedStores ?? new Map(),
  };
}

// The walk context is split into two halves so the input/output
// boundary is type-enforced:
//
//   - `WalkEnv`  — read-only lookups threaded top-down. Lambda
//     sub-scopes override `lambdaParams`/`shellLocals` by spreading
//     a fresh env; the rest is shared by reference.
//   - `Sink`     — mutable accumulators the emitters write into and
//     the page shell reads after the walk (imports, used-flags,
//     formOfs, collected testids, …). Always shared by reference;
//     never spread/copied, or writes made inside a sub-walk would be
//     silently dropped.
//
// Per-primitive emitter modules take `(env: WalkEnv, sink: Sink)` so
// each one advertises exactly what it reads vs. writes. The shared
// core still threads a single `WalkContext` (= `WalkEnv & Sink`),
// which is structurally assignable to either half.

/** Read-only lookups threaded through the walk. */
export interface WalkEnv {
  /** The framework target the walk renders against.  Owns every
   *  framework-divergent seam (state / api / match / navigate plus
   *  the markup seams — comments, conditional children, style
   *  attribute, text escaping); the shared walker consults it
   *  instead of hardcoding TSX forms.  `walkBodyToTsx` threads
   *  `tsxTarget`; the Svelte walker threads `svelteTarget`. */
  target: WalkerTarget;
  pack: LoadedPack;
  paramNames: ReadonlySet<string>;
  stateNames: ReadonlySet<string>;
  /** Page/component `derived` binding names.  A body ref to one resolves
   *  to the hoisted computed (read with the same per-framework idiom as a
   *  state read — React bare, Vue `.value` in handler, Angular `()`); the
   *  shell hoists each as `useMemo`/`computed`/`$derived`.  Read-only:
   *  there's no write path (unlike `stateNames`). */
  derivedNames: ReadonlySet<string>;
  userComponents: ReadonlyMap<string, readonly ParamIR[]>;
  /** In-scope instance variable name → aggregate name, for the
   *  current body's params whose declared type is an aggregate (e.g.
   *  `component OrderPanel(order: Order)` → `order → "Order"`).  Lets
   *  `Action(order.confirm)` resolve the receiver's aggregate at walk
   *  time — the IR's `receiverType` is unresolved for page/component
   *  bodies (lowered with a neutral env). */
  paramTypes?: ReadonlyMap<string, string>;
  /** Page name → route path, so an `Action`'s `then: navigate(<Page>,
   *  …)` effect targets the page's real declared route. */
  pageRoutes?: ReadonlyMap<string, string>;
  /** True when the hosting frontend deployable has `auth: ui`.  Lets
   *  `Action(<instance>.<op>)` hide its button at runtime when the
   *  operation's `requires` predicate is currentUser-only (the action-level
   *  mirror of the page `requires` guard).  False → no button is gated. */
  authUi: boolean;
  apiParamNames: ReadonlyMap<string, string>;
  /** Lambda params bound in the current sub-walk
   *  (source-side name → emitted JS name).  `Column("ID", o => o.id)`
   *  walks the accessor body with `o → "row"`; refs to `o` resolve
   *  to the JS identifier `row`.  Outer scope is unaffected. */
  lambdaParams: ReadonlyMap<string, string>;
  /** Identifiers emitted by the page shell that user-
   *  written sub-expressions can reference (e.g. inside a
   *  `CreateForm(of:, onSubmit:)` lambda, `create` is the mutation hook
   *  declared at function top).  Refs matching a name in this set
   *  emit as the bare identifier — no `unresolved` comment. */
  shellLocals: ReadonlySet<string>;
  /** Aggregates reachable from this UI's deployable.
   *  Powers `CreateForm(of: <Agg>)` field dispatch and `IdLink(of: <Agg>)`
   *  display-field resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Map aggregate name → owning bounded context, so the
   *  form-field preparer can resolve enums / value-objects declared
   *  in the same context. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  /** Workflows reachable from this UI's deployable.
   *  Powers `WorkflowForm(runs: <wf>)` field dispatch. */
  workflowsByName: ReadonlyMap<string, WorkflowIR>;
  /** Owning bounded context per workflow. */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR>;
  /** Extern frontend functions declared on this ui
   *  (`function f(…): T extern from "…"`) — names a body call can
   *  reference; the shell imports each used one from its
   *  `src/lib/<name>` conformance shim. */
  externFunctions?: ReadonlySet<string>;
  /** Semantic heading-nesting depth (accessibility.md Phase 2, Layer 3 —
   *  derived whole-page structure).  Incremented by the `nesting: true`
   *  containers in the a11y contract (`Section` / `Card`) when they walk
   *  their children; consumed by `emitHeading` to derive the heading rank
   *  (`min(6, 2 + depth)`) when the author gives no explicit `level:`, so
   *  levels never skip.  Distinct from the layout-indentation `depth`
   *  param threaded through `walk()`.  Absent → 0 (page top → `<h2>`; the
   *  page chrome owns the single `<h1>`). */
  headingDepth?: number;
}

/** Mutable accumulators written during the walk; read by the page
 *  shell afterwards.  Always shared by reference. */
export interface Sink {
  imports: ImportMap;
  usedParams: Set<string>;
  usesNavigate: boolean;
  /** M-T1.1 — set by a `Table` whose `renderSortedRows` seam references the
   *  shared `sortRows` helper.  Optional so the many `Sink` construction sites
   *  needn't all initialise it; only the interactive-table path writes it. */
  usesTableSort?: boolean;
  usesState: boolean;
  /** True when a currentUser-gated action button emitted from this body
   *  (an `Action(<instance>.<op>)` whose op `requires` is client-evaluable).
   *  The React page shell binds `currentUser` + imports `useSession`. */
  usesCurrentUser: boolean;
  usesRouterLink: boolean;
  usesRouteId: boolean;
  usedUserComponents: Set<string>;
  usesChildren: boolean;
  usedApiHooks: Map<string, ApiHookUse>;
  /** When `CreateForm(of: <Agg>)` or `WorkflowForm(runs: <wf>)`
   *  is walked, the emitter records the metadata the shell needs
   *  (aggregate or workflow, BC, optional user-supplied
   *  `onSubmit:` lambda body, redirect path) so the shell can
   *  emit `useForm` + mutation hook + `handleSubmit` wiring at
   *  function top. */
  formOfs: FormOfState[];
  /** OPTIONAL opaque per-target sink — the mutable write side of
   *  `WalkResult.sink` (see there).  A render seam parks its own typed
   *  accumulator here (Angular: `AngularWalkerSink`); `unknown` keeps the
   *  shared walker framework-neutral. */
  sink?: unknown;
  /** `Action(<instance>.<op>)` mutation wiring (see
   *  `ActionMutationState`). */
  actionMutations: ActionMutationState[];
  /** Accumulator for static `testid:` strings the body
   *  emits, used by the walker-side page-object builder. */
  collectedTestids: Set<string>;
  /** Extern functions actually called from this body — one shim
   *  import line each (`import { f } from "<hops>lib/f";`). */
  usedExternFunctions?: Set<string>;
  /** Named page/component `action`s referenced from this body (`onSubmit:
   *  next`, `rowAction: add`).  The page/component shell emits one hoisted
   *  handler function per referenced action from the Page/Component IR's
   *  `actions` list (named-actions-and-stores.md, Proposal A Stage 1) —
   *  tracking which are USED keeps unreferenced actions from tripping
   *  `noUnusedLocals` in the generated TSX. */
  usedActions?: Set<string>;
  /** Stores referenced from this body — store name → the set of members
   *  (state fields + actions) used (Stage 5).  The shell hoists one store
   *  hook import + per-member selector binding from this.  A shared `Map`
   *  reference, so child contexts accumulate into the same instance. */
  usedStores?: Map<string, Set<string>>;
  /** True when a `CodeBlock { … }` primitive emitted from this body.
   *  Read by the React orchestrator (aggregated across all pages)
   *  to drive conditional injection of the highlight.js CDN payload
   *  into the shell's `index.html`. */
  usesCodeBlock: boolean;
  /** True when a `For { … }` comprehension emitted a keyed React
   *  `<Fragment>` wrapper (TSX target only — Vue/Svelte iterate with
   *  native `v-for` / `{#each}` and never set it).  The React page /
   *  component shell adds `Fragment` to its `import … from "react"`
   *  line when set. */
  usesFragment?: boolean;
}

/** The combined context the shared core threads. Structurally
 *  assignable to both `WalkEnv` and `Sink`. */
export interface WalkContext extends WalkEnv, Sink {}

/** RHF wiring requirements recorded by `emitFormOf`,
 *  consumed by the page shell to splice the `useForm` declaration +
 *  request type + mutation hook + per-field `useAll<TargetX>` hooks
 *  at the top of the function body.
 *
 *  Discriminated union: `kind: "aggregate"` for `CreateForm(of: <Agg>)`,
 *  `kind: "workflow"` for `WorkflowForm(runs: <wf>)`.  The two share most
 *  fields (the form is rendered identically); they differ only in
 *  the imports / hook decls / default submit redirect that the
 *  shell emits around the form. */
export type FormOfState = AggregateFormState | WorkflowFormState | OperationFormState;

interface FormStateBase {
  bc: BoundedContextIR;
  /** X id targets needing `useAllX()` injection at function top
   *  (resolved through `idTargetsInFields`).  One hook decl per
   *  target — collapsed across multiple `X id` fields on the same
   *  target aggregate. */
  idTargets: readonly AggregateIR[];
  /** True when any field needs RHF's `Controller` for binding
   *  (currently the case for enums + X id-as-select + bool +
   *  datetime + value-objects). */
  useController: boolean;
  /** Default-values literal for `useForm({ defaultValues: ... })`. */
  defaultValuesTs: string;
  /** Slug-prefixed testid namespace (e.g. `"orders-form"`). */
  testidNamespace: string;
  /** Pre-rendered field TSX (already through the per-pack
   *  `field-input-*` templates) — the shell splices these into the
   *  `<form>` body. */
  fieldHtmls: readonly string[];
  /** Optional user-supplied `onSubmit:` lambda body.  When null,
   *  the shell uses the scaffold-equivalent default. */
  onSubmitJs: string | null;
}

export interface AggregateFormState extends FormStateBase {
  kind: "aggregate";
  agg: AggregateIR;
  /** Non-optional aggregate fields — optional fields are excluded
   *  from the create form, matching the scaffold New-page rule. */
  fields: AggregateIR["fields"];
}

export interface WorkflowFormState extends FormStateBase {
  kind: "workflow";
  workflow: WorkflowIR;
  /** Workflow params — all required (no optional filter; workflows
   *  don't have an "optional" notion the way aggregate fields do). */
  fields: WorkflowIR["params"];
}

/** `OperationForm(<instance>.<operation>)` — an aggregate-operation
 *  invocation form.  The operation is referenced through an in-scope
 *  instance (`order.confirm` for a component param, `data.confirm` for
 *  a Detail page's loaded record); the receiver's aggregate is
 *  resolved via `ctx.paramTypes`.  Unlike create/workflow forms (one
 *  per page, page-scope `useForm`), op-forms are emitted as
 *  module-scope components (`function <Op>Form`) opened via the
 *  modals manager, so a Detail page can host several without RHF-local
 *  collisions.  The page scope declares the mutation hook
 *  (`const <op> = use<Op><Agg>(<idExpr>)`). */
export interface OperationFormState extends FormStateBase {
  kind: "operation";
  agg: AggregateIR;
  op: OperationIR;
  /** Operation params (always required — params have no optional
   *  notion).  Empty ⇒ the form renders a "no parameters" note. */
  fields: OperationIR["params"];
  /** JS expression for the instance id the mutation targets.
   *  `<instance>.id` when the instance is a function-top param;
   *  `id ?? ""` (the route param) when it's a render-lambda binding
   *  not in scope where the page-top hook is declared. */
  idExpr: string;
  /** Trigger button surface, read from the enclosing `Modal`'s
   *  `trigger: Button(...)`.  Packs without a modals manager
   *  (shadcn/mui/chakra) render the trigger inside the self-
   *  contained `<Op>OpModal` component, so they need it here. */
  triggerLabel: string;
  /** True when this is the aggregate's primary operation (first
   *  public op) — `false` for the rest.  Platform-neutral emphasis
   *  token; each pack's template maps it to its button vocabulary. */
  triggerPrimary: boolean;
}

/** Rewrite a detected user-FIND hook's rendered args from positional to
 *  the object shape the emitted hook signature takes
 *  (`use<Find><Agg>(query: <Find>Query)` — see _frontend/api-module.ts).
 *  The find's param names come from the owning context's repository via
 *  `bcByAggregate`; paged finds gain the backend's page/pageSize
 *  defaults (P3b) — pagination controls on filtered lists are future
 *  work.  Standard ops (`all`/`byId`/`create`/`update`/`delete`) and
 *  unknown names pass through untouched. */
function adjustFindHookArgs(
  detected: import("./api-hook-detector.js").DetectedApiCall,
  hookUse: import("./target.js").TargetHookUse,
  ctx: WalkContext,
): import("./target.js").TargetHookUse {
  if (detected.kind !== "aggregate") return hookUse;
  if (STANDARD_AGG_OPS.has(detected.operation)) return hookUse;
  const bc = ctx.bcByAggregate.get(detected.aggregateName);
  const repo = bc?.repositories.find((r) => r.aggregateName === detected.aggregateName);
  const find = repo?.finds.find((f) => f.name === detected.operation);
  if (!find || hookUse.argsRendered.length === 0) return hookUse;
  const pairs = find.params.map((p, i) => `${p.name}: ${hookUse.argsRendered[i] ?? "undefined"}`);
  if (pagedReturn(find.returnType)) pairs.push("page: 1", "pageSize: 20");
  return { ...hookUse, argsRendered: [`{ ${pairs.join(", ")} }`], reactiveQuery: true };
}

const STANDARD_AGG_OPS: ReadonlySet<string> = new Set([
  "all",
  "byId",
  "create",
  "update",
  "delete",
]);

export function walk(expr: ExprIR, ctx: WalkContext, depth: number): string {
  // Api hook injection (JSX-child position).  Detect
  // `<param>.<aggregate>.<op>` rooted at a UiApiParam; register
  // the hook for hoisting (renderApiHoisting consumes
  // ctx.usedApiHooks); delegate the call-site emission shape to
  // tsxTarget.renderApiCall (cross-framework contract — see
  // src/generator/_walker/target.ts).  TSX's contract semantics
  // is var-only — the surrounding member / method-call IR walk
  // emits any chained `.data` / `.mutate(args)` / `.isPending`.
  // JSX-child position wraps the result in braces.
  const detected = tryDetectApiHook(expr, ctx);
  if (detected) {
    const hookUse = adjustFindHookArgs(
      detected,
      ctx.target.buildHookUse(detected, (e) => emitExpr(e, ctx)),
      ctx,
    );
    registerApiHook(hookUse, ctx);
    const rendered = ctx.target.renderApiCall(
      {
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query",
        args: [],
        varName: hookUse.varName,
      },
      "",
    );
    return ctx.target.renderInterpolation(rendered);
  }
  switch (expr.kind) {
    case "call":
      return emitComponent(expr, ctx, depth);
    case "literal":
      // String literal in a child position becomes a markup text node.
      // Other literal kinds (int / decimal / bool) stay as
      // interpolated JS literals.
      if (expr.lit === "string") return ctx.target.escapeText(expr.value);
      if (expr.lit === "bool") return ctx.target.renderInterpolation(expr.value);
      if (expr.lit === "null") return ctx.target.renderInterpolation("null");
      return ctx.target.renderInterpolation(expr.value);
    case "ref":
      // Refs to a lambda-bound param resolve to its
      // emitted JS name (e.g. `o.id` inside `o => …` walks with
      // `o → "row"`).  Interpolate as a markup child.
      {
        const jsName = ctx.lambdaParams.get(expr.name);
        if (jsName) return ctx.target.renderInterpolation(jsName);
      }
      // `<Store>.<field>` read in markup-child position (Stage 5) — record the
      // use (shell hoists the selector) and interpolate the bound local.  Fail
      // loudly on a frontend that hasn't wired stores.
      if (expr.refKind === "store-field" && expr.storeName) {
        if (!ctx.target.renderStoreFieldRead) {
          throw new Error(
            `store: ${ctx.target.framework} not yet implemented (\`${expr.storeName}.${expr.name}\` read)`,
          );
        }
        recordStoreUse(ctx, expr.storeName, expr.name);
        return ctx.target.renderInterpolation(
          storeFieldReadUseSite(ctx, expr.storeName, expr.name),
        );
      }
      // Refs that match a route param name emit as
      // interpolated expressions (`{name}`).  React Router's
      // `useParams()` brings these into scope at render time; the
      // page-shell generator destructures the used names.  Refs that
      // don't match a param emit as a placeholder comment so the
      // build error stays visible.
      if (ctx.paramNames.has(expr.name)) {
        ctx.usedParams.add(expr.name);
        return ctx.target.renderInterpolation(expr.name);
      }
      // Refs that match a state field name emit the
      // same way; the shell brings them into scope via `useState`.
      // Delegated to tsxTarget.renderStateRead — see
      // `src/generator/_walker/target.ts`.  TSX is position-invariant
      // (template == handler), but we pass the JSX-child position
      // for clarity at the call site; the brace wrap is JSX-child
      // syntax and stays here.
      if (ctx.stateNames.has(expr.name)) {
        ctx.usesState = true;
        const stateRef = {
          field: { name: expr.name, type: { kind: "primitive" as const, name: "string" as const } },
          name: expr.name,
        };
        return ctx.target.renderInterpolation(ctx.target.renderStateRead(stateRef, "template"));
      }
      // A `derived` binding — read with the same per-framework idiom as a
      // state field (computed refs unwrap identically), but no `usesState`
      // (the shell hoists it as a computed, not `useState`).
      if (ctx.derivedNames.has(expr.name)) {
        const derivedRef = {
          field: { name: expr.name, type: { kind: "primitive" as const, name: "string" as const } },
          name: expr.name,
        };
        return ctx.target.renderInterpolation(ctx.target.renderStateRead(derivedRef, "template"));
      }
      return ctx.target.renderComment(`ref: ${expr.name}`);
    case "match": {
      // Predicate-arms conditional rendering (page-metamodel §7).
      // Each arm's value walks as markup in the caller's scope; the
      // value-expression shape comes from the target seam
      // (renderMatch).  Interpolation-wrap in child position,
      // exactly as the ternary arm below.
      const arms = expr.arms.map((arm) => ({
        predicate: emitExpr(arm.cond, ctx),
        value: walk(arm.value, ctx, depth + 1),
      }));
      const elseArm = expr.otherwise ? walk(expr.otherwise, ctx, depth + 1) : undefined;
      return ctx.target.renderMatchChild(arms, elseArm, depth);
    }
    case "ternary": {
      // Conditional rendering.  `cond ? <A /> : <B />`
      // works as a top-level body (depth 0 — JSX-element inside the
      // function's `return ( … )` parens).  In nested child
      // position, JSX requires brace-wrapping `{ cond ? … : … }`.
      const cond = emitExpr(expr.cond, ctx);
      const thenS = walk(expr.then, ctx, depth + 1);
      const elseS = walk(expr.otherwise, ctx, depth + 1);
      return ctx.target.renderConditionalChild(cond, thenS, elseS, depth);
    }
    case "member":
      // Member access in markup-child position (e.g. an
      // accessor lambda body `o => o.id` walks `o.id` as the body
      // of a `<Table.Td>` cell).  Emit as an interpolated JS
      // expression; `emitExpr` resolves the receiver (lambda
      // param, hook, state) and concatenates the member name.
      // `provableStringType` is `undefined` for a member (its resolved
      // type is unreliable for untyped scaffold accessors), so a
      // text-coercing target keeps its cast — safe today, and the site
      // widens to the real type once accessors are typed.
      return ctx.target.renderInterpolation(emitExpr(expr, ctx), provableStringType(expr));
    default:
      return ctx.target.renderComment(`unsupported expr: ${expr.kind}`);
  }
}

function emitComponent(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Typed walker-primitive dispatch — the registry at
  // src/generator/_walker/registry.ts owns the per-target renderer
  // table.  Adding a primitive is one edit there (plus the renderer
  // function); the language-side admissibility sets are pinned to
  // the same registry by the completeness test.
  const def = WALKER_PRIMITIVES[call.name];
  if (def?.tsx) return def.tsx(call, ctx, depth);
  // Names not in the stdlib dispatch table fall through to user-
  // component invocation when they match a registered ComponentIR.
  if (ctx.userComponents.has(call.name)) {
    // A target may override component invocation entirely (Angular renders an
    // `ngComponentOutlet` container, not a JSX-family `<Name>` tag).  The
    // JSX/markup frontends leave the seam undefined → the shared JSX path,
    // byte-identical.
    const override = ctx.target.renderUserComponent?.(call, ctx, depth);
    return override ?? emitUserComponent(call, ctx, depth);
  }
  // Registered primitive without a TSX renderer (e.g. `For`, `List`,
  // `Detail` — source-admissible but unimplemented by the React
  // walker).  Surface a comment so the gap is visible in generated
  // output rather than silently producing nothing useful.
  if (def) {
    return ctx.target.renderComment(`${call.name}: not supported by the React walker yet`);
  }
  return ctx.target.renderComment(`unknown layout component: ${call.name}`);
}

// Layout primitives (Stack, Group, Grid, Container, Tabs) live in
// walker/primitives/layout.ts.

/** Table primitive.
 *
 *  Surface:
 *
 *    Table(
 *      rows: <expr>,                  // any data-source expression
 *      Column("ID", o => o.id),       // positional Column(...) calls
 *      Column("Status", o => Badge(o.status)),
 *      onRowClick: o => /* … *\/,     // optional
 *      testid: "orders-table"          // optional
 *    )
 *
 *  Lowers to a packed-table TSX block with a header row + a body
 *  produced by `<rowsExpr>.map((row) => …)`.  Column accessors are
 *  lambdas; the lambda's source-side param name is rebound to the
 *  emitted JS identifier `row` for the duration of the column body
 *  walk (via WalkContext.lambdaParams).  Cell bodies that are
 *  primitive calls (`Badge(…)`) emit as JSX; member-access bodies
 *  (`o.id`) emit as `{row.id}`. */
// The Table primitive (emitTable + emitColumn) lives in
// walker/primitives/table.ts.

/** Propagate boolean / object flags written on a
 *  child WalkContext back to the parent.  Maps + Sets share
 *  references through the spread, but primitive flags
 *  (`usesNavigate`, `usesRouterLink`, `usesState`, `usesChildren`)
 *  and the `formOf` slot need explicit copy-back, otherwise an
 *  IdLink emitted inside a `QueryView(data: rows => …)` lambda
 *  would set `usesRouterLink: true` on the throwaway child ctx
 *  while the page shell still sees `false` on the parent and
 *  forgets to import `Link`. */
export function propagateChildFlags(parent: WalkContext, child: WalkContext): void {
  if (child.usesNavigate) parent.usesNavigate = true;
  if (child.usesRouterLink) parent.usesRouterLink = true;
  if (child.usesRouteId) parent.usesRouteId = true;
  if (child.usesTableSort) parent.usesTableSort = true;
  if (child.usesState) parent.usesState = true;
  if (child.usesCurrentUser) parent.usesCurrentUser = true;
  if (child.usesChildren) parent.usesChildren = true;
  if (child.usesCodeBlock) parent.usesCodeBlock = true;
  if (child.usesFragment) parent.usesFragment = true;
  for (const f of child.formOfs) {
    if (!parent.formOfs.includes(f)) parent.formOfs.push(f);
  }
}

/** Record that a store member (field read / action call) was used from this
 *  body so the page/component shell can hoist the store hook import + one
 *  selector binding per member (named-actions-and-stores.md §3, Stage 5).
 *  The `usedStores` map is shared by reference across child contexts. */
export function recordStoreUse(ctx: WalkContext, storeName: string, member: string): void {
  if (!ctx.usedStores) return;
  let members = ctx.usedStores.get(storeName);
  if (!members) {
    members = new Set();
    ctx.usedStores.set(storeName, members);
  }
  members.add(member);
}

/** The use-site read form for a `<Store>.<field>` reference (Stage 5).  The
 *  expression diverges per frontend: React references the shell-bound local
 *  (`lines` — the shell hoists `const lines = useCart((s) => s.lines)`), while
 *  Angular reads the injected store member's signal in place
 *  (`this.cart.lines()` — the shell injects `readonly cart = inject(CartStore)`).
 *  Angular qualifies with `this.` so the SAME form works in a template binding
 *  AND in a generated class-method body (a page action) — Angular templates
 *  accept `this`, and a method body requires it.  The walker records the use
 *  via `recordStoreUse`; this only decides what the body emits at the
 *  reference. */
export function storeFieldReadUseSite(ctx: WalkContext, storeName: string, field: string): string {
  if (ctx.target.framework === "angular") {
    return `this.${storeName[0]!.toLowerCase()}${storeName.slice(1)}.${field}()`;
  }
  return storeLocalFor(ctx, storeName, field);
}

/** The shell-bound local name for a store member referenced from this body
 *  (Stage 5).  Bare member name in the common case; store-qualified
 *  (`cartLines`) when it collides with a page-level binding (state / param /
 *  derived) to avoid a duplicate declaration.  The page/component shell's
 *  `renderStoreWiring` computes the same name from the same reserved set, so the
 *  binding and the use-site always agree. */
export function storeLocalFor(ctx: WalkContext, storeName: string, member: string): string {
  const reserved = new Set<string>([...ctx.stateNames, ...ctx.paramNames, ...ctx.derivedNames]);
  return storeMemberLocal(storeName, member, reserved);
}

/** Extend the WalkContext.lambdaParams map with a new
 *  binding without mutating the parent map.  Caller spreads the
 *  rest of the context and overrides `lambdaParams` with the
 *  result. */
export function extendLambdaParams(
  ctx: WalkContext,
  srcName: string,
  jsName: string,
): ReadonlyMap<string, string> {
  const next = new Map(ctx.lambdaParams);
  next.set(srcName, jsName);
  return next;
}

/** Render the hoisted handler functions for a page/component's named
 *  `action`s (named-actions-and-stores.md, Proposal A Stage 1).  Only the
 *  actions in `used` are emitted (an unreferenced action would trip
 *  `noUnusedLocals` in the generated TSX).  Each body lowers through the
 *  SAME `emitStmt` path as an anonymous handler block — state writes, calls,
 *  navigate all resolve against `baseCtx` — so a body that mutates state sets
 *  `baseCtx.usesState`, which the shell reads to import the state runtime.
 *  The declaration shape (arrow const vs class method) is the active target's
 *  `renderNamedHandler` seam (JSX/markup default: `const <name> = (<p>?) =>
 *  { … }`).  Returns one joined string (newline-separated), or `""` when
 *  nothing is emitted — splice it into the shell's declaration region. */
/** Expand a set of directly-referenced action names to its transitive
 *  closure over sibling action→action calls (Proposal A Stage 1, Fix 1).  An
 *  action whose handler is emitted (because markup referenced it) may itself
 *  call another sibling action via a `target: "action"` body statement; that
 *  callee's handler must also emit, even if no markup references it directly.
 *  Pure over the action list — declaration order is irrelevant. */
export function closeUsedActions(
  actions: readonly ActionIR[],
  seed: ReadonlySet<string>,
): Set<string> {
  const byName = new Map(actions.map((a) => [a.name, a] as const));
  const closed = new Set(seed);
  const stack = [...seed];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    const action = byName.get(name);
    if (!action) continue;
    for (const s of action.body) {
      if (s.kind === "call" && s.target === "action" && !closed.has(s.name)) {
        closed.add(s.name);
        stack.push(s.name);
      }
    }
  }
  return closed;
}

export function renderActionHandlers(
  actions: readonly ActionIR[],
  used: ReadonlySet<string>,
  baseCtx: WalkContext,
): string {
  const out: string[] = [];
  // Transitively include any sibling action a used action's body calls, so
  // its handler emits too (Proposal A Stage 1, Fix 1).
  const effectiveUsed = closeUsedActions(actions, used);
  for (const action of actions) {
    if (!effectiveUsed.has(action.name)) continue;
    // The single payload param (v1) binds as a lambda param so body refs to
    // it resolve; nullary actions bind nothing.
    const param = action.params[0]?.name;
    const handlerCtx: WalkContext = param
      ? { ...baseCtx, lambdaParams: extendLambdaParams(baseCtx, param, param) }
      : baseCtx;
    const bodyStmts = action.body.map((s) => emitStmt(s, handlerCtx));
    // An action whose body awaits a remote effect (a `variant-match` over
    // `await <op>()` — async-actions-and-effects.md Stage 2) must be `async` so
    // the emitted body can `await`.
    const isAsync = action.body.some(stmtIsAwaited);
    const asyncKw = isAsync ? "async " : "";
    out.push(
      baseCtx.target.renderNamedHandler?.(action.name, param, bodyStmts, { async: isAsync }) ??
        `const ${action.name} = ${asyncKw}(${param ?? ""}) => { ${bodyStmts.join(" ")} };`,
    );
  }
  return out.join("\n");
}

/** True when a statement (or a nested arm/else body) contains an awaited
 *  effect — a `variant-match` (whose subject is `await <op>()`).  Drives the
 *  `async` handler wrapper (async-actions-and-effects.md Stage 2). */
function stmtIsAwaited(s: StmtIR): boolean {
  return s.kind === "variant-match";
}

/** Money(value, currency?, decimals?, testid?).  Renders
 *  through the pack's `MoneyValue` runtime helper (Intl.NumberFormat
 *  with `style: "currency"`).  First positional or `value:` named
 *  arg is the numeric value; `currency:` and `decimals:` are
 *  optional named args. */
// Leaf text & media primitives (Heading, Text, Money, DateDisplay,
// EnumBadge, Anchor, Image, Avatar, Loader, Empty, KeyValueRow) live
// in walker/primitives/text.ts.

/** IdLink(id, of: <Aggregate>, testid?).
 *
 *  Emits a React-Router `<Link>` to the conventional
 *  `/<plural-snake>/{id}` detail-page route, with the truncated id
 *  rendered via the pack's `IdValue` helper as the link text.
 *
 *  Link-text choice — IdValue (truncated id) is the deliberate
 *  match to the scaffold's `cell-id-link.hbs` rendering.  Looking
 *  up the aggregate's `display`-marked field would require a per-
 *  row `useXById(id)` hook call from inside the IdLink primitive,
 *  which doesn't compose cleanly when IdLink appears inside a
 *  Table cell (one hook per row violates React's rules-of-hooks).
 *  Detail-page TITLES use the display field — that's where it
 *  belongs.
 *
 *  Aggregates are plumbed through to the walker; we use that to
 *  validate `of:` at emit time — an unresolvable aggregate
 *  surfaces as a visible TSX comment rather than a silent
 *  mistakenly-pluralised path. */
// Interactive control primitives (Button, IdLink, QueryView,
// UserComponent) live in walker/primitives/controls.ts.

/** CreateForm(of: <Aggregate>, onSubmit?: <lambda>, testid?).
 *
 *  Walker-side counterpart to the scaffold New-page archetype.
 *  Introspects the aggregate's IR field list and emits one input
 *  per field using the SAME `field-input-*` templates the scaffold
 *  renderer uses (`prepareFormFieldVM` + `renderFormField`), so RHF
 *  integration is preserved at the field level (`register` /
 *  `Controller`, error-path access, testid namespace).
 *
 *  What gets emitted by THIS function:
 *   - The form's `<form onSubmit=…><Stack>{fields}{submit}</Stack>
 *     </form>` JSX block (rendered through `primitive-form-of.hbs`).
 *
 *  What the shell (`renderCustomLayoutPage`) emits on top:
 *   - `useForm` import + declaration with zodResolver wiring
 *   - `useCreate<Agg>` mutation hook
 *   - One `useAll<Target>()` hook per `X id` target needing a
 *     select picker
 *   - The submit handler — default scaffold behaviour
 *     (`create.mutateAsync` + notify + navigate) when no explicit
 *     `onSubmit:` was given.
 *
 *  Walker records the FormOfState on `ctx.formOf`; the shell reads
 *  it after the body walk completes. */
// The Form family (CreateForm / WorkflowForm / OperationForm) and the Modal
// that hosts an operation form live in walker/primitives/forms.ts.

// Layout / surface primitives (Stack, Group, Grid, Container, Tabs,
// Toolbar, Card) live in walker/primitives/layout.ts.

// Controlled input primitives (Field, Toggle, NumberField,
// PasswordField) live in walker/primitives/inputs.ts.

/** Render an `ExprIR` as a JS-expression string (NOT JSX).  Used
 *  for the right-hand side of state assignments (`count := count +
 *  1` → `count + 1`) and lambda expression bodies.  State + param
 *  refs render as bare identifiers (they're in scope via
 *  `useState` / `useParams` destructure). */
export function emitExpr(expr: ExprIR, ctx: WalkContext): string {
  // Api hook injection.  Detect `<param>.<aggregate>.<op>`
  // (with optional method-call args) rooted at a UiApiParam ref.
  // When matched, register a hook usage on the context and
  // delegate the call-site emission shape to tsxTarget.renderApiCall.
  // The shell emits the `const <var> = use<Op><Aggregate>(args)`
  // declaration at page-top via renderApiHoisting (delegated in #625).
  // Expression position — no JSX brace wrap.
  const detected = tryDetectApiHook(expr, ctx);
  if (detected) {
    const hookUse = adjustFindHookArgs(
      detected,
      ctx.target.buildHookUse(detected, (e) => emitExpr(e, ctx)),
      ctx,
    );
    registerApiHook(hookUse, ctx);
    return ctx.target.renderApiCall(
      {
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query",
        args: [],
        varName: hookUse.varName,
      },
      "",
    );
  }
  switch (expr.kind) {
    case "literal":
      return ctx.target.exprLiteral(expr.lit, expr.value);
    case "ref":
      // Lambda-bound param refs resolve to their
      // emitted JS name (e.g. `o → "row"` for column accessors).
      {
        const jsName = ctx.lambdaParams.get(expr.name);
        if (jsName) return jsName;
      }
      // `<Store>.<field>` read (Stage 5) — record the use so the shell hoists
      // the selector binding, and reference the bare field local in the body.
      // A frontend that hasn't wired stores (no `renderStoreFieldRead`) fails
      // LOUDLY here rather than emitting an unresolved name (Vue/Svelte/Angular
      // are fan-out follow-ups; the IR validator already gates LiveView).
      if (expr.refKind === "store-field" && expr.storeName) {
        if (!ctx.target.renderStoreFieldRead) {
          throw new Error(
            `store: ${ctx.target.framework} not yet implemented (\`${expr.storeName}.${expr.name}\` read)`,
          );
        }
        recordStoreUse(ctx, expr.storeName, expr.name);
        return storeFieldReadUseSite(ctx, expr.storeName, expr.name);
      }
      if (ctx.stateNames.has(expr.name)) {
        ctx.usesState = true;
        // Delegated to tsxTarget.renderStateRead — expression
        // position (no JSX braces) for handler context.
        const stateRef = {
          field: { name: expr.name, type: { kind: "primitive" as const, name: "string" as const } },
          name: expr.name,
        };
        return ctx.target.renderStateRead(stateRef, "handler");
      }
      // A `derived` binding — read like a state field (handler position),
      // no `usesState` (hoisted as a computed, not `useState`).
      if (ctx.derivedNames.has(expr.name)) {
        const derivedRef = {
          field: { name: expr.name, type: { kind: "primitive" as const, name: "string" as const } },
          name: expr.name,
        };
        return ctx.target.renderStateRead(derivedRef, "handler");
      }
      if (ctx.paramNames.has(expr.name)) {
        ctx.usedParams.add(expr.name);
        return expr.name;
      }
      // Refs to shell-emitted locals (e.g. `create`
      // inside a `CreateForm(of:, onSubmit: v => create.mutateAsync(v))`
      // lambda) resolve as themselves.
      if (ctx.shellLocals.has(expr.name)) return expr.name;
      // Refs to `let` bindings are in scope as JS
      // const declarations earlier in the same lambda body.  The IR
      // already tags these with `refKind: "let"`; emit the bare
      // name so the generated code references the local.
      if (expr.refKind === "let") return expr.name;
      return `/* unresolved: ${expr.name} */ undefined`;
    case "binary":
      // Operator-spelling + strict-equality mapping lives in the target's leaf
      // (JS `===`/`!==`; F# `=`/`<>`).
      return ctx.target.exprBinary(emitExpr(expr.left, ctx), emitExpr(expr.right, ctx), expr.op);
    case "ternary":
      // Conditional value in expression position (e.g. a `bool` cell's
      // `onCall ? "Yes" : "No"`).  Distinct from the markup-child `ternary`
      // arm in `walk`, which renders JSX-element branches.
      return ctx.target.exprTernary(
        emitExpr(expr.cond, ctx),
        emitExpr(expr.then, ctx),
        emitExpr(expr.otherwise, ctx),
      );
    case "list":
      // List literal (`["EU", "US"]`) — e.g. a SelectField's `options:`.
      return ctx.target.exprList(expr.elements.map((it) => emitExpr(it, ctx)));
    case "convert":
      // Implicit-string-concat in page bodies (`"Active: " + count`) injects a
      // `convert` IR node around the non-string operand; the leaf emits the
      // per-language cast (`String(x)` on JS, `string x` on F#).
      return ctx.target.exprConvert(emitExpr(expr.value, ctx), expr.target, expr.from);
    case "unary":
      return ctx.target.exprUnary(expr.op, emitExpr(expr.operand, ctx));
    case "call": {
      // Bare function call as a JS expression.  An extern frontend
      // function (`function f(…): T extern from "…"`) registers its
      // use so the shell imports the conformance shim; any other
      // callee is emitted verbatim — the generated code expects the
      // user to import / declare `<name>` somewhere in their app
      // shell.  Powers patterns like `let n = inc(count)` and the
      // statement form `Button("…", onClick: e => { saveOrder() })`.
      // `<Store>.<action>(args)` call (Stage 5) — record the use (so the
      // shell binds the action via the store hook) and emit the bound-local
      // call.  `name` mirrors `storeAction.action`.
      if (expr.callKind === "store-action" && expr.storeAction) {
        if (!ctx.target.renderStoreActionCall) {
          throw new Error(
            `store: ${ctx.target.framework} not yet implemented ` +
              `(\`${expr.storeAction.store}.${expr.storeAction.action}()\` call)`,
          );
        }
        recordStoreUse(ctx, expr.storeAction.store, expr.storeAction.action);
        const callArgs = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
        // The use-site call form is per-frontend: React references the
        // shell-bound local (`clear(args)`); Angular calls the injected store
        // member (`this.cart.clear(args)`).  The seam owns the divergence.
        // `local` is the collision-resolved bound-local name the JS shells use.
        return ctx.target.renderStoreActionCall(
          {
            storeName: expr.storeAction.store,
            action: expr.storeAction.action,
            local: storeLocalFor(ctx, expr.storeAction.store, expr.storeAction.action),
          },
          callArgs,
        );
      }
      if (ctx.externFunctions?.has(expr.name)) ctx.usedExternFunctions?.add(expr.name);
      const args = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
      return `${expr.name}(${args})`;
    }
    case "member": {
      // Plain JS member access: `<recv>.<member>`.  Recursive
      // emit on the receiver — if it was a hook-eligible chain
      //, tryDetectApiHook at the top has already
      // returned the hook var; we just append `.<member>`.
      return `${emitExpr(expr.receiver, ctx)}.${expr.member}`;
    }
    case "lambda": {
      // Lambda in EXPRESSION position — the callback of a higher-order
      // collection op (`orders.filter(o => o.active)`, `.map(o => o.name)`,
      // `.sortBy(o => o.placedAt)`).  This is the one place a lambda node
      // reaches `emitExpr` directly: builder primitives that take a lambda
      // (`For`, `Table` column accessors, `onSubmit`) destructure `.body` /
      // `.block` themselves and never pass the lambda node here, so this arm
      // fires only for the inline-collection-op case that used to emit
      // `/* unsupported expr: lambda */ undefined`.
      //
      // The param binds to its own JS name (the JS frontends spell the
      // binding identically); refs to it inside the body resolve through
      // `lambdaParams`.  Flags the body writes (state reads, used params,
      // …) propagate back to the parent sink.
      const childCtx: WalkContext = {
        ...ctx,
        lambdaParams: extendLambdaParams(ctx, expr.param, expr.param),
      };
      const rendered = expr.body
        ? emitExpr(expr.body, childCtx)
        : `{ ${(expr.block ?? []).map((s) => emitStmt(s, childCtx)).join(" ")} }`;
      propagateChildFlags(ctx, childCtx);
      return `(${expr.param}) => ${rendered}`;
    }
    case "object":
      // Object literal: `{ name: name, age: 30 }` — the leaf owns the
      // per-language spelling (JS `{ n: v }`, F# record).  Field values recurse
      // through emitExpr (so refs/state/binary ops compose).
      return ctx.target.exprObject(
        expr.fields.map((f) => ({ name: f.name, value: emitExpr(f.value, ctx) })),
      );
    case "method-call": {
      // When the method-call's receiver is a hook
      // (detected by tryDetectApiHook on the receiver), emit
      // `<hookVar>.<method>(<args>)` (e.g.
      // `customerCreate.mutate({...})`).
      const recvDetected = tryDetectApiHook(expr.receiver, ctx);
      if (recvDetected) {
        const recvHookUse = ctx.target.buildHookUse(recvDetected, (e) => emitExpr(e, ctx));
        registerApiHook(recvHookUse, ctx);
        const args = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
        return `${recvHookUse.varName}.${expr.member}(${args})`;
      }
      // Method calls on plain JS receivers (e.g. a
      // local `create` mutation hook inside a `CreateForm(of:)` page's
      // onSubmit lambda).  Emit the plain `recv.member(args)`
      // form when the receiver resolves cleanly (param / state /
      // lambda param / shell local).  Receivers that emit as the
      // `/* unresolved: X */ undefined` sentinel keep a visible TODO
      // placeholder — emitting `undefined.<method>(...)` would be
      // runtime-broken code.
      const recv = emitExpr(expr.receiver, ctx);
      const argsRendered = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
      if (recv.includes("/* unresolved:")) {
        const receiverDesc = describeReceiver(expr.receiver);
        return `/* TODO: method-call ${receiverDesc}.${expr.member}(${argsRendered}) — needs hooks {} binding */ undefined`;
      }
      return `${recv}.${expr.member}(${argsRendered})`;
    }
    case "id": {
      // The magic route `id` (`{ kind: "id" }`) — e.g. `Order.byId(id)` on a
      // `/orders/:id` detail page.  Each frontend binds a local `id` from the
      // route param in its page-shell; the seam returns the in-scope accessor.
      ctx.usesRouteId = true;
      return ctx.target.renderRouteId?.() ?? `/* unsupported expr: ${expr.kind} */ undefined`;
    }
    default:
      return `/* unsupported expr: ${expr.kind} */ undefined`;
  }
}

/** Best-effort description of an unresolved method-call receiver
 *  for the placeholder comment (so the user can see WHICH
 *  call landed as the placeholder).  Avoids invoking emitExpr
 *  on the receiver since that path emits a noisy
 *  `unresolved` comment for free identifiers — bad inside the
 *  outer placeholder. */
/** Detect `<param>.<aggregate>.<op>(args?)` rooted
 *  at a UiApiParam ref.  Returns an ApiHookUse on match, or null
 *  to fall through to generic expression handling.
 *
 *  Two patterns:
 *    A. `<param>.<aggregate>.<op>` — non-parameterized hook
 *       (e.g. `Sales.Customer.all`, `Sales.Customer.create`)
 *    B. `<param>.<aggregate>.<op>(args)` — parameterized hook
 *       (e.g. `Sales.Customer.byId(id)`)
 *
 *  Both emit one hook call at page-top.  Anything stacked on top
 *  (`.data`, `.isLoading`, `.mutate(args)`, etc.) is plain JS
 *  member access on the local hook variable — handled by the
 *  default member-access / method-call paths after this helper
 *  has rewritten the deepest 3-segment chain. */
// Api-hook detection/registration (tryDetectApiHook, registerApiHook,
// buildHookUse/buildViewHookUse) and renderApiHookImports live in
// walker/api-hooks.ts; emitExpr/walk call into them.

/** Render a `StmtIR` as a TS statement string (with a trailing
 *  semicolon).  Supports the subset that matters for click handlers:
 *  state mutation (`:=`, `+=`, `-=`), let-binding, and bare expression
 *  statements.  emit / call statements fall through to a comment —
 *  the frontend doesn't run domain logic. */
export function emitStmt(stmt: StmtIR, ctx: WalkContext): string {
  switch (stmt.kind) {
    case "assign": {
      const seg = stmt.target.segments;
      if (ctx.stateNames.has(seg[0]!)) {
        return stateWrite(seg, emitExpr(stmt.value, ctx), ctx);
      }
      return unsupportedPageStmt(
        `assignment to '${seg.join(".")}'`,
        "the React backend only mutates page-state fields (declare the root in `state { … }`)",
      );
    }
    case "add":
    case "remove": {
      // `count += 1` / `count -= 1` lower to
      // `kind: "add"` / `kind: "remove"` in the IR (the same
      // kinds collection-mutations use; for scalar state fields
      // they're compound additions/subtractions).  Walker emits
      // `setCount(count + 1)` — for a nested target the current value
      // reads as the plain member chain (the state root is in scope).
      const seg = stmt.target.segments;
      if (ctx.stateNames.has(seg[0]!)) {
        // Current-value read for the compound assignment.  The ROOT
        // segment always goes through the target's state-read seam
        // (position-aware — Angular reads a signal via a call `count()`,
        // HEEx/Vue diverge in handler position); a nested target then
        // appends the member tail onto the seam's root read.  Emitting
        // the plain `order.shipping.count` chain for a nested Angular
        // target referenced the signal OBJECT instead of its value —
        // it must be `order().shipping.count` (audit finding B22).
        // React/Vue/Svelte reads are the bare name, so the tail-append
        // is byte-identical there.
        const root = seg[0]!;
        const stateRef = {
          field: { name: root, type: { kind: "primitive" as const, name: "string" as const } },
          name: root,
        };
        const rootRead = ctx.target.renderStateRead(stateRef, "handler");
        const read = seg.length === 1 ? rootRead : [rootRead, ...seg.slice(1)].join(".");
        const rhs = emitExpr(stmt.value, ctx);
        // Collection target → append / remove-by-value (immutable; the
        // JS frontends share this and the per-target state-write seam
        // wraps it).  Scalar target → arithmetic compound assignment.
        // `__v` avoids colliding with the handler's event-lambda param.
        const value = stmt.collection
          ? stmt.kind === "add"
            ? `[...${read}, ${rhs}]`
            : `${read}.filter((__v) => __v !== ${rhs})`
          : `${read} ${stmt.kind === "add" ? "+" : "-"} ${rhs}`;
        return stateWrite(seg, value, ctx);
      }
      return unsupportedPageStmt(
        `'${stmt.kind === "add" ? "+=" : "-="}' on '${seg.join(".")}'`,
        "the React backend only mutates page-state fields (declare the root in `state { … }`)",
      );
    }
    case "let":
      return `const ${stmt.name} = ${emitExpr(stmt.expr, ctx)};`;
    case "expression":
      return `${emitExpr(stmt.expr, ctx)};`;
    case "call": {
      // Bare function-call statement (the
      // statement-grammar `name(args)` form).  Walker emits as a
      // plain `name(args);` line; the generated code expects the
      // user to import / declare `<name>` somewhere in their app
      // shell.
      //
      // `target: "action"` — a call to a SIBLING page/component action.  The
      // callee's handler is a `const <name> = (…) => { … }` arrow emitted by
      // `renderActionHandlers`, but ONLY when it's in `usedActions`.  A body
      // call must therefore mark its target used so the callee's handler is
      // emitted alongside the caller's (Proposal A Stage 1).
      if (stmt.target === "action") ctx.usedActions?.add(stmt.name);
      // `target: "store-action"` — a `<Store>.<action>()` call (Stage 5).
      // Record the use so the shell binds the action via the store hook, then
      // emit the bound-local call `<action>(args);`.
      if (stmt.target === "store-action" && stmt.store) {
        if (!ctx.target.renderStoreActionCall) {
          throw new Error(
            `store: ${ctx.target.framework} not yet implemented (\`${stmt.store}.${stmt.name}()\` call)`,
          );
        }
        recordStoreUse(ctx, stmt.store, stmt.name);
        const callArgs = stmt.args.map((a) => emitExpr(a, ctx)).join(", ");
        // Use-site call form is per-frontend (see the expr-position twin
        // above): React → bound local `clear(args)`; Angular → injected member
        // `this.cart.clear(args)`.
        return `${ctx.target.renderStoreActionCall({ storeName: stmt.store, action: stmt.name, local: storeLocalFor(ctx, stmt.store, stmt.name) }, callArgs)};`;
      }
      if (ctx.externFunctions?.has(stmt.name)) ctx.usedExternFunctions?.add(stmt.name);
      const args = stmt.args.map((a) => emitExpr(a, ctx)).join(", ");
      return `${stmt.name}(${args});`;
    }
    case "variant-match":
      return emitVariantMatch(stmt, ctx);
    default:
      return unsupportedPageStmt(
        `statement '${stmt.kind}'`,
        "it has no meaning in a React page event handler",
      );
  }
}

/** OR the walk's mutable BOOLEAN Sink flags from a child context back into its
 *  parent.  Needed when a child ctx was made by SPREAD (`{ ...ctx, lambdaParams }`)
 *  — the spread snapshots the booleans by value, so a body write inside the
 *  child (`usesState` from a `:=`, `usesNavigate` from a `navigate(…)`) would be
 *  lost.  Object sinks (imports / usedApiHooks / usedParams / …) stay shared by
 *  reference and need no copy-back. */
function propagateSinkFlags(from: WalkContext, to: WalkContext): void {
  to.usesState ||= from.usesState;
  to.usesNavigate ||= from.usesNavigate;
  to.usesRouteId ||= from.usesRouteId;
  to.usesCurrentUser ||= from.usesCurrentUser;
  to.usesRouterLink ||= from.usesRouterLink;
  to.usesChildren ||= from.usesChildren;
  to.usesCodeBlock ||= from.usesCodeBlock;
  if (from.usesFragment) to.usesFragment = true;
}

/** Add a named import the page/component shell must emit (`from` module →
 *  `name`).  A thin wrapper over `ctx.imports` (an `ImportMap`) so the
 *  variant-match envelope can pull in `ApiError` + the op's union response
 *  type without reaching for the primitive-layer `addImport` (which would form
 *  a runtime import cycle back into this module). */
function addPageImport(ctx: WalkContext, from: string, name: string): void {
  let names = ctx.imports.get(from);
  if (!names) {
    names = new Set<string>();
    ctx.imports.set(from, names);
  }
  names.add(name);
}

/** Emit a `variant-match` StmtIR (async-actions-and-effects.md Stage 2) — the
 *  `match await <op>() { Variant b => … }` effect form in a frontend action
 *  body.  walker-core does the FRAMEWORK-NEUTRAL work here — detect the awaited
 *  subject's remote mutation (register its hook for hoisting; the op needs the
 *  route `id`, its args become the request payload), classify the error variant
 *  from the owning context's `error` payloads, and pre-render every arm body —
 *  then delegates the framework-shaped skeleton (async try/catch + switch) to
 *  `ctx.target.renderVariantMatch`.  A target that doesn't implement the seam
 *  falls back to `unsupportedPageStmt` so the statement is never silently
 *  dropped. */
function emitVariantMatch(
  stmt: Extract<StmtIR, { kind: "variant-match" }>,
  ctx: WalkContext,
): string {
  if (!ctx.target.renderVariantMatch) {
    return unsupportedPageStmt(
      "statement 'variant-match'",
      `the ${ctx.target.framework} frontend has no variant-match rendering yet ` +
        `(async-actions-and-effects.md Stage 2)`,
    );
  }
  // Detect the awaited remote op in the subject position (Pattern B/E:
  // `Sales.Order.placeOrder(…)` / `Order.placeOrder(…)`).
  const detected = tryDetectApiHook(stmt.subject, ctx);
  let mutationVar = "";
  let mutateArgs = "{}";
  let bc: BoundedContextIR | undefined;
  let resultType: string | undefined;
  if (detected) {
    bc = ctx.bcByAggregate.get(detected.aggregateName);
    const agg = ctx.aggregatesByName.get(detected.aggregateName);
    const op = agg?.operations.find((o) => o.name === detected.operation);
    // An aggregate `operation` is an INSTANCE command — its hook takes the
    // route `id` at hook time and the request payload at `mutateAsync` time.
    // Hoist the hook with the route id (the shell binds `id` from the route
    // params), and map the awaited call's positional args onto the op's params
    // to build the request object.
    const routeId = ctx.target.renderRouteId?.() ?? "id";
    ctx.usesRouteId = true;
    // The route id is `string | undefined` at the shell (React's
    // `useParams` types it optional), but an instance-op hook takes a
    // definite `string`.  Coerce with the same `id ?? ""` idiom the
    // delete-button confirm handler uses — on a detail page the id is
    // always present at runtime, so the fallback never fires.
    const hookUse = {
      ...ctx.target.buildHookUse(detected, (e) => emitExpr(e, ctx)),
      argsRendered: [`${routeId} ?? ""`],
    };
    registerApiHook(hookUse, ctx);
    mutationVar = hookUse.varName;
    const params = op?.params ?? [];
    mutateArgs =
      params.length === 0
        ? "{}"
        : `{ ${params
            .map(
              (p, i) =>
                `${p.name}: ${detected.args[i] ? emitExpr(detected.args[i]!, ctx) : "undefined"}`,
            )
            .join(", ")} }`;
    if (agg && op) {
      // The op's `or`-union response type — the discriminated union the
      // api-module emits.  The action's `result` narrows on it, and the
      // page-shell imports it alongside the hook.
      resultType = `${upperFirstName(op.name)}${agg.name}Response`;
      addPageImport(ctx, `${hookUse.importFrom}`, resultType);
    }
  }
  // Classify the error variant (v1: at most one) via the owning context's
  // `error` payloads — the lowered arm `isError` hint is unreliable from a UI
  // body (its lowering env can't see the domain context), so the payload
  // classification is authoritative; the hint is an OR-fallback.
  const isErrorTag = (tag: string, hint: boolean | undefined): boolean =>
    hint === true || !!bc?.payloads.some((p) => p.name === tag && p.kind === "error");

  const arms = stmt.arms.map((arm) => {
    const tag = variantTag(arm.varType);
    // Bind the narrowed variant local so `o.code` resolves inside the arm.  The
    // spread copies the parent Sink's BOOLEAN flags by value (object sinks —
    // imports / usedApiHooks / usedParams — stay shared by reference), so any
    // `usesState` / `usesNavigate` a body write flips must be OR'd back into the
    // parent afterwards (else the shell skips the `useState` the setter needs).
    const armCtx: WalkContext = arm.binding
      ? { ...ctx, lambdaParams: extendLambdaParams(ctx, arm.binding, arm.binding) }
      : ctx;
    const body = arm.body.map((s) => emitStmt(s, armCtx));
    if (armCtx !== ctx) propagateSinkFlags(armCtx, ctx);
    return { tag, binding: arm.binding, body, isError: isErrorTag(tag, arm.isError) };
  });
  // All error arms (not just the first) — each paired with the RFC-7807 `type`
  // URI the backend stamps, so a multi-error reify can map the caught URI back to
  // the matching variant tag.  `errorTypeUri` is the shared derivation every
  // backend's ProblemDetails translator uses, so the client map stays in sync.
  const errorVariants = arms
    .filter((a) => a.isError)
    .map((a) => ({ tag: a.tag, uri: errorTypeUri(a.tag) }));
  if (errorVariants.length > 0) addPageImport(ctx, "../api/client", "ApiError");
  const elseBody = stmt.elseBody?.map((s) => emitStmt(s, ctx));

  return ctx.target.renderVariantMatch({
    mutationVar,
    mutateArgs,
    resultType,
    arms: arms.map(({ tag, binding, body }) => ({ tag, binding, body })),
    errorVariants,
    elseBody,
  });
}

/** A page event-handler statement the React walker can't lower.  We throw
 *  rather than emit a `/* unsupported *\/` comment: the old comment compiled
 *  fine but silently dropped the statement at runtime (e.g. a button whose
 *  handler does nothing).  Failing generation surfaces the gap loudly — see
 *  the same rationale in src/ir/validate/validate.ts (test-body fallbacks). */
/** Immutable React state write for a (possibly nested) `state` target.
 *  Single segment delegates the `setName(value)` shape to the active
 *  target (see `src/generator/_walker/target.ts`).  A multi-segment
 *  target (`order.shipping.zip := v`) builds the standard nested-spread
 *  update from the inside out:
 *  `setOrder({ ...order, shipping: { ...order.shipping, zip: v } })` —
 *  React state is immutable, so in-place member assignment would not
 *  re-render.  The spread construction is JS-flavoured by design; a
 *  target whose nested-write idiom differs (Vue refs mutate in place)
 *  revisits this seam when its walker integration lands.  The trailing
 *  `;` is statement-position context. */
function stateWrite(seg: readonly string[], valueJs: string, ctx: WalkContext): string {
  ctx.usesState = true;
  const root = seg[0]!;
  // Single-segment write delegates to the target's setter/assignment;
  // a multi-segment (nested) write goes through the dedicated seam,
  // since the idiom diverges (React immutable spread vs Vue/Svelte
  // in-place mutation).
  if (seg.length === 1) {
    const stateRef = {
      field: { name: root, type: { kind: "primitive" as const, name: "string" as const } },
      name: root,
    };
    return `${ctx.target.renderStateWrite(stateRef, valueJs)};`;
  }
  return `${ctx.target.renderNestedStateWrite(seg, valueJs)};`;
}

function unsupportedPageStmt(what: string, why: string): never {
  throw new Error(`react: unsupported ${what} in a page event handler — ${why}.`);
}

/** Read a named arg as a navigation target.  String
 *  literals come back JSON-quoted (`"\"/orders\""`); refs to a
 *  route param come back as a JS template literal that interpolates
 *  the param at render time (so `to: id` → `` `${id}` ``).  Returns
 *  undefined when the arg isn't present or isn't a recognised
 *  navigation source. */
export function stringOrRefArgValue(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "string") {
      return JSON.stringify(a.value);
    }
    if (a.kind === "ref" && ctx.paramNames.has(a.name)) {
      ctx.usedParams.add(a.name);
      return `\`\${${a.name}}\``;
    }
  }
  return undefined;
}

/** Read the `style:` IR field hoisted from a `style: { … }` named arg
 *  on a walker-primitive call.  Returns a JSX `style={{ ... }}` attribute
 *  fragment (with a leading space) ready to splice into the template's
 *  opening tag — or `''` when the call carries no `style` field.
 *
 *  Keys are camelCased on the way out (CSS property → React-style
 *  property): `background-color` → `backgroundColor`, but
 *  `backgroundColor` passes through.  Values are emitted via
 *  `emitExpr` so refs / param interpolation compose naturally.
 *
 *  Templates splice via `{{{styleAttr}}}` mirroring `{{{testidAttr}}}`. */
export function styleAttr(call: ExprIR & { kind: "call" }, ctx: WalkContext): string {
  if (!call.style || call.style.entries.length === 0) return "";
  // Render each entry's value through the walker (refs / param
  // interpolation compose), then hand the framework-shaped attribute
  // rendering to the target (TSX camel-cases keys into a JSX object;
  // Svelte emits a CSS string with `{}` interpolation).
  const entries = call.style.entries.map(({ key, value }) => ({
    key,
    rendered: emitExpr(value, ctx),
    literal: value.kind === "literal" && value.lit === "string" ? value.value : undefined,
  }));
  return ctx.target.renderStyleAttr(entries);
}

/** Read the `testid:` named arg from any primitive call
 *  and produce a TSX attribute fragment ready to splice into the
 *  template's opening tag.  Returns `' data-testid="..."'` for
 *  string literals, `' data-testid={...}'` for refs/expressions, or
 *  `''` when no `testid:` was supplied.  Templates splice via
 *  `{{{testidAttr}}}` inside the root element.
 *
 *  String-literal testids also accumulate on
 *  `ctx.collectedTestids` so the walker-side page-object emitter
 *  can expose each one as a typed `Locator` getter in the
 *  generated `e2e/pages/<page-snake>.ts` class. */
export function testidAttr(call: ExprIR & { kind: "call" }, ctx: WalkContext): string {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== "testid") continue;
    const a = call.args[i]!;
    // String literal → quoted attr (no braces).
    if (a.kind === "literal" && a.lit === "string") {
      ctx.collectedTestids.add(a.value);
      return ` data-testid=${JSON.stringify(a.value)}`;
    }
    // Anything else → run through emitExpr; bind as a dynamic
    // attribute through the target.  Refs to params/state, binary
    // ops, calls, etc. all compose.
    const expr = emitExpr(a, ctx);
    return ctx.target.renderAttrBinding("data-testid", expr);
  }
  return "";
}

// Leaf display primitives (Stat, Badge, Slot, Divider, Breadcrumbs,
// Paper, Skeleton, Alert) live in walker/primitives/display.ts.

/** QueryView(of:, loading:, error:, empty:, data:, testid?).
 *
 *  Macro for the canonical "4-arm query state" rendering pattern
 *  the scaffold List page emits inline.  Takes a query
 *  expression and four branch bodies; lowers to a fragment of
 *  guarded JSX expressions that render the right branch for the
 *  query's current state.
 *
 *  Surface:
 *
 *    QueryView(
 *      of:      Sales.Order.all,
 *      loading: Skeleton(count: 5),
 *      error:   Alert("Couldn't load orders"),
 *      empty:   Empty("No orders yet."),
 *      data:    rows => Table(rows: rows, …)
 *    )
 *
 *  The `of:` expression must resolve to a React-Query hook
 *  variable (typically via the walker's api-hook detection of
 *  `<param>.<aggregate>.all`).  The hook's `.isLoading`,
 *  `.isError`, `.data` properties drive the four conditional
 *  branches.
 *
 *  The `data` branch is special: when it's a lambda (`rows => …`),
 *  the lambda param rebinds to the unwrapped data inside the
 *  branch.  When it's a plain expression, the branch renders that
 *  expression directly (still inside the `data &&` guard).
 *
 *  All four branch args are required; any missing arg gets a
 *  null-render placeholder so the page still compiles. */
// Interactive control primitives (Button, IdLink, QueryView,
// UserComponent) live in walker/primitives/controls.ts.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function positionalChildren(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string[] {
  return positionalArgs(call).map((a) => walk(a, ctx, depth));
}

/** Return the JSX-render shape of the first
 *  positional arg as a TEXT-position content.  Quoted strings
 *  come back as `"text"` (so callers wrap them in {} when needed
 *  or strip the quotes for direct JSX text); refs come back as
 *  `{name}` (already JSX-expression-wrapped).  Returns undefined
 *  when the first positional isn't a recognisable text source. */
export function firstPositionalContent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): string | undefined {
  const positionals = positionalArgs(call);
  const first = positionals[0];
  if (!first) return undefined;
  return renderTextContent(first, ctx);
}

export function renderTextContent(expr: ExprIR, ctx: WalkContext): string | undefined {
  if (expr.kind === "literal" && expr.lit === "string") {
    return JSON.stringify(expr.value);
  }
  if (expr.kind === "ref") {
    // A lambda/loop-bound ref (the `x` of `For { each: xs, x => Card { x } }`,
    // a `rows => …` item) resolves to its emitted iteration variable — the same
    // resolution `emitExpr` does in markup-child position.  Without this a
    // loop-bound ref in TEXT position (a Card/Heading/Text title) falls through
    // to the unresolved-ref comment below and the value renders blank.
    {
      const jsName = ctx.lambdaParams.get(expr.name);
      if (jsName) return ctx.target.renderInterpolation(jsName);
    }
    // `<Store>.<field>` read in text position (Stage 5) — record the use and
    // interpolate the bound local (the shell hoists the store selector).
    if (expr.refKind === "store-field" && expr.storeName) {
      if (!ctx.target.renderStoreFieldRead) {
        throw new Error(
          `store: ${ctx.target.framework} not yet implemented (\`${expr.storeName}.${expr.name}\` read)`,
        );
      }
      recordStoreUse(ctx, expr.storeName, expr.name);
      return ctx.target.renderInterpolation(storeFieldReadUseSite(ctx, expr.storeName, expr.name));
    }
    if (ctx.paramNames.has(expr.name)) {
      ctx.usedParams.add(expr.name);
      return ctx.target.renderInterpolation(expr.name);
    }
    if (ctx.stateNames.has(expr.name)) {
      ctx.usesState = true;
      // Delegated to the target's renderStateRead — markup text
      // position (interpolated inline).
      const stateRef = {
        field: { name: expr.name, type: { kind: "primitive" as const, name: "string" as const } },
        name: expr.name,
      };
      return ctx.target.renderInterpolation(ctx.target.renderStateRead(stateRef, "template"));
    }
    // A `derived` binding — read like state (interpolated), no `usesState`.
    if (ctx.derivedNames.has(expr.name)) {
      const derivedRef = {
        field: { name: expr.name, type: { kind: "primitive" as const, name: "string" as const } },
        name: expr.name,
      };
      return ctx.target.renderInterpolation(ctx.target.renderStateRead(derivedRef, "template"));
    }
    // Unresolved ref in text position emits a JSX
    // comment so the user sees the unresolved name in the
    // generated file (the page still compiles; the comment makes
    // the gap visible).
    return ctx.target.renderComment(`ref: ${expr.name}`);
  }
  // Anything else (binary op, unary, non-string
  // literal): emit the JS-expression form as an inline
  // interpolation.  Powers patterns like `Heading("Welcome, " +
  // name)`, `Text(count + 1)`, `Stat("Count", count * step)`.
  //
  // A bare `call` in text position is a stdlib-primitive / user-
  // component invocation — fall through to undefined so the caller
  // `walk`s it as a child component rather than emitting a JS call.
  // EXCEPT a call to an extern frontend function (`function f(…): T
  // extern from "…"`): that is a value-producing JS call — emit it as
  // an inline interpolation and register the shim import.
  if (expr.kind === "call") {
    if (ctx.externFunctions?.has(expr.name)) {
      return ctx.target.renderInterpolation(emitExpr(expr, ctx));
    }
    return undefined;
  }
  // A structurally-provable string (a bare literal, a Yes/No conditional of
  // string literals) lets a text-coercing target (Feliz) drop a redundant cast;
  // `undefined` — including every member/ref read — means "coerce".
  return ctx.target.renderInterpolation(emitExpr(expr, ctx), provableStringType(expr));
}

// The page-file shell (renderCustomLayoutPage, the form-wiring renderers,
// renderUserComponentFile, and the state/type helpers) lives in
// walker/page-shell.ts. It consumes this module's core walker
// (walkBodyToTsx) plus the FormOfState records pushed onto the walk sink.
