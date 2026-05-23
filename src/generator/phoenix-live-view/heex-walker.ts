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
//   - A list of Elixir `alias`/`import` lines for user-declared
//     `import helper X from "..."` declarations the body actually
//     references.
//
// What this walker DOES NOT cover in v0:
//
//   - Full closed-primitive library (List/Detail/Form/MasterDetail/
//     Dashboard/Review/Tabs/Grid/Card/Toolbar/Heading/Text/Badge/Stat/
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
  ExprIR,
  PageIR,
  StmtIR,
  TypeIR,
  UiHelperImportIR,
  UiIR,
} from "../../ir/loom-ir.js";
import { humanize, plural, snake, upperFirst } from "../../util/naming.js";

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
  /** Elixir alias lines for user helpers actually referenced. */
  aliasLines: string[];
  /** Form bindings discovered inside the page body — one entry per
   *  `Form(of: Agg)` or `Form(runs: Wf)` call.  The LiveView emitter
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
   *  orchestrator so `Form(of: Agg)` can look up the aggregate's
   *  fields and emit one `<.input>` per field rather than a single
   *  hardcoded placeholder.  Empty map = no lookup available
   *  (validators upstream will catch missing aggregates). */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
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
  /** Set of helper names actually referenced; populated as we walk. */
  usedHelpers: Set<string>;
  /** Accumulated handle_event clauses. */
  handlers: HandleEventClause[];
  /** Accumulated `Action(...)` bindings (hoisted to the host LiveView). */
  actionBindings: ActionBinding[];
  /** Names of user components invoked while walking this body. */
  usedComponents: Set<string>;
  /** Current rendering position — see RenderPosition. */
  position: RenderPosition;
  /** Optional variable remappings — maps a source ref name to the LiveView
   *  assign name it should resolve to.  Used by QueryView to map lambda
   *  parameter names (e.g. "rows") to their assign names (e.g. "items"). */
  varRemapping?: ReadonlyMap<string, string>;
  /** In-scope instance variable → aggregate name, for instance-qualified
   *  operation forms (`Form(data.confirm)`).  Populated when QueryView
   *  walks its single-record `data:` lambda. */
  instanceTypes?: ReadonlyMap<string, string>;
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
): WalkResult {
  const stateNames = new Set<string>(page.state.map((f) => snake(f.name)));
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
    formBindings: [],
    queryBindings: [],
    page,
    ui,
    stateNames,
    usedHelpers: new Set(),
    handlers: [],
    actionBindings: [],
    usedComponents: new Set(),
    position: "template",
    instanceTypes,
  };

  const heex = body ? renderExpr(body, ctx) : `<!-- empty body -->`;

  // Helper imports — resolve from used set against declared imports.
  const aliasLines: string[] = [];
  for (const decl of ui.helperImports as readonly UiHelperImportIR[]) {
    if (!ctx.usedHelpers.has(decl.name)) continue;
    aliasLines.push(elixirAliasForHelper(decl));
  }

  return {
    heex,
    handlers: ctx.handlers,
    aliasLines,
    formBindings: ctx.formBindings,
    queryBindings: ctx.queryBindings,
    actionBindings: ctx.actionBindings,
    usedComponents: [...ctx.usedComponents],
  };
}

// ---------------------------------------------------------------------------
// Expression dispatch.
// ---------------------------------------------------------------------------

