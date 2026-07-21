// Timer scheduler emission (scheduling.md, M-T4.1 Phase 2) — the Python /
// FastAPI half.
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  The
// firing contract splits by cadence:
//
//   * `cron:` timers are DURABLE — driven by procrastinate, a Postgres-native
//     async job store.  Each becomes an `@app.periodic(cron=…)` task whose
//     single-fire (one job per boundary across every replica) and missed-run
//     catch-up (coalesce-once replay of a boundary missed while every replica
//     was down) are STORE-COORDINATED by procrastinate's `periodic_defers`
//     table — no advisory lock, no per-replica bookkeeping.  Retries ride on
//     procrastinate's `RetryStrategy`.
//   * `every:` (sub-minute) timers stay IN-PROCESS — an asyncio interval loop
//     taking a transaction-scoped Postgres advisory lock (single-fire across
//     replicas — the SAME `pg_try_advisory_xact_lock` primitive keyed by the
//     SAME FNV-1a hash the other backends use).  procrastinate's cron is
//     minute-granular, so sub-minute cadences can't be durable jobs.
//
// Both paths build the tick event struct and dispatch it through the SAME
// in-process dispatcher the sagas already route through — so an `on(t: Tick)` /
// `create(t: Tick) by …` reactor fires with no new dispatch machinery.
//
// Emitted ONLY when the deployable owns at least one timerSource; a timer-free
// deployable is byte-identical to before (no scheduling.py, no procrastinate
// dep, no lifespan wiring).  A `cron:`-free (every-only) deployable pulls no
// procrastinate dep either — it rides the existing sqlalchemy/asyncpg session.

