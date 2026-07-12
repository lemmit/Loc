// ---------------------------------------------------------------------------
// Vanilla event-sourced emit — `persistedAs(eventLog)` aggregates on the
// plain Phoenix + Ecto foundation (D-VANILLA-ES-HOME).  Slice P4.1/P4.2 of
// docs/plans/elixir-eventsourcing-vanilla-plan.md.
//
// This mirrors the cross-backend ES contract the Python/node/dotnet/java
// backends emit:
//
//   * the aggregate `<Agg>` is a plain in-memory struct (no state table —
//     its truth is the append-only event stream), so it serialises to exactly
//     the wire shape (id + properties + …), no Ecto timestamps;
//   * `<Agg>EventLog` is an Ecto schema over the shared `<agg>_events` table
//     (stream_id, version, type, data JSONB, occurred_at) that
//     `migrations-builder.ts` already emits;
//   * `<Agg>Fold` folds the stream — `apply_event/2` (one clause per declared
//     `apply(...)` applier) + `from_events/2` (fold-from-zero);
//   * `<Agg>Repository` loads+folds on read (`find_by_id` / `list`) and
//     appends gap-free versions on `append/2`; custom `find`s filter the
//     folded aggregates in memory (no queryable state columns);
//   * the command bodies (`create` / `operation`) are emit-only — they
//     produce events, the repository appends them, and the fold derives the
//     resulting state (the appliers own every state transition).
//
// The state-path emitters (schema / changeset / state repository) skip ES
// aggregates; the context module + controller branch per-aggregate (see
// `context-emit.ts` / `api-emit.ts`).
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedBoundedContextIR,
  EventIR,
  FindIR,
  OperationIR,
  StmtIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { escapeElixirIdent, snake, upperFirst } from "../../../util/naming.js";
import { contextHasDispatcher } from "../dispatch-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { aggregateHasUnionFind, renderFindActions } from "./find-controller.js";
import { renderProblemVariantHelper } from "./operation-returns-emit.js";
import { hasRefColls } from "./ref-collection-emit.js";
import { renderWireSerialize } from "./wire-serialize.js";

/** Truth-kind predicate — an aggregate whose persistence is its event log. */
export function isEventSourced(agg: AggregateIR): boolean {
  return agg.persistedAs === "eventLog";
}

/** Does any event-sourced aggregate in this context declare a command body
 *  (create / operation) with a `precondition` / `requires` guard?  Drives
 *  whether the context module emits the private `ensure/2` helper (emitting it
 *  unused would fail `mix compile --warnings-as-errors`). */
export function esContextNeedsEnsure(ctx: BoundedContextIR): boolean {
  return ctx.aggregates
    .filter(isEventSourced)
    .flatMap((agg) => [...(agg.creates ?? []), ...agg.operations])
    .some((op) => op.statements.some((s) => s.kind === "precondition" || s.kind === "requires"));
}

/** The private guard helper shared by the ES command runners in a context
 *  module.  `precondition`/`requires` lower to `:ok <- ensure(<cond>, <atom>)`
 *  with-clauses; a failed guard short-circuits the `with` to `{:error,atom}`. */
export function renderEnsureHelper(): string {
  return `  defp ensure(true, _reason), do: :ok
  defp ensure(false, reason), do: {:error, reason}`;
}

// ---------------------------------------------------------------------------
// File emit — struct + event-log schema + fold + repository, per ES aggregate.
// ---------------------------------------------------------------------------

