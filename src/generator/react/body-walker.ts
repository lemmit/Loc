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
//   - `walkBodyToTsx(body)` — { tsx, imports } where `tsx` is the
//     JSX expression and `imports` is the Mantine specifiers that
//     need to be at the top of the page file.
//   - `isWalkableLayoutBody(body)` — predicate the page emitter
//     uses to decide whether to dispatch to the walker.

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  OperationIR,
  ParamIR,
  StmtIR,
  UiApiParamIR,
  UiHelperImportIR,
  WorkflowIR,
} from "../../ir/loom-ir.js";
import type { LoadedPack } from "../_packs/loader.js";
import { registerApiHook, tryDetectApiHook } from "./walker/api-hooks.js";
import {
  emitAction,
  emitButton,
  emitIdLink,
  emitQueryView,
  emitUserComponent,
} from "./walker/primitives/controls.js";
import {
  emitAlert,
  emitBadge,
  emitBreadcrumbs,
  emitDivider,
  emitPaper,
  emitSkeleton,
  emitSlot,
  emitStat,
} from "./walker/primitives/display.js";
import {
  emitCreateForm,
  emitModal,
  emitOperationForm,
  emitWorkflowForm,
} from "./walker/primitives/forms.js";
import {
  emitField,
  emitNumberField,
  emitPasswordField,
  emitToggle,
} from "./walker/primitives/inputs.js";
import {
  emitCard,
  emitContainer,
  emitGrid,
  emitGroup,
  emitStack,
  emitTabs,
  emitToolbar,
} from "./walker/primitives/layout.js";
import { emitTable } from "./walker/primitives/table.js";
import {
  emitAnchor,
  emitAvatar,
  emitDateDisplay,
  emitEmpty,
  emitEnumBadge,
  emitHeading,
  emitImage,
  emitKeyValueRow,
  emitLoader,
  emitMoney,
  emitText,
} from "./walker/primitives/text.js";
import { describeReceiver, escapeJsxText, positionalArgs } from "./walker/shared/args.js";

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
// renderApiHookImports, renderHelperImports) live in
// walker/import-lines.ts.

export interface WalkResult {
  tsx: string;
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
  /** True when any walked node emitted JSX that
   *  references React Router's `Link` component (e.g.
   *  `Anchor("…", to: …)` → `<Anchor component={RouterLink}>`).
   *  The shell adds `Link as RouterLink` to the existing
   *  react-router-dom import — the alias keeps the slot free for
   *  design packs whose own primitive is named `Link` (MUI,
   *  chakra) without an identifier collision. */
  usesRouterLink: boolean;
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
  /** Non-null when the body contained a `Form(of: <Agg>)`
   *  primitive.  Shell consumes this to emit `useForm` / `Controller`
   *  imports, mutation hook, `defaultValues`, and the `onSubmit`
   *  handler that wraps the form's `<form onSubmit={…}>`. */
  formOfs: FormOfState[];
  /** Every static `testid:` literal encountered while
   *  walking the body, plus the synthesised testid bases the walker
   *  generates on the user's behalf (e.g. `<form-namespace>-input-
   *  <field>` for each `Form(of:)` field, `<form-namespace>-submit`
   *  for the submit button).  The walker-side page-object emitter
   *  reads this set to surface one typed `Locator` getter per
   *  testid in the generated `e2e/pages/<page-snake>.ts` class. */
  collectedTestids: Set<string>;
  /** Names of UI-declared helpers the body actually
   *  invoked.  The shell emits one `import { <name> } from
   *  "<path>"` line per used helper; declared-but-unused helpers
   *  don't pollute the page TSX. */
  usedHelpers: Set<string>;
  /** `Action(<instance>.<op>)` mutation wiring.  Each entry tells the
   *  shell to declare `const <localVar> = <hookName>(<idExpr>)` at
   *  function top and import the hook from `<prefix>api/<aggCamel>`. */
  actionMutations: ActionMutationState[];
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
  argsRendered: string[];
}

