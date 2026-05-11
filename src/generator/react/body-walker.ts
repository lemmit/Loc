// Slice 11.3 — recursive body walker.
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
//     slice opens this through the template-pack layer (one
//     stdlib emitter per pack).
//
// What this module exports:
//   - `walkBodyToTsx(body)` — { tsx, imports } where `tsx` is the
//     JSX expression and `imports` is the Mantine specifiers that
//     need to be at the top of the page file.
//   - `isWalkableLayoutBody(body)` — predicate the page emitter
//     uses to decide whether to dispatch to the walker.

import type { ImportSpec, LoadedPack } from "../_packs/loader.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ParamIR,
  StateFieldIR,
  StmtIR,
  TypeIR,
  UiApiParamIR,
  UiHelperImportIR,
  WorkflowIR,
} from "../../ir/loom-ir.js";
import { camel, humanize, pascal, plural, snake } from "../../util/naming.js";
import {
  componentsForFields,
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  needsController,
} from "./form-helpers.js";
import { prepareFormFieldVM } from "./templating/preparers/form-fields.js";
import { renderFormField } from "./templating/render.js";
import type { FormFieldVM } from "./templating/view-models.js";

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

/** Append a named-import to the walker's per-source import map.
 *  Idempotent — duplicate names dedupe inside the Set per source. */
function addImport(ctx: WalkContext, from: string, ...names: string[]): void {
  let s = ctx.imports.get(from);
  if (!s) {
    s = new Set();
    ctx.imports.set(from, s);
  }
  for (const n of names) s.add(n);
}

/** Convenience for the (still many) emit functions that haven't been
 *  ported to the pack contract yet — they all want named imports
 *  from `@mantine/core`.  Keeps call sites compact and grep-able
 *  while the migration finishes. */
function addMantineImport(ctx: WalkContext, ...names: string[]): void {
  addImport(ctx, "@mantine/core", ...names);
}

/** Slice post-D2 — register the imports a non-rendered primitive
 *  needs.  Used by `Form(of:)` / `Form(runs:)` emission: the form-
 *  shell JSX uses `<Stack>` / `<Button>` / `<Group>` (Mantine) /
 *  `<div className="...">` / `<Button>` (shadcn) etc., but the
 *  walker emits them as literal JSX (not via `renderPrimitive`),
 *  so the pack's `imports.primitive-X` declarations don't auto-
 *  add.  This helper looks them up and registers them. */
function addImportsForPrimitive(ctx: WalkContext, name: string): void {
  const specs: ImportSpec[] = ctx.pack.manifest.imports?.[name] ?? [];
  for (const spec of specs) addImport(ctx, spec.from, ...spec.named);
}

/** Slice post-D2 — walk a `FormFieldVM` tree and register each
 *  child template's imports via `imports.field-input-*` on the
 *  pack manifest.  This replaces the previous Mantine-component-
 *  name → primitive mapping: each field-input-* template is its
 *  own pack contract surface, so packs declare imports per
 *  template directly (e.g. shadcn's `field-input-id-select`
 *  imports `Select`, `SelectTrigger`, … from
 *  `@/components/ui/select`). */
function registerFormFieldImports(ctx: WalkContext, vm: FormFieldVM): void {
  addImportsForPrimitive(ctx, vm.template);
  if (vm.children) {
    for (const c of vm.children) registerFormFieldImports(ctx, c);
  }
}

/** Render a primitive through the pack and merge its declared
 *  imports into the context.  Each primitive's `imports` entry in
 *  pack.json drives the `<from>` and `<named>` set added to the
 *  page's import block.  When the pack manifest doesn't list a
 *  primitive in `imports`, we render anyway and rely on the
 *  template emitting whatever module-free JSX it wants
 *  (e.g. shadcn's primitives that emit only `<div className=…>`
 *  need no imports). */
function renderPrimitive(
  ctx: WalkContext,
  name: string,
  templateCtx: unknown,
): string {
  const specs: ImportSpec[] = ctx.pack.manifest.imports?.[name] ?? [];
  for (const spec of specs) addImport(ctx, spec.from, ...spec.named);
  return ctx.pack.render(name, templateCtx);
}

/** Render the page's import block from the per-source map.  One
 *  `import { … } from "<from>";` line per source, alphabetically
 *  sorted within each line and sources sorted by `from`.  Empty
 *  map renders as an empty string so callers can splice the
 *  result without a guard. */
export function renderImportLines(
  imports: ImportMap,
  /** Slice C2 — page-relative prefix for paths the pack writes
   *  with the default `../` shape (which assumes pages live one
   *  hop under `src/`).  Scaffold-expanded pages live two hops
   *  under `src/`, so they pass `"../../"` and we rewrite each
   *  pack-supplied `../X` → `../../X`. */
  srcImportPrefix: string = "../",
): string {
  if (imports.size === 0) return "";
  const lines = [...imports.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([from, named]) => {
      const path =
        srcImportPrefix !== "../" && from.startsWith("../")
          ? srcImportPrefix + from.slice(3)
          : from;
      return `import { ${[...named].sort().join(", ")} } from "${path}";\n`;
    });
  return lines.join("");
}

export interface WalkResult {
  tsx: string;
  imports: ImportMap;
  /** Slice 11.4 — names of route params the walker actually used
   *  while emitting (e.g. `Heading(name)` referenced `name`).  The
   *  page-shell generator destructures only the used names from
   *  `useParams()` so unused declarations don't trigger TS warnings. */
  usedParams: Set<string>;
  /** Slice 11.5 — true when any walked node emitted JSX that
   *  references the `navigate` symbol (e.g. `Button("…", to: …)`).
   *  The page-shell adds `import { useNavigate }` and a
   *  `const navigate = useNavigate();` line when set. */
  usesNavigate: boolean;
  /** Slice 11.7 — true when any walked node emitted JSX that needs
   *  a `useState` hook in scope (state-field refs in the body or
   *  `setX(...)` calls in event handlers).  The shell emits a
   *  `useState` import + per-field `const [x, setX] = useState(...)`
   *  declarations when set. */
  usesState: boolean;
  /** Slice 11.15 — true when any walked node emitted JSX that
   *  references React Router's `Link` component (e.g.
   *  `Anchor("…", to: …)` → `<Anchor component={RouterLink}>`).
   *  The shell adds `Link as RouterLink` to the existing
   *  react-router-dom import — the alias keeps the slot free for
   *  design packs whose own primitive is named `Link` (MUI,
   *  chakra) without an identifier collision. */
  usesRouterLink: boolean;
  /** Slice 11.18 — names of user-defined components the walker
   *  invoked while emitting (e.g. `WelcomeBox("Alice")` →
   *  `<WelcomeBox name="Alice" />`).  The shell emits per-name
   *  imports from `@/components/<Name>`. */
  usedUserComponents: Set<string>;
  /** Slice 11.19 — true when the walked tree referenced `Slot()`
   *  (the children-prop placeholder).  Component shells with this
   *  set add a `children?: React.ReactNode` prop to their typed
   *  Props interface. */
  usesChildren: boolean;
  /** Slice 11.24 — collected api-hook usages.  Each unique
   *  `<paramName>.<aggregate>.<op>` reference in the body becomes
   *  one entry — the shell emits a `const <varName> = use<Op>()`
   *  declaration at page-top + an import.  Body refs are
   *  rewritten to use the local var. */
  usedApiHooks: Map<string, ApiHookUse>;
  /** Slice A4 — non-null when the body contained a `Form(of: <Agg>)`
   *  primitive.  Shell consumes this to emit `useForm` / `Controller`
   *  imports, mutation hook, `defaultValues`, and the `onSubmit`
   *  handler that wraps the form's `<form onSubmit={…}>`. */
  formOf: FormOfState | null;
  /** Slice A5 — every static `testid:` literal encountered while
   *  walking the body, plus the synthesised testid bases the walker
   *  generates on the user's behalf (e.g. `<form-namespace>-input-
   *  <field>` for each `Form(of:)` field, `<form-namespace>-submit`
   *  for the submit button).  The walker-side page-object emitter
   *  reads this set to surface one typed `Locator` getter per
   *  testid in the generated `e2e/pages/<page-snake>.ts` class. */
  collectedTestids: Set<string>;
  /** Slice A6 — names of UI-declared helpers the body actually
   *  invoked.  The shell emits one `import { <name> } from
   *  "<path>"` line per used helper; declared-but-unused helpers
   *  don't pollute the page TSX. */
  usedHelpers: Set<string>;
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
  "Form",
  "Breadcrumbs",
  "Paper",
  "Skeleton",
  "Alert",
  "QueryView",
  "KeyValueRow",
]);

export function isWalkableLayoutBody(
  body: ExprIR | undefined,
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  helperNames: ReadonlySet<string> = new Set(),
): boolean {
  if (!body) return false;
  if (body.kind === "call") {
    if (STDLIB_LAYOUT_COMPONENTS.has(body.name)) return true;
    // Slice 11.18 — calls to user-defined components are walker-
    // eligible too (resolved via the supplied map).
    if (userComponents.has(body.name)) return true;
    // Slice A6 — a body whose top-level call is a UI-declared
    // helper is walker-eligible: the helper renders the page's
    // JSX in user land.  Without this, `body: RenderBanner("hi")`
    // would be silently skipped.
    return helperNames.has(body.name);
  }
  // Slice 11.17 — top-level conditional bodies dispatch through the
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
  /** Slice 11.4 — names of the page's route params; refs to these
   *  names emit as `{name}` JSX expressions (resolved by
   *  `useParams()` at render time). */
  paramNames: ReadonlySet<string> = new Set(),
  /** Slice 11.7 — names of the page's `state {}` fields; refs in
   *  body position emit as `{name}` JSX expressions (resolved by
   *  `useState` in the shell), and `:=` assignments in event-
   *  handler lambdas lower to the React `setX(...)` setter. */
  stateNames: ReadonlySet<string> = new Set(),
  /** Slice 11.18 — user-defined components known to this UI.  When
   *  the walker sees a `call` whose name matches a key here, it
   *  emits `<Name prop1={arg1} … />` (mapping positional args to
   *  the component's declared param names) instead of the
   *  "unknown component" placeholder.  Required for cross-component
   *  composition (one component invoking another). */
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  /** Slice 11.24 — UI api parameters.  Each entry maps a local
   *  handle (e.g. `Sales`) to an api name (e.g. `SalesApi`).
   *  Body refs of the form `<paramName>.<aggregate>.<op>` get
   *  detected by the walker, hoisted to a hook call at page top,
   *  and rewritten to the local hook variable. */
  apiParams: ReadonlyArray<UiApiParamIR> = [],
  /** Slice A4 — aggregates reachable from this UI's deployable.
   *  `Form(of: <Agg>)` and `IdLink(of: <Agg>)` look up the
   *  aggregate's IR here (field list for form dispatch; display-
   *  marked field for IdLink's link text). */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Slice A4 — bounded-context map keyed by aggregate name.  The
   *  form-field preparer needs the BC to resolve enum / value-
   *  object types declared alongside the aggregate. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Slice A6 — user-authored helper imports declared at the UI
   *  level via `import helper <name> from "<path>"`.  Body refs
   *  matching one of these names emit as plain JS calls and the
   *  shell adds the matching `import { <name> } from "<path>"`. */
  helperImports: ReadonlyArray<UiHelperImportIR> = [],
  /** Slice A12 — workflows reachable from this UI's deployable.
   *  `Form(runs: <wf>)` looks up the workflow's IR here (param
   *  list for form dispatch, owning BC for enum resolution). */
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  /** Slice A12 — owning bounded context per workflow (the form-
   *  field preparer needs the BC to resolve enums / value-objects
   *  referenced by workflow params). */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
): WalkResult {
  const apiParamNames = new Map<string, string>();
  for (const p of apiParams) apiParamNames.set(p.name, p.apiName);
  const helperNameToPath = new Map<string, string>();
  for (const h of helperImports) helperNameToPath.set(h.name, h.path);
  const ctx: WalkContext = {
    imports: new Map(),
    pack,
    paramNames,
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
    formOf: null,
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
    formOf: ctx.formOf,
    collectedTestids: ctx.collectedTestids,
    usedHelpers: ctx.usedHelpers,
  };
}