function renderExpr(expr: ExprIR, ctx: WalkContext): string {
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
    case "match":
      return renderMatch(expr, ctx);
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
    return ctx.position === "template"
      ? `@${snake(expr.name)}`
      : `socket.assigns.${snake(expr.name)}`;
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
      ctx.usedHelpers.add(expr.name);
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

function renderMethodCall(
  expr: Extract<ExprIR, { kind: "method-call" }>,
  ctx: WalkContext,
): string {
  if (expr.isCollectionOp) {
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
  comp: import("../../ir/loom-ir.js").ComponentIR,
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
function renderAction(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
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
  return `<.button phx-click="${eventName}" phx-value-id={${idExpr}}>${humanize(opName)}</.button>`;
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
  // Scaffold expander primitives with custom HEEx shapes.
  if (expr.name === "Breadcrumbs") return renderBreadcrumbs(expr, ctx);
  if (expr.name === "Anchor") return renderAnchor(expr, ctx);
  if (expr.name === "Modal") return renderModal(expr, ctx);
  if (expr.name === "Form") return renderForm(expr, ctx);
  if (expr.name === "Table") return renderTable(expr, ctx);
  if (expr.name === "QueryView") return renderQueryView(expr, ctx);
  if (expr.name === "KeyValueRow") return renderKeyValueRow(expr, ctx);
  if (expr.name === "Skeleton") return renderSkeleton(expr, ctx);
  if (expr.name === "Alert") return renderAlert(expr, ctx);
  if (expr.name === "Column") return renderTableColumn(expr, ctx);
  if (expr.name === "IdLink") return renderIdLink(expr, ctx);
  if (expr.name === "DateDisplay") return renderDateDisplay(expr, ctx);
  if (expr.name === "EnumBadge") return renderEnumBadge(expr, ctx);
  if (expr.name === "Action") return renderAction(expr, ctx);
  // User-defined `component` invocation → a remote HEEx function
  // component (`<MyAppWeb.Components.UiComponents.order_panel … />`).
  const userComp = ctx.ui.components.find((c) => c.name === expr.name);
  if (userComp) return renderUserComponent(expr, userComp, ctx);
  // Closed primitive library — rendered as HEEx component invocations.
  const prim = closedPrimitive(expr.name);
  if (prim) return renderPrimitive(prim, expr, ctx);
  // Helper function call.
  if (expr.callKind === "function" || expr.callKind === "free") {
    ctx.usedHelpers.add(expr.name);
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
  // Wrapping in `<%= … %>` is the caller's job when the match appears
  // in template position; in handler position, just the bare cond.
  const arms = expr.arms
    .map((a) => `      ${renderExpr(a.cond, ctx)} -> ${renderExpr(a.value, ctx)}`)
    .join("\n");
  const elseArm = expr.otherwise ? `\n      true -> ${renderExpr(expr.otherwise, ctx)}` : "";
  const cond = `cond do\n${arms}${elseArm}\n    end`;
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
  // Code-interface convention:
  //   .create  → create_<single>!(args)
  //   .update  → update_<single>!(record, args)
  //   .delete  → destroy_<single>!(record)
  //   .all     → list_<plural>!()
  //   .byId(x) → get_<single>!(x)
  //   <op>     → <op>_<single>!(record, args)
  // The api handle resolves to a backend that hosts a `<App>.<Ctx>`
  // module; v0 emits `<AppModule>.<Handle>.<fn>(...)` since the
  // handle name and context name match in acme.ddd (`Sales`).
  const handle = upperFirst(call.apiHandle);
  const single = snake(call.aggregateName);
  const args = call.args.map((a) => renderExpr(a, ctx)).join(", ");
  let fn: string;
  switch (call.operation) {
    case "create":
      fn = `create_${single}!`;
      break;
    case "update":
      fn = `update_${single}!`;
      break;
    case "delete":
    case "destroy":
      fn = `destroy_${single}!`;
      break;
    case "all":
      fn = `list_${snake(call.aggregateName)}s!`; // crude plural
      break;
    case "byId":
      fn = `get_${single}!`;
      break;
    default:
      fn = `${snake(call.operation)}_${single}!`;
  }
  return `${ctx.appModule}.${handle}.${fn}(${args})`;
}

// ---------------------------------------------------------------------------
// Navigation + toast.
// ---------------------------------------------------------------------------

function renderNavigate(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  // navigate(<Page>, { customerId: x }) — first arg is the page
  // reference, second is the params object.
  // The router uses `live "<route>", <Page>Live`; we lower to
  // `push_navigate(socket, to: ~p"<route>")`.  Param substitution into
  // `:param` placeholders happens via Phoenix's `~p` sigil.
  const target = expr.args[0];
  const params = expr.args[1];
  if (!target || target.kind !== "ref") {
    return `push_navigate(socket, to: "/")`;
  }
  // We don't have the target page's route at walker time without a
  // page registry; emit a comment marker the orchestrator can
  // post-process if it wants typed routes.  For v0, derive the route
  // from the page name's snake form — the orchestrator's renderRouter
  // does the same for scaffolded pages (`live "/<snake>", <Pascal>Live`).
  const routePath = `/${snake(target.name)}`;
  const queryPairs =
    params && params.kind === "object"
      ? params.fields
          .map((f) => `${snake(f.name)}=#{${renderExpr(f.value, { ...ctx, position: "handler" })}}`)
          .join("&")
      : "";
  const route = queryPairs ? `${routePath}?${queryPairs}` : routePath;
  return `push_navigate(socket, to: ~p"${route}")`;
}

function renderToast(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const msg = expr.args[0] ? renderExpr(expr.args[0], ctx) : `""`;
  return `put_flash(socket, :info, ${msg})`;
}

// ---------------------------------------------------------------------------
// Scaffold expander primitive renderers.
// Each function is called from renderCall when the primitive name matches.
// These emit proper Phoenix/HEEx structures — no <!-- TODO --> comments.
// ---------------------------------------------------------------------------

/** `Breadcrumbs(items...)` → `<nav aria-label="breadcrumb">` with
 *  a list of spans/links.  Positional children are each an Anchor
 *  (link) or Text (current page) from the scaffold expander. */
function renderBreadcrumbs(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const items = expr.args.map((a) => renderChild(a, ctx));
  const itemsHeex = items
    .map((item, i) =>
      i < items.length - 1
        ? `  <li class="breadcrumb-item">${item}</li>\n  <li class="breadcrumb-sep" aria-hidden="true">/</li>`
        : `  <li class="breadcrumb-item breadcrumb-current" aria-current="page">${item}</li>`,
    )
    .join("\n");
  return `<nav aria-label="breadcrumb">\n  <ol class="breadcrumbs">\n${indent(itemsHeex, 2)}\n  </ol>\n</nav>`;
}

/** `Anchor("label", to: "/path")` → `<.link navigate={~p"/path"}>label</.link>`
 *  Falls back to `<a href="...">` when not an internal route literal.
 *  `testid:` becomes `data-testid`. */
function renderAnchor(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let label = "";
  let to = "";
  let testid = "";
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      positional.push(arg);
    } else if (name === "to") {
      to = arg.kind === "literal" ? arg.value : renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "testid") {
      testid =
        arg.kind === "literal" ? arg.value : renderExpr(arg, { ...ctx, position: "template" });
    }
  }
  label = positional[0] ? renderInTemplate(positional[0], ctx) : "";
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  if (to.startsWith("/")) {
    return `<.link navigate={~p"${to}"}${testidAttr}>${label}</.link>`;
  }
  return `<a href="${to}"${testidAttr}>${label}</a>`;
}

/** `Modal(trigger: Button(...), title: "…", Form(of: Agg, op: x))`
 *  → a `<.button phx-click={show_modal(id)}>` trigger followed by
 *  a `<.modal id=…>` hosting a `<.simple_form for={@<op>_form}>`
 *  whose inputs are the operation's params.  Registers an
 *  `kind:"operation"` FormBinding the LiveView emitter turns into
 *  the `@<op>_form` assign + `validate_<op>`/`submit_<op>`
 *  handle_event clauses.  The `Form(of:, op:)` child is consumed
 *  here (never visited by renderChild) — mirrors the React
 *  walker's `emitModal`. */
function renderModal(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let title = "";
  let triggerExpr: ExprIR | undefined;
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "title") {
      title =
        arg.kind === "literal" ? arg.value : renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "trigger") {
      triggerExpr = arg;
    } else if (!name) {
      positional.push(arg);
    }
  }
  const formChild = positional.find(
    (c): c is Extract<ExprIR, { kind: "call" }> => c.kind === "call" && c.name === "Form",
  );
  // The op-form references the operation through an in-scope instance
  // (`Form(data.confirm)`); the receiver names the instance (whose
  // aggregate is resolved via `instanceTypes`) and the member is the
  // operation.
  const opRefNode = formChild ? formChild.args.find((_, i) => !formChild.argNames?.[i]) : undefined;
  const instanceName =
    opRefNode?.kind === "member" && opRefNode.receiver.kind === "ref"
      ? opRefNode.receiver.name
      : undefined;
  const opName = opRefNode?.kind === "member" ? opRefNode.member : undefined;
  const ofName = instanceName ? ctx.instanceTypes?.get(instanceName) : undefined;
  if (!formChild || !ofName || !opName) {
    return `<!-- malformed Modal: expected trigger: Button + Form(<instance>.<operation>) -->`;
  }
  const aggSnake = snake(ofName);
  const opSnake = snake(opName);
  const modalId = `${aggSnake}-op-${opSnake}-modal`;
  const formAssign = `${opSnake}_form`;

  const agg = ctx.aggregatesByName.get(ofName);
  const op = agg?.operations.find((o) => o.name === opName);
  const params = op ? op.params.map((p) => ({ name: p.name, type: p.type })) : [];

  ctx.formBindings.push({
    kind: "operation",
    name: ofName,
    op: opSnake,
    modalId,
    params,
  });

  // Trigger button surface from the `trigger: Button(...)` arg.
  let label = humanize(opName);
  let testid = "";
  if (triggerExpr && triggerExpr.kind === "call" && triggerExpr.name === "Button") {
    for (let i = 0; i < triggerExpr.args.length; i++) {
      const n = triggerExpr.argNames?.[i];
      const a = triggerExpr.args[i]!;
      if (!n && a.kind === "literal") label = a.value;
      else if (n === "testid" && a.kind === "literal") testid = a.value;
    }
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const heading = title || humanize(opName);

  const inputs =
    params.length > 0
      ? params.map((p) => `    ${renderFieldInputForField(p, formAssign)}`)
      : [`    <%!-- ${opSnake} has no parameters --%>`];

  return [
    `<.button phx-click={show_modal("${modalId}")}${testidAttr}>${label}</.button>`,
    `<.modal id="${modalId}">`,
    `  <:title>${heading}</:title>`,
    `  <.simple_form for={@${formAssign}} phx-change="validate_${opSnake}" phx-submit="submit_${opSnake}">`,
    ...inputs,
    `    <:actions>`,
    `      <.button type="submit">${heading}</.button>`,
    `    </:actions>`,
    `  </.simple_form>`,
    `</.modal>`,
  ].join("\n");
}

/** `Form(of: Agg, testid: "...", ...)` → `<.simple_form>` with auto
 *  inputs derived from the aggregate/workflow args.
 *  `runs: Wf` (workflow form) also emits a `<.simple_form>` but
 *  tied to the workflow action name. */
function renderForm(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  // `Form(<instance>.<operation>)` is the operation-modal form —
  // owned and rendered by `renderModal` (it consumes its Form child
  // directly).  This guard makes the function total if a stray
  // op-form is ever reached without its Modal wrapper: bail before
  // pushing a bogus `kind:"aggregate"` create binding.
  const positional0 = expr.args.find((_, i) => !expr.argNames?.[i]);
  if (positional0 && positional0.kind === "member") return "";
  let ofTarget = "";
  let runsTarget = "";
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of") {
      ofTarget =
        arg.kind === "ref" ? snake(arg.name) : renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "runs") {
      runsTarget =
        arg.kind === "ref" ? snake(arg.name) : renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "testid") {
      testid =
        arg.kind === "literal" ? arg.value : renderExpr(arg, { ...ctx, position: "template" });
    }
  }
  const submitEvent = ofTarget ? `save_${ofTarget}` : runsTarget ? `run_${runsTarget}` : "submit";
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  // Register a form binding so the LiveView emitter can assign @form
  // in mount/3.  We track the PascalCase name; emitter handles
  // module-name resolution against contexts + workflows.
  const ofPascal = findPascalArg(expr, "of");
  const runsPascal = findPascalArg(expr, "runs");
  if (ofPascal) {
    ctx.formBindings.push({ kind: "aggregate", name: ofPascal });
  } else if (runsPascal) {
    ctx.formBindings.push({ kind: "workflow", name: runsPascal });
  }
  // Field inputs — derive one <.input> per user-input field on the
  // bound aggregate.  Excludes the `id` primary key (auto-generated by
  // Ash on :create).  Falls back to a single labelled placeholder if
  // the aggregate isn't in the registry — keeps the form well-formed
  // even when scaffold expansion hands us a Form referencing a name
  // the walker can't resolve (shouldn't happen in practice; the
  // validator catches unknowns upstream, but the fallback keeps the
  // emitter total).
  const inputs: string[] = [];
  if (ofPascal) {
    const agg = ctx.aggregatesByName.get(ofPascal);
    if (agg) {
      for (const f of agg.fields) {
        if (f.name === "id") continue;
        inputs.push(`  ${renderFieldInputForField(f)}`);
      }
    }
  }
  if (inputs.length === 0) {
    inputs.push(`  <.input field={@form[:_placeholder]} label="Field" />`);
  }
  return [
    `<.simple_form for={@form} phx-submit="${submitEvent}"${testidAttr}>`,
    ...inputs,
    `  <:actions>`,
    `    <.button type="submit">Submit</.button>`,
    `  </:actions>`,
    `</.simple_form>`,
  ].join("\n");
}

