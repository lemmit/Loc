// ---------------------------------------------------------------------------
// HEEx walker core.
//
// Sibling of src/generator/react/body-walker.ts but emits HEEx for the
// Phoenix LiveView platform.  Same input (`PageIR.body` expression IR),
// different output language.  Follows the repo's existing per-platform
// renderer pattern (cf. dotnet/render-expr.ts vs typescript/render-expr.ts
// — neither delegates through a common interface; they coexist as
// siblings).
//
// What this walker produces, per page:
//
//   - HEEx body string spliced into `def render(assigns), do: ~H"""..."""`
//   - A list of `handle_event/3` clauses derived from operation actions
//     and block-body lambdas (`onSubmit`, `Action(op).then`).
//
// What this walker DOES NOT cover in v0:
//
//   - Full closed-primitive library (Form/Dashboard/Review/
//     Tabs/Grid/Card/Toolbar/Heading/Text/Badge/Stat/
//     Empty/Field/Toggle/Select/Fieldset/Action/Button).  v0 supports
//     the structural set (Stack/Heading/Text/Card/Toolbar/Empty/
//     Badge/Action/Button); the rest emit a HEEx comment with the
//     primitive name so the gap is visible in generated output.
//   - Field input mapping beyond the basics — page-new / page-detail
//     templates handle the heavy lifting; this walker only renders
//     custom-page bodies (PageIR.body without archetype).
//
// State seam:
//   - Template position: `state.step`  → `@step`
//   - Handler position:  `state.step`  → `socket.assigns.step`
//   - Write (in lambda block-body): `state.step := value` →
//                                   `socket = assign(socket, :step, value)`
//
// Match → `cond do … end` (works in both expression and template position).
//
// Navigate → `push_navigate(socket, to: ~p"<route>")` (handler position only).
//
// API binding (`Sales.Customer.create.mutate(args)`) → direct Ash code
// interface call (`<App>.Sales.create_customer!(args)`) — no hook
// hoisting, LiveView reads inline.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  EnumIR,
  ExprIR,
  PageIR,
  StateFieldIR,
  StmtIR,
  TypeIR,
  UiIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import { humanize, snake, upperFirst } from "../../util/naming.js";
import { tryRenderGate } from "../_frontend/gate-expr.js";
import { WALKER_PRIMITIVES } from "../_walker/registry.js";
import { heexTarget } from "./heex-target.js";

export type RenderPosition = "template" | "handler";

export interface HandleEventClause {
  /** Event name as used in `phx-click="..."` / `phx-submit="..."`. */
  name: string;
  /** Elixir parameter pattern after the event name string.
   *  Common shapes: `_params`, `%{"id" => id}`, `%{"form" => form_params}`. */
  paramsPattern: string;
  /** Body lines, indented relative to the `do` block opening. */
  body: string[];
}

export interface WalkResult {
  /** HEEx body string for `def render(assigns), do: ~H""" … """`. */
  heex: string;
  /** `handle_event/3` clauses for the LiveView module body. */
  handlers: HandleEventClause[];
  /** Form bindings discovered inside the page body — one entry per
   *  `CreateForm(of: Agg)` or `WorkflowForm(runs: Wf)` call.  The LiveView emitter
   *  uses this to assign `@form` in `mount/3` via
   *  `AshPhoenix.Form.for_create(<AggModule>, :create)` (or
   *  `for_action(...)` for workflows) and convert to `to_form(...)`.
   *  Empty when the page body has no form. */
  formBindings: FormBinding[];
  /** Query bindings discovered inside the page body — one per
   *  `QueryView(of: …)` call.  The LiveView emitter consumes these
   *  in `handle_params/3` to load `@data` (single/detail) or
   *  `@items` (list) via the aggregate's Ash code-interface.
   *  Empty when the page has no QueryView. */
  queryBindings: QueryBinding[];
  /** Action bindings discovered inside the body — one per
   *  `Action(<instance>.<op>)`.  Each yields a `handle_event` clause
   *  in the *host page's* LiveView (a component is a stateless function
   *  component, so its actions are hoisted to every page that uses it). */
  actionBindings: ActionBinding[];
  /** Names of user `component`s invoked in the body, so the LiveView
   *  emitter can hoist their action handlers transitively. */
  usedComponents: string[];
  /** True when the body renders a `Slot()` (children passthrough), so the
   *  component emitter declares `slot :inner_block` for it. */
  usesSlot: boolean;
  /** Aggregate names (PascalCase) referenced by `X id` form fields in
   *  this page's body — the LiveView emitter loads each target's
   *  record list in `mount/3` and assigns to
   *  `socket.assigns.<x_snake>_options` so the rendered select can
   *  read `options={@<x_snake>_options}`.  Empty when no `X id` form
   *  field appears. */
  idOptionsBindings: string[];
}

/** `Action(<instance>.<operation>)` → a `<.button phx-click=…>` plus a
 *  hoisted `handle_event` that loads the instance and invokes the Ash
 *  action. */
export interface ActionBinding {
  /** Owning aggregate, PascalCase. */
  agg: string;
  /** Operation name, snake_case (the Ash `update :<op>` action). */
  op: string;
  /** Human-readable operation label for the flash message. */
  opHuman: string;
  /** `phx-click` event name (`<op>_<agg>`); also the code-interface fn. */
  eventName: string;
  /** Optional `then: navigate(<Page>)` target route. */
  thenRoute?: string;
  /** When set, the handler calls `<eventName>!(id)` directly with the route
   *  id (the code interface does the lookup via `get_by: [:id]`), rather than
   *  loading a record first.  Used by `DestroyForm`, whose `destroy_<agg>`
   *  interface takes the id (matching the REST controller's destroy call). */
  byId?: boolean;
}

export interface FormBinding {
  /** Which kind of source the form is bound to. */
  kind: "aggregate" | "workflow" | "operation";
  /** Source name in PascalCase (e.g. "Customer", "PlaceOrder"; for
   *  an operation form, the owning aggregate). */
  name: string;
  /** kind:"operation" only — snake-cased operation name (the Ash
   *  `update :<op>` action the form submits to). */
  op?: string;
  /** kind:"operation" only — deterministic DOM id for the
   *  `<.modal>` wrapping the operation form. */
  modalId?: string;
  /** kind:"operation" only — the operation's params, for `<.input>`
   *  emission and the `for_update` form constructor. */
  params?: readonly { name: string; type: TypeIR }[];
}

