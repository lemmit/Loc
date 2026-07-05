import type {
  CreateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  IdValueType,
  OnIR,
  SystemIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { resolveContextSchema } from "../../ir/util/resolve-datasource.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";
import { buildPhoenixResourceModules } from "./adapters/resource-clients.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";
import { renderEsWorkflowHandler } from "./vanilla/workflow-eventsourced-emit.js";
import { lookupOp, opCallParamFields } from "./vanilla/workflow-execution-emit.js";

// ---------------------------------------------------------------------------
// In-process event dispatch for Phoenix LiveView (channels.md).
//
// Mirrors the Hono (#970) and .NET (#1012) slices: each channel-routed
// subscription — an `on(e: Event)` reactor or an event-triggered
// `create(e: Event) by` starter — becomes a handler module with a
// `handle(event)` function.  A per-context `Dispatcher` routes an emitted
// domain event (by its struct type) to every handler subscribed to it; a
// handler that itself `emit`s re-enters the dispatcher, so choreography
// chains (OrderPlaced → ShipmentRequested → …) fan out in-process.
//
// Correlation is persisted when the workflow declares a correlation field:
// the handler routes the event to a saga-instance row keyed by that field
// (load-or-allocate for `create`, route-or-drop+log for `on`).  The row is
// a plain `Ecto.Schema` over the saga table the shared `MigrationsIR`
// already derives — read/written through the app `Ecto.Repo`.
//
// Emitted files (only when `ctx.eventSubscriptions` is non-empty — a
// channel-less context emits none of this, byte-identical):
//   lib/<app>/<ctx>/dispatcher.ex                        — the router
//   lib/<app>/<ctx>/workflows/<wf>/<start|on>_<event>.ex — one per subscription
//   lib/<app>/<ctx>/workflows/<wf>_state.ex              — saga Ecto.Schema
// ---------------------------------------------------------------------------

interface Subscription {
  trigger: "on" | "create";
  event: string;
  param: string;
  workflow: WorkflowIR;
  correlation?: ExprIR;
  statements: WorkflowStmtIR[];
}

/** Resolve a context's `eventSubscriptions` join back to the concrete
 *  reactor / event-create node carrying the body + correlation expression. */
function resolveSubscriptions(ctx: EnrichedBoundedContextIR): Subscription[] {
  const subs: Subscription[] = [];
  for (const s of ctx.eventSubscriptions) {
    const wf = ctx.workflows.find((w) => w.name === s.workflow);
    if (!wf) continue;
    if (s.trigger === "on") {
      const on = (wf.subscriptions ?? []).find(
        (o: OnIR) => o.event === s.event && o.param === s.param,
      );
      if (!on) continue;
      subs.push({
        trigger: "on",
        event: s.event,
        param: s.param,
        workflow: wf,
        correlation: on.correlation,
        statements: on.statements,
      });
    } else {
      const cr = wf.creates.find(
        (c: CreateIR) => c.eventRef === s.event && c.eventBinding === s.param,
      );
      if (!cr) continue;
      subs.push({
        trigger: "create",
        event: s.event,
        param: s.param,
        workflow: wf,
        correlation: cr.correlation,
        statements: cr.statements,
      });
    }
  }
  return subs;
}

/** True when this context emits a `Dispatcher` module — i.e. it has at least
 *  one resolvable workflow event subscription.  Callers (e.g. the event-sourced
 *  repository, which fans appended events into the dispatcher) must guard the
 *  `<Ctx>.Dispatcher.dispatch/1` reference on this, since the module is only
 *  emitted when subscriptions exist (`emitDispatch` short-circuits otherwise). */
export function contextHasDispatcher(ctx: EnrichedBoundedContextIR): boolean {
  if ((ctx.eventSubscriptions ?? []).length === 0) return false;
  return resolveSubscriptions(ctx).length > 0;
}

/** The saga-state module name (`<App>.<Ctx>.Workflows.<Wf>State`). */
export function stateModule(contextModule: string, wf: WorkflowIR): string {
  return `${contextModule}.Workflows.${upperFirst(wf.name)}State`;
}

/** Emit the saga-state Ecto schema (`<wf>_state.ex`) for EVERY
 *  correlation-bearing workflow in the context — not just the ones a
 *  subscription references (workflow-instance-visibility.md needs the schema
 *  to read instances even for a command-only saga).  Idempotent with
 *  `emitDispatch`'s own schema emission: same path, byte-identical content. */
export function emitWorkflowStateSchemas(
  appName: string,
  ctx: EnrichedBoundedContextIR,
  appModule: string,
  out: Map<string, string>,
  /** The context's schema for the saga-state `@schema_prefix`; undefined ⇒
   *  unqualified. */
  schema?: string,
): void {
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  for (const wf of ctx.workflows) {
    if (!wf.correlationField || wf.eventSourced) continue;
    out.set(
      `lib/${appName}/${ctxSnake}/workflows/${snake(wf.name)}_state.ex`,
      renderStateSchema(contextModule, wf, schema),
    );
  }
}

/** The handler module name for a subscription
 *  (`<App>.<Ctx>.Workflows.<Wf>.Start<Event>` / `.On<Event>`). */
function handlerModule(contextModule: string, sub: Subscription): string {
  const verb = sub.trigger === "on" ? "On" : "Start";
  return `${contextModule}.Workflows.${upperFirst(sub.workflow.name)}.${verb}${upperFirst(sub.event)}`;
}

export function emitDispatch(
  appName: string,
  ctx: EnrichedBoundedContextIR,
  appModule: string,
  out: Map<string, string>,
  sys?: SystemIR,
  _foundation: "vanilla" = "vanilla",
): void {
  if ((ctx.eventSubscriptions ?? []).length === 0) return;
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const subs = resolveSubscriptions(ctx);
  if (subs.length === 0) return;

  // --- Saga-state Ecto schemas — one per correlation-bearing workflow that
  //     a subscription references (matches the saga table the migrations
  //     builder derives for the same workflow). ----------------------------
  // Event-sourced workflows fold a `<wf>_events` stream — they have no mutable
  // `<wf>_state` row (their `<wf>_state.ex` carries the plain fold struct,
  // emitted by `emitVanillaEsWorkflowFiles`), so skip the saga schema here.
  const correlationWfs = new Map<string, WorkflowIR>();
  for (const sub of subs) {
    if (sub.workflow.correlationField && !sub.workflow.eventSourced)
      correlationWfs.set(sub.workflow.name, sub.workflow);
  }
  const dispatchSchema = sys ? resolveContextSchema(ctx, sys) : undefined;
  for (const wf of correlationWfs.values()) {
    out.set(
      `lib/${appName}/${ctxSnake}/workflows/${snake(wf.name)}_state.ex`,
      renderStateSchema(contextModule, wf, dispatchSchema),
    );
  }

  // --- Handler modules — one per subscription. --------------------------
  for (const sub of subs) {
    const verb = sub.trigger === "on" ? "on" : "start";
    // An event-sourced workflow's handler folds the stream on load and appends
    // its own emitted events (the saga analogue of the ES aggregate).
    const content = sub.workflow.eventSourced
      ? renderEsWorkflowHandler(contextModule, sub)
      : renderHandler(appModule, contextModule, ctx, sub, sys);
    out.set(
      `lib/${appName}/${ctxSnake}/workflows/${snake(sub.workflow.name)}/${verb}_${snake(sub.event)}.ex`,
      content,
    );
  }

  // --- Dispatcher — routes each event struct to its handler(s). ----------
  out.set(`lib/${appName}/${ctxSnake}/dispatcher.ex`, renderDispatcher(contextModule, ctx, subs));
}

// ---------------------------------------------------------------------------
// Saga-state Ecto schema
// ---------------------------------------------------------------------------

/** The Ecto field/primary-key type for an id-valued correlation column —
 *  aligned with the migration's column type (`idColumnType` in the
 *  migrations builder): guid → uuid column → `:binary_id`, string → text
 *  column → `:string`, int/long → `:integer`. */
function ectoIdType(vt: IdValueType): string {
  switch (vt) {
    case "guid":
      return ":binary_id";
    case "string":
      return ":string";
    case "int":
    case "long":
      return ":integer";
  }
}

/** Plain (non-id) state-field Ecto type.  Only the handful of primitive
 *  saga-column shapes the migrations builder emits are mapped; anything
 *  exotic falls back to `:string` (no saga fixture exercises it yet). */
function ectoStateFieldType(t: import("../../ir/types/loom-ir.js").TypeIR): string {
  if (t.kind === "id") return ectoIdType(t.valueType);
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return ":integer";
      case "bool":
        return ":boolean";
      case "decimal":
      case "money":
        return ":decimal";
      case "datetime":
        return ":utc_datetime";
      default:
        return ":string";
    }
  }
  return ":string";
}