/** Extract a named arg whose value is a `ref` and return its
 *  PascalCase name (the source-level identifier, undisturbed).
 *  Used by renderForm to look up the `of:`/`runs:` targets in the
 *  aggregate/workflow registries.  Returns undefined if the arg
 *  isn't present or isn't a ref. */
function findPascalArg(
  expr: Extract<ExprIR, { kind: "call" }>,
  argName: string,
): string | undefined {
  for (let i = 0; i < expr.args.length; i++) {
    if (expr.argNames?.[i] !== argName) continue;
    const a = expr.args[i];
    if (a && a.kind === "ref") return a.name;
    return undefined;
  }
  return undefined;
}

/** Emit a `<.input>` for a single aggregate field.  Picks the HTML
 *  input type from the IR type and labels it from a humanized name.
 *  T id references fall through to a text input for now — a proper
 *  select-with-options requires loading T's list at mount time and
 *  is out of scope here (see follow-up plan §Form-of-Id). */
function renderFieldInputForField(f: { name: string; type: TypeIR }, formAssign = "form"): string {
  const fieldName = snake(f.name);
  const label = humanize(f.name);
  const inputType = htmlInputTypeForIRType(f.type);
  const isDecimal = f.type.kind === "primitive" && f.type.name === "decimal";
  const extraAttrs = isDecimal ? ` step="0.01"` : "";
  return `<.input field={@${formAssign}[:${fieldName}]} type="${inputType}" label="${label}"${extraAttrs} />`;
}