export interface QueryBinding {
  /** "single" → detail page (loads one record into `@data`);
   *  "list" → list page (loads the collection into `@items`). */
  kind: "single" | "list";
  /** LiveView assign the page's `cond` reads ("data" / "items"). */
  assign: string;
  /** Aggregate PascalCase name resolved from the `of:` query call,
   *  used to build the `<Ctx>.get_<agg>!` / `list_<agg>s` call. */
  aggregate: string;
}

export interface WalkContext {
  /** App's module prefix, e.g. "PhoenixApp" — used for Ash code-interface
   *  call qualification (`PhoenixApp.Sales.create_customer!(...)`). */
  appModule: string;
  /** Aggregate registry keyed by PascalCase name — supplied by the
   *  orchestrator so `CreateForm(of: Agg)` can look up the aggregate's
   *  fields and emit one `<.input>` per field rather than a single
   *  hardcoded placeholder.  Empty map = no lookup available
   *  (validators upstream will catch missing aggregates). */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Workspace-wide enum registry — drives `renderFieldInputForField`
   *  dispatch for enum-typed fields to `<.input type="select" options={...}>`.
   *  Built once at walker entry from every loaded context's enums. */
  enumsByName: ReadonlyMap<string, EnumIR>;
  /** Workspace-wide value-object registry — drives
   *  `renderFieldInputForField` dispatch for VO-typed fields to
   *  `<.inputs_for :let={…}>` nested forms.  Built once at walker
   *  entry from every loaded context's value objects. */
  valueObjectsByName: ReadonlyMap<string, ValueObjectIR>;
  /** Set of aggregate names (PascalCase) referenced by `X id` form
   *  fields in this page's body — drives mount-time option-list
   *  loading.  For each binding, `renderMount` emits
   *  `socket |> assign(:<x_snake>_options, <ctx>.list_<x_snake>s!() |> Enum.map(...))`
   *  so the rendered select's `options={@<x_snake>_options}` resolves.
   *  Populated lazily as the walker visits Form / OperationForm bodies. */
  idOptionsBindings: Set<string>;
  /** Form bindings discovered as the walker visits `Form(...)` calls. */
  formBindings: FormBinding[];
  /** Query bindings discovered as the walker visits `QueryView(...)`. */
  queryBindings: QueryBinding[];
  /** PageIR being walked — its `state[]` drives state-reference resolution
   *  and its `params[]` resolves route-param refs. */
  page: PageIR;
  /** UI block enclosing the page — its `helperImports[]` resolves
   *  user-helper references. */
  ui: UiIR;
  /** Local name set for `state { … }` fields (snake-cased). */
  stateNames: Set<string>;
  /** Per-field StateFieldIR keyed by snake-cased name.  Drives
   *  `heexTarget.renderStateRead` delegation — the contract's
   *  `StateRef` carries the full field, but the walker historically
   *  carried only the name set.  Built once at walker entry next
   *  to `stateNames` so lookups stay symmetric. */
  stateFields: Map<string, StateFieldIR>;
  /** Accumulated handle_event clauses. */
  handlers: HandleEventClause[];
  /** Accumulated `Action(...)` bindings (hoisted to the host LiveView). */
  actionBindings: ActionBinding[];
  /** Names of user components invoked while walking this body. */
  usedComponents: Set<string>;
  /** Shared box flag set by `Slot()` rendering — boxed so the mutation
   *  survives the `{...ctx}` shallow copies nested renders make (like the
   *  Set/array accumulators above). */
  slotUsed: { value: boolean };
  /** Monotonic per-page counter for `Tabs` instances — boxed (survives the
   *  `{...ctx}` copies) so each Tabs gets a unique id used to scope its
   *  client-side `JS.show`/`JS.hide` toggle selectors. */
  tabSeq: { value: number };
  /** Current rendering position — see RenderPosition. */
  position: RenderPosition;
  /** Optional variable remappings — maps a source ref name to the LiveView
   *  assign name it should resolve to.  Used by QueryView to map lambda
   *  parameter names (e.g. "rows") to their assign names (e.g. "items"). */
  varRemapping?: ReadonlyMap<string, string>;
  /** In-scope instance variable → aggregate name, for instance-qualified
   *  operation forms (`OperationForm(data.confirm)`).  Populated when QueryView
   *  walks its single-record `data:` lambda. */
  instanceTypes?: ReadonlyMap<string, string>;
  /** True when the host deployable runs `auth: required` — so
   *  `LiveAuth.on_mount` assigns `@current_user` into the LiveView scope.
   *  Gates an `Action(<instance>.<op>)` button whose operation's `requires`
   *  predicates are all currentUser-only: the `<.button>` is wrapped in a
   *  HEEx `<%= if (@current_user.…) do %> … <% end %>` so it's hidden
   *  server-side when the gate fails (the Ash action still enforces it).
   *  False ⇒ no `@current_user` exists, so NO gating is emitted and the
   *  button stays byte-identical. */
  authEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function walkBodyToHeex(
  body: ExprIR | undefined,
  page: PageIR,
  ui: UiIR,
  appModule: string,
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Workspace-wide enum registry — drives `renderFieldInputForField`
   *  dispatch for enum-typed fields to `<.input type="select">`.
   *  Defaults to empty when callers haven't threaded enums yet; the
   *  walker falls back to `text` input as before.  See the matching
   *  `aggregatesByName` plumbing for how to populate. */
  enumsByName: ReadonlyMap<string, EnumIR> = new Map(),
  /** Workspace-wide VO registry — drives `renderFieldInputForField`
   *  dispatch for value-object-typed fields to `<.inputs_for :let={…}>`
   *  nested-form blocks.  Defaults to empty when callers haven't
   *  threaded VOs yet; the walker falls back to text input. */
  valueObjectsByName: ReadonlyMap<string, ValueObjectIR> = new Map(),
  /** True when the host deployable runs `auth: required` — drives
   *  action-button gating against `@current_user`.  Defaults to false
   *  (no auth ⇒ no gating ⇒ byte-identical output). */
  authEnabled = false,
): WalkResult {
  const stateNames = new Set<string>(page.state.map((f) => snake(f.name)));
  const stateFields = new Map<string, StateFieldIR>(page.state.map((f) => [snake(f.name), f]));
  // Seed instance types from aggregate-typed params so `Action(p.op)` /
  // `Form(p.op)` resolve the operation's aggregate.  A component param
  // `order: Order` → `order → "Order"`; QueryView extends this for its
  // single-record `data:` lambda.
  const instanceTypes = new Map<string, string>();
  for (const p of page.params) {
    if (p.type.kind === "entity" && aggregatesByName.has(p.type.name)) {
      instanceTypes.set(p.name, p.type.name);
    }
  }
  const ctx: WalkContext = {
    appModule,
    aggregatesByName,
    enumsByName,
    valueObjectsByName,
    idOptionsBindings: new Set(),
    formBindings: [],
    queryBindings: [],
    page,
    ui,
    stateNames,
    stateFields,
    handlers: [],
    actionBindings: [],
    usedComponents: new Set(),
    slotUsed: { value: false },
    tabSeq: { value: 0 },
    position: "template",
    instanceTypes,
    authEnabled,
  };

  const heex = body ? renderExpr(body, ctx) : `<!-- empty body -->`;

  return {
    heex,
    handlers: ctx.handlers,
    formBindings: ctx.formBindings,
    queryBindings: ctx.queryBindings,
    actionBindings: ctx.actionBindings,
    usedComponents: [...ctx.usedComponents],
    usesSlot: ctx.slotUsed.value,
    idOptionsBindings: [...ctx.idOptionsBindings],
  };
}

// ---------------------------------------------------------------------------
// Expression dispatch.
// ---------------------------------------------------------------------------

export function renderExpr(expr: ExprIR, ctx: WalkContext): string {
  switch (expr.kind) {
    case "literal":
      return renderLiteral(expr.lit, expr.value);
    case "this":
      // Outside an aggregate body — `this` in a page context refers to
      // the page's primary data binding.  v0: emit as `@record` and
      // rely on the LiveView's mount to assign it.
      return ctx.position === "template" ? "@record" : "socket.assigns.record";
    case "id":
      return ctx.position === "template" ? "@id" : "socket.assigns.id";
    case "ref":
      return renderRef(expr, ctx);
    case "member":
      return renderMember(expr, ctx);
    case "method-call":
      return renderMethodCall(expr, ctx);
    case "call":
      return renderCall(expr, ctx);
    case "lambda":
      // Lambdas only appear as argument values (onSubmit, onClick, etc.).
      // The walker hoists each lambda into a handle_event clause and
      // returns the phx-event name to wire into the parent attribute.
      return hoistLambdaToHandler(expr, ctx);
    case "object":
      return renderObjectLiteral(expr, ctx);
    case "new":
      // `new Part { … }` only appears in operation bodies; pages
      // shouldn't reach here.  Emit a comment marker.
      return `<%-- TODO: new ${expr.partName} unsupported in page body --%>`;
    case "paren":
      return `(${renderExpr(expr.inner, ctx)})`;
    case "unary":
      if (expr.op === "!") return `not ${renderExpr(expr.operand, ctx)}`;
      return `-${renderExpr(expr.operand, ctx)}`;
    case "binary":
      return renderBinary(expr, ctx);
    case "ternary":
      return `if ${renderExpr(expr.cond, ctx)}, do: ${renderExpr(expr.then, ctx)}, else: ${renderExpr(expr.otherwise, ctx)}`;
    case "convert": {
      // Phoenix HEEx conversion — mirror the renderExpr emit in
      // `elixir/render-expr.ts`.  HEEx pages embed Elixir
      // expressions verbatim inside `<%= … %>`, so the same Elixir
      // idioms apply (Decimal.to_string for money, to_string for
      // primitives, Decimal.new for the inverse).
      const v = renderExpr(expr.value, ctx);
      if (expr.target === "string") {
        if (expr.from === "money") return `Decimal.to_string(${v})`;
        return `to_string(${v})`;
      }
      if (expr.target === "long" || expr.target === "decimal") {
        if (expr.from === "money") return `Decimal.to_float(${v})`;
        return v;
      }
      if (expr.target === "money") {
        if (expr.from === "money") return v;
        return `Decimal.new(${v})`;
      }
      return v;
    }
    case "match":
      return renderMatch(expr, ctx);
    case "list":
      // List literals are walker-config sugar (e.g. responsive Grid cols).
      // No HEEx page-body emit path consumes one today; emit a literal
      // Elixir list so unexpected uses produce valid Elixir.
      return `[${expr.elements.map((el) => renderExpr(el, ctx)).join(", ")}]`;
  }
}

function renderLiteral(kind: string, value: string): string {
  switch (kind) {
    case "string":
      // value already has source quoting stripped; re-quote for Elixir.
      return JSON.stringify(value);
    case "int":
    case "decimal":
      return value;
    case "money":
      // Money literal as an Elixir Decimal.new("…") call; the HEEx
      // template embeds it via `<%= … %>` so the precise value is
      // rendered as the canonical decimal string at request time.
      return `Decimal.new(${JSON.stringify(value)})`;
    case "bool":
      return value === "true" ? "true" : "false";
    case "null":
      return "nil";
    case "now":
      return "DateTime.utc_now()";
    default:
      return value;
  }
}

function renderRef(expr: Extract<ExprIR, { kind: "ref" }>, ctx: WalkContext): string {
  // Variable remapping — QueryView maps lambda params (e.g. "rows") to
  // their LiveView assign names (e.g. "items").  Check this first.
  if (ctx.varRemapping) {
    const remapped = ctx.varRemapping.get(snake(expr.name));
    if (remapped !== undefined) {
      return ctx.position === "template" ? `@${remapped}` : `socket.assigns.${remapped}`;
    }
  }
  // State field — position-dependent.
  if (ctx.stateNames.has(snake(expr.name))) {
    // Delegated to heexTarget.renderStateRead — see
    // `src/generator/_walker/target.ts`.  Walker looks the full
    // StateFieldIR up by snake-cased name (built once at walker
    // entry) and passes through; the target snake-cases the name
    // itself and dispatches by position.
    const field = ctx.stateFields.get(snake(expr.name));
    if (field) {
      return heexTarget.renderStateRead({ field, name: field.name }, ctx.position);
    }
    // Fallback to legacy path if the field isn't in the map (shouldn't
    // happen — stateNames and stateFields are populated together at
    // walker entry).  Behavior-identical to delegation.
    return ctx.position === "template"
      ? `@${snake(expr.name)}`
      : `socket.assigns.${snake(expr.name)}`;
  }
  // Page/component `derived` binding — LiveView has no render-scope hoist
  // site, so we INLINE-RECOMPUTE: substitute the derived's expr at each
  // use (LiveView re-renders on assign change, so each use stays fresh; a
  // derived referencing an earlier derived resolves via this same
  // substitution; the lowering forbids cycles).  Parenthesised to keep
  // precedence safe when the binding sits inside a larger expression.
  const derivedHit = ctx.page.derived?.find((d) => snake(d.name) === snake(expr.name));
  if (derivedHit) {
    return `(${renderExpr(derivedHit.expr, ctx)})`;
  }
  // Page route param.
  if (ctx.page.params.some((p) => p.name === expr.name)) {
    return ctx.position === "template"
      ? `@${snake(expr.name)}`
      : `socket.assigns.${snake(expr.name)}`;
  }
  switch (expr.refKind) {
    case "param":
    case "let":
    case "lambda":
      return snake(expr.name);
    case "enum-value":
      return `:${snake(expr.name)}`;
    case "current-user":
      return ctx.position === "template" ? `@current_user` : `socket.assigns.current_user`;
    case "helper-fn":
      return snake(expr.name);
    default:
      return snake(expr.name);
  }
}

function renderMember(expr: Extract<ExprIR, { kind: "member" }>, ctx: WalkContext): string {
  // Map well-known property accesses to their Elixir analogs.
  if (expr.member === "length" || expr.member === "count") {
    return `Enum.count(${renderExpr(expr.receiver, ctx)})`;
  }
  if (expr.receiver.kind === "ref" && expr.receiver.refKind === "current-user") {
    const cu = ctx.position === "template" ? "@current_user" : "socket.assigns.current_user";
    return `${cu}.${snake(expr.member)}`;
  }
  return `${renderExpr(expr.receiver, ctx)}.${snake(expr.member)}`;
}

/** JS-frontend collection ops that aren't in the shared `isCollectionOp`
 *  catalogue (`src/util/collection-ops.ts`) but DO render verbatim on the
 *  JS frontends via `emitExpr` (native `Array.prototype` methods).  In a
 *  page body these reach HEEx as a `method-call` whose first arg is a
 *  lambda; without this routing their lambda would be hoisted to a
 *  `handle_event` clause and the op emitted as an invalid `recv.filter(…)`
 *  chain.  `renderCollectionOp` already shapes them into `Enum.filter/2` /
 *  `Enum.map/2` — they just weren't reaching it (DEBT-31). */
const INLINE_LAMBDA_COLLECTION_OPS: ReadonlySet<string> = new Set(["filter", "map", "select"]);

function renderMethodCall(
  expr: Extract<ExprIR, { kind: "method-call" }>,
  ctx: WalkContext,
): string {
  if (
    expr.isCollectionOp ||
    (INLINE_LAMBDA_COLLECTION_OPS.has(expr.member) && expr.args[0]?.kind === "lambda")
  ) {
    return renderCollectionOp(expr, ctx);
  }
  // API binding shape: `<ApiHandle>.<Agg>.<op>(args)`.
  // We detect it structurally: receiver is a `member` whose receiver is
  // a `ref` to one of the UI's api parameters.
  const api = detectApiCall(expr, ctx);
  if (api) return renderApiCall(api, ctx);
  // Generic chained call — emit Elixir-style.
  const recv = renderExpr(expr.receiver, ctx);
  const args = expr.args.map((a) => renderExpr(a, ctx)).join(", ");
  return `${recv}.${snake(expr.member)}(${args})`;
}

/** A call to a user-defined `component` → a fully-qualified HEEx
 *  function-component invocation.  Positional args bind to the
 *  component's declared params in order; named args bind by name.
 *  Values render in template position (refs become `@assign`). */
function renderUserComponent(
  expr: Extract<ExprIR, { kind: "call" }>,
  comp: import("../../ir/types/loom-ir.js").ComponentIR,
  ctx: WalkContext,
): string {
  ctx.usedComponents.add(comp.name);
  const attrs: string[] = [];
  let pos = 0;
  for (let i = 0; i < expr.args.length; i++) {
    const argName = expr.argNames?.[i];
    const paramName = argName ?? comp.params[pos++]?.name;
    if (!paramName) continue;
    const value = renderExpr(expr.args[i]!, { ...ctx, position: "template" });
    attrs.push(`${snake(paramName)}={${value}}`);
  }
  const tag = `${ctx.appModule}Web.Components.UiComponents.${snake(comp.name)}`;
  return attrs.length > 0 ? `<${tag} ${attrs.join(" ")} />` : `<${tag} />`;
}

/** `Action(<instance>.<operation>, then?)` → a `<.button phx-click=…>`
 *  whose event loads the instance by id and invokes the Ash action.
 *  The operation is referenced through an in-scope aggregate instance
 *  (a component param or a QueryView record), resolved via
 *  `instanceTypes`.  The handler is recorded as an `ActionBinding` and
 *  hoisted to the host page's LiveView by the emitter. */
export function renderAction(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const opRef = expr.args.find((_, i) => !expr.argNames?.[i]);
  if (!opRef || opRef.kind !== "member" || opRef.receiver.kind !== "ref") {
    return `<!-- Action: expected <instance>.<operation> -->`;
  }
  const instanceName = opRef.receiver.name;
  const opName = opRef.member;
  const aggName = ctx.instanceTypes?.get(instanceName);
  if (!aggName) {
    return `<!-- Action(${instanceName}.${opName}): '${instanceName}' is not an in-scope aggregate instance -->`;
  }
  const agg = ctx.aggregatesByName.get(aggName);
  const op = agg?.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) {
    return `<!-- Action(${instanceName}.${opName}): no public operation '${opName}' on ${aggName} -->`;
  }
  const eventName = `${snake(opName)}_${snake(aggName)}`;
  const idExpr = `${renderExpr(opRef.receiver, { ...ctx, position: "template" })}.id`;
  // `then: navigate(<Page>)` → push_navigate route (snake convention,
  // matching renderNavigate / the scaffold router).
  let thenRoute: string | undefined;
  for (let i = 0; i < expr.args.length; i++) {
    if (expr.argNames?.[i] !== "then") continue;
    const eff = expr.args[i]!;
    if (eff.kind === "call" && eff.name === "navigate") {
      const target = eff.args[0];
      if (target && target.kind === "ref") thenRoute = `/${snake(target.name)}`;
    }
  }
  if (!ctx.actionBindings.some((b) => b.eventName === eventName)) {
    ctx.actionBindings.push({
      agg: aggName,
      op: snake(opName),
      opHuman: humanize(opName),
      eventName,
      thenRoute,
    });
  }
  const button = `<.button phx-click="${eventName}" phx-value-id={${idExpr}}>${humanize(opName)}</.button>`;
  return gateActionButton(button, op, ctx);
}