/** Component names the walker recognises.  Used by the page
 *  emitter to fast-fail dispatch when a body is neither a scaffold
 *  archetype nor a layout primitive — those pages stay silent. */
const STDLIB_LAYOUT_COMPONENTS = new Set<string>([
  "Stack",
  "Group",
  "Grid",
  "Container",
  "Tabs",
  "Toolbar",
  "Empty",
  "Field",
  "NumberField",
  "PasswordField",
  "Toggle",
  "Loader",
  "Anchor",
  "Image",
  "Avatar",
  "Slot",
  "Heading",
  "Text",
  "Button",
  "Card",
  "Stat",
  "Badge",
  "Divider",
  "Table",
  "Money",
  "DateDisplay",
  "EnumBadge",
  "IdLink",
  "CreateForm",
  "OperationForm",
  "WorkflowForm",
  "Breadcrumbs",
  "Paper",
  "Skeleton",
  "Alert",
  "QueryView",
  "KeyValueRow",
  "Modal",
]);

export function isWalkableLayoutBody(
  body: ExprIR | undefined,
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  helperNames: ReadonlySet<string> = new Set(),
): boolean {
  if (!body) return false;
  if (body.kind === "call") {
    if (STDLIB_LAYOUT_COMPONENTS.has(body.name)) return true;
    // Calls to user-defined components are walker-
    // eligible too (resolved via the supplied map).
    if (userComponents.has(body.name)) return true;
    // A body whose top-level call is a UI-declared
    // helper is walker-eligible: the helper renders the page's
    // JSX in user land.  Without this, `body: RenderBanner("hi")`
    // would be silently skipped.
    return helperNames.has(body.name);
  }
  // Top-level conditional bodies dispatch through the
  // walker as long as either branch is walkable.  Powers patterns
  // like `body: loading ? Empty("…") : Stack(…)`.
  if (body.kind === "ternary") {
    return (
      isWalkableLayoutBody(body.then, userComponents, helperNames) ||
      isWalkableLayoutBody(body.otherwise, userComponents, helperNames)
    );
  }
  return false;
}