interface WalkContext {
  imports: ImportMap;
  pack: LoadedPack;
  paramNames: ReadonlySet<string>;
  usedParams: Set<string>;
  usesNavigate: boolean;
  stateNames: ReadonlySet<string>;
  usesState: boolean;
  usesRouterLink: boolean;
  userComponents: ReadonlyMap<string, readonly ParamIR[]>;
  usedUserComponents: Set<string>;
  usesChildren: boolean;
  apiParamNames: ReadonlyMap<string, string>;
  usedApiHooks: Map<string, ApiHookUse>;
  /** Slice A2 — lambda params bound in the current sub-walk
   *  (source-side name → emitted JS name).  `Column("ID", o => o.id)`
   *  walks the accessor body with `o → "row"`; refs to `o` resolve
   *  to the JS identifier `row`.  Outer scope is unaffected. */
  lambdaParams: ReadonlyMap<string, string>;
  /** Slice A4 — identifiers emitted by the page shell that user-
   *  written sub-expressions can reference (e.g. inside a
   *  `Form(of:, onSubmit:)` lambda, `create` is the mutation hook
   *  declared at function top).  Refs matching a name in this set
   *  emit as the bare identifier — no `unresolved` comment. */
  shellLocals: ReadonlySet<string>;
  /** Slice A4 — aggregates reachable from this UI's deployable.
   *  Powers `Form(of: <Agg>)` field dispatch and `IdLink(of: <Agg>)`
   *  display-field resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Slice A4 — map aggregate name → owning bounded context, so the
   *  form-field preparer can resolve enums / value-objects declared
   *  in the same context. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  /** Slice A12 — workflows reachable from this UI's deployable.
   *  Powers `Form(runs: <wf>)` field dispatch. */
  workflowsByName: ReadonlyMap<string, WorkflowIR>;
  /** Slice A12 — owning bounded context per workflow. */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR>;
  /** Slice A4/A12 — when `Form(of: <Agg>)` or `Form(runs: <wf>)`
   *  is walked, the emitter records the metadata the shell needs
   *  (aggregate or workflow, BC, optional user-supplied
   *  `onSubmit:` lambda body, redirect path) so the shell can
   *  emit `useForm` + mutation hook + `handleSubmit` wiring at
   *  function top. */
  formOf: FormOfState | null;
  /** Slice A5 — accumulator for static `testid:` strings the body
   *  emits, used by the walker-side page-object builder. */
  collectedTestids: Set<string>;
  /** Slice A6 — UI helper-import lookup (name → import path).
   *  Populated by `walkBodyToTsx` from the UI's `helperImports`
   *  parameter; consulted by `emitComponent`'s fallthrough so
   *  body calls to a helper name emit as plain JS calls. */
  helperImports: ReadonlyMap<string, string>;
  /** Slice A6 — names of helpers the body actually called.  The
   *  shell emits one import line per used helper; declared-but-
   *  unused helpers don't pollute the page TSX. */
  usedHelpers: Set<string>;
}

/** Slice A4 / A12 — RHF wiring requirements recorded by `emitFormOf`,
 *  consumed by the page shell to splice the `useForm` declaration +
 *  request type + mutation hook + per-field `useAll<TargetX>` hooks
 *  at the top of the function body.
 *
 *  Discriminated union: `kind: "aggregate"` for `Form(of: <Agg>)`,
 *  `kind: "workflow"` for `Form(runs: <wf>)`.  The two share most
 *  fields (the form is rendered identically); they differ only in
 *  the imports / hook decls / default submit redirect that the
 *  shell emits around the form. */
export type FormOfState = AggregateFormState | WorkflowFormState;

interface FormStateBase {
  bc: BoundedContextIR;
  /** Id<X> targets needing `useAllX()` injection at function top
   *  (resolved through `idTargetsInFields`).  One hook decl per
   *  target — collapsed across multiple `Id<X>` fields on the same
   *  target aggregate. */
  idTargets: readonly AggregateIR[];
  /** True when any field needs RHF's `Controller` for binding
   *  (currently the case for enums + Id<X>-as-select + bool +
   *  datetime + value-objects). */
  useController: boolean;
  /** Default-values literal for `useForm({ defaultValues: ... })`. */
  defaultValuesTs: string;
  /** Components needed from the design pack — added on top of the
   *  base set so the import block stays sorted + de-duped. */
  fieldComponents: readonly string[];
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

function walk(expr: ExprIR, ctx: WalkContext, depth: number): string {
  // Slice 11.24 — api hook injection (JSX-child position).
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
      // Slice A2 — refs to a lambda-bound param resolve to its
      // emitted JS name (e.g. `o.id` inside `o => …` walks with
      // `o → "row"`).  Brace-wrap as a JSX child.
      {
        const jsName = ctx.lambdaParams.get(expr.name);
        if (jsName) return `{${jsName}}`;
      }
      // Slice 11.4 — refs that match a route param name emit as
      // JSX expressions (`{name}`).  React Router's `useParams()`
      // brings these into scope at render time; the page-shell
      // generator destructures the used names.  Refs that don't
      // match a param emit as a placeholder JSX comment so the
      // build error stays visible.
      if (ctx.paramNames.has(expr.name)) {
        ctx.usedParams.add(expr.name);
        return `{${expr.name}}`;
      }
      // Slice 11.7 — refs that match a state field name emit the
      // same way; the shell brings them into scope via `useState`.
      if (ctx.stateNames.has(expr.name)) {
        ctx.usesState = true;
        return `{${expr.name}}`;
      }
      return `{/* ref: ${expr.name} */}`;
    case "ternary": {
      // Slice 11.17 — conditional rendering.  `cond ? <A /> : <B />`
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
      // Slice A2 — member access in JSX-child position (e.g. an
      // accessor lambda body `o => o.id` walks `o.id` as the body
      // of a `<Table.Td>` cell).  Emit as a brace-wrapped JS
      // expression; `emitExpr` resolves the receiver (lambda
      // param, hook, state) and concatenates the member name.
      return `{${emitExpr(expr, ctx)}}`;
    default:
      return `{/* unsupported expr: ${expr.kind} */}`;
  }
}

function emitComponent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
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
    case "Form":
      return emitFormOf(call, ctx, depth);
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
    case "Card":
      return emitCard(call, ctx, depth);
    case "Stat":
      return emitStat(call, ctx, depth);
    case "Badge":
      return emitBadge(call, ctx, depth);
    case "Divider":
      return emitDivider(call, ctx, depth);
    default: {
      // Slice 11.18 — names not in the stdlib dispatch table fall
      // through to user-component invocation when they match a
      // registered ComponentIR.
      if (ctx.userComponents.has(call.name)) {
        return emitUserComponent(call, ctx, depth);
      }
      // Slice A6 — UI-declared helper imports (`import helper
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

function emitStack(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Every positional arg is a child; ignore named args in v0.
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-stack", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitGroup(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-group", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitGrid(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Each child wraps in a per-pack column container (Mantine's
  // <Grid.Col span="auto">; shadcn's plain `<div>` since gap is
  // on the parent).  v0 gives every column equal weight; a future
  // slice can read a `span:` named arg per child.
  const children = positionalChildren(call, ctx, depth + 2);
  const colIndent = "  ".repeat(depth + 1);
  const childIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-grid", {
    hasChildren: children.length > 0,
    children,
    colIndent,
    childIndent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitContainer(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Container(...children) — max-width centred wrapper.  Optional
  // `size:` named arg controls the max-width per pack idiom
  // (Mantine "xs"|"sm"|"md"|"lg"|"xl"; shadcn maps to a tailwind
  // max-w utility).
  const children = positionalChildren(call, ctx, depth + 1);
  const size = stringNamed(call, "size");
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-container", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    size,
    hasSize: size !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitTabs(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Tabs(Tab("Overview", body), Tab("Settings", body))
  // Each positional child must be a `Tab(label, body)` call;
  // anything else lands as a placeholder so the page still
  // compiles.  Tab labels must be string literals in v0; non-
  // literal labels fall back to indexed slugs `tab-1`, …
  const positionals = positionalArgs(call);
  const tabs = positionals.map((arg, i) => {
    if (arg.kind !== "call" || arg.name !== "Tab") {
      return {
        value: `tab-${i + 1}`,
        label: `Tab ${i + 1}`,
        bodyJsx: "{/* missing tab body */}",
      };
    }
    const tabPositionals = positionalArgs(arg);
    const labelArg = tabPositionals[0];
    const bodyArg = tabPositionals[1];
    const labelStr =
      labelArg && labelArg.kind === "literal" && labelArg.lit === "string"
        ? labelArg.value
        : `Tab ${i + 1}`;
    return {
      value: slugify(labelStr) || `tab-${i + 1}`,
      label: escapeJsxText(labelStr),
      bodyJsx: bodyArg
        ? walk(bodyArg, ctx, depth + 2)
        : "{/* missing tab body */}",
    };
  });
  return renderPrimitive(ctx, "primitive-tabs", {
    tabs,
    hasTabs: tabs.length > 0,
    defaultValue: tabs[0]?.value ?? "",
    indent: "  ".repeat(depth + 1),
    innerIndent: "  ".repeat(depth + 2),
    closeIndent: "  ".repeat(depth),
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice 11.11 — kebab-case-style slugifier for Tab.value
 *  attributes.  Lowercases, strips non-alphanumerics down to
 *  hyphens, collapses runs.  Maps `"User Settings"` → `"user-
 *  settings"`. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slice A2 — Table primitive.
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
function emitTable(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const rowsArg = namedArgValue(call, "rows");
  const rowsExpr = rowsArg ? emitExpr(rowsArg, ctx) : "[]";
  const onRowClick = lambdaArg(call, "onRowClick");

  const positionals = positionalArgs(call);
  const cols = positionals
    .filter(
      (a): a is ExprIR & { kind: "call" } =>
        a.kind === "call" && a.name === "Column",
    )
    .map((c, i) => emitColumn(c, ctx, i, depth + 3));

  const rowVar = "row";
  let onRowClickJs: string | undefined;
  if (onRowClick) {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, onRowClick.param, rowVar),
    };
    if (onRowClick.body) {
      onRowClickJs = emitExpr(onRowClick.body, childCtx);
    } else if (onRowClick.block && onRowClick.block.length > 0) {
      const stmts = onRowClick.block
        .map((s) => emitStmt(s, childCtx))
        .join(" ");
      onRowClickJs = `{ ${stmts} }`;
    }
    propagateChildFlags(ctx, childCtx);
  }

  // Slice A9 — boolean style props matching Mantine's `<Table>`
  // surface.  shadcn templates ignore the props (their <Table> has
  // built-in striping); reading them here keeps the DSL pack-
  // agnostic.
  const striped = boolNamed(call, "striped");
  const highlight = boolNamed(call, "highlight");
  const sticky = boolNamed(call, "sticky");

  // Slice A13 — `keyExpr:` named arg overrides the default
  // `row.id` key.  Views with custom output (no `id` field on the
  // row type) supply `keyExpr: "idx"` (or similar) so the
  // `<Table.Tr key=…>` doesn't reference a non-existent field.
  // String-literal arg only — emitted verbatim into the JSX
  // expression.
  const keyExprArg = stringNamed(call, "keyExpr");
  const keyExpr = keyExprArg ?? `${rowVar}.id`;

  // Slice A9 — `rowTestid:` lambda computes a per-row testid.
  // The lambda's source-side param rebinds to `row` (Slice A2's
  // lambdaParams scope) so user code reads `row.id` cleanly.
  // The expression body emits inside a TS template literal so
  // dynamic ids interpolate (`orders-row-${row.id}`).
  const rowTestidLam = lambdaArg(call, "rowTestid");
  let rowTestidJs: string | undefined;
  if (rowTestidLam && rowTestidLam.body) {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, rowTestidLam.param, rowVar),
    };
    rowTestidJs = emitExpr(rowTestidLam.body, childCtx);
    propagateChildFlags(ctx, childCtx);
  }

  const indent = "  ".repeat(depth + 1);
  const headIndent = "  ".repeat(depth + 2);
  const bodyIndent = "  ".repeat(depth + 2);
  const rowIndent = "  ".repeat(depth + 3);
  const cellIndent = "  ".repeat(depth + 4);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-table", {
    rowsExpr,
    rowVar,
    keyExpr,
    columns: cols,
    hasColumns: cols.length > 0,
    hasOnRowClick: onRowClickJs !== undefined,
    onRowClick: onRowClickJs,
    striped,
    highlight,
    sticky,
    hasAnyStyleProps: striped || highlight || sticky,
    hasRowTestid: rowTestidJs !== undefined,
    rowTestid: rowTestidJs,
    indent,
    headIndent,
    bodyIndent,
    rowIndent,
    cellIndent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A9 — read a boolean-literal named arg.  Used for Table's
 *  `striped:` / `highlight:` / `sticky:` style toggles where any
 *  truthy value flips the prop on.  Returns `false` when the arg
 *  is missing so the template can read it as a boolean directly. */
function boolNamed(
  call: ExprIR & { kind: "call" },
  name: string,
): boolean {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "bool") return a.value === "true";
  }
  return false;
}

/** Slice A2 — emit one `Column("Header", <accessor>)` into a
 *  template-friendly shape: a header string + a per-cell TSX
 *  fragment.  Accessor lambda bodies that are primitive calls
 *  walk through the regular emitter (yields JSX); expression
 *  bodies (member access, refs) emit as `{<expr>}` brace-wrapped
 *  JS expressions. */
function emitColumn(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  index: number,
  depth: number,
): { header: string; cellJsx: string; key: string } {
  const positionals = positionalArgs(call);
  const headerArg = positionals[0];
  const accessorArg = positionals[1];
  const headerStr =
    headerArg && headerArg.kind === "literal" && headerArg.lit === "string"
      ? headerArg.value
      : `Column ${index + 1}`;
  const key = slugify(headerStr) || `col-${index + 1}`;

  const rowVar = "row";
  let cellJsx = "{/* missing accessor */}";
  if (accessorArg && accessorArg.kind === "lambda") {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, accessorArg.param, rowVar),
    };
    const body = accessorArg.body;
    if (body) {
      if (body.kind === "call") {
        cellJsx = walk(body, childCtx, depth);
      } else if (body.kind === "literal" && body.lit === "string") {
        cellJsx = escapeJsxText(body.value);
      } else {
        cellJsx = `{${emitExpr(body, childCtx)}}`;
      }
    }
    propagateChildFlags(ctx, childCtx);
  }
  return {
    header: escapeJsxText(headerStr),
    cellJsx,
    key,
  };
}

/** Slice A2 — return the value-expression of a named arg (e.g.
 *  the `<expr>` in `rows: <expr>`).  Undefined when the named arg
 *  is missing.  Distinct from `stringNamed` (string literals only)
 *  and `numericNamed` (number literals only): this keeps any
 *  expression IR for the caller to render as JS. */
function namedArgValue(
  call: ExprIR & { kind: "call" },
  name: string,
): ExprIR | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] === name) return call.args[i];
  }
  return undefined;
}

