// Timer scheduler emission (scheduling.md, M-T4.1 Phase 2) — the Python /
// FastAPI half.
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  This
// builder renders `app/scheduling.py`: one APScheduler job per owned timer
// that, on each tick, opens a transaction, takes a Postgres advisory lock
// (single-fire across replicas — the SAME `pg_try_advisory_xact_lock` primitive
// the Hono backend uses, keyed by the SAME FNV-1a hash so a cross-backend
// replica contends on the same key), constructs the tick event struct, and
// dispatches it through the SAME in-process dispatcher the sagas already route
// through — so an `on(t: Tick)` / `create(t: Tick) by …` reactor fires with no
// new dispatch machinery.
//
// Emitted ONLY when the deployable owns at least one timerSource; a timer-free
// deployable is byte-identical to before (no scheduling.py, no apscheduler dep,
// no lifespan wiring).

import type { EventIR, FieldIR, TimerSourceIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";

/** Does any owned timer use a real cron expression (vs a bare-interval
 *  `every:`)?  Gates the `CronTrigger` import.  A `every:`-only deployable
 *  uses `IntervalTrigger`. */
export function anyPyTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

function anyPyTimerUsesInterval(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "every");
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
  const usesCron = anyPyTimerUsesCron(timers);
  const usesInterval = anyPyTimerUsesInterval(timers);
  const imp = collectTickImports(timers, eventByName);

  const jobs = timers.flatMap((ts) => {
    const event = eventByName.get(ts.event);
    const build = event ? tickBuild(event) : `${ts.event}()`;
    const trigger =
      ts.cadence.kind === "cron"
        ? `CronTrigger.from_crontab(${JSON.stringify(ts.cadence.cron)})`
        : `IntervalTrigger(seconds=${ts.cadence.everyMs / 1000})`;
    const cadenceComment =
      ts.cadence.kind === "cron"
        ? `cron: ${JSON.stringify(ts.cadence.cron)}`
        : `every: ${ts.cadence.everyMs}ms`;
    return [
      `    # timerSource ${ts.name} { for: ${ts.event}, ${cadenceComment} }`,
      "    scheduler.add_job(",
      `        _make_tick(${JSON.stringify(ts.name)}, lambda: ${build}),`,
      `        ${trigger},`,
      "    )",
    ];
  });

  // The dispatcher construction — the in-process router the sagas use when a
  // channel carries a subscribed event, else the no-op default.
  const dispatchExpr = hasDispatch ? "make_dispatcher(session)" : "NoopDomainEventDispatcher()";

  return lines(
    `"""Timer scheduler (scheduling.md, M-T4.1).  Auto-generated.`,
    "",
    "Fires each owned `timerSource`'s tick event on a wall-clock cadence.  A tick",
    "opens its own transaction, takes a Postgres advisory lock (single-fire across",
    "replicas), builds the tick event, and dispatches it through the SAME in-process",
    "dispatcher the sagas use — so an `on(t: Tick)` / `create(t: Tick) by …` reactor",
    "fires with no new dispatch machinery.  Emitted only when this deployable owns a",
    "timerSource; a timer-free deployable has no scheduling module.",
    `"""`,
    "",
    "from collections.abc import Awaitable, Callable",
    imp.usesDatetime ? "from datetime import UTC, datetime" : null,
    imp.usesTimedelta ? "from datetime import timedelta" : null,
    imp.usesDecimal ? "from decimal import Decimal" : null,
    "",
    "from apscheduler.schedulers.asyncio import AsyncIOScheduler",
    usesCron ? "from apscheduler.triggers.cron import CronTrigger" : null,
    usesInterval ? "from apscheduler.triggers.interval import IntervalTrigger" : null,
    "from sqlalchemy import text",
    "",
    "from app.db.engine import session_factory",
    hasDispatch ? "from app.dispatch import make_dispatcher" : null,
    `from app.domain.events import ${["DomainEvent", ...imp.eventNames]
      .concat(hasDispatch ? [] : ["NoopDomainEventDispatcher"])
      .sort()
      .join(", ")}`,
    imp.idFactories.length > 0 ? `from app.domain.ids import ${imp.idFactories.join(", ")}` : null,
    "from app.obs.log import log",
    "",
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
    "def _make_tick(name: str, build: Callable[[], DomainEvent]) -> Callable[[], Awaitable[None]]:",
    `    """One tick: a TRANSACTION-SCOPED advisory lock (single-fire across`,
    "    replicas) → build the event → dispatch, all inside one transaction whose",
    "    commit releases the lock (no manual unlock to leak onto a pooled",
    "    connection — a plain session-level lock + pool would).  The in-process",
    "    `running` guard skips — does not queue — a tick that overlaps a slow body",
    `    on THIS replica."""`,
    "    lock_key = _timer_lock_key(name)",
    "    running = False",
    "",
    "    async def _tick() -> None:",
    "        nonlocal running",
    "        if running:",
    '            log("info", "timer_skipped_overlap", timer=name)',
    "            return",
    "        running = True",
    "        try:",
    "            async with session_factory() as session, session.begin():",
    "                locked = (",
    "                    await session.execute(",
    '                        text("SELECT pg_try_advisory_xact_lock(:key) AS locked"),',
    '                        {"key": lock_key},',
    "                    )",
    "                ).scalar()",
    "                if not locked:",
    '                    log("debug", "timer_lock_contended", timer=name)',
    "                    return",
    `                await ${dispatchExpr}.dispatch(build())`,
    '                log("info", "timer_fired", timer=name)',
    "        except Exception as err:  # noqa: BLE001 — one tick's failure is isolated",
    '            log("error", "timer_emit_failed", timer=name, error=str(err))',
    "        finally:",
    "            running = False",
    "",
    "    return _tick",
    "",
    "",
    "def start_timer_scheduler() -> AsyncIOScheduler:",
    `    """Start one APScheduler job per owned timerSource.  Returns the running`,
    "    scheduler so the FastAPI lifespan can shut it down gracefully on drain.",
    `    """`,
    "    scheduler = AsyncIOScheduler()",
    ...jobs,
    "    scheduler.start()",
    "    return scheduler",
    "",
  );
}