export function walkBodyToTsx(
  body: ExprIR,
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
   *  `Form(of: <Agg>)` and `IdLink(of: <Agg>)` look up the
   *  aggregate's IR here (field list for form dispatch; display-
   *  marked field for IdLink's link text). */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Bounded-context map keyed by aggregate name.  The
   *  form-field preparer needs the BC to resolve enum / value-
   *  object types declared alongside the aggregate. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** User-authored helper imports declared at the UI
   *  level via `import helper <name> from "<path>"`.  Body refs
   *  matching one of these names emit as plain JS calls and the
   *  shell adds the matching `import { <name> } from "<path>"`. */
  helperImports: ReadonlyArray<UiHelperImportIR> = [],
  /** Workflows reachable from this UI's deployable.
   *  `Form(runs: <wf>)` looks up the workflow's IR here (param
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
): WalkResult {
  const apiParamNames = new Map<string, string>();
  for (const p of apiParams) apiParamNames.set(p.name, p.apiName);
  const helperNameToPath = new Map<string, string>();
  for (const h of helperImports) helperNameToPath.set(h.name, h.path);
  const ctx: WalkContext = {
    imports: new Map(),
    pack,
    paramNames,
    paramTypes,
    pageRoutes,
    usedParams: new Set(),
    usesNavigate: false,
    stateNames,
    usesState: false,
    usesRouterLink: false,
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
    actionMutations: [],
    collectedTestids: new Set(),
    helperImports: helperNameToPath,
    usedHelpers: new Set(),
  };
  const tsx = walk(body, ctx, 0);
  return {
    tsx,
    imports: ctx.imports,
    usedParams: ctx.usedParams,
    usesNavigate: ctx.usesNavigate,
    usesState: ctx.usesState,
    usesRouterLink: ctx.usesRouterLink,
    usedUserComponents: ctx.usedUserComponents,
    usesChildren: ctx.usesChildren,
    usedApiHooks: ctx.usedApiHooks,
    formOfs: ctx.formOfs,
    actionMutations: ctx.actionMutations,
    collectedTestids: ctx.collectedTestids,
    usedHelpers: ctx.usedHelpers,
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
  pack: LoadedPack;
  paramNames: ReadonlySet<string>;
  stateNames: ReadonlySet<string>;
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
  apiParamNames: ReadonlyMap<string, string>;
  /** Lambda params bound in the current sub-walk
   *  (source-side name → emitted JS name).  `Column("ID", o => o.id)`
   *  walks the accessor body with `o → "row"`; refs to `o` resolve
   *  to the JS identifier `row`.  Outer scope is unaffected. */
  lambdaParams: ReadonlyMap<string, string>;
  /** Identifiers emitted by the page shell that user-
   *  written sub-expressions can reference (e.g. inside a
   *  `Form(of:, onSubmit:)` lambda, `create` is the mutation hook
   *  declared at function top).  Refs matching a name in this set
   *  emit as the bare identifier — no `unresolved` comment. */
  shellLocals: ReadonlySet<string>;
  /** Aggregates reachable from this UI's deployable.
   *  Powers `Form(of: <Agg>)` field dispatch and `IdLink(of: <Agg>)`
   *  display-field resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Map aggregate name → owning bounded context, so the
   *  form-field preparer can resolve enums / value-objects declared
   *  in the same context. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  /** Workflows reachable from this UI's deployable.
   *  Powers `Form(runs: <wf>)` field dispatch. */
  workflowsByName: ReadonlyMap<string, WorkflowIR>;
  /** Owning bounded context per workflow. */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR>;
  /** UI helper-import lookup (name → import path).
   *  Populated by `walkBodyToTsx` from the UI's `helperImports`
   *  parameter; consulted by `emitComponent`'s fallthrough so
   *  body calls to a helper name emit as plain JS calls. */
  helperImports: ReadonlyMap<string, string>;
}

/** Mutable accumulators written during the walk; read by the page
 *  shell afterwards.  Always shared by reference. */
export interface Sink {
  imports: ImportMap;
  usedParams: Set<string>;
  usesNavigate: boolean;
  usesState: boolean;
  usesRouterLink: boolean;
  usedUserComponents: Set<string>;
  usesChildren: boolean;
  usedApiHooks: Map<string, ApiHookUse>;
  /** When `Form(of: <Agg>)` or `Form(runs: <wf>)`
   *  is walked, the emitter records the metadata the shell needs
   *  (aggregate or workflow, BC, optional user-supplied
   *  `onSubmit:` lambda body, redirect path) so the shell can
   *  emit `useForm` + mutation hook + `handleSubmit` wiring at
   *  function top. */
  formOfs: FormOfState[];
  /** `Action(<instance>.<op>)` mutation wiring (see
   *  `ActionMutationState`). */
  actionMutations: ActionMutationState[];
  /** Accumulator for static `testid:` strings the body
   *  emits, used by the walker-side page-object builder. */
  collectedTestids: Set<string>;
  /** Names of helpers the body actually called.  The
   *  shell emits one import line per used helper; declared-but-
   *  unused helpers don't pollute the page TSX. */
  usedHelpers: Set<string>;
}

/** The combined context the shared core threads. Structurally
 *  assignable to both `WalkEnv` and `Sink`. */
export interface WalkContext extends WalkEnv, Sink {}

