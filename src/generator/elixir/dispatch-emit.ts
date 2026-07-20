import { deriveEventSubscriptions } from "../../ir/enrich/enrichments.js";
import type {
  ChannelIR,
  CreateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  IdValueType,
  OnIR,
  ProjectionIR,
  ProjectionOnIR,
  StmtIR,
  SystemIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import type { OriginRef } from "../../ir/types/origin.js";
import { resolveContextSchema } from "../../ir/util/resolve-datasource.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";
import { lineCount, type SourceMapRecorder } from "../_trace/sourcemap.js";
import { buildPhoenixResourceModules } from "./adapters/resource-clients.js";
import type { ElixirChannelsCfg } from "./channels-emit.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";
import { renderEsWorkflowHandler } from "./vanilla/workflow-eventsourced-emit.js";
import { lookupOp, opCallParamFields } from "./vanilla/workflow-execution-emit.js";

/** M13 — a handler-render result: the module's final content plus one
 *  statement-granular `fragment()` anchor per rendered statement — the
 *  exact text a statement rendered to (VERBATIM, as it appears in the
 *  final content) paired with its origin.  Shared shape between the
 *  regular (`renderHandler`) and event-sourced (`renderEsWorkflowHandler`
 *  in `workflow-eventsourced-emit.ts`) reactor bodies, so `emitDispatch`'s
 *  call site handles both without a per-path branch. */
export interface HandlerResult {
  content: string;
  regions: { text: string; origin: OriginRef | undefined }[];
}

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
// A projection (projection.md) subscribes to the SAME channel events as a
// pure read-model fold (load-or-allocate → set fields → upsert; no route-or-
// drop split, no child frame).  Subscriptions are re-derived WITH projections
// (like python's `dispatchSubscriptionsOf`) because the enricher-stored
// `ctx.eventSubscriptions` omits them — so a projection-only context still gets
// a dispatcher.  Its fold joins the event's dispatch clause alongside any saga
// reactor.
//
// Emitted files (only when the context has ≥1 workflow subscription OR
// projection fold — a channel-/projection-less context emits none of this,
// byte-identical):
//   lib/<app>/<ctx>/dispatcher.ex                        — the router
//   lib/<app>/<ctx>/workflows/<wf>/<start|on>_<event>.ex — one per saga subscription
//   lib/<app>/<ctx>/workflows/<wf>_state.ex              — saga Ecto.Schema
//   lib/<app>/<ctx>/projections/<proj>/on_<event>.ex     — one per projection fold
// ---------------------------------------------------------------------------

interface Subscription {
  trigger: "on" | "create";
  event: string;
  param: string;
  workflow: WorkflowIR;
  correlation?: ExprIR;
  statements: WorkflowStmtIR[];
}

/** A projection fold subscription (projection.md) — a pure read-model upsert,
 *  kept SEPARATE from the saga `Subscription` so the workflow handler renderers
 *  keep their required-`workflow` contract. */
interface ProjectionSub {
  event: string;
  param: string;
  projection: ProjectionIR;
  on: ProjectionOnIR;
}

/** Resolve a context's channel-routed WORKFLOW subscriptions back to the
 *  concrete reactor / event-create node.  Re-derives WITH projections so the
 *  derivation is shared, then keeps only the workflow (non-projection) subs;
 *  projection folds are resolved by `resolveProjectionSubs`. */
function resolveSubscriptions(
  ctx: EnrichedBoundedContextIR,
  extraChannels: ChannelIR[] = [],
): Subscription[] {
  const subs: Subscription[] = [];
  for (const s of deriveEventSubscriptions(
    [...ctx.channels, ...extraChannels],
    ctx.workflows,
    ctx.projections,
  )) {
    if (s.projection) continue;
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

/** Resolve a context's projection fold subscriptions (projection.md) — one per
 *  `(projection, on-handler)`.  A projection has no route-or-drop split: every
 *  event allocates-or-loads and upserts. */
function resolveProjectionSubs(ctx: EnrichedBoundedContextIR): ProjectionSub[] {
  const out: ProjectionSub[] = [];
  for (const proj of ctx.projections) {
    for (const on of proj.handlers) {
      // Only folds whose event is carried by a channel in this context route
      // (matches `deriveEventSubscriptions`); a fold on an uncarried event is
      // unreachable and silently skipped (parity with the saga derivation).
      const carried = ctx.channels.some((ch) => ch.carries.includes(on.event));
      if (carried) out.push({ event: on.event, param: on.param, projection: proj, on });
    }
  }
  return out;
}

/** True when this context emits a `Dispatcher` module — i.e. it has at least
 *  one resolvable workflow event subscription OR projection fold.  Callers (e.g.
 *  the aggregate emit path, which fans emitted events into the dispatcher) must
 *  guard the `<Ctx>.Dispatcher.dispatch/1` reference on this, since the module is
 *  only emitted when a subscriber exists (`emitDispatch` short-circuits otherwise). */
export function contextHasDispatcher(
  ctx: EnrichedBoundedContextIR,
  extraChannels: ChannelIR[] = [],
): boolean {
  return (
    resolveSubscriptions(ctx, extraChannels).length > 0 || resolveProjectionSubs(ctx).length > 0
  );
}

/** The saga-state module name (`<App>.<Ctx>.Workflows.<Wf>State`). */
export function stateModule(contextModule: string, wf: WorkflowIR): string {
  return `${contextModule}.Workflows.${upperFirst(wf.name)}State`;
}

/** The projection read-model row module (`<App>.<Ctx>.Projections.<Proj>Row`) —
 *  the Ecto schema the fold upserts and the read controller queries. */
export function projectionRowModule(contextModule: string, proj: ProjectionIR): string {
  return `${contextModule}.Projections.${upperFirst(proj.name)}Row`;
}

/** The projection fold handler module (`<App>.<Ctx>.Projections.<Proj>.On<Event>`). */
function projectionHandlerModule(
  contextModule: string,
  proj: ProjectionIR,
  on: ProjectionOnIR,
): string {
  return `${contextModule}.Projections.${upperFirst(proj.name)}.On${upperFirst(on.event)}`;
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
  /** Source-map Milestone 13 collector (`--sourcemap`).  Each handler file is
   *  single-workflow-attributable, so it gets a whole-file `wf.origin`
   *  region (like the command-workflow file) PLUS per-statement fragments —
   *  same contract as `emitVanillaWorkflowExecution`. */
  sourcemap?: SourceMapRecorder,
  /** Broker channels (M-T4.4 slice 6c): presence widens the subscription
   *  derivation with the wired-but-foreign channels and re-routes handler
   *  re-emits through the `<App>.Channels` tee. */
  channels?: ElixirChannelsCfg,
  extraChannels: ChannelIR[] = [],
): void {
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const subs = resolveSubscriptions(ctx, extraChannels);
  const projSubs = resolveProjectionSubs(ctx);
  if (subs.length === 0 && projSubs.length === 0) return;

  // --- Saga-state Ecto schemas — one per correlation-bearing workflow that
  //     a subscription references (matches the saga table the migrations
  //     builder derives for the same workflow). ----------------------------
  // Event-sourced workflows fold a `<wf>_events` stream — they have no mutable
  // `<wf>_state` row (their `<wf>_state.ex` carries the plain fold struct,
  // emitted by `emitVanillaEsWorkflowFiles`), so skip the saga schema here.
  // Projection read-model row schemas are emitted by `emitVanillaProjections`
  // (vanilla/index.ts), not here.
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

  // --- Workflow handler modules — one per subscription. -----------------
  for (const sub of subs) {
    const verb = sub.trigger === "on" ? "on" : "start";
    // An event-sourced workflow's handler folds the stream on load and appends
    // its own emitted events (the saga analogue of the ES aggregate).
    const { content, regions }: HandlerResult = sub.workflow.eventSourced
      ? renderEsWorkflowHandler(contextModule, sub)
      : renderHandler(appModule, contextModule, ctx, sub, sys, channels);
    const path = `lib/${appName}/${ctxSnake}/workflows/${snake(sub.workflow.name)}/${verb}_${snake(sub.event)}.ex`;
    out.set(path, content);
    const construct = `${ctx.name}.${sub.workflow.name}`;
    sourcemap?.file(path, content, sub.workflow.origin, construct);
    // M13 — one independent `fragment()` anchor per rendered statement
    // (verified: `renderBody`/`renderStmt`'s guard/chain/dispatch bucketing —
    // and the ES handler's guards/lets/emits bucketing — relocate a
    // statement's own text WITHOUT splitting it, so each anchors on its own
    // exact text regardless of the position the bucketing moved it to).
    for (const r of regions) {
      if (!r.origin) continue;
      sourcemap?.fragment(path, content, r.text, [
        { rel: [1, lineCount(r.text)], origin: r.origin, construct },
      ]);
    }
  }

  // --- Projection fold modules — a pure read-model upsert per (proj, event). --
  for (const ps of projSubs) {
    const content = renderProjectionFoldHandler(appModule, contextModule, ps.projection, ps.on);
    const path = `lib/${appName}/${ctxSnake}/projections/${snake(ps.projection.name)}/on_${snake(ps.event)}.ex`;
    out.set(path, content);
    sourcemap?.file(path, content, ps.projection.origin, `${ctx.name}.${ps.projection.name}`);
  }

  // --- Dispatcher — routes each event struct to its handler(s). ----------
  out.set(
    `lib/${appName}/${ctxSnake}/dispatcher.ex`,
    renderDispatcher(contextModule, ctx, subs, projSubs, channels),
  );
}

// ---------------------------------------------------------------------------
// Saga-state Ecto schema
// ---------------------------------------------------------------------------

/** The Ecto field/primary-key type for an id-valued correlation column —
 *  aligned with the migration's column type (`idColumnType` in the
 *  migrations builder): guid → uuid column → `:binary_id`, string → text
 *  column → `:string`, int/long → `:integer`. */
export function ectoIdType(vt: IdValueType): string {
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
  projSubs: ProjectionSub[] = [],
  channels?: ElixirChannelsCfg,
): string {
  // Group handler-module calls by event type so one `dispatch(%Event{})` clause
  // invokes every subscriber — workflow reactor AND projection fold — of that
  // event (parity with python's isinstance fan-out / Hono's `projectionTee`).
  const byEvent = new Map<string, string[]>();
  const push = (event: string, mod: string): void => {
    const list = byEvent.get(event) ?? [];
    list.push(`    ${mod}.handle(event)`);
    byEvent.set(event, list);
  };
  for (const sub of subs) push(sub.event, handlerModule(contextModule, sub));
  for (const ps of projSubs)
    push(ps.event, projectionHandlerModule(contextModule, ps.projection, ps.on));
  const clauses: string[] = [];
  for (const [event, calls] of byEvent) {
    // A wired-but-foreign channel's event struct lives under its OWNING
    // context's module (M-T4.4 slice 6c) — qualify the match accordingly.
    const evModule = channels?.foreignEventModules.get(event) ?? contextModule;
    clauses.push(
      `  def dispatch(%${evModule}.Events.${upperFirst(event)}{} = event) do\n${calls.join("\n")}\n    :ok\n  end`,
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
  channels?: ElixirChannelsCfg,
): HandlerResult {
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
  const { lines: body, regions } = renderBody(
    sub.statements,
    ctx,
    renderCtx,
    contextModule,
    channels,
  );

  // Saga routing wrapper, indented to the `def handle` body (4 spaces).
  const inner = persisted
    ? renderPersistedBody(appModule, contextModule, wf, sub, body, usesThis)
    : indent(body, 4).join("\n");

  // Module names render fully-qualified throughout the body, so the only
  // import a handler needs is `require Logger` for the `on` drop+log path
  // (`Logger.warning/2` is a macro).
  const needLogger = sub.trigger === "on" && persisted;
  const requireLogger = needLogger ? "  require Logger\n\n" : "";

  const content = `# Auto-generated.
defmodule ${handlerModule(contextModule, sub)} do
  @moduledoc "${sub.trigger === "on" ? "Reactor" : "Starter"} for ${upperFirst(sub.event)} → ${upperFirst(wf.name)}."

${requireLogger}  def handle(%${channels?.foreignEventModules.get(sub.event) ?? contextModule}.Events.${upperFirst(sub.event)}{} = event) do
    # A reactor is a per-dispatch boundary: run it in a child execution frame
    # (parent_id <- the dispatching request's scope) so its audit / provenance
    # rows record their call-structure position.
    ${appModule}.RequestContext.with_child_frame(fn ->
${inner}
    end)
  end
end
`;
  return { content, regions };
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
// Projection fold handler (projection.md)
// ---------------------------------------------------------------------------

/** A pure projection fold: load-or-allocate the read-model row for the event's
 *  key, apply each `:=` as an in-memory struct update, upsert.  Every event
 *  allocates (a projection has no route-or-drop split), and the body is pure —
 *  no emit, no child frame, no `event_unrouted` logging (contrast the saga
 *  reactor).  The fold body is `StmtIR` (the applier statement set), so it only
 *  ever carries `:=` assigns — rendered here directly, matching the ES-applier
 *  `state = %{state | field: value}` shape. */
function renderProjectionFoldHandler(
  appModule: string,
  contextModule: string,
  proj: ProjectionIR,
  on: ProjectionOnIR,
): string {
  const corr = proj.correlationField as string;
  const rowMod = projectionRowModule(contextModule, proj);
  const renderCtx: RenderCtx = {
    thisName: "state",
    contextModule,
    paramRenames: { [on.param]: "event" },
  };
  // Routing key: the `by <expr>` value, else the event field name-matching the
  // correlation field (the omitted-`by` rule) — an id, so `Repo.get` keys on it.
  const keyExpr = on.correlation ? renderExpr(on.correlation, renderCtx) : `event.${snake(corr)}`;
  // Each `field := value` → an in-memory struct update.  The correlation `:=`
  // (if the fold spells it) is skipped: it's the immutable primary key, seeded
  // at allocation (parity with the java / hono / python folds).
  const assignLines = on.statements
    .filter(
      (s): s is Extract<StmtIR, { kind: "assign" }> =>
        s.kind === "assign" && snake(s.target.segments[0] ?? "") !== snake(corr),
    )
    .map(
      (s) =>
        `    state = %{state | ${snake(s.target.segments[0]!)}: ${renderExpr(s.value, renderCtx)}}`,
    );
  const body = [
    `    key = ${keyExpr}`,
    "",
    `    state =`,
    `      case ${appModule}.Repo.get(${rowMod}, key) do`,
    `        nil -> %${rowMod}{${snake(corr)}: key}`,
    `        existing -> existing`,
    `      end`,
    ...(assignLines.length > 0 ? ["", ...assignLines] : []),
    "",
    `    {:ok, _} = ${appModule}.Repo.insert_or_update(Ecto.Changeset.change(state))`,
    `    :ok`,
  ];
  return `# Auto-generated.
defmodule ${projectionHandlerModule(contextModule, proj, on)} do
  @moduledoc "Projection fold for ${upperFirst(on.event)} → ${upperFirst(proj.name)}."

  def handle(%${contextModule}.Events.${upperFirst(on.event)}{} = event) do
${body.join("\n")}
  end
end
`;
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
  /** M13 — the source `WorkflowStmtIR` this line was lowered from, stamped
   *  by `renderBody` (every `renderStmt` arm returns exactly one `BodyLine`,
   *  so it's a straight 1:1 zip against `statements`). */
  origin?: OriginRef;
}

interface RenderBodyResult {
  /** 0-indented Elixir lines (the caller indents the block to its position). */
  lines: string[];
  /** M13 — one independent `fragment()` anchor per rendered statement: each
   *  statement's OWN text (as originally rendered, before the guard/chain/
   *  dispatch bucketing groups it into `lines`), verbatim-preserved through
   *  that bucketing (verified: bucketing only prepends/joins text around a
   *  statement's own substring — it never splits or rewrites the interior of
   *  a statement's rendered text, so an independent per-statement anchor
   *  works regardless of where the bucketing relocated it). */
  regions: { text: string; origin: OriginRef | undefined }[];
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
  channels?: ElixirChannelsCfg,
): RenderBodyResult {
  const lines: BodyLine[] = [];
  for (const st of statements) {
    for (const l of renderStmt(st, ctx, renderCtx, contextModule, channels)) {
      lines.push({ ...l, origin: st.origin });
    }
  }

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

  // M13 — capture the per-statement anchors AFTER the assign-prefix-drop
  // mutation above (it mutates the SAME `BodyLine` objects `lines` holds), so
  // a rebind-dropped assign anchors on the text that actually lands in the
  // final content, not the pre-mutation text.
  const regions = lines.map((l) => ({ text: l.text, origin: l.origin }));

  const out: string[] = [];
  for (const g of guards) out.push(g.text);

  if (chain.length === 0) {
    // No chained calls — run the dispatches (if any) then return :ok.
    for (const d of dispatches) out.push(d.text);
    out.push(":ok");
    return { lines: out, regions };
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
  return { lines: out, regions };
}

function renderStmt(
  st: WorkflowStmtIR,
  ctx: EnrichedBoundedContextIR,
  renderCtx: RenderCtx,
  contextModule: string,
  channels?: ElixirChannelsCfg,
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
      // Broker tee (M-T4.4 slice 6c): a reactor re-emit goes through
      // `<App>.Channels.dispatch` so choreography chains re-publish broker-
      // routed events instead of short-circuiting locally (.NET/Java parity).
      const dispatchText = channels
        ? `${channels.appModule}.Channels.dispatch(${struct}, ${contextModule}.Dispatcher)`
        : `${contextModule}.Dispatcher.dispatch(${struct})`;
      return [{ kind: "dispatch", text: dispatchText }];
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