/** Map a TypeIR to the HTML `<input type="…">` attribute Ash forms
 *  use.  Defaults to "text" for anything not specifically mapped —
 *  including T id, enum (until the select variant lands), and
 *  value-object embeds (which would be split into per-leaf inputs
 *  in a deeper pass — out of scope here). */
function htmlInputTypeForIRType(t: TypeIR): string {
  if (t.kind === "optional") return htmlInputTypeForIRType(t.inner);
  if (t.kind !== "primitive") return "text";
  switch (t.name) {
    case "int":
    case "long":
    case "decimal":
      return "number";
    case "bool":
      return "checkbox";
    case "datetime":
      return "datetime-local";
    default:
      return "text";
  }
}

/** `Table(Column(...), ..., rows: ref("rows"), ...)` →
 *  `<.table id="..." rows={@rows}>` with `<:col :let={row}>` slots. */
function renderTable(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let rowsExpr = "@items";
  let testid = "";
  const cols: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      // positional — Column nodes
      cols.push(arg);
    } else if (name === "rows") {
      rowsExpr = renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "testid") {
      testid =
        arg.kind === "literal" ? arg.value : renderExpr(arg, { ...ctx, position: "template" });
    }
    // striped / highlight / sticky / rowTestid / keyExpr — ignored in HEEx
    // (these are Mantine-specific props; CoreComponents.table doesn't use them)
  }
  const tableId = testid || "data-table";
  const colSlots = cols.map((c) => renderTableColumn(c, ctx)).join("\n");
  return [
    `<.table id="${tableId}" rows={${rowsExpr}}>`,
    colSlots.length > 0 ? indent(colSlots, 2) : `  <:col :let={_row} label="Data"></:col>`,
    `</.table>`,
  ].join("\n");
}