/** RHF wiring requirements recorded by `emitFormOf`,
 *  consumed by the page shell to splice the `useForm` declaration +
 *  request type + mutation hook + per-field `useAll<TargetX>` hooks
 *  at the top of the function body.
 *
 *  Discriminated union: `kind: "aggregate"` for `Form(of: <Agg>)`,
 *  `kind: "workflow"` for `Form(runs: <wf>)`.  The two share most
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

/** `Form(<instance>.<operation>)` — an aggregate-operation
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

export function walk(expr: ExprIR, ctx: WalkContext, depth: number): string {
  // Api hook injection (JSX-child position).
  // Detect `<param>.<aggregate>.<op>` rooted at a UiApiParam.
  // In JSX-child position, the local hook var is brace-wrapped.
  const hookUse = tryDetectApiHook(expr, ctx);
  if (hookUse) {
    registerApiHook(hookUse, ctx);
    return `{${hookUse.varName}}`;
  }
  switch (expr.kind) {
    case "call":
      return emitComponent(expr, ctx, depth);
    case "literal":
      // String literal in a child position becomes a JSX text node.
      // Other literal kinds (int / decimal / bool) stay as
      // expression-bracketed JS literals.
      if (expr.lit === "string") return escapeJsxText(expr.value);
      if (expr.lit === "bool") return `{${expr.value}}`;
      if (expr.lit === "null") return `{null}`;
      return `{${expr.value}}`;
    case "ref":
      // Refs to a lambda-bound param resolve to its
      // emitted JS name (e.g. `o.id` inside `o => …` walks with
      // `o → "row"`).  Brace-wrap as a JSX child.
      {
        const jsName = ctx.lambdaParams.get(expr.name);
        if (jsName) return `{${jsName}}`;
      }
      // Refs that match a route param name emit as
      // JSX expressions (`{name}`).  React Router's `useParams()`
      // brings these into scope at render time; the page-shell
      // generator destructures the used names.  Refs that don't
      // match a param emit as a placeholder JSX comment so the
      // build error stays visible.
      if (ctx.paramNames.has(expr.name)) {
        ctx.usedParams.add(expr.name);
        return `{${expr.name}}`;
      }
      // Refs that match a state field name emit the
      // same way; the shell brings them into scope via `useState`.
      if (ctx.stateNames.has(expr.name)) {
        ctx.usesState = true;
        return `{${expr.name}}`;
      }
      return `{/* ref: ${expr.name} */}`;
    case "ternary": {
      // Conditional rendering.  `cond ? <A /> : <B />`
      // works as a top-level body (depth 0 — JSX-element inside the
      // function's `return ( … )` parens).  In nested child
      // position, JSX requires brace-wrapping `{ cond ? … : … }`.
      const cond = emitExpr(expr.cond, ctx);
      const thenS = walk(expr.then, ctx, depth + 1);
      const elseS = walk(expr.otherwise, ctx, depth + 1);
      const inner = `${cond} ? (\n${"  ".repeat(depth + 1)}${thenS}\n${"  ".repeat(depth)}) : (\n${"  ".repeat(depth + 1)}${elseS}\n${"  ".repeat(depth)})`;
      return depth === 0 ? inner : `{${inner}}`;
    }
    case "member":
      // Member access in JSX-child position (e.g. an
      // accessor lambda body `o => o.id` walks `o.id` as the body
      // of a `<Table.Td>` cell).  Emit as a brace-wrapped JS
      // expression; `emitExpr` resolves the receiver (lambda
      // param, hook, state) and concatenates the member name.
      return `{${emitExpr(expr, ctx)}}`;
    default:
      return `{/* unsupported expr: ${expr.kind} */}`;
  }
}

function emitComponent(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  switch (call.name) {
    case "Stack":
      return emitStack(call, ctx, depth);
    case "Group":
      return emitGroup(call, ctx, depth);
    case "Grid":
      return emitGrid(call, ctx, depth);
    case "Container":
      return emitContainer(call, ctx, depth);
    case "Tabs":
      return emitTabs(call, ctx, depth);
    case "Table":
      return emitTable(call, ctx, depth);
    case "Money":
      return emitMoney(call, ctx, depth);
    case "DateDisplay":
      return emitDateDisplay(call, ctx, depth);
    case "EnumBadge":
      return emitEnumBadge(call, ctx, depth);
    case "IdLink":
      return emitIdLink(call, ctx, depth);
    case "CreateForm":
      return emitCreateForm(call, ctx, depth);
    case "OperationForm":
      return emitOperationForm(call, ctx, depth);
    case "WorkflowForm":
      return emitWorkflowForm(call, ctx, depth);
    case "Breadcrumbs":
      return emitBreadcrumbs(call, ctx, depth);
    case "Paper":
      return emitPaper(call, ctx, depth);
    case "Skeleton":
      return emitSkeleton(call, ctx, depth);
    case "Alert":
      return emitAlert(call, ctx, depth);
    case "QueryView":
      return emitQueryView(call, ctx, depth);
    case "KeyValueRow":
      return emitKeyValueRow(call, ctx, depth);
    case "Toolbar":
      return emitToolbar(call, ctx, depth);
    case "Empty":
      return emitEmpty(call, ctx, depth);
    case "Field":
      return emitField(call, ctx, depth);
    case "NumberField":
      return emitNumberField(call, ctx, depth);
    case "PasswordField":
      return emitPasswordField(call, ctx, depth);
    case "Toggle":
      return emitToggle(call, ctx, depth);
    case "Loader":
      return emitLoader(call, ctx, depth);
    case "Anchor":
      return emitAnchor(call, ctx, depth);
    case "Image":
      return emitImage(call, ctx, depth);
    case "Avatar":
      return emitAvatar(call, ctx, depth);
    case "Slot":
      return emitSlot(call, ctx, depth);
    case "Heading":
      return emitHeading(call, ctx, depth);
    case "Text":
      return emitText(call, ctx, depth);
    case "Button":
      return emitButton(call, ctx, depth);
    case "Action":
      return emitAction(call, ctx, depth);
    case "Card":
      return emitCard(call, ctx, depth);
    case "Modal":
      return emitModal(call, ctx, depth);
    case "Stat":
      return emitStat(call, ctx, depth);
    case "Badge":
      return emitBadge(call, ctx, depth);
    case "Divider":
      return emitDivider(call, ctx, depth);
    default: {
      // Names not in the stdlib dispatch table fall
      // through to user-component invocation when they match a
      // registered ComponentIR.
      if (ctx.userComponents.has(call.name)) {
        return emitUserComponent(call, ctx, depth);
      }
      // UI-declared helper imports (`import helper
      // <name> from "..."`) emit as plain JS calls in JSX-child
      // position (brace-wrapped).  The shell adds the matching
      // import line once `usedHelpers` is populated.
      if (ctx.helperImports.has(call.name)) {
        ctx.usedHelpers.add(call.name);
        const args = call.args.map((a) => emitExpr(a, ctx)).join(", ");
        return `{${call.name}(${args})}`;
      }
      return `{/* unknown layout component: ${call.name} */}`;
    }
  }
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
  if (child.usesState) parent.usesState = true;
  if (child.usesChildren) parent.usesChildren = true;
  for (const f of child.formOfs) {
    if (!parent.formOfs.includes(f)) parent.formOfs.push(f);
  }
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