import type { EventIR, FieldIR, TimerSourceIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";

/** Does any owned timer use a real cron expression (vs a bare-interval
 *  `every:`)?  Gates the procrastinate dependency + the durable job store — a
 *  `every:`-only deployable needs neither. */
export function anyPyTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/** The `cron:` timers — durable procrastinate periodic tasks. */
function cronTimers(timers: readonly TimerSourceIR[]): TimerSourceIR[] {
  return timers.filter((ts) => ts.cadence.kind === "cron");
}

/** The `every:` timers — in-process asyncio interval loops + advisory lock. */
function everyTimers(timers: readonly TimerSourceIR[]): TimerSourceIR[] {
  return timers.filter((ts) => ts.cadence.kind === "every");
}

/** The value expression a scheduler tick uses to fill one tick-event field.  A
 *  tick is infrastructure-emitted, so every field is synthesised: id fields get
 *  a fresh id (a new saga instance per tick — the `create(t) by t.<id>`
 *  semantics), `at`-style datetimes get the fire time, and any other scalar
 *  gets a type-safe zero.  The residual arm (`typeIgnore`) covers exotic field
 *  types (enum / value-object) that a real tick never carries — kept
 *  mypy-clean so the emitted struct always typechecks under `--strict`. */
function tickFieldValue(field: FieldIR): { text: string; typeIgnore?: boolean } {
  const t = field.type;
  if (t.kind === "id") return { text: `new_${snake(t.targetName)}_id()` };
  if (t.kind === "optional") return { text: "None" };
  if (t.kind === "array") return { text: "[]" };
  if (t.kind === "primitive") {
    switch (t.name) {
      case "datetime":
        return { text: "datetime.now(UTC)" };
      case "int":
      case "long":
        return { text: "0" };
      case "decimal":
        return { text: "0.0" };
      case "money":
        return { text: 'Decimal("0")' };
      case "bool":
        return { text: "False" };
      case "string":
      case "guid":
        return { text: '""' };
      case "json":
        return { text: "{}" };
      case "duration":
        return { text: "timedelta()" };
    }
  }
  // enum / value-object / union / etc.: not a meaningful tick field — a
  // placeholder that keeps the emitted struct mypy-clean (ticks carry at/id).
  return { text: "None", typeIgnore: true };
}

/** The keyword-argument call that constructs one tick event, e.g.
 *  `SweepTick(sweep=new_sweep_id(), at=datetime.now(UTC))`. */
function tickBuild(event: EventIR): string {
  const kwargs = event.fields.map((f) => {
    const { text, typeIgnore } = tickFieldValue(f);
    return `${snake(f.name)}=${text}${typeIgnore ? "  # type: ignore[arg-type]" : ""}`;
  });
  return `${event.name}(${kwargs.join(", ")})`;
}

/** Which stdlib / domain imports the synthesised tick structs require. */
interface TickImports {
  idFactories: string[];
  eventNames: string[];
  usesDatetime: boolean;
  usesDecimal: boolean;
  usesTimedelta: boolean;
}

function collectTickImports(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
): TickImports {
  const idFactories = new Set<string>();
  const eventNames = new Set<string>();
  let usesDatetime = false;
  let usesDecimal = false;
  let usesTimedelta = false;
  for (const ts of timers) {
    eventNames.add(ts.event);
    const event = eventByName.get(ts.event);
    for (const f of event?.fields ?? []) {
      const t = f.type;
      if (t.kind === "id") idFactories.add(`new_${snake(t.targetName)}_id`);
      if (t.kind === "primitive") {
        if (t.name === "datetime") usesDatetime = true;
        if (t.name === "money") usesDecimal = true;
        if (t.name === "duration") usesTimedelta = true;
      }
    }
  }
  return {
    idFactories: [...idFactories].sort(),
    eventNames: [...eventNames].sort(),
    usesDatetime,
    usesDecimal,
    usesTimedelta,
  };
}

/**
 * Render `app/scheduling.py` for a deployable's owned timers.  `eventByName`
 * resolves each timer's `for:` event to its declared field shape (for the tick
 * struct).  `hasDispatch` gates whether the in-process dispatcher exists — a
 * timer whose event nothing reacts to (no carrying channel) dispatches into the
 * no-op default instead of crashing on a missing `app.dispatch` import.
 */
export function renderPyTimerScheduler(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  hasDispatch: boolean,
): string {
  const crons = cronTimers(timers);
  const everies = everyTimers(timers);
  const hasCron = crons.length > 0;
  const hasEvery = everies.length > 0;
  const imp = collectTickImports(timers, eventByName);
  // The dispatcher construction — the in-process router the sagas use when a
  // channel carries a subscribed event, else the no-op default.
  const dispatchExpr = hasDispatch ? "make_dispatcher(session)" : "NoopDomainEventDispatcher()";

  // ── Durable `cron:` timers: one procrastinate periodic task each ──────────
  // The task body opens its own session (it runs on the procrastinate worker,
  // off the request path), builds the tick, and dispatches.  Single-fire +
  // missed-run catch-up are store-coordinated by procrastinate's periodic
  // deferrer (periodic_defers dedup) — no advisory lock here.
  const cronTasks = crons.flatMap((ts) => {
    const event = eventByName.get(ts.event);
    const build = event ? tickBuild(event) : `${ts.event}()`;
    const cron = ts.cadence.kind === "cron" ? ts.cadence.cron : "";
    const fn = `_timer_${snake(ts.name)}`;
    return [
      "",
      "",
      `@timer_app.periodic(cron=${JSON.stringify(cron)}, periodic_id=${JSON.stringify(ts.name)})`,
      "@timer_app.task(",
      // A queueing lock means a boundary is SKIPPED (not queued) while the
      // previous fire is still running — the overlap-skip semantics.  Retries
      // ride on the store: three attempts with exponential backoff.
      `    queueing_lock=${JSON.stringify(`timer:${ts.name}`)},`,
      "    retry=RetryStrategy(max_attempts=3, exponential_wait=2),",
      ")",
      `async def ${fn}(timestamp: int) -> None:`,
      `    """Durable tick for timerSource ${ts.name} (cron ${JSON.stringify(cron)}).`,
      "",
      "    Runs on the procrastinate worker: opens its own transaction, builds the",
      "    tick event, and dispatches it through the in-process dispatcher.  `timestamp`",
      `    is the scheduled boundary (procrastinate fills it)."""`,
      "    async with session_factory() as session, session.begin():",
      `        await ${dispatchExpr}.dispatch(${build})`,
      `    log("info", "timer_fired", timer=${JSON.stringify(ts.name)}, boundary=timestamp)`,
    ];
  });

  // ── In-process `every:` timers: asyncio interval loop + advisory lock ─────
  const everyJobs = everies.flatMap((ts) => {
    const event = eventByName.get(ts.event);
    const build = event ? tickBuild(event) : `${ts.event}()`;
    const seconds = ts.cadence.kind === "every" ? ts.cadence.everyMs / 1000 : 0;
    return [
      `        # timerSource ${ts.name} { for: ${ts.event}, every: ${
        ts.cadence.kind === "every" ? ts.cadence.everyMs : 0
      }ms }`,
      "        self._tasks.append(",
      "            asyncio.create_task(",
      `                _interval_loop(${JSON.stringify(ts.name)}, ${seconds}, lambda: ${build})`,
      "            )",
      "        )",
    ];
  });

  return lines(
    `"""Timer scheduler (scheduling.md, M-T4.1 Phase 2).  Auto-generated.`,
    "",
    "Fires each owned `timerSource`'s tick event on a wall-clock cadence.",
    "",
    hasCron ? "`cron:` timers are DURABLE — procrastinate periodic tasks whose single-fire" : null,
    hasCron ? "(one job per boundary across every replica) and missed-run catch-up (one" : null,
    hasCron ? "coalesced replay of a boundary missed while every replica was down) are" : null,
    hasCron ? "store-coordinated by the `periodic_defers` table." : null,
    hasEvery
      ? "`every:` (sub-minute) timers run in-process: an asyncio interval loop taking"
      : null,
    hasEvery ? "a transaction-scoped Postgres advisory lock (single-fire across replicas)." : null,
    "Ticks dispatch through the SAME in-process dispatcher the sagas use, so an",
    "`on(t: Tick)` / `create(t: Tick) by …` reactor fires with no new dispatch",
    "machinery.",
    "",
    "Emitted only when this deployable owns a timerSource; a timer-free deployable",
    "has no scheduling module.",
    `"""`,
    "",
    "import asyncio",
    "import contextlib",
    "from collections.abc import Callable",
    imp.usesDatetime ? "from datetime import UTC, datetime" : null,
    imp.usesTimedelta ? "from datetime import timedelta" : null,
    imp.usesDecimal ? "from decimal import Decimal" : null,
    "",
    hasCron ? "import procrastinate" : null,
    hasCron ? "from procrastinate import RetryStrategy" : null,
    hasEvery ? "from sqlalchemy import text" : null,
    "",
    "from app.db.engine import session_factory",
    hasDispatch ? "from app.dispatch import make_dispatcher" : null,
    `from app.domain.events import ${["DomainEvent", ...imp.eventNames]
      .concat(hasDispatch ? [] : ["NoopDomainEventDispatcher"])
      .sort()
      .join(", ")}`,
    imp.idFactories.length > 0 ? `from app.domain.ids import ${imp.idFactories.join(", ")}` : null,
    "from app.obs.log import log",
    hasCron ? "from app.settings import DATABASE_URL" : null,
    "",
    "",
    ...(hasCron
      ? [
          "# procrastinate speaks libpq (psycopg 3); strip SQLAlchemy's async-driver",
          "# suffix off DATABASE_URL to get a plain conninfo.  The durable job store",
          "# shares the app's Postgres database but owns its own connection pool.",
          '_CONNINFO = DATABASE_URL.replace("+asyncpg", "").replace("+psycopg", "")',
          "",
          "timer_app = procrastinate.App(",
          "    connector=procrastinate.PsycopgConnector(conninfo=_CONNINFO),",
          ")",
          ...cronTasks,
          "",
        ]
      : []),
    ...(hasEvery
      ? [
          "",
          "def _timer_lock_key(name: str) -> int:",
          `    """Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource`,
          "    name into a signed 32-bit int, so two replicas (any backend) contend on the",
          "    SAME key.  `pg_try_advisory_xact_lock` is non-blocking: the loser skips this",
          `    tick, and the lock auto-releases when the tick's transaction commits."""`,
          "    h = 0x811C9DC5",
          "    for ch in name:",
          "        h = (h ^ ord(ch)) & 0xFFFFFFFF",
          "        h = (h * 0x01000193) & 0xFFFFFFFF",
          "    return h - 0x100000000 if h & 0x80000000 else h",
          "",
          "",
          "async def _tick_once(name: str, build: Callable[[], DomainEvent]) -> None:",
          `    """One in-process tick: a TRANSACTION-SCOPED advisory lock (single-fire`,
          "    across replicas) → build the event → dispatch, all inside one transaction",
          "    whose commit releases the lock (no manual unlock to leak onto a pooled",
          `    connection)."""`,
          "    lock_key = _timer_lock_key(name)",
          "    try:",
          "        async with session_factory() as session, session.begin():",
          "            locked = (",
          "                await session.execute(",
          '                    text("SELECT pg_try_advisory_xact_lock(:key) AS locked"),',
          '                    {"key": lock_key},',
          "                )",
          "            ).scalar()",
          "            if not locked:",
          '                log("debug", "timer_lock_contended", timer=name)',
          "                return",
          `            await ${dispatchExpr}.dispatch(build())`,
          '            log("info", "timer_fired", timer=name)',
          "    except Exception as err:  # noqa: BLE001 — one tick's failure is isolated",
          '        log("error", "timer_emit_failed", timer=name, error=str(err))',
          "",
          "",
          "async def _interval_loop(",
          "    name: str, seconds: float, build: Callable[[], DomainEvent]",
          ") -> None:",
          `    """Fire \`name\` every \`seconds\`.  The in-process \`running\` guard is`,
          "    unnecessary here — each iteration awaits its own tick before sleeping, so",
          `    a slow body just delays the next iteration (it never overlaps itself)."""`,
          "    while True:",
          "        await asyncio.sleep(seconds)",
          "        await _tick_once(name, build)",
          "",
        ]
      : []),
    "",
    "class TimerScheduler:",
    `    """Handle for the running timer machinery${
      hasCron ? " — the procrastinate worker" : ""
    }${hasCron && hasEvery ? " and " : ""}${
      hasEvery ? `${hasCron ? "" : " — "}the asyncio interval loops` : ""
    }.`,
    "    Started once at boot; stopped on drain.",
    `    """`,
    "",
    "    def __init__(self) -> None:",
    "        self._stack = contextlib.AsyncExitStack()",
    "        self._tasks: list[asyncio.Task[None]] = []",
    "",
    "    async def start(self) -> None:",
    ...(hasCron
      ? [
          "        # Open the durable store, ensure its schema, and run the worker in",
          "        # process.  `install_signal_handlers=False`: uvicorn owns SIGTERM;",
          '        # `delete_jobs="successful"`: keep the jobs table bounded (the',
          "        # periodic_defers dedup row is what persists, not finished job history).",
          "        await self._stack.enter_async_context(timer_app.open_async())",
          "        await timer_app.schema_manager.apply_schema_async()",
          "        self._tasks.append(",
          "            asyncio.create_task(",
          "                timer_app.run_worker_async(",
          '                    install_signal_handlers=False, delete_jobs="successful"',
          "                )",
          "            )",
          "        )",
        ]
      : []),
    ...everyJobs,
    "",
    "    async def stop(self) -> None:",
    "        for task in self._tasks:",
    "            task.cancel()",
    "        for task in self._tasks:",
    "            with contextlib.suppress(asyncio.CancelledError):",
    "                await task",
    "        await self._stack.aclose()",
    "",
    "",
    "async def start_timer_scheduler() -> TimerScheduler:",
    `    """Start every owned timerSource and return the handle the FastAPI lifespan`,
    `    stops on drain."""`,
    "    scheduler = TimerScheduler()",
    "    await scheduler.start()",
    "    return scheduler",
    "",
  );
}