/** Slice A13 — propagate boolean / object flags written on a
 *  child WalkContext back to the parent.  Maps + Sets share
 *  references through the spread, but primitive flags
 *  (`usesNavigate`, `usesRouterLink`, `usesState`, `usesChildren`)
 *  and the `formOf` slot need explicit copy-back, otherwise an
 *  IdLink emitted inside a `QueryView(data: rows => …)` lambda
 *  would set `usesRouterLink: true` on the throwaway child ctx
 *  while the page shell still sees `false` on the parent and
 *  forgets to import `Link`. */
function propagateChildFlags(
  parent: WalkContext,
  child: WalkContext,
): void {
  if (child.usesNavigate) parent.usesNavigate = true;
  if (child.usesRouterLink) parent.usesRouterLink = true;
  if (child.usesState) parent.usesState = true;
  if (child.usesChildren) parent.usesChildren = true;
  if (child.formOf) parent.formOf = child.formOf;
}

/** Slice A2 — extend the WalkContext.lambdaParams map with a new
 *  binding without mutating the parent map.  Caller spreads the
 *  rest of the context and overrides `lambdaParams` with the
 *  result. */
function extendLambdaParams(
  ctx: WalkContext,
  srcName: string,
  jsName: string,
): ReadonlyMap<string, string> {
  const next = new Map(ctx.lambdaParams);
  next.set(srcName, jsName);
  return next;
}

/** Slice A3 — Money(value, currency?, decimals?, testid?).  Renders
 *  through the pack's `MoneyValue` runtime helper (Intl.NumberFormat
 *  with `style: "currency"`).  First positional or `value:` named
 *  arg is the numeric value; `currency:` and `decimals:` are
 *  optional named args. */