/** Wrap an `Action` `<.button>` in a server-side currentUser gate when the
 *  host deployable has auth AND every `requires` predicate on the operation
 *  is currentUser-only — the LiveView/HEEx mirror of the JSX frontends'
 *  action-button gating (`emitAction` in _walker/primitives/controls.ts).
 *
 *  Gating signal: `ctx.authEnabled` (the deployable runs `auth: required`,
 *  so `LiveAuth.on_mount` assigns `@current_user`).  Without auth there is
 *  no `@current_user` to read, so the button is left ungated and the output
 *  stays byte-identical.  An op with no `requires`, or any predicate that
 *  touches `this.<field>` / params (not currentUser-only — `tryRenderGate`
 *  returns null), is also left ungated; the Ash action still enforces the
 *  gate server-side regardless (defence-in-depth). */
function gateActionButton(
  button: string,
  op: import("../../ir/types/loom-ir.js").OperationIR,
  ctx: WalkContext,
): string {
  if (!ctx.authEnabled) return button;
  const gates = op.statements.filter((s) => s.kind === "requires").map((s) => s.expr);
  if (gates.length === 0) return button;
  // Classify with the JS gate-expr (currentUser-only ⇒ non-null); gate only
  // when EVERY predicate is currentUser-only.  The rendered Elixir gate is
  // produced by `renderExpr` in template scope (`@current_user.…`), NOT by
  // the JS renderer — `tryRenderGate` is used purely as the classifier.
  if (!gates.every((g) => tryRenderGate(g, "currentUser") !== null)) return button;
  const tmplCtx: WalkContext = { ...ctx, position: "template" };
  // Multiple `requires` clauses combine with Elixir's `and` (the JSX mirror
  // uses `&&`); `renderExpr` already emits `@current_user.…` in template
  // scope, so the parenthesised predicates compose directly inside `if`.
  const gate = gates.map((g) => `(${renderExpr(g, tmplCtx)})`).join(" and ");
  return `<%= if (${gate}) do %>${button}<% end %>`;
}