function renderStateSchema(contextModule: string, wf: WorkflowIR, schema?: string): string {
  const corr = wf.correlationField as string;
  const corrField = (wf.stateFields ?? []).find((f) => f.name === corr);
  const pkType =
    corrField && corrField.type.kind === "id" ? ectoIdType(corrField.type.valueType) : ":string";
  const table = plural(snake(wf.name));
  const fieldLines = (wf.stateFields ?? [])
    .filter((f) => f.name !== corr)
    .map((f) => `    field :${snake(f.name)}, ${ectoStateFieldType(f.type)}`);
  // `@schema_prefix` targets the workflow's context schema, matching the
  // migration `prefix:`.  Omitted ⇒ public, byte-identical.
  const prefixLine = schema ? `  @schema_prefix ${JSON.stringify(schema)}\n` : "";
  return `# Auto-generated.
defmodule ${stateModule(contextModule, wf)} do
  @moduledoc "Persisted correlation state for the ${upperFirst(wf.name)} workflow."

  use Ecto.Schema

${prefixLine}  @primary_key {:${snake(corr)}, ${pkType}, autogenerate: false}
  schema "${table}" do
${fieldLines.length > 0 ? fieldLines.join("\n") + "\n" : ""}    timestamps()
  end
end
`;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function renderDispatcher(
  contextModule: string,
  ctx: EnrichedBoundedContextIR,
  subs: Subscription[],
): string {
  // Group subscriptions by event type so one `dispatch(%Event{})` clause
  // invokes every handler subscribed to that event.
  const byEvent = new Map<string, Subscription[]>();
  for (const sub of subs) {
    const list = byEvent.get(sub.event) ?? [];
    list.push(sub);
    byEvent.set(sub.event, list);
  }
  const clauses: string[] = [];
  for (const [event, list] of byEvent) {
    const calls = list.map((sub) => `    ${handlerModule(contextModule, sub)}.handle(event)`);
    clauses.push(
      `  def dispatch(%${contextModule}.Events.${upperFirst(event)}{} = event) do\n${calls.join("\n")}\n    :ok\n  end`,
    );
  }
  return `# Auto-generated.
defmodule ${contextModule}.Dispatcher do
  @moduledoc "In-process event dispatch for the ${upperFirst(ctx.name)} context."

${clauses.join("\n\n")}

  # Events with no in-process subscriber are a no-op.
  def dispatch(_event), do: :ok
end
`;
}

// ---------------------------------------------------------------------------
// Handler module
// ---------------------------------------------------------------------------

/** Does any expression in the body reference `this` (a saga-state field)? */
function bodyUsesThis(statements: WorkflowStmtIR[]): boolean {
  let used = false;
  const visitExpr = (e: ExprIR): void => {
    if (used) return;
    if (e.kind === "ref") {
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop" || e.refKind === "this-derived")
        used = true;
      return;
    }
    if (e.kind === "member") visitExpr(e.receiver);
    else if (e.kind === "method-call") {
      visitExpr(e.receiver);
      e.args.forEach(visitExpr);
    } else if (e.kind === "call") e.args.forEach(visitExpr);
    else if (e.kind === "binary") {
      visitExpr(e.left);
      visitExpr(e.right);
    } else if (e.kind === "unary") visitExpr(e.operand);
    else if (e.kind === "paren") visitExpr(e.inner);
    else if (e.kind === "ternary") {
      visitExpr(e.cond);
      visitExpr(e.then);
      visitExpr(e.otherwise);
    } else if (e.kind === "new" || e.kind === "object") {
      for (const f of e.fields) visitExpr(f.value);
    } else if (e.kind === "lambda" && e.body) visitExpr(e.body);
  };
  const visitStmt = (st: WorkflowStmtIR): void => {
    switch (st.kind) {
      case "factory-let":
      case "emit":
        for (const f of st.fields) visitExpr(f.value);
        break;
      case "repo-let":
        st.args.forEach(visitExpr);
        break;
      case "op-call":
        st.args.forEach(visitExpr);
        break;
      case "expr-let":
        visitExpr(st.expr);
        break;
      case "assign":
        // The write target IS `state` (`Repo.update!(... state ...)`), so an
        // own-state assignment always references it — bind `state`, not `_state`.
        used = true;
        visitExpr(st.value);
        break;
      case "precondition":
      case "requires":
        visitExpr(st.expr);
        break;
    }
  };
  statements.forEach(visitStmt);
  return used;
}

function renderHandler(
  appModule: string,
  contextModule: string,
  ctx: EnrichedBoundedContextIR,
  sub: Subscription,
  sys?: SystemIR,
): string {
  const wf = sub.workflow;
  const persisted = !!wf.correlationField;
  const usesThis = persisted && bodyUsesThis(sub.statements);
  const renderCtx: RenderCtx = {
    thisName: "state",
    contextModule,
    typesModule: `${appModule}.Types`,
    resourceModules: buildPhoenixResourceModules(sys, appModule),
    paramRenames: { [sub.param]: "event" },
  };

  // Body statements → ordered Elixir lines (0-indented), woven into a
  // `with`-chain plus the re-entrant dispatches the do-branch runs.
  const body = renderBody(sub.statements, ctx, renderCtx, contextModule);

  // Saga routing wrapper, indented to the `def handle` body (4 spaces).
  const inner = persisted
    ? renderPersistedBody(appModule, contextModule, wf, sub, body, usesThis)
    : indent(body, 4).join("\n");

  // Module names render fully-qualified throughout the body, so the only
  // import a handler needs is `require Logger` for the `on` drop+log path
  // (`Logger.warning/2` is a macro).
  const needLogger = sub.trigger === "on" && persisted;
  const requireLogger = needLogger ? "  require Logger\n\n" : "";

  return `# Auto-generated.
defmodule ${handlerModule(contextModule, sub)} do
  @moduledoc "${sub.trigger === "on" ? "Reactor" : "Starter"} for ${upperFirst(sub.event)} → ${upperFirst(wf.name)}."

${requireLogger}  def handle(%${contextModule}.Events.${upperFirst(sub.event)}{} = event) do
    # A reactor is a per-dispatch boundary: run it in a child execution frame
    # (parent_id <- the dispatching request's scope) so its audit / provenance
    # rows record their call-structure position.
    ${appModule}.RequestContext.with_child_frame(fn ->
${inner}
    end)
  end
end
`;
}

/** Prefix every non-empty physical line of a 0-indented block with `n`
 *  spaces.  Multi-line elements (a `with`-chain whose clauses joined with
 *  `\n`) are split so each physical line is shifted — preserving the
 *  relative continuation alignment. */
function indent(lines: string[], n: number): string[] {
  const pad = " ".repeat(n);
  return lines.flatMap((l) => l.split("\n").map((sub) => (sub.length > 0 ? pad + sub : sub)));
}

/** Wrap a 0-indented rendered body in the correlation routing logic:
 *  load-or-allocate (`create`) or route-or-drop+log (`on`).  All wrapper
 *  lines sit at the `def handle` body's 4-space base; the body itself is
 *  indented to its position (a sibling of the load for `create`, nested in
 *  the matched case clause for `on`). */
function renderPersistedBody(
  appModule: string,
  contextModule: string,
  wf: WorkflowIR,
  sub: Subscription,
  bodyLines: string[],
  usesThis: boolean,
): string {
  const corr = wf.correlationField as string;
  const stateMod = stateModule(contextModule, wf);
  // Routing key: the `by <expr>` value, else the event field name-matching
  // the correlation field (the omitted-`by` rule).
  const keyExpr = sub.correlation
    ? renderExpr(sub.correlation, {
        thisName: "state",
        contextModule,
        paramRenames: { [sub.param]: "event" },
      })
    : `event.${snake(corr)}`;
  const bind = usesThis ? "state" : "_state";

  if (sub.trigger === "create") {
    // Load-or-allocate: a fresh key seeds the instance row (typed defaults).
    const allocFields = [`${snake(corr)}: key`];
    for (const f of wf.stateFields ?? []) {
      if (f.name === corr || f.optional) continue;
      allocFields.push(`${snake(f.name)}: ${stateDefault(f.type)}`);
    }
    return [
      `    key = ${keyExpr}`,
      `    ${bind} =`,
      `      case ${appModule}.Repo.get(${stateMod}, key) do`,
      `        nil -> ${appModule}.Repo.insert!(%${stateMod}{${allocFields.join(", ")}})`,
      `        existing -> existing`,
      `      end`,
      "",
      ...indent(bodyLines, 4),
    ].join("\n");
  }
  // Reactor: route to the started instance, else drop + log `event_unrouted`.
  const logCall = renderPhoenixLogCall("eventUnrouted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
    { name: "event_type", valueExpr: JSON.stringify(sub.event) },
    { name: "key", valueExpr: "key" },
  ]);
  return [
    `    key = ${keyExpr}`,
    `    case ${appModule}.Repo.get(${stateMod}, key) do`,
    `      nil ->`,
    `        ${logCall}`,
    `        :ok`,
    `      ${bind} ->`,
    ...indent(bodyLines, 8),
    `    end`,
  ].join("\n");
}