/** Form(of: <Aggregate>, onSubmit?: <lambda>, testid?).
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
// The Form family (Form(of:)/Form(runs:)/Form(of:,op:)) and the Modal
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
  // When matched, register a hook usage on the context and return
  // the local hook variable name; the shell emits the
  // `const <var> = use<Op><Aggregate>(args)` declaration at page-top.
  const hookUse = tryDetectApiHook(expr, ctx);
  if (hookUse) {
    registerApiHook(hookUse, ctx);
    return hookUse.varName;
  }
  switch (expr.kind) {
    case "literal":
      if (expr.lit === "string") return JSON.stringify(expr.value);
      if (expr.lit === "bool") return expr.value;
      if (expr.lit === "null") return "null";
      // int / decimal / now → emit as numeric literal verbatim.
      return String(expr.value);
    case "ref":
      // Lambda-bound param refs resolve to their
      // emitted JS name (e.g. `o → "row"` for column accessors).
      {
        const jsName = ctx.lambdaParams.get(expr.name);
        if (jsName) return jsName;
      }
      if (ctx.stateNames.has(expr.name)) {
        ctx.usesState = true;
        return expr.name;
      }
      if (ctx.paramNames.has(expr.name)) {
        ctx.usedParams.add(expr.name);
        return expr.name;
      }
      // Refs to shell-emitted locals (e.g. `create`
      // inside a `Form(of:, onSubmit: v => create.mutateAsync(v))`
      // lambda) resolve as themselves.
      if (ctx.shellLocals.has(expr.name)) return expr.name;
      // Refs to `let` bindings are in scope as JS
      // const declarations earlier in the same lambda body.  The IR
      // already tags these with `refKind: "let"`; emit the bare
      // name so the generated code references the local.
      if (expr.refKind === "let") return expr.name;
      return `/* unresolved: ${expr.name} */ undefined`;
    case "binary":
      return `(${emitExpr(expr.left, ctx)} ${expr.op} ${emitExpr(expr.right, ctx)})`;
    case "convert": {
      // Mirrors `generator/typescript/render-expr.ts`'s renderTsConvert.
      // Implicit-string-concat in page bodies (`"Active: " + count`)
      // injects a `convert` IR node around the non-string operand;
      // the walker emits the same `String(x)` / `x.toString()` form
      // the domain renderer does.
      const v = emitExpr(expr.value, ctx);
      if (expr.target === "string") {
        if (expr.from === "money") return `${v}.toString()`;
        return `String(${v})`;
      }
      if (expr.target === "long" || expr.target === "decimal") {
        if (expr.from === "money") return `${v}.toNumber()`;
        return v;
      }
      if (expr.target === "money") {
        if (expr.from === "money") return v;
        return `new Decimal(${v})`;
      }
      return v;
    }
    case "unary":
      return `(${expr.op}${emitExpr(expr.operand, ctx)})`;
    case "call": {
      // Bare function call as a JS expression.  The
      // callee is emitted verbatim — the generated code expects the
      // user to import / declare `<name>` somewhere in their app
      // shell.  Powers patterns like `let n = inc(count)` and the
      // statement form `Button("…", onClick: e => { saveOrder() })`.
      //
      // UI-declared helper imports take this path too:
      // tracking `usedHelpers` so the shell emits the matching
      // `import { <name> } from "<path>"` line.
      if (ctx.helperImports.has(expr.name)) {
        ctx.usedHelpers.add(expr.name);
      }
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
    case "object": {
      // Object literal: `{ name: name, age: 30 }`
      // emits as plain JS `{ name: name, age: 30 }`.  Field values
      // recurse through emitExpr (so refs/state/binary ops compose).
      const fields = expr.fields.map((f) => `${f.name}: ${emitExpr(f.value, ctx)}`).join(", ");
      return `{ ${fields} }`;
    }
    case "method-call": {
      // When the method-call's receiver is a hook
      // (detected by tryDetectApiHook on the receiver), emit
      // `<hookVar>.<method>(<args>)` (e.g.
      // `customerCreate.mutate({...})`).
      const recvHookUse = tryDetectApiHook(expr.receiver, ctx);
      if (recvHookUse) {
        registerApiHook(recvHookUse, ctx);
        const args = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
        return `${recvHookUse.varName}.${expr.member}(${args})`;
      }
      // Method calls on plain JS receivers (e.g. a
      // local `create` mutation hook inside a `Form(of:)` page's
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
 *  semicolon).  v0 supports the subset that matters for click
 *  handlers: state mutation (`:=`, `+=`, `-=`), let-binding, and
 *  bare expression statements.  emit / call statements fall
 *  through to a comment for now. */
export function emitStmt(stmt: StmtIR, ctx: WalkContext): string {
  switch (stmt.kind) {
    case "assign": {
      const seg = stmt.target.segments;
      if (seg.length === 1 && ctx.stateNames.has(seg[0]!)) {
        ctx.usesState = true;
        const name = seg[0]!;
        const setter = "set" + name[0]!.toUpperCase() + name.slice(1);
        return `${setter}(${emitExpr(stmt.value, ctx)});`;
      }
      return unsupportedPageStmt(
        `assignment to '${seg.join(".")}'`,
        "the React backend only mutates single-segment page-state fields",
      );
    }
    case "add":
    case "remove": {
      // `count += 1` / `count -= 1` lower to
      // `kind: "add"` / `kind: "remove"` in the IR (the same
      // kinds collection-mutations use; for scalar state fields
      // they're compound additions/subtractions).  Walker emits
      // `setCount(count + 1)` / `setCount(count - 1)`.
      const seg = stmt.target.segments;
      if (seg.length === 1 && ctx.stateNames.has(seg[0]!)) {
        ctx.usesState = true;
        const name = seg[0]!;
        const setter = "set" + name[0]!.toUpperCase() + name.slice(1);
        const op = stmt.kind === "add" ? "+" : "-";
        return `${setter}(${name} ${op} ${emitExpr(stmt.value, ctx)});`;
      }
      return unsupportedPageStmt(
        `'${stmt.kind === "add" ? "+=" : "-="}' on '${seg.join(".")}'`,
        "the React backend only mutates single-segment page-state fields",
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
      const args = stmt.args.map((a) => emitExpr(a, ctx)).join(", ");
      return `${stmt.name}(${args});`;
    }
    default:
      return unsupportedPageStmt(
        `statement '${stmt.kind}'`,
        "it has no meaning in a React page event handler",
      );
  }
}

/** A page event-handler statement the React walker can't lower.  We throw
 *  rather than emit a `/* unsupported *\/` comment: the old comment compiled
 *  fine but silently dropped the statement at runtime (e.g. a button whose
 *  handler does nothing).  Failing generation surfaces the gap loudly — see
 *  the same rationale in src/ir/validate.ts (test-body fallbacks). */
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
    // Anything else → run through emitExpr; brace-wrap as a
    // JSX expression.  Refs to params/state, binary ops, calls,
    // etc. all compose.
    const expr = emitExpr(a, ctx);
    return ` data-testid={${expr}}`;
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
    if (ctx.paramNames.has(expr.name)) {
      ctx.usedParams.add(expr.name);
      return `{${expr.name}}`;
    }
    if (ctx.stateNames.has(expr.name)) {
      ctx.usesState = true;
      return `{${expr.name}}`;
    }
    // Unresolved ref in text position emits a JSX
    // comment so the user sees the unresolved name in the
    // generated file (the page still compiles; the comment makes
    // the gap visible).
    return `{/* ref: ${expr.name} */}`;
  }
  // Anything else (binary op, unary, non-string
  // literal): emit the JS-expression form wrapped as a JSX
  // expression.  Powers patterns like `Heading("Welcome, " +
  // name)`, `Text(count + 1)`, `Stat("Count", count * step)`.
  //
  // UI-declared helper calls also belong in text
  // position; route them through `emitExpr` so they emit as
  // plain JS calls (`{formatPrice(99)}`).  Stdlib-primitive
  // calls still fall through to undefined — those are child
  // components and the caller should `walk` them instead.
  if (expr.kind === "call") {
    if (ctx.helperImports.has(expr.name)) {
      return `{${emitExpr(expr, ctx)}}`;
    }
    return undefined;
  }
  return `{${emitExpr(expr, ctx)}}`;
}

// The page-file shell (renderCustomLayoutPage, the form-wiring renderers,
// renderUserComponentFile, and the state/type helpers) lives in
// walker/page-shell.ts. It consumes this module's core walker
// (walkBodyToTsx) plus the FormOfState records pushed onto the walk sink.