function renderCall(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  // navigate(<Page>, { … }) — Loom's cross-page navigation primitive.
  if (expr.name === "navigate") {
    return renderNavigate(expr, ctx);
  }
  // toast(<msg>) — flash message.
  if (expr.name === "toast") {
    return renderToast(expr, ctx);
  }
  // Closed-primitive library dispatch — the typed registry at
  // src/generator/_walker/registry.ts holds the renderer for every
  // primitive the HEEx target supports (a subset of what TSX
  // supports; see the registry for the matrix).  Names registered
  // without a `heex` entry fall through to the user-component /
  // helper paths and ultimately to a visible HEEx comment so the
  // gap is visible in generated output.
  const def = WALKER_PRIMITIVES[expr.name];
  if (def?.heex) return def.heex(expr, ctx);
  // User-defined `component` invocation → a remote HEEx function
  // component (`<MyAppWeb.Components.UiComponents.order_panel … />`).
  const userComp = ctx.ui.components.find((c) => c.name === expr.name);
  if (userComp) return renderUserComponent(expr, userComp, ctx);
  // Registered primitive that the HEEx target doesn't support yet —
  // emit a visible HEEx comment so the divergence shows up in
  // generated output instead of silently producing wrong markup.
  if (def) {
    return `<!-- ${expr.name}: not supported by Phoenix LiveView target -->`;
  }
  // Helper function call.
  if (expr.callKind === "function" || expr.callKind === "free") {
    const args = expr.args.map((a) => renderExpr(a, ctx)).join(", ");
    return `${snake(expr.name)}(${args})`;
  }
  const args = expr.args.map((a) => renderExpr(a, ctx)).join(", ");
  return `${snake(expr.name)}(${args})`;
}