/** A backend-zero Elixir literal for a required saga column at allocation
 *  (the correlation field is seeded from the routing key, never this). */
function stateDefault(t: import("../../ir/types/loom-ir.js").TypeIR): string {
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "0";
      case "decimal":
      case "money":
        return "Decimal.new(0)";
      case "bool":
        return "false";
      case "datetime":
        return "DateTime.utc_now()";
      default:
        return '""';
    }
  }
  if (t.kind === "array") return "[]";
  return "nil";
}

// ---------------------------------------------------------------------------
// Body rendering — the reactor / starter statement list.
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: "with-clause" | "dispatch" | "expr" | "guard";
  text: string;
  bindName?: string;
  /** An own-state assign that rebinds `state = Repo.update!(...)`.  The binding
   *  is only needed when a later line reads `state`; otherwise it's dropped so
   *  `mix compile --warnings-as-errors` doesn't trip on an unused variable. */
  rebindsState?: boolean;
}

/** Render the constrained reactor / starter statement set into ordered,
 *  0-indented Elixir lines (the caller indents the block to its position).
 *  `factory-let` / `repo-let` / `op-call` become `with` clauses in source
 *  order; `emit` becomes a re-entrant `Dispatcher.dispatch(...)` call run in
 *  the success do-branch; guards short-circuit. */
