// ---------------------------------------------------------------------------
// timerSource → Phoenix/Ecto scheduler emission (scheduling.md, M-T4.1).
//
// The Elixir half of the timerSource feature — the sibling of the Hono
// `scheduler-builder.ts`.  A `timerSource` fires a plain domain event on a
// wall-clock cadence.  Each owned timer becomes ONE `GenServer` module under
// `lib/<app>/scheduler/<timer>.ex`, added to the OTP supervision tree.  On each
// tick the GenServer takes a TRANSACTION-SCOPED Postgres advisory lock
// (single-fire across replicas), builds the tick event struct, and dispatches
// it through the SAME in-process `<Ctx>.Dispatcher` the sagas already route
// through — so an event-triggered `create(t: Tick) by …` reactor fires with no
// new dispatch machinery.
//
// Design (vs the recommended Quantum): a single GenServer-per-timer is cleaner
// than adding Quantum here — one mechanism carries BOTH cadences (the advisory-
// lock tick body lives in one place), and the BEAM's serialised message loop
// gives the non-overlap guarantee for free (the property Hono's `running` flag
// has to simulate), so there is no separate scheduler process + job registry to
// wire.  `every:` uses a fixed `Process.send_after`; `cron:` computes the next
// matching wall-clock minute via the small pure `crontab` lib (the same cron
// engine Quantum itself wraps), added as a dep ONLY when an owned timer uses a
// real `cron:` expression — mirroring Hono's conditional `node-cron` dep.
//
// The single-fire lock is `pg_try_advisory_xact_lock` held INSIDE
// `Repo.transaction` (on the tx's single pinned connection, auto-released on
// commit) — NOT a session-level lock+unlock, so there is no manual unlock to
// leak onto a different pooled connection.  Identical primitive + FNV-1a key
// derivation to the Hono reference.
//
// Emitted ONLY when the deployable owns at least one timerSource; a timer-free
// deployable is byte-identical (no scheduler module, no crontab dep, no
// supervision child).
// ---------------------------------------------------------------------------