function renderBinary(expr: Extract<ExprIR, { kind: "binary" }>, ctx: WalkContext): string {
  const l = renderExpr(expr.left, ctx);
  const r = renderExpr(expr.right, ctx);
  // String concatenation: Elixir uses `<>`.  Detect by left operand
  // type — but in v0 we don't carry type tags on raw binary nodes
  // ubiquitously, so assume `+` on strings if either side is a string
  // literal.  This matches dotnet/render-expr.ts's heuristic.
  if (expr.op === "+" && (isStringLit(expr.left) || isStringLit(expr.right))) {
    return `${l} <> ${r}`;
  }
  switch (expr.op) {
    case "&&":
      return `${l} and ${r}`;
    case "||":
      return `${l} or ${r}`;
    default:
      return `${l} ${expr.op} ${r}`;
  }
}

function isStringLit(e: ExprIR): boolean {
  return e.kind === "literal" && e.lit === "string";
}

function renderMatch(expr: Extract<ExprIR, { kind: "match" }>, ctx: WalkContext): string {
  // `match { p => v; … else => f }` → Elixir `cond do … end`.
  // Delegates the bare `cond do … end` shape to `heexTarget.renderMatch`
  // (cross-framework contract — see src/generator/_walker/target.ts).
  // The `<%= … %>` template-position wrap stays here because it's
  // walker-local (HEEx walker tracks `ctx.position`; the target
  // contract is position-agnostic for match).
  const arms = expr.arms.map((a) => ({
    predicate: renderExpr(a.cond, ctx),
    value: renderExpr(a.value, ctx),
  }));
  const elseArm = expr.otherwise ? renderExpr(expr.otherwise, ctx) : undefined;
  const cond = heexTarget.renderMatch(arms, elseArm);
  return ctx.position === "template" ? `<%= ${cond} %>` : cond;
}