function emitMoney(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const value =
    namedArgValue(call, "value") ?? positionalArgs(call)[0];
  const valueExpr = value ? emitExpr(value, ctx) : "0";
  const currency = stringNamed(call, "currency");
  const decimals = numericNamed(call, "decimals");
  return renderPrimitive(ctx, "primitive-money", {
    valueExpr,
    hasCurrency: currency !== undefined,
    currency: currency !== undefined ? JSON.stringify(currency) : "",
    hasDecimals: decimals !== undefined,
    decimals: decimals !== undefined ? String(decimals) : "",
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A3 — DateDisplay(iso, testid?).  Renders through the
 *  pack's `DateTimeValue` runtime helper (locale-formatted with
 *  the raw ISO surfaced in a tooltip).  Accepts a string or null;
 *  empty values render as the shared dimmed em-dash. */
function emitDateDisplay(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const value =
    namedArgValue(call, "value") ?? positionalArgs(call)[0];
  const valueExpr = value ? emitExpr(value, ctx) : '""';
  return renderPrimitive(ctx, "primitive-date-display", {
    valueExpr,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A3 — EnumBadge(value, color?, testid?).  Renders the
 *  per-pack Badge with an optional explicit colour.  Mantine
 *  passes `color={…}`; shadcn maps `color` to the Badge `variant`
 *  prop in the template (so the same DSL surface works on both
 *  packs). */
function emitEnumBadge(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const value =
    namedArgValue(call, "value") ?? positionalArgs(call)[0];
  const valueExpr = value ? emitExpr(value, ctx) : '""';
  const color = stringNamed(call, "color");
  return renderPrimitive(ctx, "primitive-enum-badge", {
    valueExpr,
    hasColor: color !== undefined,
    color: color !== undefined ? JSON.stringify(color) : "",
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A3 — IdLink(id, of: <Aggregate>, testid?).
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
 *  Slice A4 plumbs aggregates through to the walker; we now use
 *  that to validate `of:` at emit time — an unresolvable aggregate
 *  surfaces as a visible TSX comment rather than a silent
 *  mistakenly-pluralised path. */
function emitIdLink(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const id =
    namedArgValue(call, "id") ?? positionalArgs(call)[0];
  const idExpr = id ? emitExpr(id, ctx) : '""';
  const ofArg = namedArgValue(call, "of");
  const aggName =
    ofArg && ofArg.kind === "ref"
      ? ofArg.name
      : ofArg && ofArg.kind === "literal" && ofArg.lit === "string"
        ? ofArg.value
        : undefined;
  if (!aggName) {
    return `{/* IdLink: missing 'of:' aggregate ref */}`;
  }
  // When aggregate IR is in scope (Slice A4), prefer the official
  // aggregate's plural-snake slug over our local pluralisation
  // pass — `agg.name` is canonical (already validated) and any
  // future irregular-plural rules live with the IR.  When the
  // aggregate isn't visible (e.g. a deployable that excludes its
  // module), we still emit a working link, just without IR-level
  // verification.
  const agg = ctx.aggregatesByName.get(aggName);
  const slug = agg ? plural(snake(agg.name)) : plural(snake(aggName));
  ctx.usesRouterLink = true;
  return renderPrimitive(ctx, "primitive-id-link", {
    idExpr,
    pathPrefix: `/${slug}/`,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A4 — Form(of: <Aggregate>, onSubmit?: <lambda>, testid?).
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
 *   - One `useAll<Target>()` hook per `Id<X>` target needing a
 *     select picker
 *   - The submit handler — default scaffold behaviour
 *     (`create.mutateAsync` + notify + navigate) when no explicit
 *     `onSubmit:` was given.
 *
 *  Walker records the FormOfState on `ctx.formOf`; the shell reads
 *  it after the body walk completes. */
function emitFormOf(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Slice A12 — `Form` dispatches on which named arg is present:
  //   `of:  <Aggregate>` → create-form for the aggregate
  //   `runs: <workflow>` → workflow-run form
  // The two share rendering (same per-field preparer + same outer
  // <form> JSX) but differ in shell wiring (request type, mutation
  // hook, default redirect).  We branch here, build the matching
  // FormOfState variant, and let the shell + template handle the
  // rest.
  const runsArg = namedArgValue(call, "runs");
  if (runsArg) return emitFormRuns(call, ctx, depth, runsArg);
  return emitFormOfAggregate(call, ctx, depth);
}

function emitFormOfAggregate(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const ofArg = namedArgValue(call, "of");
  const aggName =
    ofArg && ofArg.kind === "ref"
      ? ofArg.name
      : ofArg && ofArg.kind === "literal" && ofArg.lit === "string"
        ? ofArg.value
        : undefined;
  if (!aggName) {
    return `{/* Form(of: …): missing 'of:' aggregate ref */}`;
  }
  const agg = ctx.aggregatesByName.get(aggName);
  const bc = ctx.bcByAggregate.get(aggName);
  if (!agg || !bc) {
    return `{/* Form(of: ${aggName}): aggregate not found in this UI's reachable contexts */}`;
  }
  // Optional fields are excluded from create forms — same rule as
  // the scaffold New-page builder (`!f.optional`).  This keeps the
  // first iteration of a form schema focused on what the wire
  // contract REQUIRES; optional fields surface via update-flow
  // operations on the detail page.
  const fields = agg.fields.filter((f) => !f.optional);
  const aggregatesByNameMut = new Map(ctx.aggregatesByName);
  const idTargets = idTargetsInFields(fields, bc, aggregatesByNameMut);
  const useController = needsController(fields, bc, aggregatesByNameMut);
  const defaultValuesTs = initialValuesTs(fields, bc);
  const fieldComponents = [...componentsForFields(fields, bc)];
  const testidArg = stringNamed(call, "testid");
  const testidNamespace = testidArg ?? `${snake(plural(agg.name))}-new`;
  const fieldVMs = fields.map((f) =>
    prepareFormFieldVM(
      f.name,
      f.type,
      bc,
      `${testidNamespace}-input-${f.name}`,
      aggregatesByNameMut,
    ),
  );
  // The pack's `primitive-form-of` imports cover the form-shell
  // components (Stack/Button/Group on Mantine, equivalents on
  // other packs).  Per-field input components come from each
  // `field-input-*` template's import declaration in pack.json
  // (recursing into value-object children).  All resolve through
  // `addImportsForPrimitive` so the page's import block is
  // pack-neutral.
  addImportsForPrimitive(ctx, "primitive-form-of");
  for (const vm of fieldVMs) registerFormFieldImports(ctx, vm);
  const fieldHtmls = fieldVMs.map((vm) => renderFormField(vm, ctx.pack));
  for (const vm of fieldVMs) ctx.collectedTestids.add(vm.testId);
  ctx.collectedTestids.add(`${testidNamespace}-submit`);
  let onSubmitJs: string | null = null;
  const onSubmit = lambdaArg(call, "onSubmit");
  if (onSubmit) {
    const shellLocals = new Set<string>([
      "create",
      "register",
      "handleSubmit",
      "control",
      "errors",
      ...idTargets.map((t) => idTargetHookVar(t)),
    ]);
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, onSubmit.param, "vals"),
      shellLocals,
    };
    if (onSubmit.body) {
      onSubmitJs = emitExpr(onSubmit.body, childCtx);
    } else if (onSubmit.block && onSubmit.block.length > 0) {
      const stmts = onSubmit.block
        .map((s) => emitStmt(s, childCtx))
        .join(" ");
      onSubmitJs = `{ ${stmts} }`;
    }
    propagateChildFlags(ctx, childCtx);
  }
  ctx.formOf = {
    kind: "aggregate",
    agg,
    bc,
    fields,
    idTargets,
    useController,
    defaultValuesTs,
    fieldComponents,
    testidNamespace,
    fieldHtmls,
    onSubmitJs,
  };
  const slug = snake(plural(agg.name));
  const submitBody =
    onSubmitJs !== null
      ? onSubmitJs
      : ctx.pack.render("form-default-onsubmit", {
          mutationCall: "const out = await create.mutateAsync(vals);",
          successMessage: `${humanize(agg.name)} created`,
          redirectStmt: `navigate(\`/${slug}/\${out.id}\`)`,
        });
  return renderPrimitive(ctx, "primitive-form-of", {
    fieldHtmls,
    submitBody,
    submitTestid: `${testidNamespace}-submit`,
    submitPendingExpr: "create.isPending",
    submitLabel: "Create",
    testidAttr: testidAttr(call, ctx),
    indent: "  ".repeat(depth + 1),
    innerIndent: "  ".repeat(depth + 2),
    deepIndent: "  ".repeat(depth + 3),
    deeperIndent: "  ".repeat(depth + 4),
    closeIndent: "  ".repeat(depth),
  });
}

/** Slice A12 — `Form(runs: <wf>)` walker variant.  Same per-field
 *  preparer + same outer <form> JSX as the aggregate form, but
 *  the shell wires a workflow request type + mutation hook + a
 *  default redirect to `/workflows`. */
function emitFormRuns(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
  runsArg: ExprIR,
): string {
  const wfName =
    runsArg.kind === "ref"
      ? runsArg.name
      : runsArg.kind === "literal" && runsArg.lit === "string"
        ? runsArg.value
        : undefined;
  if (!wfName) {
    return `{/* Form(runs: …): missing 'runs:' workflow ref */}`;
  }
  const workflow = ctx.workflowsByName.get(wfName);
  const bc = ctx.bcByWorkflow.get(wfName);
  if (!workflow || !bc) {
    return `{/* Form(runs: ${wfName}): workflow not found in this UI's reachable contexts */}`;
  }
  const fields = workflow.params;
  // form-helpers expect `{ name, type, optional }` rows; workflow
  // params don't carry an `optional` flag so we adapt here.  All
  // workflow params are treated as required (matches the scaffold
  // workflow-form builder, which doesn't filter them either).
  const fieldsForHelpers = fields.map((f) => ({ ...f, optional: false }));
  const aggregatesByNameMut = new Map(ctx.aggregatesByName);
  const idTargets = idTargetsInFields(fieldsForHelpers, bc, aggregatesByNameMut);
  const useController = needsController(fieldsForHelpers, bc, aggregatesByNameMut);
  const defaultValuesTs = initialValuesTs(fieldsForHelpers, bc);
  const fieldComponents = [...componentsForFields(fieldsForHelpers, bc)];
  const testidArg = stringNamed(call, "testid");
  const testidNamespace = testidArg ?? `workflow-${snake(workflow.name)}`;
  const fieldVMs = fields.map((f) =>
    prepareFormFieldVM(
      f.name,
      f.type,
      bc,
      `${testidNamespace}-input-${f.name}`,
      aggregatesByNameMut,
    ),
  );
  // The pack's `primitive-form-of` imports cover the form-shell
  // components (Stack/Button/Group on Mantine, equivalents on
  // other packs).  Per-field input components come from each
  // `field-input-*` template's import declaration in pack.json
  // (recursing into value-object children).  All resolve through
  // `addImportsForPrimitive` so the page's import block is
  // pack-neutral.
  addImportsForPrimitive(ctx, "primitive-form-of");
  for (const vm of fieldVMs) registerFormFieldImports(ctx, vm);
  const fieldHtmls = fieldVMs.map((vm) => renderFormField(vm, ctx.pack));
  for (const vm of fieldVMs) ctx.collectedTestids.add(vm.testId);
  ctx.collectedTestids.add(`${testidNamespace}-submit`);
  let onSubmitJs: string | null = null;
  const onSubmit = lambdaArg(call, "onSubmit");
  if (onSubmit) {
    const shellLocals = new Set<string>([
      "run",
      "register",
      "handleSubmit",
      "control",
      "errors",
      ...idTargets.map((t) => idTargetHookVar(t)),
    ]);
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, onSubmit.param, "vals"),
      shellLocals,
    };
    if (onSubmit.body) {
      onSubmitJs = emitExpr(onSubmit.body, childCtx);
    } else if (onSubmit.block && onSubmit.block.length > 0) {
      const stmts = onSubmit.block
        .map((s) => emitStmt(s, childCtx))
        .join(" ");
      onSubmitJs = `{ ${stmts} }`;
    }
    propagateChildFlags(ctx, childCtx);
  }
  ctx.formOf = {
    kind: "workflow",
    workflow,
    bc,
    fields,
    idTargets,
    useController,
    defaultValuesTs,
    fieldComponents,
    testidNamespace,
    fieldHtmls,
    onSubmitJs,
  };
  const submitBody =
    onSubmitJs !== null
      ? onSubmitJs
      : ctx.pack.render("form-default-onsubmit", {
          mutationCall: "await run.mutateAsync(vals);",
          successMessage: `${humanize(workflow.name)} completed`,
          redirectStmt: `navigate("/workflows")`,
        });
  return renderPrimitive(ctx, "primitive-form-of", {
    fieldHtmls,
    submitBody,
    submitTestid: `${testidNamespace}-submit`,
    submitPendingExpr: "run.isPending",
    submitLabel: "Run",
    testidAttr: testidAttr(call, ctx),
    indent: "  ".repeat(depth + 1),
    innerIndent: "  ".repeat(depth + 2),
    deepIndent: "  ".repeat(depth + 3),
    deeperIndent: "  ".repeat(depth + 4),
    closeIndent: "  ".repeat(depth),
  });
}

function emitToolbar(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Toolbar(...children) — same children-as-positionals contract
  // as Group, but with space-between justification (canonical
  // page-header layout: left-aligned + right-aligned cluster).
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-toolbar", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitEmpty(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Empty("No results yet") — empty-state placeholder.  No
  // dedicated component on either pack; both compose a centred
  // dimmed text block.  The first positional is the message;
  // refs / ops welcome (routes through renderTextContent).
  const msg = firstPositionalContent(call, ctx) ?? '"No results."';
  void depth;
  return renderPrimitive(ctx, "primitive-empty", {
    text: unwrapTextLiteral(msg),
    testidAttr: testidAttr(call, ctx),
  });
}

/** Build the dual label representations input primitives need:
 *  `labelAttr` for an `label="..."` JSX attribute (Mantine's
 *  TextInput/Switch take label this way) and `labelText` for a
 *  child-text position (shadcn pairs `<Label>...</Label>` next to
 *  the input).  Both come from the same first-positional content
 *  source. */
function inputLabelForms(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): { labelAttr: string; labelText: string } {
  const raw = firstPositionalContent(call, ctx) ?? '""';
  return {
    labelAttr: unwrapAsAttr(raw),
    labelText: unwrapTextLiteral(raw),
  };
}

function emitField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Field("Label", bind: <state-field>) — controlled text input
  // bound to a state field.  `bind:` required; without it the
  // input falls back to a label-only stub.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitToggle(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Toggle("Label", bind: <bool state>) — controlled bool input.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-toggle", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitNumberField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // NumberField("Label", bind: <int|decimal state>) — controlled
  // number input.  Setter is wrapped with `typeof v === "number"
  // ? v : 0` so binding stays type-safe across the
  // string-or-number onChange union.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-number-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitPasswordField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // PasswordField("Label", bind: <string state>) — visibility-
  // toggle text input.  Same bind-shape as Field.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-password-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitLoader(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Loader() — spinner.  Optional `size:` string literal.
  void depth;
  const size = stringNamed(call, "size");
  return renderPrimitive(ctx, "primitive-loader", {
    size,
    hasSize: size !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitAnchor(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Anchor("label", to: "/path") — text-style link.  With `to:`,
  // routes via React Router's Link; without, falls through to a
  // bare anchor (no href — visible no-op).
  void depth;
  const label = firstPositionalContent(call, ctx) ?? '"link"';
  const to = stringOrRefArgValue(call, "to", ctx);
  if (to) ctx.usesRouterLink = true;
  return renderPrimitive(ctx, "primitive-anchor", {
    label: unwrapTextLiteral(label),
    to,
    hasTo: to !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitImage(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Image(src: "...", alt: "...") — packs render a styled image
  // tag.  Both attrs accept string literals or refs.
  void depth;
  const src = stringOrRefArgValue(call, "src", ctx);
  const alt = stringOrRefArgValue(call, "alt", ctx);
  return renderPrimitive(ctx, "primitive-image", {
    src,
    alt,
    hasSrc: src !== undefined,
    hasAlt: alt !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitAvatar(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Avatar(src: "...", alt: "...") — packs render a circle-cropped
  // image.  Without src, packs render their user-icon fallback.
  void depth;
  const src = stringOrRefArgValue(call, "src", ctx);
  const alt = stringOrRefArgValue(call, "alt", ctx);
  return renderPrimitive(ctx, "primitive-avatar", {
    src,
    alt,
    hasSrc: src !== undefined,
    hasAlt: alt !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice 11.14 — read a `bind:` named arg as a state-field name.
 *  Returns the field name when the arg is a `ref` to a known
 *  state field (and marks `usesState` on the context); otherwise
 *  undefined.  Drives controlled-input wiring in Field / Toggle. */
function stateBindArg(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "ref" && ctx.stateNames.has(a.name)) {
      ctx.usesState = true;
      return a.name;
    }
  }
  return undefined;
}

/** Slice 11.14 — render a renderTextContent() result as a JSX
 *  attribute value.  Quoted strings stay quoted; JSX-expression
 *  values (already brace-wrapped) stay brace-wrapped. */
function unwrapAsAttr(s: string): string {
  if (s.length >= 2 && s.startsWith("{") && s.endsWith("}")) return s;
  return s; // already a quoted string literal — JSX accepts it
}

function emitHeading(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // First positional is the heading text — accepts a string
  // literal OR a ref (e.g. a route-param name).  Optional `level:`
  // named arg controls the heading rank (1..6, default 2).
  const text = firstPositionalContent(call, ctx) ?? '"Heading"';
  const level = numericNamed(call, "level") ?? 2;
  void depth;
  return renderPrimitive(ctx, "primitive-heading", {
    text: unwrapTextLiteral(text),
    level,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitText(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const text = firstPositionalContent(call, ctx) ?? '""';
  void depth;
  return renderPrimitive(ctx, "primitive-text", {
    text: unwrapTextLiteral(text),
    testidAttr: testidAttr(call, ctx),
  });
}

function emitButton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const label = firstPositionalContent(call, ctx) ?? '"Button"';
  void depth;
  // Slice 11.7 — `onClick:` lambda named arg wires the button to
  // a multi-statement event handler.  Takes priority over `to:` if
  // both are written.
  const onClick = lambdaArg(call, "onClick");
  let onClickHandler: string | undefined;
  if (onClick && (onClick.block || onClick.body)) {
    onClickHandler = emitLambdaBody(onClick, ctx);
  } else {
    // Slice 11.5 — `to:` named arg wires the button to a React
    // Router navigate call.  Accepts either a string-literal path
    // or a route-param ref.
    const to = stringOrRefArgValue(call, "to", ctx);
    if (to) {
      ctx.usesNavigate = true;
      onClickHandler = `() => navigate(${to})`;
    }
  }
  // Slice 11.29 — `disabled:` and `loading:` named args.  Both
  // accept any expression (typically a hook accessor like
  // `Sales.Customer.create.isPending` — emitExpr triggers hook
  // injection so the local hook var is available at page-top).
  const disabled = anyNamedArgExpr(call, "disabled", ctx);
  const loading = anyNamedArgExpr(call, "loading", ctx);
  return renderPrimitive(ctx, "primitive-button", {
    label: unwrapTextLiteral(label),
    onClick: onClickHandler,
    hasOnClick: onClickHandler !== undefined,
    disabled,
    hasDisabled: disabled !== undefined,
    loading,
    hasLoading: loading !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice 11.29 — render any named arg's value through emitExpr.
 *  Used for boolean prop pass-through (`disabled:`, `loading:`)
 *  where the value is an arbitrary expression — refs, hook
 *  accessors, binary ops are all admissible. */
function anyNamedArgExpr(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    return emitExpr(call.args[i]!, ctx);
  }
  return undefined;
}

/** Slice 11.7 — extract a lambda-shaped named arg from a call.
 *  Returns the lambda IR sub-node (its `param`/`body`/`block`
 *  fields) so callers can emit the handler.  Returns undefined
 *  when the named arg is missing or isn't a lambda. */
function lambdaArg(
  call: ExprIR & { kind: "call" },
  name: string,
): (ExprIR & { kind: "lambda" }) | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "lambda") return a;
  }
  return undefined;
}

/** Render a Lambda IR as a TS arrow function suitable for an event
 *  handler position.  The lambda's source-side `param` name is
 *  dropped — v0 walker output is event-data-agnostic and emitting
 *  `() => …` keeps the generated code clean (no unused-var
 *  warnings).  Block-body lambdas emit a brace-wrapped sequence of
 *  statements; expression-body lambdas emit a single expression. */
function emitLambdaBody(
  lam: ExprIR & { kind: "lambda" },
  ctx: WalkContext,
): string {
  if (lam.block && lam.block.length > 0) {
    const stmts = lam.block.map((s) => emitStmt(s, ctx)).join(" ");
    return `() => { ${stmts} }`;
  }
  if (lam.body) {
    return `() => ${emitExpr(lam.body, ctx)}`;
  }
  return `() => {}`;
}

/** Render an `ExprIR` as a JS-expression string (NOT JSX).  Used
 *  for the right-hand side of state assignments (`count := count +
 *  1` → `count + 1`) and lambda expression bodies.  State + param
 *  refs render as bare identifiers (they're in scope via
 *  `useState` / `useParams` destructure). */
function emitExpr(expr: ExprIR, ctx: WalkContext): string {
  // Slice 11.24 — api hook injection.  Detect `<param>.<aggregate>.<op>`
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
      // Slice A2 — lambda-bound param refs resolve to their
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
      // Slice A4 — refs to shell-emitted locals (e.g. `create`
      // inside a `Form(of:, onSubmit: v => create.mutateAsync(v))`
      // lambda) resolve as themselves.
      if (ctx.shellLocals.has(expr.name)) return expr.name;
      // Slice 11.23 — refs to `let` bindings are in scope as JS
      // const declarations earlier in the same lambda body.  The IR
      // already tags these with `refKind: "let"`; emit the bare
      // name so the generated code references the local.
      if (expr.refKind === "let") return expr.name;
      return `/* unresolved: ${expr.name} */ undefined`;
    case "binary":
      return `(${emitExpr(expr.left, ctx)} ${expr.op} ${emitExpr(expr.right, ctx)})`;
    case "unary":
      return `(${expr.op}${emitExpr(expr.operand, ctx)})`;
    case "call": {
      // Slice 11.23 — bare function call as a JS expression.  The
      // callee is emitted verbatim — the generated code expects the
      // user to import / declare `<name>` somewhere in their app
      // shell.  Powers patterns like `let n = inc(count)` and the
      // statement form `Button("…", onClick: e => { saveOrder() })`.
      //
      // Slice A6 — UI-declared helper imports take this path too:
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
      // (Slice 11.24), tryDetectApiHook at the top has already
      // returned the hook var; we just append `.<member>`.
      return `${emitExpr(expr.receiver, ctx)}.${expr.member}`;
    }
    case "object": {
      // Slice 11.29 — object literal: `{ name: name, age: 30 }`
      // emits as plain JS `{ name: name, age: 30 }`.  Field values
      // recurse through emitExpr (so refs/state/binary ops compose).
      const fields = expr.fields
        .map((f) => `${f.name}: ${emitExpr(f.value, ctx)}`)
        .join(", ");
      return `{ ${fields} }`;
    }
    case "method-call": {
      // Slice 11.24 — when the method-call's receiver is a hook
      // (detected by tryDetectApiHook on the receiver), emit
      // `<hookVar>.<method>(<args>)` (e.g.
      // `customerCreate.mutate({...})`).
      const recvHookUse = tryDetectApiHook(expr.receiver, ctx);
      if (recvHookUse) {
        registerApiHook(recvHookUse, ctx);
        const args = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
        return `${recvHookUse.varName}.${expr.member}(${args})`;
      }
      // Slice A4 — method calls on plain JS receivers (e.g. a
      // local `create` mutation hook inside a `Form(of:)` page's
      // onSubmit lambda).  Emit the plain `recv.member(args)`
      // form when the receiver resolves cleanly (param / state /
      // lambda param / shell local).  Receivers that emit as the
      // `/* unresolved: X */ undefined` sentinel keep the
      // pre-existing Slice 11.23 TODO placeholder — emitting
      // `undefined.<method>(...)` would be runtime-broken code.
      const recv = emitExpr(expr.receiver, ctx);
      const argsRendered = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
      if (recv.includes("/* unresolved:")) {
        const receiverDesc = describeReceiver(expr.receiver);
        return `/* TODO: method-call ${receiverDesc}.${expr.member}(${argsRendered}) — needs hooks {} binding (Slice 11.24+) */ undefined`;
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
/** Slice 11.24 — detect `<param>.<aggregate>.<op>(args?)` rooted
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
function tryDetectApiHook(expr: ExprIR, ctx: WalkContext): ApiHookUse | null {
  // Pattern A: member(member(ref:apiParam, agg), op)
  if (expr.kind === "member" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return buildHookUse(inner.member, expr.member, [], ctx);
    }
  }
  // Pattern B: method-call(member(ref:apiParam, agg), op, args)
  if (expr.kind === "method-call" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return buildHookUse(inner.member, expr.member, expr.args, ctx);
    }
  }
  // Slice A13 — Pattern C: member(ref:"Views", viewName) lifts to
  // `useXxxView()` from `../api/views`.
  if (expr.kind === "member" && expr.receiver.kind === "ref" && expr.receiver.name === "Views") {
    return buildViewHookUse(expr.member);
  }
  // Slice D1 — Pattern D: member(ref:<Aggregate>, op) without an
  // api param prefix lifts to the same hook Pattern A produces.
  // Lets UIs without a `api X: Y` binding still get auto-injected
  // hooks (e.g. legacy `scaffold modules: M` deployables that
  // never declared api params).
  if (expr.kind === "member" && expr.receiver.kind === "ref"
      && ctx.aggregatesByName.has(expr.receiver.name)) {
    return buildHookUse(expr.receiver.name, expr.member, [], ctx);
  }
  // Slice D1 — Pattern E: same as D but with method-call args
  // (parameterised forms like `Account.byId(id)`).
  if (expr.kind === "method-call" && expr.receiver.kind === "ref"
      && ctx.aggregatesByName.has(expr.receiver.name)) {
    return buildHookUse(expr.receiver.name, expr.member, expr.args, ctx);
  }
  return null;
}

/** Slice A13 — `useXxxView()` hook injection.  View hooks live in
 *  the shared `../api/views.ts` module; the local var name is
 *  `<viewCamel>View` (e.g. `activeOrdersView`). */
function buildViewHookUse(viewName: string): ApiHookUse {
  const viewPascal = pascal(viewName);
  return {
    varName: `${camel(viewName)}View`,
    hookName: `use${viewPascal}View`,
    importFrom: "../api/views",
    argsRendered: [],
  };
}

/** Build the ApiHookUse for a detected `<aggregate>.<op>(args?)`
 *  reference.  Naming convention matches the existing scaffold
 *  output (see `webApp/src/api/<aggregate>.ts`):
 *    `<agg>.all`    → useAll<Plural>
 *    `<agg>.byId`   → use<Single>ById  (parameterized)
 *    `<agg>.create` → useCreate<Single>
 *    `<agg>.update` → useUpdate<Single>
 *    `<agg>.delete` → useDelete<Single>
 *    `<agg>.<find>` → use<FindPascal><Single>  (custom finder)
 *
 *  The local var name is `<aggCamel><OpPascal>` — deterministic,
 *  visible in the generated file, never invented by the user. */
function buildHookUse(
  aggregate: string,
  op: string,
  args: ExprIR[],
  ctx: WalkContext,
): ApiHookUse {
  const aggSingle = pascal(aggregate);
  const aggPlural = plural(aggSingle);
  let hookName: string;
  if (op === "all") hookName = `useAll${aggPlural}`;
  else if (op === "byId") hookName = `use${aggSingle}ById`;
  else if (op === "create") hookName = `useCreate${aggSingle}`;
  else if (op === "update") hookName = `useUpdate${aggSingle}`;
  else if (op === "delete") hookName = `useDelete${aggSingle}`;
  else hookName = `use${pascal(op)}${aggSingle}`;
  const varName = `${camel(aggSingle)}${pascal(op)}`;
  const importFrom = `../api/${camel(aggSingle)}`;
  // Render args via the main ctx so refs to params/state propagate
  // (param refs add to `usedParams` → the shell destructures them
  // from `useParams`; state refs are an error since the hook lives
  // before useState in the function body).
  const argsRendered = args.map((a) => emitExpr(a, ctx));
  return { varName, hookName, importFrom, argsRendered };
}

/** Register a detected hook usage on the walker context.  De-dupes
 *  by var name — if the same `<param>.<aggregate>.<op>` appears
 *  twice in the body, only one declaration is emitted at page-top. */
function registerApiHook(hook: ApiHookUse, ctx: WalkContext): void {
  if (!ctx.usedApiHooks.has(hook.varName)) {
    ctx.usedApiHooks.set(hook.varName, hook);
  }
}

/** Group api-hook imports by source file so multiple ops on one
 *  aggregate (e.g. `useAllCustomers` + `useCreateCustomer`) collapse
 *  to a single import line — matches the existing scaffold output
 *  shape (one api/<aggregate>.ts per aggregate, exporting all
 *  hooks). */
function renderApiHookImports(
  usedApiHooks: Map<string, ApiHookUse>,
  /** Slice C2 — see `renderImportLines` for prefix semantics. */
  srcImportPrefix: string = "../",
): string {
  const byPath = new Map<string, Set<string>>();
  for (const h of usedApiHooks.values()) {
    let names = byPath.get(h.importFrom);
    if (!names) {
      names = new Set();
      byPath.set(h.importFrom, names);
    }
    names.add(h.hookName);
  }
  const lines: string[] = [];
  for (const [path, names] of [...byPath.entries()].sort()) {
    const sorted = [...names].sort();
    const rewritten =
      srcImportPrefix !== "../" && path.startsWith("../")
        ? srcImportPrefix + path.slice(3)
        : path;
    lines.push(`import { ${sorted.join(", ")} } from "${rewritten}";\n`);
  }
  return lines.join("");
}

/** Slice A6 — render `import { … } from "…"` lines for every
 *  UI-declared helper actually used in the body.  Helpers
 *  sharing an import path collapse into one line; paths are
 *  sorted for deterministic output. */
function renderHelperImports(
  usedHelpers: Set<string>,
  declared: ReadonlyArray<UiHelperImportIR>,
): string {
  if (usedHelpers.size === 0) return "";
  const byPath = new Map<string, Set<string>>();
  for (const h of declared) {
    if (!usedHelpers.has(h.name)) continue;
    let names = byPath.get(h.path);
    if (!names) {
      names = new Set();
      byPath.set(h.path, names);
    }
    names.add(h.name);
  }
  const lines: string[] = [];
  for (const [path, names] of [...byPath.entries()].sort()) {
    const sorted = [...names].sort();
    lines.push(`import { ${sorted.join(", ")} } from "${path}";\n`);
  }
  return lines.join("");
}

function describeReceiver(expr: ExprIR): string {
  if (expr.kind === "ref") return expr.name;
  if (expr.kind === "method-call") return `${describeReceiver(expr.receiver)}.${expr.member}`;
  return `<expr>`;
}

/** Render a `StmtIR` as a TS statement string (with a trailing
 *  semicolon).  v0 supports the subset that matters for click
 *  handlers: state mutation (`:=`, `+=`, `-=`), let-binding, and
 *  bare expression statements.  emit / call statements fall
 *  through to a comment for now. */
function emitStmt(stmt: StmtIR, ctx: WalkContext): string {
  switch (stmt.kind) {
    case "assign": {
      const seg = stmt.target.segments;
      if (seg.length === 1 && ctx.stateNames.has(seg[0]!)) {
        ctx.usesState = true;
        const name = seg[0]!;
        const setter = "set" + name[0]!.toUpperCase() + name.slice(1);
        return `${setter}(${emitExpr(stmt.value, ctx)});`;
      }
      return `/* unsupported assign: ${seg.join(".")} */`;
    }
    case "add":
    case "remove": {
      // Slice 11.9 — `count += 1` / `count -= 1` lower to
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
      return `/* unsupported ${stmt.kind === "add" ? "+=" : "-="}: ${seg.join(".")} */`;
    }
    case "let":
      return `const ${stmt.name} = ${emitExpr(stmt.expr, ctx)};`;
    case "expression":
      return `${emitExpr(stmt.expr, ctx)};`;
    case "call": {
      // Slice 11.23 — bare function-call statement (the
      // statement-grammar `name(args)` form).  Walker emits as a
      // plain `name(args);` line; the generated code expects the
      // user to import / declare `<name>` somewhere in their app
      // shell.
      const args = stmt.args.map((a) => emitExpr(a, ctx)).join(", ");
      return `${stmt.name}(${args});`;
    }
    default:
      return `/* unsupported stmt: ${stmt.kind} */`;
  }
}

/** Slice 11.5 — read a named arg as a navigation target.  String
 *  literals come back JSON-quoted (`"\"/orders\""`); refs to a
 *  route param come back as a JS template literal that interpolates
 *  the param at render time (so `to: id` → `` `${id}` ``).  Returns
 *  undefined when the arg isn't present or isn't a recognised
 *  navigation source. */
function stringOrRefArgValue(
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

/** Slice A1 — read the `testid:` named arg from any primitive call
 *  and produce a TSX attribute fragment ready to splice into the
 *  template's opening tag.  Returns `' data-testid="..."'` for
 *  string literals, `' data-testid={...}'` for refs/expressions, or
 *  `''` when no `testid:` was supplied.  Templates splice via
 *  `{{{testidAttr}}}` inside the root element.
 *
 *  Slice A5 — string-literal testids also accumulate on
 *  `ctx.collectedTestids` so the walker-side page-object emitter
 *  can expose each one as a typed `Locator` getter in the
 *  generated `e2e/pages/<page-snake>.ts` class. */
function testidAttr(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): string {
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

function emitCard(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Card("title", content) — first positional title (anything not
  // a call counts as title); second positional is the body.
  // Slice 11.10: `Card(child)` (single non-text-like positional)
  // renders a card with no heading.
  const positionals = positionalArgs(call);
  const titleArg = positionals[0];
  const titleIsTextLike =
    titleArg !== undefined && titleArg.kind !== "call";
  const contentExpr: ExprIR | undefined = titleIsTextLike
    ? positionals[1]
    : positionals[0];
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const titleText = titleIsTextLike && titleArg
    ? unwrapTextLiteral(renderTextContent(titleArg, ctx) ?? '""')
    : undefined;
  const contentJsx = contentExpr ? walk(contentExpr, ctx, depth + 1) : undefined;
  return renderPrimitive(ctx, "primitive-card", {
    hasTitle: titleText !== undefined,
    titleText,
    hasContent: contentJsx !== undefined,
    contentJsx,
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitStat(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Stat(label, value) — small headline-stat card.  No dedicated
  // component on either pack; both compose two stacked text
  // elements (dimmed label + bold value).
  const positionals = positionalArgs(call);
  const labelArg = positionals[0];
  const valueArg = positionals[1];
  const label = labelArg ? renderTextContent(labelArg, ctx) ?? '""' : '""';
  const value = valueArg ? renderTextContent(valueArg, ctx) ?? '""' : '""';
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-stat", {
    label: unwrapTextLiteral(label),
    value: unwrapTextLiteral(value),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitBadge(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const label = firstPositionalContent(call, ctx) ?? '"Badge"';
  void depth;
  return renderPrimitive(ctx, "primitive-badge", {
    label: unwrapTextLiteral(label),
    testidAttr: testidAttr(call, ctx),
  });
}

function emitSlot(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Slice 11.19 — children-prop placeholder.  `Slot()` inside a
  // component's body emits `{children}`, the React idiom for
  // rendering whatever JSX the parent passed in.  Marks usesChildren
  // on the context so the shell adds `children?: React.ReactNode`
  // to the typed Props interface.
  void call;
  void depth;
  ctx.usesChildren = true;
  return `{children}`;
}

function emitDivider(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  // Optional `label:` named arg — packs that support a labelled
  // divider can use the slot; packs that don't drop it.
  const label = stringNamed(call, "label");
  return renderPrimitive(ctx, "primitive-divider", {
    label,
    hasLabel: label !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A7 — Breadcrumbs(...children, testid?).  Wraps a chain of
 *  positional children (Anchor / Text / arbitrary primitives) in
 *  the per-pack breadcrumbs container.  Mantine's `<Breadcrumbs>`
 *  inserts separators automatically; shadcn renders a flex row
 *  with hand-emitted separators (template responsibility). */
function emitBreadcrumbs(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-breadcrumbs", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A7 — Paper(...children, padding?, testid?).  Per-pack
 *  surface container with consistent padding + subtle shadow.
 *  Composable wrapper for tables, cards, alerts.  Defaults to
 *  `p="md"` (Mantine) / equivalent shadcn class set. */
function emitPaper(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const children = positionalChildren(call, ctx, depth + 1);
  const padding = stringNamed(call, "padding");
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-paper", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    hasPadding: padding !== undefined,
    padding: padding !== undefined ? JSON.stringify(padding) : "",
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A7 — Skeleton(height?, count?, testid?).  Per-pack
 *  loading-placeholder block.  When `count:` > 1, emits a stacked
 *  group of `count` skeleton lines (matching the scaffold's
 *  loading-state convention).  `height:` defaults to 28px. */
function emitSkeleton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const height = numericNamed(call, "height") ?? 28;
  const count = numericNamed(call, "count") ?? 1;
  return renderPrimitive(ctx, "primitive-skeleton", {
    height,
    count,
    isMulti: count > 1,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A7 — Alert(message, color?, title?, testid?).  Per-pack
 *  callout for error / info / warning states.  `color:` accepts
 *  the per-pack semantic palette ("red"/"green"/"yellow"/"blue").
 *  `title:` is optional; without it, packs render the message
 *  alone (Mantine's `<Alert>` skips the bold-title block). */
function emitAlert(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const message = firstPositionalContent(call, ctx) ?? '""';
  const color = stringNamed(call, "color");
  const title = stringNamed(call, "title");
  return renderPrimitive(ctx, "primitive-alert", {
    message: unwrapTextLiteral(message),
    hasColor: color !== undefined,
    color: color ?? "red",
    hasTitle: title !== undefined,
    title: title ?? "",
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A8 — QueryView(of:, loading:, error:, empty:, data:, testid?).
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
function emitQueryView(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const ofArg = namedArgValue(call, "of");
  if (!ofArg) {
    return `{/* QueryView: missing 'of:' query expression */}`;
  }
  // Render the query expression; this triggers `tryDetectApiHook`
  // so the page-shell registers the matching `useAll<X>()` (or
  // similar) hook decl + import, and we get the local var name
  // back via emitExpr's hook-detection path.
  const queryExpr = emitExpr(ofArg, ctx);

  const indent = "  ".repeat(depth + 1);
  const branchIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);

  const loading = namedArgValue(call, "loading");
  const error = namedArgValue(call, "error");
  const empty = namedArgValue(call, "empty");
  const data = namedArgValue(call, "data");
  // Slice A11 — `single: true` flips QueryView to single-record
  // semantics (byId queries return `T | undefined`, not `T[]`).
  // The `empty` branch fires when `data === undefined` after
  // loading completes; `data` branch fires when `data` is truthy.
  // Without the flag, the default collection semantics apply
  // (`data && data.length === 0` / `data && data.length > 0`).
  const single = boolNamed(call, "single");

  const loadingJsx = loading ? walk(loading, ctx, depth + 2) : "null";
  const errorJsx = error ? walk(error, ctx, depth + 2) : "null";
  const emptyJsx = empty ? walk(empty, ctx, depth + 2) : "null";

  // `data:` branch supports the lambda-binding form `rows => …`.
  // Lambda body walks with the lambda param rebound to the
  // unwrapped query data; non-lambda bodies render as-is.
  let dataJsx: string;
  if (data && data.kind === "lambda") {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, data.param, `${queryExpr}.data`),
    };
    dataJsx = data.body
      ? walk(data.body, childCtx, depth + 2)
      : "null";
    propagateChildFlags(ctx, childCtx);
  } else if (data) {
    dataJsx = walk(data, ctx, depth + 2);
  } else {
    dataJsx = "null";
  }

  return renderPrimitive(ctx, "primitive-query-view", {
    queryExpr,
    loadingJsx,
    errorJsx,
    emptyJsx,
    dataJsx,
    single,
    indent,
    branchIndent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice A10 — KeyValueRow(label, child, testid?).  Two-column
 *  detail-page row that pairs a fixed-width label with a value.
 *  First positional is the label string; second positional is the
 *  child JSX (any walker primitive).  Per-pack runtime helper
 *  `KeyValueRow` does the layout. */
function emitKeyValueRow(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const positionals = positionalArgs(call);
  const labelArg = positionals[0];
  const childArg = positionals[1];
  const labelStr =
    labelArg && labelArg.kind === "literal" && labelArg.lit === "string"
      ? labelArg.value
      : "";
  const childJsx = childArg
    ? walk(childArg, ctx, depth + 2)
    : "{/* missing value */}";
  return renderPrimitive(ctx, "primitive-key-value-row", {
    label: escapeJsxText(labelStr),
    childJsx,
    testidAttr: testidAttr(call, ctx),
  });
}

function emitUserComponent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Slice 11.18 — invoke a user-defined component as a JSX element.
  // Positional args map to the component's declared param names by
  // position; named args use their `name:` prefix verbatim.  String
  // literals render as quoted attrs (`name="Alice"`); refs / binary
  // ops / non-string literals emit through emitExpr inside `{...}`.
  //
  // Slice 11.19 — positional args BEYOND the component's declared
  // param count are JSX children — wrapped between the open and
  // close tags so the component receives them via the `children`
  // prop.  Named args still go to props regardless of position.
  const params = ctx.userComponents.get(call.name) ?? [];
  ctx.usedUserComponents.add(call.name);
  const argNames = call.argNames ?? [];
  // Slice 11.19 — collect names already filled by named args so
  // positional args don't clobber them when looking up the next
  // free param slot.
  const filledByName = new Set<string>();
  for (let i = 0; i < argNames.length; i++) {
    const n = argNames[i];
    if (n !== undefined) filledByName.add(n);
  }
  const attrs: string[] = [];
  const childrenExprs: ExprIR[] = [];
  let nextParamCursor = 0;
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i]!;
    if (argNames[i] !== undefined) {
      attrs.push(`${argNames[i]}=${attrValue(arg, ctx)}`);
      continue;
    }
    // Advance the cursor past any params that were already filled
    // via a named arg.
    while (
      nextParamCursor < params.length &&
      filledByName.has(params[nextParamCursor]!.name)
    ) {
      nextParamCursor += 1;
    }
    const param = params[nextParamCursor];
    if (param) {
      nextParamCursor += 1;
      attrs.push(`${param.name}=${attrValue(arg, ctx)}`);
    } else {
      // No more declared params — extra positional arg becomes a
      // JSX child.
      childrenExprs.push(arg);
    }
  }
  const open = attrs.length > 0
    ? `<${call.name} ${attrs.join(" ")}`
    : `<${call.name}`;
  if (childrenExprs.length === 0) {
    return `${open} />`;
  }
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const childTsx = childrenExprs
    .map((c) => walk(c, ctx, depth + 1))
    .join(`\n${indent}`);
  return `${open}>\n${indent}${childTsx}\n${closeIndent}</${call.name}>`;
}

/** Slice 11.18 — render an ExprIR as a JSX attribute value.
 *  String literals → `"text"` (quoted attr); everything else →
 *  `{<emitExpr>}` (brace-wrapped JS expression). */
function attrValue(expr: ExprIR, ctx: WalkContext): string {
  if (expr.kind === "literal" && expr.lit === "string") {
    return JSON.stringify(expr.value);
  }
  return `{${emitExpr(expr, ctx)}}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positionalArgs(call: ExprIR & { kind: "call" }): ExprIR[] {
  const argNames = call.argNames ?? [];
  const out: ExprIR[] = [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] === undefined) out.push(call.args[i]!);
  }
  return out;
}

function positionalChildren(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string[] {
  return positionalArgs(call).map((a) => walk(a, ctx, depth));
}

function firstPositionalText(call: ExprIR & { kind: "call" }): string | undefined {
  const positionals = positionalArgs(call);
  const first = positionals[0];
  if (!first) return undefined;
  if (first.kind === "literal" && first.lit === "string") return first.value;
  return undefined;
}

/** Slice 11.4 — return the JSX-render shape of the first
 *  positional arg as a TEXT-position content.  Quoted strings
 *  come back as `"text"` (so callers wrap them in {} when needed
 *  or strip the quotes for direct JSX text); refs come back as
 *  `{name}` (already JSX-expression-wrapped).  Returns undefined
 *  when the first positional isn't a recognisable text source. */
function firstPositionalContent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): string | undefined {
  const positionals = positionalArgs(call);
  const first = positionals[0];
  if (!first) return undefined;
  return renderTextContent(first, ctx);
}

function renderTextContent(
  expr: ExprIR,
  ctx: WalkContext,
): string | undefined {
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
    // Slice 11.4 — unresolved ref in text position emits a JSX
    // comment so the user sees the unresolved name in the
    // generated file (the page still compiles; the comment makes
    // the gap visible).
    return `{/* ref: ${expr.name} */}`;
  }
  // Slice 11.10 — anything else (binary op, unary, non-string
  // literal): emit the JS-expression form wrapped as a JSX
  // expression.  Powers patterns like `Heading("Welcome, " +
  // name)`, `Text(count + 1)`, `Stat("Count", count * step)`.
  //
  // Slice A6 — UI-declared helper calls also belong in text
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

/** Slice 11.4 helper — `firstPositionalContent` returns either a
 *  `"quoted string"` or a `{paramRef}` JSX expression.  Components
 *  embedding the result in JSX text need quoted strings unwrapped
 *  to bare text; JSX expressions stay verbatim. */
function unwrapTextLiteral(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return escapeJsxText(JSON.parse(s) as string);
  }
  return s;
}

function stringNamed(
  call: ExprIR & { kind: "call" },
  name: string,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "string") return a.value;
  }
  return undefined;
}

function numericNamed(
  call: ExprIR & { kind: "call" },
  name: string,
): number | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "int") {
      const n = Number(a.value);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

function escapeJsxText(s: string): string {
  // Replace `{` and `}` (which JSX would interpret as expression
  // delimiters) with their HTML entity equivalents.  Apostrophes /
  // quotes are fine inside JSX text.
  return s.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

/** Render the page-file shell around a walked body — imports +
 *  function component + return.
 *
 *  Slice 11.4 — when the page has typed route params, the walker
 *  is given their names.  If the body referenced any of them
 *  (`Heading(name)`, `Text(customerId)`), the shell adds a
 *  `useParams<{ name: string, customerId: string }>()` hook and
 *  destructures the names so the JSX expressions resolve at
 *  render time.  Unused params are NOT destructured (avoids TS
 *  "declared but never read" warnings) — but the type parameter
 *  always lists every declared param so the typed shape stays
 *  intact regardless of usage. */
export function renderCustomLayoutPage(
  pageName: string,
  body: ExprIR,
  pack: LoadedPack,
  params: ParamIR[] = [],
  state: StateFieldIR[] = [],
  /** Slice 11.12 — page-level `title:` expression.  Renders into a
   *  `useEffect` that sets `document.title` on mount and whenever
   *  any referenced param/state changes (deps array auto-derived
   *  from the title expression's refs). */
  title: ExprIR | undefined = undefined,
  /** Slice 11.18 — user-defined components in scope, so calls to
   *  them in the body emit as `<Name prop={…} />` instead of
   *  unknown-component placeholders. */
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  /** Slice 11.24 — UI api parameters.  Body refs of the form
   *  `<paramName>.<aggregate>.<op>` become hook calls injected at
   *  page-top by the walker. */
  apiParams: ReadonlyArray<UiApiParamIR> = [],
  /** Slice A4 — aggregates reachable from this UI's deployable.
   *  Required for `Form(of: <Agg>)` field dispatch and
   *  `IdLink(of: <Agg>)` display-field resolution. */
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Slice A4 — owning bounded context per aggregate (drives
   *  enum / value-object resolution inside the form-field
   *  preparer). */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** Slice A6 — user-authored helper imports.  Body refs whose
   *  call name matches a helper emit as plain JS calls; the shell
   *  adds `import { <name> } from "<path>"` for each USED helper. */
  helperImports: ReadonlyArray<UiHelperImportIR> = [],
  /** Slice C2 — relative-path prefix from the emitted page TSX
   *  back to the `src/` root.  Defaults to `"../"` for pages at
   *  `src/pages/<name>.tsx` (1 hop).  Scaffold-expanded pages live
   *  at `src/pages/<plural>/<arch>.tsx` (2 hops) so the caller
   *  passes `"../../"`.  Used to resolve api-hook + format-helper
   *  imports the shell emits at function-top. */
  srcImportPrefix: string = "../",
  /** Slice A12 — workflows reachable from this UI's deployable.
   *  Required for `Form(runs: <wf>)` field dispatch. */
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  /** Slice A12 — owning bounded context per workflow. */
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usedParams,
    usesNavigate,
    usesState,
    usesRouterLink,
    usedUserComponents,
    usedApiHooks,
    formOf,
    usedHelpers,
  } = walkBodyToTsx(
    body,
    pack,
    paramNames,
    stateNames,
    userComponents,
    apiParams,
    aggregatesByName,
    bcByAggregate,
    helperImports,
    workflowsByName,
    bcByWorkflow,
  );
  // Slice 11.12 — render the title expression through emitExpr
  // (sharing the body's tracking state so the shell destructures
  // any param/state the title references).  Compute the deps
  // array from the title's referenced names so the effect re-runs
  // when those values change.
  let titleEffect = "";
  let usesEffect = false;
  let usesStateForTitle = false;
  if (title !== undefined) {
    const titleCtx: WalkContext = {
      imports,
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      usesState,
      usesRouterLink: false,
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
      formOf: null,
      collectedTestids: new Set(),
      helperImports: new Map(),
      usedHelpers: new Set(),
    };
    const titleExpr = emitExpr(title, titleCtx);
    // emitExpr may have added to usedParams; reflect title's state
    // usage separately so the shell knows whether to import useState.
    usesStateForTitle = titleCtx.usesState && !usesState;
    const refs = new Set<string>();
    collectExprRefs(title, refs);
    const deps = [...refs]
      .filter((n) => paramNames.has(n) || stateNames.has(n))
      .sort();
    titleEffect = `  useEffect(() => { document.title = ${titleExpr}; }, [${deps.join(", ")}]);\n`;
    usesEffect = true;
  }
  const effectiveUsesState = usesState || usesStateForTitle;

  const mantineImport = renderImportLines(imports, srcImportPrefix);
  // Slice 11.18 — one default-import line per user component
  // referenced in the body, sorted alphabetically.
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((name) => `import ${name} from "${srcImportPrefix}components/${name}";\n`)
    .join("");
  // Slice 11.24 — api hook imports, grouped per `from` path so
  // multiple ops on the same aggregate dedupe to one import line
  // (matching the existing scaffold output's per-aggregate api file).
  const apiHookImports = renderApiHookImports(usedApiHooks, srcImportPrefix);
  // Slice A6 — `import { <name> } from "<path>"` per UI-declared
  // helper actually referenced in the body.  Lines grouped per
  // path so two helpers from the same module dedupe to one
  // import line; paths sorted for deterministic output.
  const helperImportLines = renderHelperImports(usedHelpers, helperImports);
  // Slice 11.24 — api hook declarations, emitted at page-top right
  // before the JSX return.  Each unique `<param>.<aggregate>.<op>`
  // becomes one `const <var> = use<Op><Aggregate>(args?);` line.
  const apiHookDecls = [...usedApiHooks.values()]
    .map((h) => `  const ${h.varName} = ${h.hookName}(${h.argsRendered.join(", ")});\n`)
    .join("");
  // Slice A4 — RHF wiring when the body included a `Form(of: <Agg>)`
  // primitive.  Emits the create-mutation hook import, per-Id<X>
  // target `useAllX()` hooks, the `useForm` declaration, and the
  // `react-hook-form` import.  When the user provided an explicit
  // `onSubmit:` lambda the shell wires that into `handleSubmit`;
  // otherwise the default is the scaffold-equivalent create flow.
  const form = renderFormOfWiring(formOf, pack, srcImportPrefix);
  const hasParams = params.length > 0;
  const routerSpecifiers: string[] = [];
  if (hasParams) routerSpecifiers.push("useParams");
  if (usesNavigate || form.usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link as RouterLink");
  const reactRouterImport = routerSpecifiers.length > 0
    ? `import { ${routerSpecifiers.join(", ")} } from "react-router-dom";\n`
    : "";
  // Slice 11.7 — emit the `useState` hook + per-field declaration
  // when any state ref or `:=` mutation surfaced during the walk.
  // Pages that DECLARE state but never reference it from the body
  // skip the import so unused-var warnings stay quiet (parallel to
  // how `usedParams` shapes the useParams destructure).
  // Slice 11.12 — `useEffect` joins the same React import line.
  const reactSpecifiers: string[] = [];
  if (effectiveUsesState) reactSpecifiers.push("useState");
  if (usesEffect) reactSpecifiers.push("useEffect");
  const reactImport = reactSpecifiers.length > 0
    ? `import { ${reactSpecifiers.join(", ")} } from "react";\n`
    : "";
  const stateLines = effectiveUsesState
    ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("")
    : "";
  const paramsType = hasParams
    ? `<{ ${params.map((p) => `${p.name}: ${typeRefAsTsString(p)}`).join("; ")} }>`
    : "";
  const used = [...usedParams].sort();
  const paramsLine = used.length > 0
    ? `  const { ${used.join(", ")} } = useParams${paramsType}();\n`
    : hasParams
      ? `  useParams${paramsType}();\n`
      : "";
  const navigateLine = usesNavigate || form.usesNavigate
    ? `  const navigate = useNavigate();\n`
    : "";
  return `// Auto-generated.  Do not edit by hand.
${reactImport}${reactRouterImport}${form.imports}${mantineImport}${apiHookImports}${helperImportLines}${userComponentImports}
export default function ${pageName}() {
${paramsLine}${navigateLine}${stateLines}${apiHookDecls}${form.decls}${titleEffect}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Slice A4 — assemble the RHF + create-mutation wiring around a
 *  `Form(of: <Agg>)` body emission.  Rendered through per-pack
 *  templates (`form-of-imports.hbs` + `form-of-decls.hbs`) so the
 *  pack controls exactly which packages it imports and how it
 *  destructures the RHF result (`form.handleSubmit` for shadcn,
 *  destructured `{ handleSubmit, register, … }` for mantine).
 *
 *  The form's JSX block (rendered by `emitFormOf`) embeds the
 *  `handleSubmit(...)` call directly; this helper produces only
 *  the shell-level surroundings: imports + in-function hook
 *  declarations + the `usesNavigate` signal. */
function renderFormOfWiring(
  state: FormOfState | null,
  pack: LoadedPack,
  /** Slice C2 — see `renderImportLines` for prefix semantics. */
  srcImportPrefix: string = "../",
): { imports: string; decls: string; usesNavigate: boolean } {
  if (!state) return { imports: "", decls: "", usesNavigate: false };
  if (state.kind === "workflow") {
    return renderFormRunsWiring(state, pack, srcImportPrefix);
  }
  const { agg, idTargets, useController, defaultValuesTs, onSubmitJs } = state;
  const tplCtx = {
    aggregateName: agg.name,
    aggregateNameCamel: camel(agg.name),
    pluralAggregateName: plural(agg.name),
    snakePluralAggregate: snake(plural(agg.name)),
    humanAgg: humanize(agg.name),
    humanAggLower: humanize(agg.name).toLowerCase(),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: camel(t.name),
      namePlural: plural(t.name),
      hookVar: idTargetHookVar(t),
    })),
    useController,
    defaultValuesTs,
    hasDefaultOnSubmit: onSubmitJs === null,
  };
  const imports = pack.render("form-of-imports", tplCtx);
  const decls = pack.render("form-of-decls", tplCtx);
  return {
    imports: imports.endsWith("\n") ? imports : imports + "\n",
    decls: decls.endsWith("\n") ? decls : decls + "\n",
    usesNavigate: onSubmitJs === null,
  };
}

/** Slice A12 — workflow-form variant of renderFormOfWiring.  Same
 *  RHF wiring, but the request type / mutation hook / import
 *  source come from the workflow surface (`<Wf>Request`,
 *  `use<Wf>Workflow`, `../api/workflows`) instead of the
 *  aggregate's. */
function renderFormRunsWiring(
  state: WorkflowFormState,
  pack: LoadedPack,
  srcImportPrefix: string,
): { imports: string; decls: string; usesNavigate: boolean } {
  const { workflow, idTargets, useController, defaultValuesTs, onSubmitJs } = state;
  const wfPascal = pascal(workflow.name);
  const tplCtx = {
    workflowName: workflow.name,
    workflowPascal: wfPascal,
    humanWorkflow: humanize(workflow.name),
    srcImportPrefix,
    idTargets: idTargets.map((t) => ({
      name: t.name,
      nameCamel: camel(t.name),
      namePlural: plural(t.name),
      hookVar: idTargetHookVar(t),
    })),
    useController,
    defaultValuesTs,
    hasDefaultOnSubmit: onSubmitJs === null,
  };
  const imports = pack.render("form-runs-imports", tplCtx);
  const decls = pack.render("form-runs-decls", tplCtx);
  return {
    imports: imports.endsWith("\n") ? imports : imports + "\n",
    decls: decls.endsWith("\n") ? decls : decls + "\n",
    usesNavigate: onSubmitJs === null,
  };
}

/** Slice 11.18 — render one ComponentIR as a `.tsx` file: typed
 *  Props interface, default-export function component, useState
 *  declarations from the component's own state, body walked
 *  through the same machinery as page bodies.  Components don't
 *  have routes / titles, so the shell skips useParams /
 *  useEffect; they CAN have state and CAN invoke other user
 *  components. */
export function renderUserComponentFile(
  name: string,
  params: ParamIR[],
  state: StateFieldIR[],
  body: ExprIR,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usedParams,
    usesState,
    usesRouterLink,
    usesNavigate,
    usedUserComponents,
    usesChildren,
  } = walkBodyToTsx(body, pack, paramNames, stateNames, userComponents);
  const mantineImport = renderImportLines(imports);
  // Components don't have routes — useNavigate/Link still legal in
  // a component subtree (e.g. Button(to:) inside).
  const routerSpecifiers: string[] = [];
  if (usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link as RouterLink");
  const reactRouterImport = routerSpecifiers.length > 0
    ? `import { ${routerSpecifiers.join(", ")} } from "react-router-dom";\n`
    : "";
  const reactImport = usesState
    ? `import { useState } from "react";\n`
    : "";
  // Slice 11.19 — components that reference Slot() get a
  // `children` prop on top of their declared params.  React's
  // type is imported lazily.
  const reactTypesImport = usesChildren
    ? `import type { ReactNode } from "react";\n`
    : "";
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((n) => `import ${n} from "./${n}";\n`)
    .join("");
  // Props interface — every declared param becomes a typed field;
  // Slot()-using components also get a `children` field.
  const propLines = params.map(
    (p) => `  ${p.name}: ${typeRefAsTsString(p)};`,
  );
  if (usesChildren) propLines.push(`  children?: ReactNode;`);
  const propsType = propLines.length > 0
    ? `\nexport interface ${name}Props {\n${propLines.join("\n")}\n}\n`
    : "";
  const destructureNames = params.map((p) => p.name);
  if (usesChildren) destructureNames.push("children");
  const propDestructure = destructureNames.length > 0
    ? `{ ${destructureNames.join(", ")} }: ${name}Props`
    : "";
  const navigateLine = usesNavigate
    ? `  const navigate = useNavigate();\n`
    : "";
  const stateLines = usesState
    ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("")
    : "";
  // Suppress used-prop warnings — params declared but unused at
  // walker-emit time (e.g. typed pass-through to a child component
  // not yet wired) shouldn't trigger TS lint noise.  We reference
  // them with a `void` block when none made it into `tsx`.
  void usedParams;
  return `// Auto-generated.  Do not edit by hand.
${reactImport}${reactTypesImport}${reactRouterImport}${mantineImport}${userComponentImports}${propsType}
export default function ${name}(${propDestructure}) {
${navigateLine}${stateLines}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Slice 11.12 — collect every name referenced in an expression
 *  (via `ref` nodes), used to derive the deps array for the
 *  title's `useEffect`.  Walks binary / unary / call subtrees. */
function collectExprRefs(expr: ExprIR, out: Set<string>): void {
  switch (expr.kind) {
    case "ref":
      out.add(expr.name);
      return;
    case "binary":
      collectExprRefs(expr.left, out);
      collectExprRefs(expr.right, out);
      return;
    case "unary":
      collectExprRefs(expr.operand, out);
      return;
    case "call":
      for (const a of expr.args) collectExprRefs(a, out);
      return;
    default:
      return;
  }
}

/** Slice 11.7 — render one `state {}` field as a React `useState`
 *  declaration: `const [name, setName] = useState<T>(init);`.  Init
 *  comes from the field's optional `=` initializer; absent
 *  initializers fall back to the type's zero value. */
function renderUseState(field: StateFieldIR, pack: LoadedPack): string {
  const setter = "set" + field.name[0]!.toUpperCase() + field.name.slice(1);
  const tsType = stateTypeAsTsString(field.type);
  const init = field.init !== undefined
    ? renderInitExpr(field.init, pack)
    : zeroValueForType(field.type);
  return `const [${field.name}, ${setter}] = useState<${tsType}>(${init});`;
}

/** Render a state-field initializer ExprIR as a JS expression
 *  string.  Reuses the same shape `emitExpr` produces but runs
 *  with an empty context — initializers can't reference state or
 *  params (they evaluate at component-mount time). */
function renderInitExpr(expr: ExprIR, pack: LoadedPack): string {
  // Empty walker context — init expressions don't see state /
  // params (they evaluate before the hooks run).
  const dummy: WalkContext = {
    imports: new Map(),
    pack,
    paramNames: new Set(),
    usedParams: new Set(),
    usesNavigate: false,
    stateNames: new Set(),
    usesState: false,
    usesRouterLink: false,
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
    formOf: null,
    collectedTestids: new Set(),
    helperImports: new Map(),
    usedHelpers: new Set(),
  };
  return emitExpr(expr, dummy);
}

/** Map a Loom `TypeIR` to the TS type used in `useState<T>(...)`.
 *  v0 covers the primitives that show up in click-counter-shaped
 *  toy pages; complex types fall back to `any`. */
function stateTypeAsTsString(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "bool":
        return "boolean";
      case "string":
      case "datetime":
      case "guid":
        return "string";
    }
  }
  if (type.kind === "id" || type.kind === "enum") return "string";
  if (type.kind === "optional") {
    return `${stateTypeAsTsString(type.inner)} | undefined`;
  }
  return "any";
}

/** Default initial value for a state field that doesn't declare an
 *  `=` initializer.  Mirrors the spec §6 zero-value table. */
function zeroValueForType(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "bool":
        return "false";
      case "string":
      case "datetime":
      case "guid":
        return '""';
    }
  }
  if (type.kind === "id" || type.kind === "enum") return '""';
  if (type.kind === "optional") return "undefined";
  return "undefined";
}

/** Render a `ParamIR` (route param) as the TS type the
 *  `useParams<{...}>()` generic should declare for it.  Slice 11.4
 *  v0 — every route param is `string` at the React-Router level;
 *  the original Loom type intent (e.g. `Id<Order>`) is preserved
 *  in the IR but doesn't affect the typed-useParams shape today.
 *  A future slice can layer `z.coerce` or similar at the page-
 *  shell to convert to the declared types. */
function typeRefAsTsString(p: ParamIR): string {
  void p;
  return "string";
}

/** Indent every line of a JSX fragment by a given prefix.  First
 *  line is left as-is (the surrounding template provides its
 *  prefix). */
function indentJsx(tsx: string, prefix: string): string {
  const lines = tsx.split("\n");
  return lines
    .map((l, i) => (i === 0 ? l : prefix + l))
    .join("\n");
}