function renderBody(
  statements: WorkflowStmtIR[],
  ctx: EnrichedBoundedContextIR,
  renderCtx: RenderCtx,
  contextModule: string,
): string[] {
  const lines: BodyLine[] = [];
  for (const st of statements) lines.push(...renderStmt(st, ctx, renderCtx, contextModule));

  const guards = lines.filter((l) => l.kind === "guard");
  // `with` clauses + `=` matches compose the chain, in source order.
  const chain = lines.filter((l) => l.kind === "with-clause" || l.kind === "expr");
  const dispatches = lines.filter((l) => l.kind === "dispatch");

  // An own-state assign rebinds `state = Repo.update!(...)`.  A later line reads
  // the rebound value only if it references `state` (a chained assign or an emit
  // whose fields read state); when nothing does, drop the binding to the bare
  // side-effecting call so Elixir doesn't warn the variable is unused.
  for (let i = 0; i < dispatches.length; i++) {
    const d = dispatches[i]!;
    if (!d.rebindsState) continue;
    const laterReadsState = dispatches.slice(i + 1).some((l) => /\bstate\b/.test(l.text));
    if (!laterReadsState) d.text = d.text.replace(/^state = /, "");
  }

  const out: string[] = [];
  for (const g of guards) out.push(g.text);

  if (chain.length === 0) {
    // No chained calls — run the dispatches (if any) then return :ok.
    for (const d of dispatches) out.push(d.text);
    out.push(":ok");
    return out;
  }
  // `with` must hug its first clause on the same line; continuations align
  // under it (5 cols = "with ").
  const clauses = chain.map((l) => l.text.trim());
  const first = `with ${clauses[0]}`;
  const rest = clauses.slice(1).map((c) => `     ${c}`);
  out.push([first, ...rest].join(",\n") + " do");
  for (const d of dispatches) out.push(`  ${d.text}`);
  out.push("  :ok");
  out.push("end");
  return out;
}