function renderObjectLiteral(expr: Extract<ExprIR, { kind: "object" }>, ctx: WalkContext): string {
  const fields = expr.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`).join(", ");
  return `%{${fields}}`;
}

// ---------------------------------------------------------------------------
// Collection operations.
// ---------------------------------------------------------------------------

function renderCollectionOp(
  expr: Extract<ExprIR, { kind: "method-call" }>,
  ctx: WalkContext,
): string {
  const recv = renderExpr(expr.receiver, ctx);
  const arg0 = expr.args[0];
  switch (expr.member) {
    case "count":
      return `Enum.count(${recv})`;
    case "sum":
      if (arg0?.kind === "lambda" && arg0.body) {
        const param = arg0.param;
        const body = renderExpr(arg0.body, { ...ctx, position: ctx.position });
        return `Enum.reduce(${recv}, 0, fn ${snake(param)}, acc -> acc + ${body} end)`;
      }
      return `Enum.sum(${recv})`;
    case "where":
    case "filter":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.filter(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return recv;
    case "map":
    case "select":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.map(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return recv;
    case "any":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.any?(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return `(${recv} != [])`;
    case "all":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.all?(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return `true`;
    case "contains":
      if (arg0) {
        return `Enum.member?(${recv}, ${renderExpr(arg0, ctx)})`;
      }
      return `false`;
    default:
      return `${recv}.${snake(expr.member)}(${expr.args.map((a) => renderExpr(a, ctx)).join(", ")})`;
  }
}

// ---------------------------------------------------------------------------
// API binding lowering.
// ---------------------------------------------------------------------------

interface ApiCallSite {
  apiHandle: string;
  aggregateName: string;
  operation: string;
  args: ExprIR[];
}

function detectApiCall(
  expr: Extract<ExprIR, { kind: "method-call" }>,
  ctx: WalkContext,
): ApiCallSite | null {
  // Shape: <ApiHandle>.<Agg>.<op>(args)  →
  // method-call { receiver: member { receiver: ref, member: <Agg> }, member: <op> }
  if (
    expr.receiver.kind === "member" &&
    expr.receiver.receiver.kind === "ref" &&
    isApiHandle(expr.receiver.receiver.name, ctx)
  ) {
    return {
      apiHandle: expr.receiver.receiver.name,
      aggregateName: expr.receiver.member,
      operation: expr.member,
      args: expr.args,
    };
  }
  return null;
}

function isApiHandle(name: string, ctx: WalkContext): boolean {
  return ctx.ui.apiParams.some((p) => p.name === name);
}

function renderApiCall(call: ApiCallSite, ctx: WalkContext): string {
  // The api handle resolves to a backend that hosts a `<App>.<Ctx>`
  // module; v0 emits `<AppModule>.<Handle>.<fn>(...)` since the
  // handle name and context name match in acme.ddd (`Sales`).
  //
  // The bare `<fn>(<args>)` shape — including the op→fn naming
  // convention and the crude pluralisation — is delegated to
  // `heexTarget.renderApiCall` (cross-framework contract — see
  // src/generator/_walker/target.ts).  The `<AppModule>.<Handle>.`
  // prefix stays walker-local because it's a Phoenix-orchestration
  // concern (which module the resource lives in), not a per-target
  // rendering decision.
  const handle = upperFirst(call.apiHandle);
  const renderedArgs = call.args.map((a) => renderExpr(a, ctx)).join(", ");
  const bare = heexTarget.renderApiCall(
    {
      apiHandle: call.apiHandle,
      aggregateName: call.aggregateName,
      operation: call.operation,
      // ApiCallSite.kind isn't consulted by heexTarget.renderApiCall —
      // the bare-fn naming is op-driven, not query-vs-mutation.  Pass
      // a structural placeholder.
      kind: "query",
      args: call.args,
    },
    renderedArgs,
  );
  return `${ctx.appModule}.${handle}.${bare}`;
}

// ---------------------------------------------------------------------------
// Navigation + toast.
// ---------------------------------------------------------------------------

function renderNavigate(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  // navigate(<Page>, { customerId: x }) — first arg is the page
  // reference, second is the params object.  The router uses
  // `live "<route>", <Page>Live`; lowers to `push_navigate(socket,
  // to: ~p"<route>")` with param substitution via Phoenix's `~p`
  // sigil.
  //
  // Walker resolves the page → route + params object → arg list,
  // then delegates the `push_navigate(...)` shape to
  // `heexTarget.renderNavigate` (cross-framework contract — see
  // src/generator/_walker/target.ts).  The `args[0].kind !== "ref"`
  // fallback stays walker-local because it's a parse-time invariant
  // failure, not a per-target rendering decision.
  const target = expr.args[0];
  const params = expr.args[1];
  if (!target || target.kind !== "ref") {
    return `push_navigate(socket, to: "/")`;
  }
  const routePath = `/${snake(target.name)}`;
  const args =
    params && params.kind === "object"
      ? params.fields.map((f) => ({
          name: f.name,
          value: renderExpr(f.value, { ...ctx, position: "handler" }),
        }))
      : [];
  return heexTarget.renderNavigate(routePath, args);
}

function renderToast(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const msg = expr.args[0] ? renderExpr(expr.args[0], ctx) : `""`;
  return `put_flash(socket, :info, ${msg})`;
}

export interface PrimitiveSpec {
  /** HEEx component tag, e.g. ".heading", "div" (for raw layout), or
   *  ".button" — driven by the ashPhoenix pack conventions. */
  tag: string;
  /** Attribute keys that take literal values rendered as static
   *  strings (vs JS-expression braces).  Empty by default. */
  staticAttrs?: string[];
  /** Whether the primitive renders children — if so, the call's
   *  argument that's an array of children expressions is rendered
   *  as nested HEEx. */
  takesChildren?: boolean;
}

export function renderPrimitive(
  spec: PrimitiveSpec,
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  // Named args (`Stack(children: […])`, `Heading("title", level: 2)`)
  // become HEEx attributes; positional args land as children for
  // takesChildren=true, or as the primary value for tag-specific
  // primitives (Heading's text, Badge's label).
  const namedAttrs: string[] = [];
  const childrenExprs: ExprIR[] = [];
  const positional: ExprIR[] = [];

  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name) {
      if (name === "children" && arg.kind === "object") {
        // Unlikely shape; skip.
      } else if (name === "children") {
        // Children as an array.  Unwrap if literal `[a,b,c]` — but the
        // expression IR doesn't have an explicit array literal kind,
        // so children typically arrive as a single sub-expression.
        childrenExprs.push(arg);
      } else if (name === "on" || name === "onClick" || name === "onSubmit" || name === "then") {
        // Lambda → handle_event hoist.
        const eventName = hoistLambdaToHandler(arg, ctx);
        const phxAttr = name === "onSubmit" ? "phx-submit" : "phx-click";
        namedAttrs.push(`${phxAttr}="${eventName}"`);
      } else if (name === "testid") {
        // The DSL `testid:` arg maps to the HTML `data-testid` attribute
        // (what Playwright / lvtest assertions look for).  Without this
        // special-case the generic else-branch below would emit a bare
        // `testid=` attribute which no test harness recognises.
        const value = renderAttrValue(arg, ctx, false);
        namedAttrs.push(`data-testid=${value}`);
      } else {
        const value = renderAttrValue(arg, ctx, spec.staticAttrs?.includes(name) ?? false);
        namedAttrs.push(`${snake(name)}=${value}`);
      }
    } else {
      positional.push(arg);
    }
  }

  // `style: { ... }` escape hatch — see styleIrToHeex.  Pushed first
  // so it lands before any other attributes for predictable output.
  const styleHeexAttr = styleIrToHeex(expr);
  if (styleHeexAttr) namedAttrs.unshift(styleHeexAttr);

  // Handle Heading specially: first positional is text, optional
  // `level:` attribute.
  if (spec.tag === ".header") {
    const text = positional[0] ? renderInTemplate(positional[0], ctx) : "";
    const attrs = namedAttrs.length > 0 ? " " + namedAttrs.join(" ") : "";
    return `<.header${attrs}>${text}</.header>`;
  }
  if (spec.tag === ".empty") {
    const attrs = namedAttrs.length > 0 ? " " + namedAttrs.join(" ") : "";
    return `<.empty${attrs} />`;
  }

  // Other primitives — render children (if any).
  const childrenHeex = [...childrenExprs, ...(spec.takesChildren ? positional : [])]
    .map((c) => renderChild(c, ctx))
    .join("\n");
  const attrs = namedAttrs.length > 0 ? " " + namedAttrs.join(" ") : "";
  if (childrenHeex.length === 0) {
    return spec.tag.startsWith(".") ? `<${spec.tag}${attrs} />` : `<${spec.tag}${attrs} />`;
  }
  return `<${spec.tag}${attrs}>\n${indent(childrenHeex, 2)}\n</${spec.tag}>`;
}