export function emitVanillaEventSourcedFiles(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  /** The context's Postgres schema for the shared `<ctx>_events` log's
   *  `@schema_prefix` (matches the migration `prefix:`); undefined ⇒ public. */
  ctxSchema?: string,
): void {
  const ctxModule = upperFirst(ctx.name);
  const appSnake = toAppSnake(appModule);
  const ctxSnake = snake(ctx.name);
  const eventsByName = new Map(ctx.events.map((e) => [e.name, e]));
  // The context's `Dispatcher` is only emitted when it has resolvable workflow
  // subscriptions; gate the append-time fan-out on its existence.
  const hasDispatcher = contextHasDispatcher(ctx as EnrichedBoundedContextIR);
  for (const agg of ctx.aggregates) {
    if (!isEventSourced(agg)) continue;
    const aggSnake = snake(agg.name);
    const base = `lib/${appSnake}/${ctxSnake}`;
    out.set(`${base}/${aggSnake}.ex`, renderStructModule(appModule, ctxModule, agg));
    out.set(
      `${base}/${aggSnake}_event_log.ex`,
      renderEventLogSchema(appModule, ctxModule, agg, ctxSnake, ctxSchema),
    );
    out.set(`${base}/${aggSnake}_fold.ex`, renderFoldModule(appModule, ctxModule, agg));
    out.set(
      `${base}/${aggSnake}_repository.ex`,
      renderEsRepository(
        appModule,
        ctxModule,
        agg,
        eventsByName,
        customFindsOfAgg(ctx, agg),
        hasDispatcher,
      ),
    );
  }
}

/** Custom `find`s declared on this aggregate's repository, minus the
 *  enrichment-synthesized `all` (the `list/0` CRUD seam covers it). */
export function customFindsOfAgg(ctx: BoundedContextIR, agg: AggregateIR): FindIR[] {
  const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
  return (repo?.finds ?? []).filter((f) => f.name !== "all");
}

function toAppSnake(appModule: string): string {
  return appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
}

/** Field names carried on the in-memory aggregate struct — the canonical
 *  wire shape (id, then declared properties / containments / derived). */
function structFields(agg: AggregateIR): string[] {
  return (agg.wireShape ?? []).map((f) => snake(f.name));
}

// --- `<Agg>` plain struct ---------------------------------------------------

function renderStructModule(appModule: string, ctxModule: string, agg: AggregateIR): string {
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const fields = structFields(agg);
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Event-sourced aggregate — in-memory state folded from its event stream (no state table)."
  defstruct [${fields.map((f) => `:${f}`).join(", ")}]
  @type t :: %__MODULE__{}
end
`;
}

// --- `<Agg>EventLog` Ecto schema over the shared `<ctx>_events` log ----------
//
// The per-context event log (event-log-architecture.md) collapses every ES
// stream in a context into ONE table; this aggregate's stream is the subset
// tagged `stream_type = "<Agg>"`.  The composite PK is `(stream_type,
// stream_id, version)`; `seq` is the DB-assigned bigserial cursor (never
// selected/inserted here — the fold reads by version, appends omit it).

function renderEventLogSchema(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  ctxSnake: string,
  ctxSchema?: string,
): string {
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(agg.name)}EventLog`;
  const table = `${ctxSnake}_events`;
  // `@schema_prefix` targets the migration's `prefix:` schema; without it Ecto
  // queries `public.<ctx>_events` while the table was created under `<ctx>`.
  const prefixLine = ctxSchema ? `  @schema_prefix ${JSON.stringify(ctxSchema)}\n` : "";
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc false
  use Ecto.Schema

${prefixLine}  @primary_key false
  schema "${table}" do
    field :stream_type, :string, primary_key: true
    field :stream_id, :string, primary_key: true
    field :version, :integer, primary_key: true
    field :type, :string
    field :data, :map
    field :occurred_at, :utc_datetime_usec
    field :seq, :integer
  end
end
`;
}

// --- `<Agg>Fold` — apply_event/2 + from_events/2 ----------------------------

function renderFoldModule(appModule: string, ctxModule: string, agg: AggregateIR): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const eventsModule = `${appModule}.${ctxModule}.Events`;
  const renderCtx: RenderCtx = {
    thisName: "state",
    contextModule: `${appModule}.${ctxModule}`,
    foundation: "vanilla",
  };

  const clauses = (agg.appliers ?? []).map((ap) => {
    const usesParam = appliersStmtsUseParam(ap.statements, ap.param, renderCtx);
    const bind = usesParam ? snake(ap.param) : `_${snake(ap.param)}`;
    const body = renderFoldStatements(ap.statements, renderCtx);
    return `  def apply_event(state, %${eventsModule}.${upperFirst(ap.event)}{} = ${bind}) do
${body}
    state
  end`;
  });
  // Total fallback so an unrecognised stored event is a clear runtime error
  // rather than a FunctionClauseError with no context.
  clauses.push(`  def apply_event(_state, ev) do
    raise ArgumentError, "no applier for event #{inspect(ev.__struct__)}"
  end`);

  return `# Auto-generated.
defmodule ${aggModule}Fold do
  @moduledoc false

  @spec from_events(binary(), [struct()]) :: ${aggModule}.t()
  def from_events(id, events) do
    Enum.reduce(events, %${aggModule}{id: id}, fn ev, acc -> apply_event(acc, ev) end)
  end

${clauses.join("\n\n")}
end
`;
}

