// ---------------------------------------------------------------------------
// timerSource → Phoenix/Ecto scheduler emission (scheduling.md, M-T4.1).
//
// The Elixir half of the timerSource feature — the sibling of the Hono
// `scheduler-builder.ts`.  A `timerSource` fires a plain domain event on a
// wall-clock cadence.  The firing contract splits by cadence:
//
//   * `cron:` timers are DURABLE (Phase 2) — driven by **Oban**, the Postgres-
//     backed job queue.  A per-timer GenServer computes each wall-clock boundary
//     (the same `crontab` next-minute logic the Phase-1 loop used) and enqueues
//     a unique Oban job for it; Oban's `unique` constraint makes that job
//     single-fire across every replica AND idempotent for a boundary already
//     handled, and Oban runs the tick durably with retry (`max_attempts`).  A
//     self-owned `loom_timer_runs` watermark drives coalesce-once missed-run
//     catch-up: first boot records a baseline WITHOUT firing (a fresh deploy
//     must not replay history); a later boot whose most-recent boundary is past
//     the watermark enqueues exactly ONE catch-up job (the whole missed window
//     collapses to a single replay, never a stampede).
//   * `every:` (sub-minute) timers stay IN-PROCESS (Phase 1) — ONE `GenServer`
//     that on each tick takes a TRANSACTION-SCOPED Postgres advisory lock
//     (single-fire across replicas, the SAME `pg_try_advisory_xact_lock`
//     primitive keyed by the SAME FNV-1a hash the other backends use), builds
//     the tick event, and dispatches it.  Durability is meaningless for a 15s
//     poll, and Oban's cron/queue granularity is per-minute.
//
// Both cadences build the tick event struct and dispatch it through the SAME
// in-process `<Ctx>.Dispatcher` the sagas already route through — so an
// event-triggered `create(t: Tick) by …` reactor fires with no new dispatch
// machinery.
//
// Emitted ONLY when the deployable owns at least one timerSource; a timer-free
// deployable is byte-identical (no scheduler module, no crontab/oban dep, no
// migration, no supervision child).  A `cron:`-free (every-only) deployable
// pulls neither Oban nor the timer migration — it rides the in-process path.
// ---------------------------------------------------------------------------

