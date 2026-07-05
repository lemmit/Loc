// ---------------------------------------------------------------------------
// Vanilla event-sourced WORKFLOWS — `workflow X eventSourced { … apply(…) }`
// on the plain Phoenix + Ecto foundation (workflow-and-applier.md A2-S5b).  The
// saga analogue of a `persistedAs(eventLog)` aggregate (vanilla/eventsourced-emit.ts):
// instead of a mutable `<wf>_state` Ecto row, the workflow persists as an
// append-only `<wf>_events` stream (keyed by the correlation field) and folds it
// through its `apply(...)` blocks on load.  Emit-only handlers (A1 discipline).
//
// Per ES workflow (referenced by a resolved subscription) this emits:
//   * `<Wf>State` — a plain struct (the folded snapshot; NOT an Ecto schema,
//     so it shares the `workflows/<wf>_state.ex` path the state path would use);
//   * `<Wf>EventLog` — an Ecto schema over the shared `<wf>_events` table;
//   * `<Wf>Fold` — `apply_event/2` (one clause per applier) + `from_events/2`
//     (seed correlation key + typed defaults, then reduce);
//   * `<Wf>Stream` — `load/1` (load+map stream) + `append/2` (gap-free insert)
//     + the Jason codec (`event_type` / `event_to_data` / `row_to_event`).
//
// The fold-on-load handler modules (create / on) are rendered here too and
// wired by `emitDispatch` (dispatch-emit.ts); the shared `Dispatcher` router
// fans events to them unchanged (they are named like any other handler).
// ---------------------------------------------------------------------------