function renderStmt(
  st: WorkflowStmtIR,
  ctx: EnrichedBoundedContextIR,
  renderCtx: RenderCtx,
  contextModule: string,
): BodyLine[] {
  switch (st.kind) {
    case "factory-let": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const call = `${contextModule}.create_${snake(st.aggName)}(%{${fields}})`;
      return [
        {
          kind: "with-clause",
          text: `{:ok, ${snake(st.name)}} <- ${call}`,
          bindName: snake(st.name),
        },
      ];
    }
    case "repo-let": {
      const argList = st.args.map((a) => renderExpr(a, renderCtx)).join(", ");
      const action =
        st.method === "getById"
          ? `get_${snake(st.aggName)}`
          : `${snake(st.method)}_${snake(st.aggName)}`;
      const call = argList
        ? `${contextModule}.${action}(${argList})`
        : `${contextModule}.${action}()`;
      return [
        {
          kind: "with-clause",
          text: `{:ok, ${snake(st.name)}} <- ${call}`,
          bindName: snake(st.name),
        },
      ];
    }
    case "op-call": {
      // The context facade emits ops as arity-2 `<op>_<agg>(record, params)`
      // regardless of param count — mirror `vanilla/workflow-execution-emit.ts`
      // (key shape `arg<i>:` for positional args, `%{}` for none).
      const action = `${snake(st.op)}_${snake(st.aggName)}`;
      const target = snake(st.target);
      const op = lookupOp(ctx, st.aggName, st.op);
      const argTexts = st.args.map((arg) => renderExpr(arg, renderCtx));
      const fields = opCallParamFields(argTexts, op, `${st.aggName}.${st.op}`);
      const call = `${contextModule}.${action}(${target}, %{${fields}})`;
      return [{ kind: "with-clause", text: `{:ok, _} <- ${call}` }];
    }
    case "emit": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const struct = `%${contextModule}.Events.${upperFirst(st.eventName)}{${fields}}`;
      return [{ kind: "dispatch", text: `${contextModule}.Dispatcher.dispatch(${struct})` }];
    }
    case "expr-let": {
      return [
        {
          kind: "expr",
          text: `${snake(st.name)} = ${renderExpr(st.expr, renderCtx)}`,
          bindName: snake(st.name),
        },
      ];
    }
    case "assign": {
      // `field := value` — own-state mutation.  Saga state is a plain Ecto
      // schema, so persist the write directly: rebind `state`
      // to the updated struct via an `Ecto.Changeset.change/2` + `Repo.update!`.
      // Runs in the do-branch (`dispatch` kind) after any `with`-chain succeeds;
      // the row already exists (allocated on `create`, loaded on `on`).  `Repo`
      // is reached off the app module (the segment(s) before the context name
      // in `contextModule = "<App>.<Ctx>"`).
      const appModule = contextModule.split(".").slice(0, -1).join(".");
      const field = snake(st.target.segments[0]!);
      const value = renderExpr(st.value, renderCtx);
      return [
        {
          kind: "dispatch",
          text: `state = ${appModule}.Repo.update!(Ecto.Changeset.change(state, %{${field}: ${value}}))`,
          rebindsState: true,
        },
      ];
    }
    case "precondition": {
      const expr = renderExpr(st.expr, renderCtx);
      return [
        {
          kind: "guard",
          text: `unless ${expr}, do: throw({:error, ${JSON.stringify(`Precondition failed: ${st.source}`)}})`,
        },
      ];
    }
    case "requires": {
      const expr = renderExpr(st.expr, renderCtx);
      return [{ kind: "guard", text: `unless ${expr}, do: throw({:error, :forbidden})` }];
    }
    default:
      // for-each / repo-run / resource-call don't appear in validated
      // reactor / starter bodies today (channels.md defers them); guard
      // against silently emitting nothing.
      throw new Error(`dispatch-emit: unsupported reactor statement kind '${st.kind}'`);
  }
}