import type {
  ChannelIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  EventIR,
  FieldIR,
  SystemIR,
  TimerSourceIR,
} from "../../../ir/types/loom-ir.js";
import { elixirString, snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { type ElixirChannelsCfg, elixirDispatchCall } from "../channels-emit.js";
import { contextHasDispatcher } from "../dispatch-emit.js";

/** The owner of a timer is DERIVED (never stamped): the deployable whose
 *  subdomain `migrationsOwner` owns the for-event's context — the same
 *  deployable that owns that context's DB, so the durable-job/lock owner is the
 *  DB owner.  Filters the system's timers to the ones THIS deployable owns.
 *  Mirrors the Hono `ownedTimers` derivation byte-for-byte. */
export function ownedElixirTimers(sys: SystemIR, deployable: DeployableIR): TimerSourceIR[] {
  return (sys.timerSources ?? []).filter((ts) => {
    const sub = sys.subdomains.find((s) => s.contexts.some((c) => c.name === ts.context));
    return sub?.migrationsOwner === deployable.name;
  });
}

/** Whether any owned timer uses a real cron expression (vs a bare-interval
 *  `every:`).  Gates the `crontab` + `oban` hex deps, the timer migration, the
 *  Oban config block, and the Oban supervision child. */
export function anyElixirTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/** Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource name
 *  into a signed 32-bit int, the SAME derivation the Hono backend computes at
 *  runtime, so two replicas (of any backend) contend on the SAME key.  Computed
 *  at codegen and inlined as an Elixir integer literal.  (every: path only —
 *  cron: single-fire is Oban-native.) */
function timerLockKey(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** The value expression a scheduler tick uses to fill one tick-event field.  A
 *  tick is infrastructure-emitted, so every field is synthesised: id fields get
 *  a fresh id (a new saga instance per tick — the `create(t) by t.<id>`
 *  semantics), `datetime` gets the fire time, and any other scalar gets a
 *  type-safe zero.  Sister to the Hono `tickFieldValue`. */
function tickFieldValue(field: FieldIR): string {
  const t = field.type;
  if (t.kind === "id") {
    switch (t.valueType) {
      case "guid":
      case "string":
        // A fresh unique id — UUIDv7 (the same generator the Ecto schemas
        // autogenerate their `:binary_id` / string primary keys with).
        return "UUIDv7.generate()";
      case "int":
      case "long":
        return "System.unique_integer([:positive])";
    }
  }
  if (t.kind === "primitive") {
    switch (t.name) {
      case "datetime":
        return "DateTime.utc_now()";
      case "int":
      case "long":
        return "0";
      case "decimal":
      case "money":
        return "Decimal.new(0)";
      case "bool":
        return "false";
      case "string":
      case "guid":
        return '""';
      default:
        // json / duration: not a meaningful tick field — nil keeps the struct
        // build valid (ticks carry at/id).
        return "nil";
    }
  }
  return "nil";
}

/** The `%Ctx.Events.<Event>{field: val, …}` struct-build for a tick. */
function tickEventStruct(contextModule: string, ts: TimerSourceIR, event: EventIR): string {
  const fields = event.fields.map((f) => `${snake(f.name)}: ${tickFieldValue(f)}`).join(", ");
  return `%${contextModule}.Events.${upperFirst(ts.event)}{${fields}}`;
}

// ── every: — the Phase-1 in-process GenServer (advisory lock) ───────────────

/** Render one `lib/<app>/scheduler/<timer>.ex` GenServer for an `every:` timer
 *  (unchanged Phase-1 design — advisory-lock single-fire, inline dispatch). */
function renderEveryTimerModule(
  appModule: string,
  ts: TimerSourceIR,
  event: EventIR | undefined,
  hasDispatcher: boolean,
  channels: ElixirChannelsCfg | undefined,
): string {
  const mod = `${appModule}.Scheduler.${upperFirst(ts.name)}`;
  const contextModule = `${appModule}.${upperFirst(ts.context)}`;
  const lockKey = timerLockKey(ts.name);
  const everyMs = ts.cadence.kind === "every" ? ts.cadence.everyMs : 0;

  const fireLog = renderPhoenixLogCall("timerFired", [{ name: "timer", valueExpr: "@timer_name" }]);
  const contendedLog = renderPhoenixLogCall("timerLockContended", [
    { name: "timer", valueExpr: "@timer_name" },
  ]);
  const failedLog = renderPhoenixLogCall("timerEmitFailed", [
    { name: "timer", valueExpr: "@timer_name" },
    { name: "error", valueExpr: "Exception.message(e)" },
  ]);

  const lockedBody =
    event && (hasDispatcher || channels)
      ? [
          `        event = ${tickEventStruct(contextModule, ts, event)}`,
          `        ${elixirDispatchCall("event", contextModule, hasDispatcher, channels)}`,
          `        ${fireLog}`,
        ]
      : [`        ${fireLog}`];

  return `# Auto-generated — every: timer (scheduling.md, M-T4.1); in-process, single-fire via advisory lock.
defmodule ${mod} do
  @moduledoc "timerSource ${ts.name} — fires ${upperFirst(ts.event)} on a ${everyMs}ms cadence."

  use GenServer
  require Logger

  @timer_name ${elixirString(ts.name)}
  # Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource name
  # into a signed 32-bit int (the SAME derivation the Hono backend uses), so
  # replicas contend on the same key.  pg_try_advisory_xact_lock is transaction-
  # scoped: held on the tx's single pinned connection and released automatically
  # when the tx commits, so there is no manual unlock to leak onto another
  # pooled connection (a plain session-level lock + pool would).
  @lock_key ${lockKey}

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    schedule_next()
    {:ok, %{}}
  end

  @impl true
  def handle_info(:tick, state) do
    tick()
    # Reschedule AFTER the body: the GenServer message loop serialises ticks, so
    # a slow body delays the next fire rather than overlapping it (the non-
    # overlap guarantee Hono's 'running' flag simulates, free on the BEAM).
    schedule_next()
    {:noreply, state}
  end

  # every: ${everyMs}ms — a fixed interval cron cannot express.
  defp schedule_next do
    Process.send_after(self(), :tick, ${everyMs})
  end

  # One tick: a TRANSACTION-SCOPED advisory lock (single-fire across replicas) →
  # build the tick event → dispatch through the in-process Dispatcher the sagas
  # already route through.  A peer replica's concurrent tick fails the try and
  # logs timer_lock_contended; the commit releases the lock.
  defp tick do
    ${appModule}.Repo.transaction(fn ->
      %{rows: [[locked]]} =
        Ecto.Adapters.SQL.query!(${appModule}.Repo, "SELECT pg_try_advisory_xact_lock($1)", [@lock_key])

      if locked do
${lockedBody.join("\n")}
      else
        ${contendedLog}
      end
    end)

    :ok
  rescue
    e ->
      ${failedLog}
  end
end
`;
}

// ── cron: — the durable Oban worker + scheduler GenServer (Phase 2) ─────────

/** Render one `lib/<app>/scheduler/<timer>_worker.ex` Oban worker for a `cron:`
 *  timer — the DURABLE executor.  `unique` on the `boundary` arg makes a
 *  boundary fire at most once ever (across replicas and across time until
 *  pruned), so the scheduler's concurrent + catch-up enqueues coalesce to a
 *  single fire.  `max_attempts` gives retry with Oban's default backoff. */
function renderCronTimerWorker(
  appModule: string,
  ts: TimerSourceIR,
  event: EventIR | undefined,
  hasDispatcher: boolean,
  channels: ElixirChannelsCfg | undefined,
): string {
  const mod = `${appModule}.Scheduler.${upperFirst(ts.name)}Worker`;
  const contextModule = `${appModule}.${upperFirst(ts.context)}`;
  const fireLog = renderPhoenixLogCall("timerFired", [{ name: "timer", valueExpr: "@timer_name" }]);
  const failedLog = renderPhoenixLogCall("timerEmitFailed", [
    { name: "timer", valueExpr: "@timer_name" },
    { name: "error", valueExpr: "Exception.message(e)" },
  ]);

  const body =
    event && (hasDispatcher || channels)
      ? [
          `    event = ${tickEventStruct(contextModule, ts, event)}`,
          `    ${elixirDispatchCall("event", contextModule, hasDispatcher, channels)}`,
          `    ${fireLog}`,
          "    :ok",
        ]
      : [`    ${fireLog}`, "    :ok"];

  return `# Auto-generated — cron: timer durable executor (scheduling.md, M-T4.1 Phase 2).
defmodule ${mod} do
  @moduledoc "Durable executor for timerSource ${ts.name}: builds ${upperFirst(ts.event)} and dispatches it. Enqueued single-fire per boundary by ${appModule}.Scheduler.${upperFirst(ts.name)}; retried by Oban."

  # \`unique\` on the boundary arg is the single-fire ledger: two replicas
  # enqueuing the same boundary (and the boot catch-up re-enqueuing one already
  # run) collapse to ONE job.  \`:completed\` is in the state set so a boundary is
  # never re-run.  max_attempts: 3 gives durable retry with Oban's backoff.
  use Oban.Worker,
    queue: :timers,
    max_attempts: 3,
    unique: [
      keys: [:boundary],
      period: :infinity,
      # All states — a boundary is unique across its whole lifecycle, so it is
      # never re-run (the boot catch-up re-enqueue of an already-run boundary
      # no-ops).
      states: [
        :scheduled,
        :available,
        :executing,
        :retryable,
        :completed,
        :cancelled,
        :discarded,
        :suspended
      ]
    ]

  require Logger

  @timer_name ${elixirString(ts.name)}

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"boundary" => _boundary}}) do
${body.join("\n")}
  rescue
    e ->
      ${failedLog}
      reraise e, __STACKTRACE__
  end
end
`;
}

/** Render one `lib/<app>/scheduler/<timer>.ex` scheduler GenServer for a `cron:`
 *  timer — computes each wall-clock boundary and enqueues the durable Oban
 *  worker for it, plus a coalesce-once boot catch-up over a `loom_timer_runs`
 *  watermark. */
function renderCronTimerScheduler(appModule: string, ts: TimerSourceIR): string {
  const mod = `${appModule}.Scheduler.${upperFirst(ts.name)}`;
  const worker = `${appModule}.Scheduler.${upperFirst(ts.name)}Worker`;
  const cron = ts.cadence.kind === "cron" ? ts.cadence.cron : "";
  const catchupLog = renderPhoenixLogCall("timerCatchup", [
    { name: "timer", valueExpr: "@timer_name" },
    { name: "boundary", valueExpr: "boundary" },
  ]);

  return `# Auto-generated — cron: timer scheduler (scheduling.md, M-T4.1 Phase 2).
defmodule ${mod} do
  @moduledoc "timerSource ${ts.name} — enqueues a durable ${worker} job at each cron boundary (single-fire across replicas via Oban), replaying one missed boundary on recovery."

  use GenServer
  require Logger

  @timer_name ${elixirString(ts.name)}
  @cron ${elixirString(cron)}

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    {:ok, cron} = Crontab.CronExpression.Parser.parse(@cron)
    catch_up(cron)
    schedule_next(cron)
    {:ok, %{cron: cron}}
  end

  @impl true
  def handle_info(:tick, %{cron: cron} = state) do
    enqueue(previous_boundary(cron))
    schedule_next(cron)
    {:noreply, state}
  end

  # cron: ${cron} — the next matching wall-clock minute.
  defp schedule_next(cron) do
    now = NaiveDateTime.utc_now()
    # One second past now so the just-fired minute is never re-matched (cron is
    # minute-granular) without skipping the next occurrence.
    next = Crontab.Scheduler.get_next_run_date!(cron, NaiveDateTime.add(now, 1, :second))
    delay = max(1, NaiveDateTime.diff(next, now, :millisecond))
    Process.send_after(self(), :tick, delay)
  end

  # The most-recent past boundary (unix seconds) — the one that just elapsed.
  defp previous_boundary(cron) do
    now = NaiveDateTime.utc_now()
    {:ok, prev} = Crontab.Scheduler.get_previous_run_date(cron, now)
    prev |> DateTime.from_naive!("Etc/UTC") |> DateTime.to_unix()
  end

  # Enqueue a durable Oban job for \`boundary\`; the worker's \`unique\` constraint
  # makes it single-fire across replicas and idempotent for a boundary already
  # enqueued/run.  The watermark advances so a later restart knows where we left
  # off.
  defp enqueue(boundary) do
    %{boundary: boundary} |> ${worker}.new() |> Oban.insert()
    record_watermark(boundary)
  end

  # Boot catch-up (coalesce-once): compare the most-recent past boundary against
  # the persisted watermark.  First boot records a baseline WITHOUT firing (a
  # fresh deploy must not replay history); a later boot whose boundary is past
  # the watermark enqueues exactly ONE catch-up job (Oban dedups if a peer
  # already handled it), collapsing the whole missed window to a single replay.
  defp catch_up(cron) do
    boundary = previous_boundary(cron)

    case last_watermark() do
      nil ->
        record_watermark(boundary)

      last when boundary > last ->
        ${catchupLog}
        enqueue(boundary)

      _ ->
        :ok
    end
  end

  # A self-owned, timer-specific watermark (\`loom_timer_runs\`, created by the
  # timer migration this feature emits — NOT part of the domain schema, so no
  # other backend is touched).  One row per timer.
  defp last_watermark do
    %{rows: rows} =
      Ecto.Adapters.SQL.query!(
        ${appModule}.Repo,
        "SELECT last_boundary FROM loom_timer_runs WHERE timer = $1",
        [@timer_name]
      )

    case rows do
      [[b]] -> b
      _ -> nil
    end
  end

  defp record_watermark(boundary) do
    Ecto.Adapters.SQL.query!(
      ${appModule}.Repo,
      "INSERT INTO loom_timer_runs (timer, last_boundary) VALUES ($1, $2) " <>
        "ON CONFLICT (timer) DO UPDATE SET last_boundary = " <>
        "GREATEST(loom_timer_runs.last_boundary, EXCLUDED.last_boundary)",
      [@timer_name, boundary]
    )
  end
end
`;
}

/** The Ecto migration that provisions the durable-timer infrastructure — Oban's
 *  own tables plus the self-owned `loom_timer_runs` watermark.  Emitted only
 *  when this deployable owns a `cron:` timer.  An early version prefix so it
 *  runs before the domain migrations (independent tables — order is immaterial,
 *  but a fixed early stamp keeps it deterministic and collision-free). */
function renderTimerMigration(appModule: string): { path: string; content: string } {
  const version = "20000101000000";
  return {
    path: `priv/repo/migrations/${version}_add_timer_infrastructure.exs`,
    content: `defmodule ${appModule}.Repo.Migrations.AddTimerInfrastructure do
  # Auto-generated — durable timerSource infrastructure (scheduling.md, M-T4.1 Phase 2).
  use Ecto.Migration

  def up do
    Oban.Migration.up(version: 12)

    # Watermark for coalesce-once missed-run catch-up (one row per timerSource).
    create_if_not_exists table(:loom_timer_runs, primary_key: false) do
      add :timer, :text, primary_key: true, null: false
      add :last_boundary, :bigint, null: false
    end
  end

  def down do
    drop_if_exists table(:loom_timer_runs)
    Oban.Migration.down(version: 1)
  end
end
`,
  };
}

/** The Oban config block spliced into `config/config.exs` when a `cron:` timer
 *  is owned.  `timers` queue + a Pruner to bound the completed-job table (the
 *  watermark — not job history — is the catch-up ledger, so pruning is safe). */
export function renderObanConfig(appName: string, appModule: string): string {
  return `
# Durable timerSource jobs (scheduling.md, M-T4.1 Phase 2) — cron timers enqueue
# ${appModule}.Scheduler.*Worker jobs onto Oban; the unique constraint gives
# single-fire across replicas, max_attempts gives retry.  The Pruner bounds the
# completed-job table (the loom_timer_runs watermark is the catch-up ledger).
config :${appName}, Oban,
  repo: ${appModule}.Repo,
  queues: [timers: 10],
  plugins: [{Oban.Plugins.Pruner, max_age: 3600}]
`;
}

/** Emit the per-timer scheduler modules this deployable owns.  Returns the
 *  supervision-tree children (Oban first, then the timer GenServers), whether a
 *  `crontab` dep is needed (any cron timer), and whether Oban is needed (== any
 *  cron timer).  A timer-free deployable emits nothing (byte-identical). */
export function emitVanillaScheduler(
  appName: string,
  appModule: string,
  contexts: EnrichedBoundedContextIR[],
  deployable: DeployableIR,
  sys: SystemIR,
  out: Map<string, string>,
  /** Broker tee config (channels.md) — presence routes a tick's dispatch
   *  through `<App>.Channels.dispatch/2` so broker-carried tick events
   *  publish instead of fanning out locally. */
  channels?: ElixirChannelsCfg,
  /** Wired-but-foreign channels widening the dispatcher-existence check. */
  wiredForeignChannels: ChannelIR[] = [],
): { schedulerChildren: string[]; usesCron: boolean; usesOban: boolean } {
  const timers = ownedElixirTimers(sys, deployable);
  if (timers.length === 0) return { schedulerChildren: [], usesCron: false, usesOban: false };

  const ctxByName = new Map(contexts.map((c) => [c.name, c] as const));
  const usesOban = anyElixirTimerUsesCron(timers);
  // Oban must start before the timer GenServers (they enqueue on boot), so it
  // leads the supervision children.
  const schedulerChildren: string[] = usesOban
    ? [`{Oban, Application.fetch_env!(:${appName}, Oban)}`]
    : [];

  for (const ts of timers) {
    const ctx = ctxByName.get(ts.context);
    const event = ctx?.events.find((e) => e.name === ts.event);
    const hasDispatcher = ctx ? contextHasDispatcher(ctx, wiredForeignChannels) : false;
    if (ts.cadence.kind === "cron") {
      out.set(
        `lib/${appName}/scheduler/${snake(ts.name)}_worker.ex`,
        renderCronTimerWorker(appModule, ts, event, hasDispatcher, channels),
      );
      out.set(
        `lib/${appName}/scheduler/${snake(ts.name)}.ex`,
        renderCronTimerScheduler(appModule, ts),
      );
    } else {
      out.set(
        `lib/${appName}/scheduler/${snake(ts.name)}.ex`,
        renderEveryTimerModule(appModule, ts, event, hasDispatcher, channels),
      );
    }
    schedulerChildren.push(`${appModule}.Scheduler.${upperFirst(ts.name)}`);
  }

  if (usesOban) {
    const migration = renderTimerMigration(appModule);
    out.set(migration.path, migration.content);
  }

  return { schedulerChildren, usesCron: usesOban, usesOban };
}