/** Render a `Column("label", accessor_lambda)` node as a
 *  `<:col :let={row} label="...">...</:col>` slot.  Called only from
 *  `renderTable` — never registered as a top-level primitive because
 *  Column nodes are always children of Table in the expander output. */
function renderTableColumn(expr: ExprIR, ctx: WalkContext): string {
  if (expr.kind !== "call" || expr.name !== "Column") {
    // Unexpected shape — emit a stub slot.
    return `<:col :let={_row} label="Column">${renderChild(expr, ctx)}</:col>`;
  }
  // First positional arg: label string
  // Second positional arg: accessor lambda `fn cell -> renderCell(cell) end`
  let label = "Column";
  let cellHeex = "<%= row %>";
  const labelArg = expr.args.find((_, i) => !expr.argNames?.[i]);
  const lambdaArg = expr.args.find((a, i) => !expr.argNames?.[i] && a.kind === "lambda");
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  if (positionals[0]) {
    label =
      positionals[0].kind === "literal"
        ? positionals[0].value
        : renderExpr(positionals[0], { ...ctx, position: "template" });
  }
  void labelArg;
  const accessor = lambdaArg ?? positionals[1];
  if (accessor && accessor.kind === "lambda" && accessor.body) {
    // The row variable is a :let={o} slot binding — a local variable, NOT
    // a LiveView assign.  Do NOT add it to stateNames (which would give
    // it an `@` prefix).  The renderRef fall-through for "unknown" refKind
    // returns bare `snake(name)`, which is exactly what we want inside the
    // <:col :let={o}> slot.
    cellHeex = renderChild(accessor.body, ctx);
  }
  return `<:col :let={${renderColLetVar(accessor, ctx)}} label="${label}">${cellHeex}</:col>`;
}