import type {
  EnrichedBoundedContextIR,
  EventIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { escapeElixirIdent, snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** Event-sourced workflows in a context. */
export function eventSourcedWorkflowsOf(ctx: EnrichedBoundedContextIR): WorkflowIR[] {
  return ctx.workflows.filter((wf) => wf.eventSourced);
}

const wfModule = (contextModule: string, wf: WorkflowIR): string =>
  `${contextModule}.Workflows.${upperFirst(wf.name)}`;

/** A backend-zero Elixir literal for a required folded-state field at seed time
 *  (the correlation field is seeded from the routing key, never this). */
function stateDefault(t: TypeIR): string {
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

// --- `<Wf>State` plain struct (the folded snapshot) -------------------------

function renderStateStruct(contextModule: string, wf: WorkflowIR): string {
  const fields = (wf.stateFields ?? []).map((f) => `:${snake(f.name)}`);
  return `# Auto-generated.
defmodule ${contextModule}.Workflows.${upperFirst(wf.name)}State do
  @moduledoc "Folded saga state of the ${upperFirst(wf.name)} event-sourced workflow (no state table)."
  defstruct [${fields.join(", ")}]
  @type t :: %__MODULE__{}
end
`;
}

// --- `<Wf>EventLog` Ecto schema over `<wf>_events` --------------------------

function renderEventLogSchema(contextModule: string, wf: WorkflowIR, schema?: string): string {
  // `@schema_prefix` makes every Repo query/insert target the workflow's
  // context schema (`catalog`), matching the migration `prefix:`.  Omitted →
  // public, byte-identical for binding-free systems.
  const prefixLine = schema ? `  @schema_prefix ${JSON.stringify(schema)}\n` : "";
  return `# Auto-generated.
defmodule ${wfModule(contextModule, wf)}EventLog do
  @moduledoc false
  use Ecto.Schema

${prefixLine}  @primary_key false
  schema "${snake(wf.name)}_events" do
    field :stream_id, :string, primary_key: true
    field :version, :integer, primary_key: true
    field :type, :string
    field :data, :map
    field :occurred_at, :utc_datetime_usec
  end
end
`;
}

// --- `<Wf>Fold` — apply_event/2 + from_events/2 -----------------------------

function renderFoldModule(contextModule: string, wf: WorkflowIR): string {
  const stateMod = `${contextModule}.Workflows.${upperFirst(wf.name)}State`;
  const eventsModule = `${contextModule}.Events`;
  const corr = wf.correlationField as string;
  const renderCtx: RenderCtx = { thisName: "state", contextModule, foundation: "vanilla" };

  const seeds = [
    `${snake(corr)}: key`,
    ...(wf.stateFields ?? [])
      .filter((f) => f.name !== corr && !(f.optional || f.type.kind === "optional"))
      .map((f) => `${snake(f.name)}: ${stateDefault(f.type)}`),
  ];

  const clauses = (wf.appliers ?? []).map((ap) => {
    const token = new RegExp(`\\b${snake(ap.param)}\\b`);
    const rhs = ap.statements
      .map((s) =>
        s.kind === "assign"
          ? renderExpr(s.value, renderCtx)
          : s.kind === "let"
            ? renderExpr(s.expr, renderCtx)
            : "",
      )
      .join(" ");
    const bind = token.test(rhs) ? snake(ap.param) : `_${snake(ap.param)}`;
    const body = ap.statements
      .map((s) => {
        if (s.kind === "assign") {
          return `    state = %{state | ${snake(s.target.segments[0] ?? "")}: ${renderExpr(s.value, renderCtx)}}`;
        }
        if (s.kind === "let")
          return `    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, renderCtx)}`;
        if (s.kind === "expression") return `    _ = ${renderExpr(s.expr, renderCtx)}`;
        return `    # unsupported applier statement: ${s.kind}`;
      })
      .join("\n");
    return `  def apply_event(state, %${eventsModule}.${upperFirst(ap.event)}{} = ${bind}) do
${body}
    state
  end`;
  });
  clauses.push(`  def apply_event(_state, ev) do
    raise ArgumentError, "no applier for event #{inspect(ev.__struct__)}"
  end`);

  return `# Auto-generated.
defmodule ${wfModule(contextModule, wf)}Fold do
  @moduledoc false

  @spec from_events(term(), [struct()]) :: ${stateMod}.t()
  def from_events(key, events) do
    Enum.reduce(events, %${stateMod}{${seeds.join(", ")}}, fn ev, acc -> apply_event(acc, ev) end)
  end

${clauses.join("\n\n")}
end
`;
}

// --- `<Wf>Stream` — load + gap-free append + Jason codec --------------------

function renderStreamModule(
  appModule: string,
  contextModule: string,
  wf: WorkflowIR,
  events: EventIR[],
): string {
  const eventsModule = `${contextModule}.Events`;
  const logMod = `${wfModule(contextModule, wf)}EventLog`;
  const logShort = `${upperFirst(wf.name)}EventLog`;

  const typeClauses = events
    .map(
      (e) =>
        `  defp event_type(%${eventsModule}.${upperFirst(e.name)}{}), do: ${JSON.stringify(e.name)}`,
    )
    .join("\n");
  const toDataClauses = events
    .map((e) => {
      const pairs = e.fields
        .map((f) => `${JSON.stringify(snake(f.name))} => e.${snake(f.name)}`)
        .join(", ");
      return `  defp event_to_data(%${eventsModule}.${upperFirst(e.name)}{} = e), do: %{${pairs}}`;
    })
    .join("\n");
  const fromRowClauses = events
    .map((e) => {
      const fields = e.fields
        .map((f) => `${snake(f.name)}: d[${JSON.stringify(snake(f.name))}]`)
        .join(", ");
      return `  defp row_to_event(%{type: ${JSON.stringify(e.name)}, data: d}), do: %${eventsModule}.${upperFirst(e.name)}{${fields}}`;
    })
    .join("\n");

  const foldMod = `${wfModule(contextModule, wf)}Fold`;
  const foldShort = `${upperFirst(wf.name)}Fold`;
  const stateMod = `${contextModule}.Workflows.${upperFirst(wf.name)}State`;
  return `# Auto-generated.
defmodule ${wfModule(contextModule, wf)}Stream do
  @moduledoc "Event stream IO for the ${upperFirst(wf.name)} event-sourced workflow."
  import Ecto.Query
  alias ${appModule}.Repo
  alias ${logMod}
  alias ${foldMod}

  @spec load(binary()) :: [struct()]
  def load(stream_id) when is_binary(stream_id) do
    Repo.all(from(r in ${logShort}, where: r.stream_id == ^stream_id, order_by: [asc: r.version]))
    |> Enum.map(&row_to_event/1)
  end

  @doc "List every running instance: load all streams, group by stream_id, fold each."
  @spec list_instances() :: [${stateMod}.t()]
  def list_instances do
    Repo.all(from(r in ${logShort}, order_by: [asc: r.stream_id, asc: r.version]))
    |> Enum.group_by(& &1.stream_id)
    |> Enum.map(fn {sid, rows} ->
      ${foldShort}.from_events(sid, Enum.map(rows, &row_to_event/1))
    end)
  end

  @doc "One instance by correlation id: load + fold one stream (nil if empty)."
  @spec instance_by_id(binary()) :: ${stateMod}.t() | nil
  def instance_by_id(id) when is_binary(id) do
    case load(id) do
      [] -> nil
      loaded -> ${foldShort}.from_events(id, loaded)
    end
  end

  @doc "Append gap-free event versions to the workflow's stream."
  @spec append(binary(), [struct()]) :: :ok | {:error, term()}
  def append(_stream_id, []), do: :ok

  def append(stream_id, events) when is_binary(stream_id) and is_list(events) do
    Repo.transaction(fn ->
      prior =
        Repo.one(from(r in ${logShort}, where: r.stream_id == ^stream_id, select: max(r.version))) ||
          0

      events
      |> Enum.with_index(prior + 1)
      |> Enum.each(fn {ev, version} ->
        Repo.insert_all(${logShort}, [
          %{
            stream_id: stream_id,
            version: version,
            type: event_type(ev),
            data: event_to_data(ev),
            occurred_at: DateTime.utc_now()
          }
        ])
      end)
    end)
    |> case do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

${typeClauses}

${toDataClauses}

${fromRowClauses}
end
`;
}

/** Emit the per-workflow support modules (struct / event-log / fold / stream)
 *  for every event-sourced workflow in the context.  Called from the vanilla
 *  orchestrator alongside the dispatcher; the `<wf>_state.ex` path carries the
 *  plain fold struct (the state path skips ES workflows). */
export function emitVanillaEsWorkflowFiles(
  appName: string,
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
  /** The workflows' owning-context schema for the ES `<Wf>EventLog`
   *  `@schema_prefix`; undefined ⇒ unqualified. */
  schema?: string,
): void {
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const eventsByName = new Map(ctx.events.map((e) => [e.name, e]));
  for (const wf of eventSourcedWorkflowsOf(ctx)) {
    const base = `lib/${appName}/${ctxSnake}/workflows`;
    const wfSnake = snake(wf.name);
    const eventNames = [...new Set((wf.appliers ?? []).map((a) => a.event))];
    const events = eventNames.map((n) => eventsByName.get(n)).filter((e): e is EventIR => !!e);
    out.set(`${base}/${wfSnake}_state.ex`, renderStateStruct(contextModule, wf));
    out.set(`${base}/${wfSnake}_event_log.ex`, renderEventLogSchema(contextModule, wf, schema));
    out.set(`${base}/${wfSnake}_fold.ex`, renderFoldModule(contextModule, wf));
    out.set(
      `${base}/${wfSnake}_stream.ex`,
      renderStreamModule(appModule, contextModule, wf, events),
    );
  }
}

// --- handler module (create / on), wired by emitDispatch --------------------

interface EsSub {
  trigger: "on" | "create";
  event: string;
  param: string;
  workflow: WorkflowIR;
  correlation?: import("../../../ir/types/loom-ir.js").ExprIR;
  statements: WorkflowStmtIR[];
}

/** Does any emit/guard/let in the body read the folded `state`? */
function bodyUsesState(statements: WorkflowStmtIR[]): boolean {
  let used = false;
  const visit = (e: import("../../../ir/types/loom-ir.js").ExprIR): void => {
    if (used) return;
    if (e.kind === "ref") {
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop" || e.refKind === "this-derived")
        used = true;
      return;
    }
    if (e.kind === "member") visit(e.receiver);
    else if (e.kind === "method-call") {
      visit(e.receiver);
      e.args.forEach(visit);
    } else if (e.kind === "call") e.args.forEach(visit);
    else if (e.kind === "binary") {
      visit(e.left);
      visit(e.right);
    } else if (e.kind === "unary") visit(e.operand);
    else if (e.kind === "paren") visit(e.inner);
    else if (e.kind === "ternary") {
      visit(e.cond);
      visit(e.then);
      visit(e.otherwise);
    } else if (e.kind === "new" || e.kind === "object") {
      for (const f of e.fields) visit(f.value);
    } else if (e.kind === "lambda" && e.body) visit(e.body);
  };
  for (const st of statements) {
    if (st.kind === "emit" || st.kind === "factory-let") for (const f of st.fields) visit(f.value);
    else if (st.kind === "expr-let") visit(st.expr);
    else if (st.kind === "precondition" || st.kind === "requires") visit(st.expr);
  }
  return used;
}

/** Render an ES workflow handler module: fold-on-load, run the emit-only body
 *  against the folded snapshot, append the workflow's own events gap-free, then
 *  re-publish for choreography.  `emit` collects into the appended-then-
 *  dispatched `events` list (unlike the state path's inline re-dispatch). */
export function renderEsWorkflowHandler(contextModule: string, sub: EsSub): string {
  const wf = sub.workflow;
  // contextModule is `<appModule>.<Context>`; strip the context segment for the
  // RequestContext module path.
  const appModule = contextModule.replace(/\.[^.]+$/, "");
  const corr = wf.correlationField as string;
  const verb = sub.trigger === "on" ? "On" : "Start";
  const handlerMod = `${contextModule}.Workflows.${upperFirst(wf.name)}.${verb}${upperFirst(sub.event)}`;
  const foldMod = `${wfModule(contextModule, wf)}Fold`;
  const streamMod = `${wfModule(contextModule, wf)}Stream`;
  const renderCtx: RenderCtx = {
    thisName: "state",
    contextModule,
    foundation: "vanilla",
    paramRenames: { [sub.param]: "event" },
  };

  const keyExpr = sub.correlation ? renderExpr(sub.correlation, renderCtx) : `event.${snake(corr)}`;
  const usesState = bodyUsesState(sub.statements);
  const stateBind = usesState ? "state" : "_state";

  // Body → guard clauses (with `ensure`), let bindings, emitted event structs.
  const guards: string[] = [];
  const lets: string[] = [];
  const emits: string[] = [];
  for (const st of sub.statements) {
    switch (st.kind) {
      case "precondition":
        guards.push(`:ok <- ensure(${renderExpr(st.expr, renderCtx)}, :precondition_failed)`);
        break;
      case "requires":
        guards.push(`:ok <- ensure(${renderExpr(st.expr, renderCtx)}, :forbidden)`);
        break;
      case "expr-let":
        lets.push(`      ${snake(st.name)} = ${renderExpr(st.expr, renderCtx)}`);
        break;
      case "emit": {
        const fields = st.fields
          .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
          .join(", ");
        emits.push(`%${contextModule}.Events.${upperFirst(st.eventName)}{${fields}}`);
        break;
      }
      default:
        // ES workflow handlers are emit-only (A1 discipline); other kinds are
        // gated out upstream.  Keep the renderer total.
        break;
    }
  }

  const withClauses = [
    ...guards,
    `events = [${emits.join(", ")}]`,
    `:ok <- ${streamMod}.append(sid, events)`,
  ];
  const withBlock = [
    `      with ${withClauses.join(",\n           ")} do`,
    `        Enum.each(events, &${contextModule}.Dispatcher.dispatch/1)`,
    `        :ok`,
    `      end`,
  ].join("\n");

  const hasGuards = guards.length > 0;
  const ensureHelper = hasGuards
    ? `\n  defp ensure(true, _reason), do: :ok\n  defp ensure(false, reason), do: {:error, reason}\n`
    : "";

  const letBlock = lets.length > 0 ? `${lets.join("\n")}\n` : "";

  let inner: string;
  if (sub.trigger === "on") {
    // Reactor: a started saga has a non-empty stream; else drop + log.
    const logCall = renderPhoenixLogCall("eventUnrouted", [
      { name: "workflow", valueExpr: JSON.stringify(wf.name) },
      { name: "event_type", valueExpr: JSON.stringify(sub.event) },
      { name: "key", valueExpr: "key" },
    ]);
    inner = `    key = ${keyExpr}
    sid = to_string(key)

    case ${streamMod}.load(sid) do
      [] ->
        ${logCall}
        :ok

      loaded ->
        ${stateBind} = ${foldMod}.from_events(key, loaded)
${letBlock}${withBlock.replace(/^/gm, "  ")}
    end`;
  } else {
    // Starter: fold from zero (empty stream → seeded defaults).
    inner = `    key = ${keyExpr}
    sid = to_string(key)
    ${stateBind} = ${foldMod}.from_events(key, ${streamMod}.load(sid))
${letBlock}${withBlock}`;
  }

  const requireLogger = sub.trigger === "on" ? "  require Logger\n\n" : "";
  return `# Auto-generated.
defmodule ${handlerMod} do
  @moduledoc "${sub.trigger === "on" ? "Reactor" : "Starter"} for ${upperFirst(sub.event)} → ${upperFirst(wf.name)} (event-sourced)."

${requireLogger}  def handle(%${contextModule}.Events.${upperFirst(sub.event)}{} = event) do
    # A reactor is a per-dispatch boundary: child execution frame (parent_id <-
    # the dispatching request's scope).
    ${appModule}.RequestContext.with_child_frame(fn ->
${inner}
    end)
  end
${ensureHelper}end
`;
}