/** Render an applier's fold body — assignments rebind `state` via struct
 *  update; `let`/`expression` lower as usual.  ES discipline guarantees the
 *  body is pure (assignments / lets only — no emit, no side-effecting calls). */
function renderFoldStatements(stmts: StmtIR[], ctx: RenderCtx): string {
  return stmts
    .map((s) => {
      switch (s.kind) {
        case "assign":
          return `    state = %{state | ${snake(s.target.segments[0] ?? "")}: ${renderExpr(s.value, ctx)}}`;
        case "let":
          return `    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, ctx)}`;
        case "expression":
          return `    _ = ${renderExpr(s.expr, ctx)}`;
        default:
          // ES discipline rejects everything else inside an applier; keep the
          // renderer total with a comment rather than emitting broken Elixir.
          return `    # unsupported applier statement: ${s.kind}`;
      }
    })
    .join("\n");
}

/** True when any applier statement's value expression references the bound
 *  event param — decides whether the `apply_event` head binds it or `_param`s
 *  it (an unused bind fails `--warnings-as-errors`). */
function appliersStmtsUseParam(stmts: StmtIR[], param: string, ctx: RenderCtx): boolean {
  const token = new RegExp(`\\b${snake(param)}\\b`);
  const rhs: string[] = [];
  for (const s of stmts) {
    if (s.kind === "assign") rhs.push(renderExpr(s.value, ctx));
    else if (s.kind === "let") rhs.push(renderExpr(s.expr, ctx));
    else if (s.kind === "expression") rhs.push(renderExpr(s.expr, ctx));
  }
  return rhs.some((r) => token.test(r));
}

// --- `<Agg>Repository` — load+fold reads, append writes ---------------------