/** Extract the row variable name from a Column accessor lambda for the
 *  `:let={row}` binding.  Falls back to `"row"` when shape is unexpected. */
function renderColLetVar(accessor: ExprIR | undefined, _ctx: WalkContext): string {
  if (accessor && accessor.kind === "lambda") return snake(accessor.param);
  return "row";
}

/** `QueryView(of: expr, loading: ..., error: ..., empty: ..., data: rows => ...)` →
 *  LiveView-idiomatic conditional rendering.
 *
 *  The `data:` lambda's parameter (usually `rows` or `data`) maps to a
 *  LiveView assign (`@items` or `@data`).  mount() is responsible for
 *  pre-loading (or setting nil for lazy loading).  The success branch
 *  renders the lambda body directly — the Table primitive reads its
 *  own `rows={…}` from the same assign, so no for-loop is needed here. */
/** Resolve the aggregate PascalCase name out of a `QueryView`
 *  `of:` argument.  The scaffold-expander emits one of:
 *    detail  → method-call `<api>.<Agg>.byId(id)` (receiver is a
 *              member `{receiver: ref(api), member: Agg}`), or the
 *              no-api fallback `<Agg>.byId(id)` (receiver ref(Agg))
 *    list    → member access `<api>.<Agg>.all` (the `.all` is the
 *              outer member; its receiver is `<api>.<Agg>`), or the
 *              fallback bare `ref(Agg)` / `<Agg>.all`. */
function resolveQueryAggregate(arg: ExprIR): string | undefined {
  if (arg.kind === "method-call") {
    if (arg.receiver.kind === "member") return arg.receiver.member;
    if (arg.receiver.kind === "ref") return arg.receiver.name;
  }
  if (arg.kind === "member") {
    // `<api>.<Agg>.all` → receiver is `<api>.<Agg>` (a member);
    // `<Agg>.all` → receiver is ref(Agg).
    if (arg.receiver.kind === "member") return arg.receiver.member;
    if (arg.receiver.kind === "ref") return arg.receiver.name;
    return arg.member;
  }
  if (arg.kind === "ref") return arg.name;
  return undefined;
}

function renderQueryView(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let ofExpr = "";
  let ofArgNode: ExprIR | undefined;
  let loadingHeex = `<div class="animate-pulse">Loading...</div>`;
  let errorHeex = `<div class="alert alert-error">Error loading data.</div>`;
  let emptyHeex = `<div class="empty">No items.</div>`;
  let dataHeex = "";
  let dataVar = "rows";
  let assignName = "items";
  let isSingle = false;

  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of") {
      ofArgNode = arg;
      ofExpr = renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "single") {
      isSingle = arg.kind === "literal" && arg.value === "true";
    } else if (name === "loading") {
      loadingHeex = renderChild(arg, ctx);
    } else if (name === "error") {
      errorHeex = renderChild(arg, ctx);
    } else if (name === "empty") {
      emptyHeex = renderChild(arg, ctx);
    } else if (name === "data") {
      if (arg.kind === "lambda") {
        dataVar = snake(arg.param);
        // Map the lambda param name to a LiveView assign.
        // Convention: "rows" → @items (list pages), "data" → @data (detail pages)
        assignName = dataVar === "rows" ? "items" : dataVar;
        // Build a remapping so ref("rows") → @items, ref("data") → @data, etc.
        const remapping = new Map<string, string>([[dataVar, assignName]]);
        // Type the data binding so a nested instance-qualified op-form
        // (`Form(data.confirm)`) resolves the aggregate it operates on.
        const recordAgg = isSingle && ofArgNode ? resolveQueryAggregate(ofArgNode) : undefined;
        const innerCtx: WalkContext = {
          ...ctx,
          varRemapping: remapping,
          instanceTypes:
            recordAgg && ctx.aggregatesByName.has(recordAgg)
              ? new Map([...(ctx.instanceTypes ?? []), [arg.param, recordAgg]])
              : ctx.instanceTypes,
        };
        if (arg.body) dataHeex = renderChild(arg.body, innerCtx);
      } else {
        dataHeex = renderChild(arg, ctx);
      }
    }
  }
  void ofExpr;

  // Register the query binding so the LiveView emitter loads the
  // record(s) in handle_params (the assign the cond below reads is
  // never populated otherwise — see QueryBinding).
  const aggName = ofArgNode ? resolveQueryAggregate(ofArgNode) : undefined;
  if (aggName) {
    ctx.queryBindings.push({
      kind: isSingle ? "single" : "list",
      assign: assignName,
      aggregate: aggName,
    });
  }

  if (isSingle) {
    // Single-record (detail page).  handle_params assigns one of:
    //   nil        → still loading            → loading branch
    //   :error     → Ash load error           → error branch
    //   :not_found → no record for that id     → empty branch
    //   record     → loaded                    → data branch
    return [
      `<%= cond do %>`,
      `  <% is_nil(@${assignName}) -> %>`,
      `    ${loadingHeex}`,
      `  <% @${assignName} == :error -> %>`,
      `    ${errorHeex}`,
      `  <% @${assignName} == :not_found -> %>`,
      `    ${emptyHeex}`,
      `  <% true -> %>`,
      `    ${dataHeex}`,
      `<% end %>`,
    ].join("\n");
  }

  // List query: check for nil (loading), error, empty, then render data.
  // The Table primitive already iterates @items internally via rows={@items},
  // so no Elixir for-loop is needed here.
  return [
    `<%= cond do %>`,
    `  <% is_nil(@${assignName}) -> %>`,
    `    ${loadingHeex}`,
    `  <% @${assignName} == :error -> %>`,
    `    ${errorHeex}`,
    `  <% Enum.empty?(@${assignName}) -> %>`,
    `    ${emptyHeex}`,
    `  <% true -> %>`,
    `    ${dataHeex}`,
    `<% end %>`,
  ].join("\n");
}

