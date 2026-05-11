// ---------------------------------------------------------------------------
// HEEx walker — Batch B core.
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
//     custom-page bodies (PageIR.body without scaffoldOrigin).
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
  ExprIR,
  PageIR,
  StmtIR,
  UiIR,
  UiHelperImportIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { camel, pascal, snake } from "../../util/naming.js";

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
}

export interface WalkContext {
  /** App's module prefix, e.g. "PhoenixApp" — used for Ash code-interface
   *  call qualification (`PhoenixApp.Sales.create_customer!(...)`). */
  appModule: string;
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
  /** Current rendering position — see RenderPosition. */
  position: RenderPosition;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function walkBodyToHeex(
  body: ExprIR | undefined,
  page: PageIR,
  ui: UiIR,
  appModule: string,
): WalkResult {
  const stateNames = new Set<string>(page.state.map((f) => snake(f.name)));
  const ctx: WalkContext = {
    appModule,
    page,
    ui,
    stateNames,
    usedHelpers: new Set(),
    handlers: [],
    position: "template",
  };

  const heex = body ? renderExpr(body, ctx) : `<!-- empty body -->`;

  // Helper imports — resolve from used set against declared imports.
  const aliasLines: string[] = [];
  for (const decl of ui.helperImports as readonly UiHelperImportIR[]) {
    if (!ctx.usedHelpers.has(decl.name)) continue;
    aliasLines.push(elixirAliasForHelper(decl));
  }

  return { heex, handlers: ctx.handlers, aliasLines };
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

function renderRef(
  expr: Extract<ExprIR, { kind: "ref" }>,
  ctx: WalkContext,
): string {
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
      return ctx.position === "template"
        ? `@current_user`
        : `socket.assigns.current_user`;
    case "helper-fn":
      ctx.usedHelpers.add(expr.name);
      return snake(expr.name);
    default:
      return snake(expr.name);
  }
}

function renderMember(
  expr: Extract<ExprIR, { kind: "member" }>,
  ctx: WalkContext,
): string {
  // Map well-known property accesses to their Elixir analogs.
  if (expr.member === "length" || expr.member === "count") {
    return `Enum.count(${renderExpr(expr.receiver, ctx)})`;
  }
  if (
    expr.receiver.kind === "ref" &&
    expr.receiver.refKind === "current-user"
  ) {
    const cu =
      ctx.position === "template" ? "@current_user" : "socket.assigns.current_user";
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

function renderCall(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  // navigate(<Page>, { … }) — Loom's cross-page navigation primitive.
  if (expr.name === "navigate") {
    return renderNavigate(expr, ctx);
  }
  // toast(<msg>) — flash message.
  if (expr.name === "toast") {
    return renderToast(expr, ctx);
  }
  // Extended closed primitive library — complex primitives with
  // dedicated renderers.
  switch (expr.name) {
    case "List":        return renderList(expr, ctx);
    case "Detail":      return renderDetail(expr, ctx);
    case "Form":        return renderForm(expr, ctx);
    case "MasterDetail": return renderMasterDetail(expr, ctx);
    case "Dashboard":   return renderDashboard(expr, ctx);
    case "Review":      return renderReview(expr, ctx);
    case "Grid":        return renderGrid(expr, ctx);
    case "Tabs":        return renderTabs(expr, ctx);
    case "Field":       return renderField(expr, ctx);
    case "Toggle":      return renderToggle(expr, ctx);
    case "Select":      return renderSelect(expr, ctx);
    case "Fieldset":    return renderFieldset(expr, ctx);
    case "Stat":        return renderStat(expr, ctx);
  }
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

function renderBinary(
  expr: Extract<ExprIR, { kind: "binary" }>,
  ctx: WalkContext,
): string {
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

function renderMatch(
  expr: Extract<ExprIR, { kind: "match" }>,
  ctx: WalkContext,
): string {
  // `match { p => v; … else => f }` → Elixir `cond do … end`.
  // Wrapping in `<%= … %>` is the caller's job when the match appears
  // in template position; in handler position, just the bare cond.
  const arms = expr.arms
    .map((a) => `      ${renderExpr(a.cond, ctx)} -> ${renderExpr(a.value, ctx)}`)
    .join("\n");
  const elseArm = expr.otherwise
    ? `\n      true -> ${renderExpr(expr.otherwise, ctx)}`
    : "";
  const cond = `cond do\n${arms}${elseArm}\n    end`;
  return ctx.position === "template" ? `<%= ${cond} %>` : cond;
}

function renderObjectLiteral(
  expr: Extract<ExprIR, { kind: "object" }>,
  ctx: WalkContext,
): string {
  const fields = expr.fields
    .map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`)
    .join(", ");
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
  // Phase 3B's code-interface convention:
  //   .create  → create_<single>!(args)
  //   .update  → update_<single>!(record, args)
  //   .delete  → destroy_<single>!(record)
  //   .all     → list_<plural>!()
  //   .byId(x) → get_<single>!(x)
  //   <op>     → <op>_<single>!(record, args)
  // The api handle resolves to a backend that hosts a `<App>.<Ctx>`
  // module; v0 emits `<AppModule>.<Handle>.<fn>(...)` since the
  // handle name and context name match in acme.ddd (`Sales`).
  const handle = pascal(call.apiHandle);
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

function renderNavigate(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  // navigate(<Page>, { customerId: x }) — first arg is the page
  // reference, second is the params object.
  // Phase 3B's router uses `live "<route>", <Page>Live`; we lower to
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

function renderToast(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const msg = expr.args[0] ? renderExpr(expr.args[0], ctx) : `""`;
  return `put_flash(socket, :info, ${msg})`;
}

// ---------------------------------------------------------------------------
// Closed primitive library — HEEx component dispatch.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared argument-extraction helpers (mirrors React body-walker helpers).
// ---------------------------------------------------------------------------

function namedArgValue(
  expr: Extract<ExprIR, { kind: "call" }>,
  name: string,
): ExprIR | undefined {
  const argNames = expr.argNames ?? [];
  for (let i = 0; i < expr.args.length; i++) {
    if (argNames[i] === name) return expr.args[i];
  }
  return undefined;
}

function positionalArgs(expr: Extract<ExprIR, { kind: "call" }>): ExprIR[] {
  const argNames = expr.argNames ?? [];
  return expr.args.filter((_, i) => !argNames[i]);
}

function stringNamed(
  expr: Extract<ExprIR, { kind: "call" }>,
  name: string,
): string | undefined {
  const v = namedArgValue(expr, name);
  if (v && v.kind === "literal" && v.lit === "string") return v.value;
  return undefined;
}

function namedLambdaArg(
  expr: Extract<ExprIR, { kind: "call" }>,
  name: string,
): Extract<ExprIR, { kind: "lambda" }> | undefined {
  const v = namedArgValue(expr, name);
  if (v && v.kind === "lambda") return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// Extended primitive renderers — Batch H.
// ---------------------------------------------------------------------------

/** List(of: T, source?: expr) → <.table id="list" rows={…}> */
function renderList(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const sourceArg = namedArgValue(expr, "source");
  const ofArg = namedArgValue(expr, "of");
  const rowsExpr = sourceArg
    ? renderExpr(sourceArg, { ...ctx, position: "template" })
    : ofArg && ofArg.kind === "ref"
      ? `@${snake(ofArg.name)}_list`
      : "@rows";
  return `<.table id="list" rows={${rowsExpr}}>
  <:col :let={row} label="ID"><%= row.id %></:col>
  <%!-- TODO: add columns per field of T --%>
</.table>`;
}

/** Detail(of: T, by: Id<T>) → <dl> of field rows */
function renderDetail(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const ofArg = namedArgValue(expr, "of");
  const recordExpr = ofArg && ofArg.kind === "ref"
    ? `@${snake(ofArg.name)}`
    : "@record";
  // Wire per-operation buttons for known action args.
  const actionLines: string[] = [];
  const actionArg = namedArgValue(expr, "actions");
  if (actionArg) {
    const eventName = hoistLambdaToHandler(actionArg, ctx);
    actionLines.push(`  <.button phx-click="${eventName}">Action</.button>`);
  }
  const actionsBlock = actionLines.length > 0 ? "\n" + actionLines.join("\n") : "";
  return `<dl>
  <%!-- TODO: render fields from ${recordExpr} --%>
  <div class="field-row">
    <dt>ID</dt>
    <dd><%= ${recordExpr}.id %></dd>
  </div>${actionsBlock}
</dl>`;
}

/** Form(creates: T | runs: workflow | into: state, fields, onSubmit, then?) */
function renderForm(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const onSubmitLam = namedLambdaArg(expr, "onSubmit");
  const eventName = onSubmitLam
    ? hoistLambdaToHandler(onSubmitLam, ctx)
    : "save";

  const createsArg = namedArgValue(expr, "creates");
  const runsArg = namedArgValue(expr, "runs");
  const intoArg = namedArgValue(expr, "into");

  // Determine form source annotation.
  let formComment: string;
  if (createsArg && createsArg.kind === "ref") {
    const mod = pascal(createsArg.name);
    formComment = `<%!-- AshPhoenix.Form.for_create(${mod}, :create) --%>`;
  } else if (runsArg && runsArg.kind === "ref") {
    formComment = `<%!-- AshPhoenix.Form against workflow ${runsArg.name} --%>`;
  } else if (intoArg) {
    formComment = `<%!-- wizard step bound to socket assigns --%>`;
  } else {
    formComment = `<%!-- TODO: specify creates:, runs:, or into: --%>`;
  }

  // Collect declared fields.
  const fieldsArg = namedArgValue(expr, "fields");
  let fieldsBlock = "  <%!-- TODO: add <.input> per declared field --%>";
  if (fieldsArg && fieldsArg.kind === "call") {
    // Single field short-hand.
    fieldsBlock = `  ${renderFieldInput(fieldsArg, ctx)}`;
  }

  return `${formComment}
<.simple_form for={@form} phx-submit="${eventName}">
${fieldsBlock}
  <:actions>
    <.button type="submit">Submit</.button>
  </:actions>
</.simple_form>`;
}

/** Render a Field/Toggle/Select IR as an <.input> inside a form. */
function renderFieldInput(
  expr: Extract<ExprIR, { kind: "call" }>,
  _ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const nameArg = positionals[0] ?? namedArgValue(expr, "name");
  const fieldName = nameArg && nameArg.kind === "ref"
    ? snake(nameArg.name)
    : nameArg && nameArg.kind === "literal" && nameArg.lit === "string"
      ? snake(nameArg.value)
      : "field";
  const labelArg = namedArgValue(expr, "label");
  const label = labelArg && labelArg.kind === "literal" && labelArg.lit === "string"
    ? labelArg.value
    : fieldName;
  if (expr.name === "Toggle") {
    return `<.input field={@form[:${fieldName}]} type="checkbox" label="${label}" />`;
  }
  if (expr.name === "Select") {
    return `<.input field={@form[:${fieldName}]} type="select" options={@${fieldName}_options} label="${label}" />`;
  }
  return `<.input field={@form[:${fieldName}]} type="text" label="${label}" />`;
}

/** MasterDetail(of: T, …) → two-column grid with list + detail panel */
function renderMasterDetail(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const ofArg = namedArgValue(expr, "of");
  const listExpr = ofArg && ofArg.kind === "ref"
    ? `@${snake(ofArg.name)}_list`
    : "@rows";
  const actionsArg = namedArgValue(expr, "actions");
  let actionsBlock = "";
  if (actionsArg) {
    const eventName = hoistLambdaToHandler(actionsArg, ctx);
    actionsBlock = `\n      <.button phx-click="${eventName}">Action</.button>`;
  }
  return `<div class="grid grid-cols-[1fr_2fr] gap-4">
  <div class="master-panel">
    <.table id="master-list" rows={${listExpr}}>
      <:col :let={row} label="ID">
        <span phx-click="select_row" phx-value-id={row.id}><%= row.id %></span>
      </:col>
      <%!-- TODO: add columns per field of T --%>
    </.table>
  </div>
  <div class="detail-panel">
    <%= if @selected_row do %>
      <dl>
        <%!-- TODO: render fields from @selected_row --%>
      </dl>${actionsBlock}
    <% else %>
      <.empty />
    <% end %>
  </div>
</div>`;
}

/** Dashboard(items: […]) → grid of cards */
function renderDashboard(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const itemsArg = namedArgValue(expr, "items");
  const children = [...(itemsArg ? [itemsArg] : []), ...positionals];
  const childrenHeex = children
    .map((c) => renderChild(c, ctx))
    .map((h) => `  <div class="card">\n    ${h}\n  </div>`)
    .join("\n");
  return `<div class="grid grid-cols-3 gap-4">
${childrenHeex || "  <%!-- TODO: add dashboard items --%>"}
</div>`;
}

/** Review(of: T, onSubmit) → read-only dl + submit button */
function renderReview(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const ofArg = namedArgValue(expr, "of");
  const recordExpr = ofArg && ofArg.kind === "ref"
    ? `@${snake(ofArg.name)}`
    : "@record";
  const onSubmitLam = namedLambdaArg(expr, "onSubmit");
  const eventName = onSubmitLam
    ? hoistLambdaToHandler(onSubmitLam, ctx)
    : "submit";
  return `<dl>
  <%!-- TODO: render review fields from ${recordExpr} --%>
</dl>
<.button phx-click="${eventName}">Submit</.button>`;
}

/** Grid(…children) → <div class="grid"> */
function renderGrid(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const cols = stringNamed(expr, "cols") ?? stringNamed(expr, "columns") ?? "3";
  const positionals = positionalArgs(expr);
  const childrenHeex = positionals
    .map((c) => renderChild(c, ctx))
    .join("\n");
  return `<div class="grid grid-cols-${cols} gap-4">
${indent(childrenHeex || "<%!-- TODO: add grid children --%>", 2)}
</div>`;
}

/** Tabs(Tab("label", body), …) → <div role="tablist"> with phx-click */
function renderTabs(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const tabs = positionals.map((arg, i) => {
    if (arg.kind !== "call" || arg.name !== "Tab") {
      return {
        value: `tab-${i + 1}`,
        label: `Tab ${i + 1}`,
        bodyHeex: `<%!-- missing tab body --%>`,
      };
    }
    const tabPositionals = positionalArgs(arg);
    const labelArg = tabPositionals[0];
    const bodyArg = tabPositionals[1];
    const labelStr =
      labelArg && labelArg.kind === "literal" && labelArg.lit === "string"
        ? labelArg.value
        : `Tab ${i + 1}`;
    const bodyHeex = bodyArg ? renderChild(bodyArg, ctx) : `<%!-- missing tab body --%>`;
    return {
      value: snake(labelStr) || `tab_${i + 1}`,
      label: labelStr,
      bodyHeex,
    };
  });

  const tabButtons = tabs
    .map(
      (t) =>
        `  <button role="tab" phx-click="switch_tab" phx-value-tab="${t.value}" class={if @active_tab == "${t.value}", do: "tab tab--active", else: "tab"}>${t.label}</button>`,
    )
    .join("\n");

  const tabPanels = tabs
    .map(
      (t) =>
        `  <div role="tabpanel" hidden={@active_tab != "${t.value}"}>\n    ${t.bodyHeex}\n  </div>`,
    )
    .join("\n");

  return `<div>
  <div role="tablist">
${tabButtons}
  </div>
${tabPanels}
</div>`;
}

/** Field(name, label?) → <.input field={@form[:name]} type="text" label=…> */
function renderField(
  expr: Extract<ExprIR, { kind: "call" }>,
  _ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const nameArg = positionals[0] ?? namedArgValue(expr, "name");
  const fieldName = nameArg && nameArg.kind === "ref"
    ? snake(nameArg.name)
    : nameArg && nameArg.kind === "literal" && nameArg.lit === "string"
      ? snake(nameArg.value)
      : "field";
  const label = stringNamed(expr, "label") ?? fieldName;
  const typeStr = stringNamed(expr, "type") ?? "text";
  return `<.input field={@form[:${fieldName}]} type="${typeStr}" label="${label}" />`;
}

/** Toggle(name, label?) → <.input type="checkbox" …> */
function renderToggle(
  expr: Extract<ExprIR, { kind: "call" }>,
  _ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const nameArg = positionals[0] ?? namedArgValue(expr, "name");
  const fieldName = nameArg && nameArg.kind === "ref"
    ? snake(nameArg.name)
    : nameArg && nameArg.kind === "literal" && nameArg.lit === "string"
      ? snake(nameArg.value)
      : "field";
  const label = stringNamed(expr, "label") ?? fieldName;
  return `<.input field={@form[:${fieldName}]} type="checkbox" label="${label}" />`;
}

/** Select(name, options, label?) → <.input type="select" options={…}> */
function renderSelect(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const nameArg = positionals[0] ?? namedArgValue(expr, "name");
  const optionsArg = positionals[1] ?? namedArgValue(expr, "options");
  const fieldName = nameArg && nameArg.kind === "ref"
    ? snake(nameArg.name)
    : nameArg && nameArg.kind === "literal" && nameArg.lit === "string"
      ? snake(nameArg.value)
      : "field";
  const label = stringNamed(expr, "label") ?? fieldName;
  const optionsExpr = optionsArg
    ? renderExpr(optionsArg, { ...ctx, position: "template" })
    : `@${fieldName}_options`;
  return `<.input field={@form[:${fieldName}]} type="select" options={${optionsExpr}} label="${label}" />`;
}

/** Fieldset(legend, children) → <fieldset><legend>…</legend>…</fieldset> */
function renderFieldset(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const legendArg = positionals[0] ?? namedArgValue(expr, "legend");
  const legendText = legendArg
    ? renderInTemplate(legendArg, ctx)
    : "Fieldset";
  const childrenArg = positionals[1] ?? namedArgValue(expr, "children");
  const childrenHeex = childrenArg
    ? renderChild(childrenArg, ctx)
    : "<%!-- TODO: add fieldset children --%>";
  return `<fieldset>
  <legend>${legendText}</legend>
  ${childrenHeex}
</fieldset>`;
}

/** Stat(label, value) → <div class="stat"><dt>…</dt><dd>…</dd></div> */
function renderStat(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const positionals = positionalArgs(expr);
  const labelArg = positionals[0] ?? namedArgValue(expr, "label");
  const valueArg = positionals[1] ?? namedArgValue(expr, "value");
  const labelHeex = labelArg ? renderInTemplate(labelArg, ctx) : "Label";
  const valueHeex = valueArg ? renderInTemplate(valueArg, ctx) : "Value";
  return `<div class="stat">
  <dt>${labelHeex}</dt>
  <dd>${valueHeex}</dd>
</div>`;
}

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
    case "Empty":
      return { tag: ".empty", takesChildren: false };
    case "Badge":
      return { tag: ".badge", takesChildren: true };
    case "Button":
      return { tag: ".button", takesChildren: true };
    case "Action":
      return { tag: ".button", takesChildren: true };
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
    return spec.tag.startsWith(".")
      ? `<${spec.tag}${attrs} />`
      : `<${spec.tag}${attrs} />`;
  }
  return `<${spec.tag}${attrs}>\n${indent(childrenHeex, 2)}\n</${spec.tag}>`;
}

function renderChild(child: ExprIR, ctx: WalkContext): string {
  // If the child is itself a primitive call, render it normally;
  // otherwise wrap in `<%= %>` for inline interpolation.
  if (child.kind === "call" && closedPrimitive(child.name)) {
    return renderExpr(child, ctx);
  }
  if (child.kind === "literal" && child.lit === "string") {
    return child.value;
  }
  return `<%= ${renderExpr(child, { ...ctx, position: "template" })} %>`;
}

function renderInTemplate(arg: ExprIR, ctx: WalkContext): string {
  if (arg.kind === "literal" && arg.lit === "string") return arg.value;
  return `<%= ${renderExpr(arg, { ...ctx, position: "template" })} %>`;
}

function renderAttrValue(
  arg: ExprIR,
  ctx: WalkContext,
  isStatic: boolean,
): string {
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

let handlerCounter = 0;

function hoistLambdaToHandler(arg: ExprIR, ctx: WalkContext): string {
  if (arg.kind !== "lambda") {
    // Not a lambda — try to lower as expression in handler context.
    // Caller will get back something it can put in `phx-click="…"`.
    return "noop";
  }
  // Generate a stable event name.  We use a counter for now;
  // collision-free across one page's walk.
  handlerCounter += 1;
  const eventName = `event_${handlerCounter}`;
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
export function renderRequiresGuard(
  page: PageIR,
  ui: UiIR,
  appModule: string,
): string | null {
  if (!page.requires) return null;
  const ctx: WalkContext = {
    appModule,
    page,
    ui,
    stateNames: new Set(page.state.map((f) => snake(f.name))),
    usedHelpers: new Set(),
    handlers: [],
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
    .map((seg) => pascal(seg.replace(/[^a-zA-Z0-9]/g, "_")))
    .join(".");
  return `  alias ${moduleName}, as: ${pascal(decl.name)}`;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

// Unused-import suppression for re-exports.
void camel;