function renderEsRepository(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  eventsByName: Map<string, EventIR>,
  finds: FindIR[],
  hasDispatcher: boolean,
): string {
  const aggPascal = upperFirst(agg.name);
  const aggModule = `${appModule}.${ctxModule}.${aggPascal}`;
  const eventsModule = `${appModule}.${ctxModule}.Events`;
  const contextModule = `${appModule}.${ctxModule}`;
  const logMod = `${aggModule}EventLog`;
  const foldMod = `${aggModule}Fold`;
  const repoMod = `${aggModule}Repository`;
  // Fan each appended event into the context Dispatcher so workflow saga /
  // channel handlers fire (the event-sourced analogue of the state path's
  // emit→PubSub).  Runs inside the append transaction, like the workflow
  // `emit` broadcast.  Only when the context emits a Dispatcher at all.
  const dispatchLine = hasDispatcher ? `\n\n        ${contextModule}.Dispatcher.dispatch(ev)` : "";

  // Event types that may appear in this aggregate's stream — its appliers'
  // event set (ES discipline: every emitted event has a matching applier).
  const eventNames = [...new Set((agg.appliers ?? []).map((a) => a.event))];
  const events = eventNames.map((n) => eventsByName.get(n)).filter((e): e is EventIR => !!e);

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

  const findFns = finds.map((f) => renderEsFind(f, aggModule));
  const findBlock = findFns.length > 0 ? `\n\n${findFns.join("\n\n")}` : "";
  // Short aliases used throughout the body — declaring an alias and then
  // referencing the fully-qualified name is an *unused alias*, which fails
  // `mix compile --warnings-as-errors`.
  const logShort = `${aggPascal}EventLog`;
  const foldShort = `${aggPascal}Fold`;
  // Every stream in the shared `<ctx>_events` log is tagged by owner; this
  // aggregate reads/appends only rows whose `stream_type` is its own name —
  // the correctness trap of a per-context log is that a sibling aggregate's
  // events must never fold into this stream.
  const streamType = JSON.stringify(agg.name);

  return `# Auto-generated.
defmodule ${repoMod} do
  @moduledoc false
  import Ecto.Query
  alias ${appModule}.Repo
  alias ${aggModule}
  alias ${logMod}
  alias ${foldMod}

  @spec list() :: {:ok, [${aggPascal}.t()]} | {:error, term()}
  def list do
    aggregates =
      Repo.all(
        from(r in ${logShort},
          where: r.stream_type == ^${streamType},
          order_by: [asc: r.stream_id, asc: r.version]
        )
      )
      |> Enum.group_by(& &1.stream_id)
      |> Enum.map(fn {sid, rows} ->
        ${foldShort}.from_events(sid, Enum.map(rows, &row_to_event/1))
      end)

    {:ok, aggregates}
  end

  @spec find_by_id(binary()) :: {:ok, ${aggPascal}.t()} | {:error, :not_found}
  def find_by_id(id) when is_binary(id) do
    rows =
      Repo.all(
        from(r in ${logShort},
          where: r.stream_type == ^${streamType} and r.stream_id == ^id,
          order_by: [asc: r.version]
        )
      )

    case rows do
      [] -> {:error, :not_found}
      _ -> {:ok, ${foldShort}.from_events(id, Enum.map(rows, &row_to_event/1))}
    end
  end

  @doc "Append gap-free event versions to the aggregate's stream."
  @spec append(binary(), [struct()]) :: :ok | {:error, term()}
  def append(_id, []), do: :ok

  def append(id, events) when is_binary(id) and is_list(events) do
    Repo.transaction(fn ->
      prior =
        Repo.one(
          from(r in ${logShort},
            where: r.stream_type == ^${streamType} and r.stream_id == ^id,
            select: max(r.version)
          )
        ) || 0

      events
      |> Enum.with_index(prior + 1)
      |> Enum.each(fn {ev, version} ->
        Repo.insert_all(${logShort}, [
          %{
            stream_type: ${streamType},
            stream_id: id,
            version: version,
            type: event_type(ev),
            data: event_to_data(ev),
            occurred_at: DateTime.utc_now()
          }
        ])${dispatchLine}
      end)
    end)
    |> case do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  rescue
    e in Postgrex.Error ->
      # The (stream_id, version) PK rejected a duplicate append: a competing write
      # won the version race (unique_violation, SQLSTATE 23505).  That IS the event
      # stream's optimistic-concurrency control — surface it as {:error, :conflict}
      # → HTTP 409 (parity with the \`versioned\` guarded write's stale-write).
      case e do
        %Postgrex.Error{postgres: %{code: :unique_violation}} -> {:error, :conflict}
        _ -> reraise(e, __STACKTRACE__)
      end
  end${findBlock}

${typeClauses}

${toDataClauses}

${fromRowClauses}
end
`;
}

/** One in-memory custom find — load all + filter the folded aggregates.
 *  ES streams have no queryable state columns, so finds run client-side. */