/** `KeyValueRow("Label", value_expr)` → `<div class="key-value-row">` */
function renderKeyValueRow(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const label =
    positionals[0]?.kind === "literal"
      ? positionals[0].value
      : positionals[0]
        ? renderInTemplate(positionals[0], ctx)
        : "Field";
  const value = positionals[1] ? renderInTemplate(positionals[1], ctx) : "";
  return `<div class="key-value-row">\n  <dt class="key-value-label">${label}</dt>\n  <dd class="key-value-value">${value}</dd>\n</div>`;
}

/** `Skeleton(count: N)` → `<div class="animate-pulse">` repeated loading lines. */
function renderSkeleton(expr: Extract<ExprIR, { kind: "call" }>, _ctx: WalkContext): string {
  let count = 3;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "count" && arg.kind === "literal") {
      count = parseInt(arg.value, 10) || 3;
    }
  }
  const lines = Array.from(
    { length: count },
    () => `  <div class="h-4 bg-gray-200 rounded animate-pulse mb-2"></div>`,
  ).join("\n");
  return `<div class="skeleton">\n${lines}\n</div>`;
}

/** `Alert("message")` → `<div class="alert">` */
function renderAlert(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let color = "red";
  let message = "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  if (positionals[0]) message = renderInTemplate(positionals[0], ctx);
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "color" && arg.kind === "literal") color = arg.value;
  }
  return `<div class="alert alert-${color}" role="alert">${message}</div>`;
}

/** `IdLink(value, of: Aggregate)` → `<.link navigate={...}>value</.link>` */
function renderIdLink(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let aggName = "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const valueExpr = positionals[0];
  const valueHeex = valueExpr ? renderInTemplate(valueExpr, ctx) : "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of" && arg.kind === "ref") aggName = snake(plural(arg.name));
  }
  if (aggName && valueExpr) {
    const idVal = renderExpr(valueExpr, { ...ctx, position: "template" });
    return `<.link navigate={~p"/${aggName}/#{${idVal}}"}>${valueHeex}</.link>`;
  }
  return `<span>${valueHeex}</span>`;
}

/** `DateDisplay(date_expr)` → `<time>` with formatted date. */
function renderDateDisplay(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const dateExpr = positionals[0];
  if (!dateExpr) return `<time></time>`;
  const val = renderExpr(dateExpr, { ...ctx, position: "template" });
  return `<time datetime={to_string(${val})}><%= Calendar.strftime(${val}, "%Y-%m-%d") %></time>`;
}