/** Build a `style="..."` HEEx attribute from a call's `style` IR.
 *  Returns undefined when the call carries no style field.  Keys are
 *  emitted verbatim (kebab-case is the HTML CSS spelling).  String-
 *  literal values land as raw CSS values; non-literal values are
 *  passed through as Elixir interpolation (`<%= … %>`) — but for v1
 *  we keep the common path (string literals) static-safe.  Special
 *  characters are HTML-escaped so the attribute stays well-formed. */
function styleIrToHeex(expr: Extract<ExprIR, { kind: "call" }>): string | undefined {
  if (!expr.style || expr.style.entries.length === 0) return undefined;
  const parts = expr.style.entries.map(({ key, value }) => {
    let v: string;
    if (value.kind === "literal" && value.lit === "string") v = value.value;
    else if (value.kind === "ref") v = `<%= ${value.name} %>`;
    else v = "";
    return `${key}: ${v}`;
  });
  const css = parts.join("; ").replace(/"/g, "&quot;");
  return `style="${css}"`;
}

/** Returns true for calls that produce raw HEEx markup (not Elixir
 *  expressions) — these should NOT be wrapped in `<%= %>`.  Consults
 *  the typed registry (anything with a `heex` renderer registered
 *  produces HEEx markup) so new primitives don't need a second list
 *  edit. */
function isHEExCall(name: string): boolean {
  return WALKER_PRIMITIVES[name]?.heex !== undefined;
}

export function renderChild(child: ExprIR, ctx: WalkContext): string {
  // If the child is itself a primitive call that returns HEEx markup,
  // render it directly without `<%= %>` wrapping.
  if (child.kind === "call" && isHEExCall(child.name)) {
    return renderExpr(child, ctx);
  }
  if (child.kind === "literal" && child.lit === "string") {
    return child.value;
  }
  return `<%= ${renderExpr(child, { ...ctx, position: "template" })} %>`;
}

export function renderInTemplate(arg: ExprIR, ctx: WalkContext): string {
  if (arg.kind === "literal" && arg.lit === "string") return arg.value;
  // HEEx-generating calls should not be wrapped in <%= %>.
  if (arg.kind === "call" && isHEExCall(arg.name)) {
    return renderExpr(arg, ctx);
  }
  return `<%= ${renderExpr(arg, { ...ctx, position: "template" })} %>`;
}

function renderAttrValue(arg: ExprIR, ctx: WalkContext, isStatic: boolean): string {
  if (arg.kind === "literal" && arg.lit === "string") {
    return JSON.stringify(arg.value);
  }
  if (isStatic && arg.kind === "literal") {
    return JSON.stringify(arg.value);
  }
  return `{${renderExpr(arg, { ...ctx, position: "template" })}}`;
}

// ---------------------------------------------------------------------------
// Lambda hoisting → handle_event clauses.
// ---------------------------------------------------------------------------

function hoistLambdaToHandler(arg: ExprIR, ctx: WalkContext): string {
  if (arg.kind !== "lambda") {
    // Not a lambda — try to lower as expression in handler context.
    // Caller will get back something it can put in `phx-click="…"`.
    return "noop";
  }
  // Event name is scoped to this page's walk: each hoist pushes exactly one
  // handler onto ctx.handlers (shared by reference across nested renders), so
  // its length gives a per-page sequence that resets for the next page and is
  // deterministic regardless of how many pages were walked before.
  const eventName = `event_${ctx.handlers.length + 1}`;
  // Lambda body — either single-expression or block.
  const bodyLines: string[] = [];
  bodyLines.push(`    socket =`);
  if (arg.block) {
    const stmtLines = arg.block.map((s) => renderStmt(s, ctx));
    bodyLines.push(`      socket`);
    for (const line of stmtLines) bodyLines.push(`      ${line}`);
  } else if (arg.body) {
    // Single-expression lambda — typically `() => navigate(...)`.
    const expr = renderExpr(arg.body, { ...ctx, position: "handler" });
    bodyLines.push(`      ${expr}`);
  } else {
    bodyLines.push(`      socket`);
  }
  bodyLines.push(`    {:noreply, socket}`);
  ctx.handlers.push({
    name: eventName,
    paramsPattern: "_params",
    body: bodyLines,
  });
  return eventName;
}

function renderStmt(stmt: StmtIR, ctx: WalkContext): string {
  switch (stmt.kind) {
    case "assign": {
      // state.field := value  →  |> assign(:field, value)
      // Path's first segment is the state field name.  Delegates
      // the pipe-assign shape to `heexTarget.renderStateWrite`
      // (cross-framework contract — see src/generator/_walker/target.ts).
      // We don't carry the full `StateFieldIR` at this site, so pass
      // a minimal-shape StateRef — the target's `renderStateWrite`
      // consumes only the `.name` slot.  When/if the contract grows
      // a method that consults the field's type, this site threads
      // the full StateFieldIR via `ctx.page.state` lookup.
      const fieldName = stmt.target.segments[0];
      if (!fieldName) return `# bad assign`;
      const value = renderExpr(stmt.value, { ...ctx, position: "handler" });
      const stateRef = {
        field: { name: fieldName, type: { kind: "primitive" as const, name: "string" as const } },
        name: fieldName,
      };
      return heexTarget.renderStateWrite(stateRef, value);
    }
    case "let": {
      const value = renderExpr(stmt.expr, { ...ctx, position: "handler" });
      return `|> tap(fn _ -> ${snake(stmt.name)} = ${value} end)`;
    }
    case "expression": {
      const e = renderExpr(stmt.expr, { ...ctx, position: "handler" });
      // If this is a navigate/toast call, route the socket through it.
      if (
        stmt.expr.kind === "call" &&
        (stmt.expr.name === "navigate" || stmt.expr.name === "toast")
      ) {
        return `|> then(fn socket -> ${e} end)`;
      }
      return `|> tap(fn _ -> ${e} end)`;
    }
    default:
      return `# TODO ${stmt.kind}`;
  }
}

// ---------------------------------------------------------------------------
// `requires` page-level guard → handle_params guard expression.
// ---------------------------------------------------------------------------

/** Render a `requires <pred>` guard for `handle_params/3`.  Returns
 *  null when the page has no guard.  Caller wraps in
 *  `if not (<pred>), do: push_navigate(socket, to: "/")`. */
export function renderRequiresGuard(page: PageIR, ui: UiIR, appModule: string): string | null {
  return renderRequiresGuardAt(page, ui, appModule, "handler");
}

/** Render a page's `requires <pred>` in HEEx *template* scope — the
 *  current-user claim resolves to `@current_user` rather than the
 *  handler-scope `socket.assigns.current_user`.  Used by the sidebar
 *  emitter to gate a nav link inside a `<%= if (<gate>) do %>` against the
 *  layout-assigned `@current_user`.  Returns null when the page has no
 *  `requires` clause. */
export function renderRequiresGuardInTemplate(
  page: PageIR,
  ui: UiIR,
  appModule: string,
): string | null {
  return renderRequiresGuardAt(page, ui, appModule, "template");
}

function renderRequiresGuardAt(
  page: PageIR,
  ui: UiIR,
  appModule: string,
  position: RenderPosition,
): string | null {
  if (!page.requires) return null;
  const ctx: WalkContext = {
    appModule,
    aggregatesByName: new Map(),
    enumsByName: new Map(),
    valueObjectsByName: new Map(),
    idOptionsBindings: new Set(),
    formBindings: [],
    queryBindings: [],
    page,
    ui,
    stateNames: new Set(page.state.map((f) => snake(f.name))),
    stateFields: new Map(page.state.map((f) => [snake(f.name), f])),
    handlers: [],
    actionBindings: [],
    usedComponents: new Set(),
    slotUsed: { value: false },
    tabSeq: { value: 0 },
    position,
  };
  return renderExpr(page.requires, ctx);
}

// ---------------------------------------------------------------------------
// State field default values — type-aware.  Caller invokes
// `defaultInitFor(field)` when the field has no explicit `= <init>`.
// ---------------------------------------------------------------------------

export function defaultInitFor(t: TypeIR): string {
  switch (t.kind) {
    case "optional":
      return "nil";
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
        case "decimal":
          return "0";
        case "money":
          return `Decimal.new("0")`;
        case "bool":
          return "false";
        case "string":
        case "guid":
          return `""`;
        case "datetime":
          return "DateTime.utc_now()";
        default:
          return "nil";
      }
    case "id":
      return "nil";
    case "array":
      return "[]";
    default:
      return "nil";
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// the target through the cross-framework contract above; this file
// no longer carries the path → module name derivation.

export function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

// Unused-import suppression for re-exports.