function renderEsFind(f: FindIR, aggModule: string): string {
  const fnName = snake(f.name);
  const argNames = f.params.map((p) => snake(p.name));
  const single = isSingleReturn(f.returnType);
  const ctx: RenderCtx = { thisName: "a", contextModule: aggModule, foundation: "vanilla" };
  const pred = f.filter
    ? renderExpr(f.filter, ctx)
    : argNames.map((n) => `a.${n} == ${n}`).join(" and ");
  const reduce = single
    ? `{:ok, Enum.find(all, fn a -> ${pred} end)}`
    : `{:ok, Enum.filter(all, fn a -> ${pred} end)}`;
  return `  def ${fnName}(${argNames.join(", ")}) do
    {:ok, all} = list()
    ${reduce}
  end`;
}

function isSingleReturn(t: TypeIR): boolean {
  if (t.kind === "optional" && t.inner.kind === "entity") return true;
  if (t.kind === "entity") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Context-module block + controller for an ES aggregate.
// ---------------------------------------------------------------------------

const CRUD_OP_NAMES = new Set(["create", "update", "delete", "destroy", "list", "get"]);

/** The context-module block for one ES aggregate: create / get / list +
 *  one command runner per public non-CRUD operation + in-memory find
 *  delegates.  Mirrors the read function names the controllers/state path
 *  use (`create_<agg>` / `get_<agg>` / `list_<agg>s` / `<op>_<agg>`). */
export function renderEsContextBlock(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  finds: FindIR[],
): string {
  const aggPascal = upperFirst(agg.name);
  const aggSnake = snake(agg.name);
  const facadeMod = `${appModule}.${ctxModule}`;
  const aggModule = `${facadeMod}.${aggPascal}`;
  const repoMod = `${aggModule}Repository`;
  const foldMod = `${aggModule}Fold`;
  const eventsModule = `${facadeMod}.Events`;

  const create = agg.creates?.[0];
  const createFn = create
    ? renderCommandRunner({
        kind: "create",
        op: create,
        aggSnake,
        aggModule,
        repoMod,
        foldMod,
        eventsModule,
      })
    : `  def create_${aggSnake}(_attrs), do: {:error, :not_constructible}`;

  const opFns = agg.operations
    .filter((op) => op.visibility === "public" && !CRUD_OP_NAMES.has(op.name))
    .map((op) =>
      renderCommandRunner({
        kind: "operation",
        op,
        aggSnake,
        aggModule,
        repoMod,
        foldMod,
        eventsModule,
      }),
    );

  const findLines = finds
    .filter((f) => f.name !== "all")
    .map((f) => {
      const findSnake = snake(f.name);
      const args = f.params.map((p) => snake(p.name)).join(", ");
      return `  defdelegate ${findSnake}_${aggSnake}(${args}), to: ${repoMod}, as: :${findSnake}`;
    });

  return `  # ${aggPascal} (event-sourced)
${createFn}
  defdelegate get_${aggSnake}(id), to: ${repoMod}, as: :find_by_id
  defdelegate list_${aggSnake}s(), to: ${repoMod}, as: :list
${findLines.length > 0 ? `${findLines.join("\n")}\n` : ""}${opFns.length > 0 ? `\n${opFns.join("\n\n")}\n` : ""}`;
}

// ---------------------------------------------------------------------------
// Controller for an ES aggregate — index/show/create + per-op member actions.
// Diverges from the state controller in two ways: no generic update/delete
// (operations are the only mutations), and command errors are atoms
// (`:precondition_failed` → 422, `:forbidden` → 403) rather than changesets.
// ---------------------------------------------------------------------------

export function renderEsController(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const aggPascal = upperFirst(agg.name);
  const aggSnake = snake(agg.name);
  const facadeMod = `${appModule}.${ctxModule}`;
  // `GET /<plural>/<find>` actions — event-sourced finds run load-all + filter.
  const findActions = renderFindActions(ctxModule, agg, ctx);

  const create =
    (agg.creates ?? []).length > 0
      ? `
  def create(conn, params) do
    create_result(conn, ${ctxModule}.create_${aggSnake}(params))
  end

  def create_result(conn, {:ok, record}) do
    conn
    |> put_status(201)
    |> json(serialize(record))
  end

  def create_result(conn, {:error, reason}), do: command_error(conn, reason)
`
      : "";

  const publicOps = agg.operations.filter(
    (op) => op.visibility === "public" && !CRUD_OP_NAMES.has(op.name),
  );
  const opActions = publicOps
    .map((op) => {
      const opSnake = snake(op.name);
      // The command result flows through a public `<op>_<agg>_result/2` rather
      // than a second `with`-clause + `else` arm: a guard-free op body infers
      // `{:ok, _}`-only, which would make the `{:error, reason}` else arm
      // "never match" under Elixir 1.18's --warnings-as-errors.  A public fn
      // keeps both arms at their full clause domain.
      const opResultFn = `${opSnake}_${aggSnake}_result`;
      return `
  def ${opSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id) do
      ${opResultFn}(conn, ${ctxModule}.${opSnake}_${aggSnake}(record, attrs))
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end

  def ${opResultFn}(conn, {:ok, _updated}), do: send_resp(conn, 204, "")

  def ${opResultFn}(conn, {:error, reason}), do: command_error(conn, reason)`;
    })
    .join("\n");

  // `command_error/2` is only referenced from the create / operation error
  // branches — emit it only when one of those exists, else it's an unused
  // private function (fails `--warnings-as-errors`).
  const hasCommands = (agg.creates ?? []).length > 0 || publicOps.length > 0;
  const commandError = hasCommands
    ? `
  defp command_error(conn, :forbidden) do
    ProblemDetails.problem_response(conn, 403, "Forbidden", "Operation not permitted")
  end

  # A concurrent append lost the (stream_id, version) race — the append-only PK
  # rejected the duplicate (unique_violation, 23505), which the repository
  # rescued to {:error, :conflict}.  Map to the distinct 409 conflict responder
  # (parity with the \`versioned\` capability's stale-write → 409).
  defp command_error(conn, :conflict) do
    ProblemDetails.conflict_response(conn)
  end

  defp command_error(conn, _reason) do
    ProblemDetails.problem_response(conn, 422, "Unprocessable Entity", "A precondition failed")
  end
`
    : "";

  // Union finds translate their absent variant via the shared problem_variant/5
  // responder — emit it (once) when the aggregate has any union find.
  const problemVariant = aggregateHasUnionFind(ctx, agg)
    ? `\n${renderProblemVariantHelper()}\n`
    : "";

  // §14: serialize the folded struct from the enriched `wireShape` (camelCase
  // keys, matching the relational REST path + every other backend) instead of a
  // raw `Map.from_struct` dump (snake_case).  The ES struct's fields are exactly
  // `snake(wireShape.name)` (`structFields`), so `renderWireSerialize`'s
  // `record.<snake>` reads line up.  A ref-collection field would need a
  // `__ref_ids/1` helper whose Ecto-assoc semantics don't hold for the in-memory
  // fold, so those (rare) aggregates keep the raw dump.
  const wire = hasRefColls(agg)
    ? null
    : renderWireSerialize(agg, ctx, { contextModule: facadeMod });
  const serializeBlock = wire
    ? `${wire.serialize}${wire.helpers.length > 0 ? `\n\n${wire.helpers.join("\n\n")}` : ""}`
    : `  defp serialize(record) do
    record
    |> Map.from_struct()
    |> Map.drop([:__meta__, :__struct__])
  end`;

  return `# Auto-generated.
defmodule ${appModule}Web.${aggPascal}Controller do
  use ${appModule}Web, :controller
  alias ${facadeMod}
  alias ${appModule}Web.ProblemDetails

  def index(conn, _params) do
    with {:ok, records} <- ${ctxModule}.list_${aggSnake}s() do
      json(conn, Enum.map(records, &serialize/1))
    end
  end

  def show(conn, %{"id" => id}) do
    case ${ctxModule}.get_${aggSnake}(id) do
      {:ok, record} ->
        json(conn, serialize(record))

      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end
${findActions}
${create}${opActions}
${commandError}${problemVariant}
${serializeBlock}
end
`;
}

interface CommandCtx {
  kind: "create" | "operation";
  op: OperationIR;
  aggSnake: string;
  aggModule: string;
  repoMod: string;
  foldMod: string;
  eventsModule: string;
}

/** A command runner — reads params, evaluates guards, builds the emitted
 *  events, appends them, and returns the folded state.  Create generates the
 *  new id; an operation receives the (already folded) aggregate. */
function renderCommandRunner(c: CommandCtx): string {
  const opSnake = snake(c.op.name);
  const fnName = c.kind === "create" ? `create_${c.aggSnake}` : `${opSnake}_${c.aggSnake}`;

  const idExpr = c.kind === "create" ? "id" : "state.id";
  const exprCtx: RenderCtx = {
    thisName: "state",
    contextModule: c.aggModule.split(".").slice(0, -1).join("."),
    foundation: "vanilla",
    ...(c.kind === "create" ? { idLocal: "id" } : {}),
  };

  // Param reads — the JSON body key is the param name as authored (camelCase
  // by DSL convention, matching the cross-backend wire); the Elixir local is
  // its snake form.
  const paramReads = c.op.params.map(
    (p) => `    ${snake(p.name)} = Map.get(attrs, ${JSON.stringify(p.name)})`,
  );
  if (c.kind === "create") paramReads.push("    id = UUIDv7.generate()");

  // with-clauses: guards + the `events` binding + the append.
  const clauses: string[] = [];
  const lets: string[] = [];
  const eventStructs: string[] = [];
  for (const s of c.op.statements) {
    switch (s.kind) {
      case "precondition":
        clauses.push(`:ok <- ensure(${renderExpr(s.expr, exprCtx)}, :precondition_failed)`);
        break;
      case "requires":
        clauses.push(`:ok <- ensure(${renderExpr(s.expr, exprCtx)}, :forbidden)`);
        break;
      case "let":
        lets.push(`    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, exprCtx)}`);
        break;
      case "emit": {
        const fields = s.fields
          .map((f) => `${snake(f.name)}: ${renderExpr(f.value, exprCtx)}`)
          .join(", ");
        eventStructs.push(`%${c.eventsModule}.${upperFirst(s.eventName)}{${fields}}`);
        break;
      }
      default:
        // ES command discipline rejects assign / add / remove / call here.
        break;
    }
  }

  clauses.push(`events = [${eventStructs.join(", ")}]`);
  clauses.push(`:ok <- ${c.repoMod}.append(${idExpr}, events)`);

  const newState =
    c.kind === "create"
      ? `${c.foldMod}.from_events(id, events)`
      : `Enum.reduce(events, state, fn ev, acc -> ${c.foldMod}.apply_event(acc, ev) end)`;

  // `attrs` is only read when the command has params (via `Map.get(attrs, …)`);
  // a param-less command (e.g. `create open()` / `operation close()`) leaves it
  // unused, which fails `--warnings-as-errors` — bind `_attrs` there.
  const attrsArg = c.op.params.length > 0 ? "attrs" : "_attrs";
  const head =
    c.kind === "create"
      ? `  def ${fnName}(${attrsArg}) do`
      : `  def ${fnName}(%${c.aggModule}{} = state, ${attrsArg}) do`;

  const preamble = [...paramReads, ...lets].join("\n");
  return `${head}
${preamble}${preamble ? "\n" : ""}    with ${clauses.join(",\n         ")} do
      {:ok, ${newState}}
    end
  end`;
}