/** `EnumBadge(enum_value)` → `<.badge>` with the enum value. */
function renderEnumBadge(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const val = positionals[0] ? renderInTemplate(positionals[0], ctx) : "";
  return `<span class="badge badge-enum">${val}</span>`;
}

// ---------------------------------------------------------------------------
// Closed primitive library — HEEx component dispatch.
// ---------------------------------------------------------------------------

interface PrimitiveSpec {
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

function closedPrimitive(name: string): PrimitiveSpec | null {
  switch (name) {
    case "Stack":
      return { tag: "div", staticAttrs: ["class"], takesChildren: true };
    case "Heading":
      return { tag: ".header", takesChildren: true };
    case "Text":
      return { tag: "p", takesChildren: true };
    case "Card":
      return { tag: "div", staticAttrs: ["class"], takesChildren: true };
    case "Toolbar":
      return { tag: "div", staticAttrs: ["class"], takesChildren: true };
    case "Group":
      return { tag: "div", staticAttrs: ["class"], takesChildren: true };
    case "Empty":
      return { tag: ".empty", takesChildren: false };
    case "Badge":
      return { tag: ".badge", takesChildren: true };
    case "Button":
      return { tag: ".button", takesChildren: true };
    // --- scaffold expander primitives ---
    case "Paper":
      return { tag: "div", staticAttrs: ["class"], takesChildren: true };
    case "Grid":
      return { tag: "div", staticAttrs: ["class"], takesChildren: true };
    case "Container":
      return { tag: "div", staticAttrs: ["class"], takesChildren: true };
    default:
      return null;
  }
}

function renderPrimitive(
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
      } else {
        const value = renderAttrValue(arg, ctx, spec.staticAttrs?.includes(name) ?? false);
        namedAttrs.push(`${snake(name)}=${value}`);
      }
    } else {
      positional.push(arg);
    }
  }

  // Handle Heading specially: first positional is text, optional
  // `level:` attribute.
  if (spec.tag === ".header") {
    const text = positional[0] ? renderInTemplate(positional[0], ctx) : "";
    const attrs = namedAttrs.length > 0 ? " " + namedAttrs.join(" ") : "";
    return `<.header${attrs}>${text}</.header>`;
  }
  if (spec.tag === ".empty") {
    return `<.empty />`;
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

/** Returns true for calls that produce raw HEEx markup (not Elixir
 *  expressions) — these should NOT be wrapped in `<%= %>`. */
function isHEExCall(name: string): boolean {
  return (
    closedPrimitive(name) !== null ||
    name === "Breadcrumbs" ||
    name === "Anchor" ||
    name === "Modal" ||
    name === "Form" ||
    name === "Table" ||
    name === "QueryView" ||
    name === "KeyValueRow" ||
    name === "Skeleton" ||
    name === "Alert" ||
    name === "Column" ||
    name === "IdLink" ||
    name === "DateDisplay" ||
    name === "EnumBadge"
  );
}

function renderChild(child: ExprIR, ctx: WalkContext): string {
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

function renderInTemplate(arg: ExprIR, ctx: WalkContext): string {
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
      // Path's first segment is the state field name.
      const fieldName = stmt.target.segments[0];
      if (!fieldName) return `# bad assign`;
      const value = renderExpr(stmt.value, { ...ctx, position: "handler" });
      return `|> assign(:${snake(fieldName)}, ${value})`;
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
  if (!page.requires) return null;
  const ctx: WalkContext = {
    appModule,
    aggregatesByName: new Map(),
    formBindings: [],
    queryBindings: [],
    page,
    ui,
    stateNames: new Set(page.state.map((f) => snake(f.name))),
    usedHelpers: new Set(),
    handlers: [],
    actionBindings: [],
    usedComponents: new Set(),
    position: "handler",
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

function elixirAliasForHelper(decl: UiHelperImportIR): string {
  // Loom DSL: `import helper formatPrice from "./helpers/price"`.
  // Phoenix-side: `import <App>Web.Helpers.Price` (the user is
  // responsible for ensuring that module exists at the named path).
  // v0 emits an `alias` with the path-derived module name; the user
  // can override at the convention level.
  const moduleName = decl.path
    .replace(/^\.\//, "")
    .replace(/^\.\.\//g, "")
    .split("/")
    .map((seg) => upperFirst(seg.replace(/[^a-zA-Z0-9]/g, "_")))
    .join(".");
  return `  alias ${moduleName}, as: ${upperFirst(decl.name)}`;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

// Unused-import suppression for re-exports.