import type {
  DeployableIR,
  EnrichedBoundedContextIR,
  EventIR,
  FieldIR,
  SystemIR,
  TimerSourceIR,
} from "../../../ir/types/loom-ir.js";
import { elixirString, snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { contextHasDispatcher } from "../dispatch-emit.js";

/** The owner of a timer's single-fire lock is DERIVED (never stamped): the
 *  deployable whose subdomain `migrationsOwner` owns the for-event's context —
 *  the same deployable that owns that context's DB, so the advisory-lock owner
 *  is the DB owner.  Filters the system's timers to the ones THIS deployable
 *  owns.  Mirrors the Hono `ownedTimers` derivation byte-for-byte. */
export function ownedElixirTimers(sys: SystemIR, deployable: DeployableIR): TimerSourceIR[] {
  return (sys.timerSources ?? []).filter((ts) => {
    const sub = sys.subdomains.find((s) => s.contexts.some((c) => c.name === ts.context));
    return sub?.migrationsOwner === deployable.name;
  });
}

/** Whether any owned timer uses a real cron expression (vs a bare-interval
 *  `every:`).  Gates the `crontab` hex dep. */
export function anyElixirTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/** Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource name
 *  into a signed 32-bit int, the SAME derivation the Hono backend computes at
 *  runtime, so two replicas (of any backend) contend on the SAME key.  Computed
 *  at codegen and inlined as an Elixir integer literal. */
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

/** Render one `lib/<app>/scheduler/<timer>.ex` GenServer module for a timer. */
function renderTimerSchedulerModule(
  appModule: string,
  ts: TimerSourceIR,
  event: EventIR | undefined,
  hasDispatcher: boolean,
): string {
  const mod = `${appModule}.Scheduler.${upperFirst(ts.name)}`;
  const contextModule = `${appModule}.${upperFirst(ts.context)}`;
  const lockKey = timerLockKey(ts.name);

  const fireLog = renderPhoenixLogCall("timerFired", [{ name: "timer", valueExpr: "@timer_name" }]);
  const contendedLog = renderPhoenixLogCall("timerLockContended", [
    { name: "timer", valueExpr: "@timer_name" },
  ]);
  const failedLog = renderPhoenixLogCall("timerEmitFailed", [
    { name: "timer", valueExpr: "@timer_name" },
    { name: "error", valueExpr: "Exception.message(e)" },
  ]);

  // Locked branch: build + dispatch the tick event (when the for-event's
  // context has an in-process Dispatcher — i.e. a reactor subscribes), then log
  // timer_fired.  A timer whose event has no subscriber has nowhere to dispatch,
  // so it just logs the fire (keeps the module compile-clean either way).
  const lockedBody =
    hasDispatcher && event
      ? [
          `        event = %${contextModule}.Events.${upperFirst(ts.event)}{${event.fields
            .map((f) => `${snake(f.name)}: ${tickFieldValue(f)}`)
            .join(", ")}}`,
          `        ${contextModule}.Dispatcher.dispatch(event)`,
          `        ${fireLog}`,
        ]
      : [`        ${fireLog}`];

  // Cadence → next-delay computation.  cron: the next matching wall-clock minute
  // via crontab; every: a fixed interval cron cannot express.
  const scheduleFn =
    ts.cadence.kind === "cron"
      ? [
          `  # cron: ${ts.cadence.cron} — the next matching wall-clock minute.`,
          `  defp schedule_next do`,
          `    cron = Crontab.CronExpression.Parser.parse!(${elixirString(ts.cadence.cron)})`,
          `    now = NaiveDateTime.utc_now()`,
          `    # One second past now so the just-fired minute is never re-matched`,
          `    # (cron is minute-granular) without skipping the next occurrence.`,
          `    next = Crontab.Scheduler.get_next_run_date!(cron, NaiveDateTime.add(now, 1, :second))`,
          `    delay = max(1, NaiveDateTime.diff(next, now, :millisecond))`,
          `    Process.send_after(self(), :tick, delay)`,
          `  end`,
        ]
      : [
          `  # every: ${ts.cadence.everyMs}ms — a fixed interval cron cannot express.`,
          `  defp schedule_next do`,
          `    Process.send_after(self(), :tick, ${ts.cadence.everyMs})`,
          `  end`,
        ];

  return `# Auto-generated — emitted only when this deployable owns timerSources (scheduling.md).
defmodule ${mod} do
  @moduledoc "timerSource ${ts.name} — fires ${upperFirst(ts.event)} on a wall-clock cadence."

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

${scheduleFn.join("\n")}

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

/** Emit the per-timer GenServer modules this deployable owns.  Returns the
 *  supervision-tree child module names (threaded into `renderApplication`) and
 *  whether a `crontab` dep is needed.  A timer-free deployable emits nothing and
 *  returns an empty result (byte-identical). */
export function emitVanillaScheduler(
  appName: string,
  appModule: string,
  contexts: EnrichedBoundedContextIR[],
  deployable: DeployableIR,
  sys: SystemIR,
  out: Map<string, string>,
): { schedulerChildren: string[]; usesCron: boolean } {
  const timers = ownedElixirTimers(sys, deployable);
  if (timers.length === 0) return { schedulerChildren: [], usesCron: false };

  const ctxByName = new Map(contexts.map((c) => [c.name, c] as const));
  const schedulerChildren: string[] = [];
  for (const ts of timers) {
    const ctx = ctxByName.get(ts.context);
    const event = ctx?.events.find((e) => e.name === ts.event);
    const hasDispatcher = ctx ? contextHasDispatcher(ctx) : false;
    out.set(
      `lib/${appName}/scheduler/${snake(ts.name)}.ex`,
      renderTimerSchedulerModule(appModule, ts, event, hasDispatcher),
    );
    schedulerChildren.push(`${appModule}.Scheduler.${upperFirst(ts.name)}`);
  }
  return { schedulerChildren, usesCron: anyElixirTimerUsesCron(timers) };
}
