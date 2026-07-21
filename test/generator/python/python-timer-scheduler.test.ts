// timerSource → Python/FastAPI scheduler emission (scheduling.md, M-T4.1 Phase 2).
//
// The Python sibling of test/platform/hono-timer-scheduler.test.ts.  Pins the
// emitted `app/scheduling.py` durable-driver shape: `cron:` timers become
// procrastinate periodic tasks (store-coordinated single-fire + missed-run
// catch-up, retry with backoff — no advisory lock); `every:` (sub-minute)
// timers stay in-process (asyncio interval loop + transaction-scoped
// pg_try_advisory_xact_lock); the FastAPI lifespan wiring; the conditional
// procrastinate+psycopg deps (cron only) — and that a timer-free deployable is
// byte-identical (no scheduling.py, no procrastinate, no lifespan wiring).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const WITH_TIMERS = `
system Reaping {
  subdomain Ops {
    context Orders {
      aggregate Sweep { runId: string }
      event SweepTick { sweep: Sweep id, at: datetime }
      event SweepRan  { sweep: Sweep id, at: datetime }
      event HealthTick { at: datetime }
      channel Ticks { carries: SweepTick }
      workflow SweepRun eventSourced {
        sweep: Sweep id
        firedAt: datetime
        create(t: SweepTick) by t.sweep { emit SweepRan { sweep: t.sweep, at: t.at } }
        apply(r: SweepRan) { firedAt := r.at }
      }
    }
  }
  storage pg { type: postgres }
  resource opsState { for: Orders, kind: state, use: pg }
  api A from Ops
  deployable d { platform: python, contexts: [Orders], dataSources: [opsState], serves: A, port: 8000 }
  timerSource sweep   { for: SweepTick, cron: "*/5 * * * *" }
  timerSource healthz { for: HealthTick, every: 15s }
}
`;

const NO_TIMERS = `
system Plain {
  subdomain Ops { context Orders { aggregate Order { status: string } } }
  storage pg { type: postgres }
  resource opsState { for: Orders, kind: state, use: pg }
  api A from Ops
  deployable d { platform: python, contexts: [Orders], dataSources: [opsState], serves: A, port: 8000 }
}
`;

async function filesFor(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  expect(errors).toEqual([]);
  return generateSystems(model).files;
}

const getter =
  (files: Map<string, string>) =>
  (suffix: string): string =>
    [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("timerSource → Python/FastAPI scheduler", () => {
  it("makes cron timers DURABLE procrastinate periodic tasks (store-coordinated, no advisory lock)", async () => {
    const get = getter(await filesFor(WITH_TIMERS));

    const scheduler = get("d/app/scheduling.py");
    expect(scheduler).not.toBe("");
    // A durable procrastinate App over the app's Postgres (own pool, libpq conninfo).
    expect(scheduler).toContain("import procrastinate");
    expect(scheduler).toContain("timer_app = procrastinate.App(");
    expect(scheduler).toContain("procrastinate.PsycopgConnector(conninfo=_CONNINFO)");
    expect(scheduler).toContain('_CONNINFO = DATABASE_URL.replace("+asyncpg", "")');
    // The cron timer → periodic task keyed by the timer name.  Single-fire +
    // missed-run catch-up are store-coordinated (procrastinate's periodic_defers
    // dedup) — so the cron path has NO advisory lock.
    expect(scheduler).toContain('@timer_app.periodic(cron="*/5 * * * *", periodic_id="sweep")');
    expect(scheduler).toContain('queueing_lock="timer:sweep"');
    // Durable retry: three attempts, exponential backoff (Hono/.NET/Java parity).
    expect(scheduler).toContain("retry=RetryStrategy(max_attempts=3, exponential_wait=2)");
    // The task body opens its own tx (off the request path) and dispatches
    // through the existing in-process dispatcher.
    expect(scheduler).toContain("async def _timer_sweep(timestamp: int) -> None:");
    expect(scheduler).toContain("await make_dispatcher(session).dispatch(SweepTick(");
    // The tick struct: mint an id per tick, stamp the fire time.
    expect(scheduler).toContain("new_sweep_id()");
    expect(scheduler).toContain("at=datetime.now(UTC)");
    // The worker runs in-process inside the FastAPI event loop; uvicorn owns
    // signals, and successful jobs are pruned to bound the table.
    expect(scheduler).toContain("timer_app.run_worker_async(");
    expect(scheduler).toContain("install_signal_handlers=False");
    expect(scheduler).toContain('delete_jobs="successful"');
    expect(scheduler).toContain("await timer_app.schema_manager.apply_schema_async()");
  });

  it("keeps every: (sub-minute) timers in-process with a transaction-scoped advisory lock", async () => {
    const get = getter(await filesFor(WITH_TIMERS));
    const scheduler = get("d/app/scheduling.py");

    // Single-fire via a TRANSACTION-SCOPED advisory lock (auto-released on tx
    // commit). Keyed per timer via the SAME FNV-1a hash the other backends use,
    // so a cross-backend replica contends on one key.
    expect(scheduler).toContain("pg_try_advisory_xact_lock");
    expect(scheduler).toContain("async with session_factory() as session, session.begin():");
    expect(scheduler).toContain("def _timer_lock_key(name: str) -> int:");
    expect(scheduler).toContain("h = 0x811C9DC5");
    // No session-level unlock (the tx commit releases the xact lock).
    expect(scheduler).not.toContain("pg_advisory_unlock");
    // The every: cadence becomes an asyncio interval loop (procrastinate cron
    // is minute-granular; sub-minute can't be a durable job).
    expect(scheduler).toContain("async def _interval_loop(");
    expect(scheduler).toContain('_interval_loop("healthz", 15, lambda: HealthTick(');
    // Catalog obs events.
    expect(scheduler).toContain('"timer_fired"');
    expect(scheduler).toContain('"timer_lock_contended"');
    expect(scheduler).toContain('"timer_emit_failed"');
  });

  it("wires the scheduler into the FastAPI lifespan and adds procrastinate + psycopg", async () => {
    const get = getter(await filesFor(WITH_TIMERS));

    const main = get("d/app/main.py");
    expect(main).toContain("from app.scheduling import start_timer_scheduler");
    expect(main).toContain("_timer_scheduler = await start_timer_scheduler()");
    expect(main).toContain("await _timer_scheduler.stop()"); // graceful drain

    const pyproject = get("d/pyproject.toml");
    // Durable store deps — procrastinate + psycopg (binary wheel bundles libpq
    // so the slim image needs no apt libpq).  Both ship py.typed, so no mypy
    // override is emitted (unlike the old apscheduler driver).
    expect(pyproject).toContain("procrastinate>=3,<4");
    expect(pyproject).toContain("psycopg[binary]>=3.2,<4");
    expect(pyproject).not.toContain("apscheduler");
    expect(pyproject).not.toContain("ignore_missing_imports");
  });

  it("an every-only project pulls no procrastinate dep (in-process path only)", async () => {
    const get = getter(
      await filesFor(`
system IntervalOnly {
  subdomain Ops {
    context Orders {
      aggregate Sweep { runId: string }
      event SweepTick { sweep: Sweep id, at: datetime }
      event SweepRan  { sweep: Sweep id, at: datetime }
      channel Ticks { carries: SweepTick }
      workflow SweepRun eventSourced {
        sweep: Sweep id
        firedAt: datetime
        create(t: SweepTick) by t.sweep { emit SweepRan { sweep: t.sweep, at: t.at } }
        apply(r: SweepRan) { firedAt := r.at }
      }
    }
  }
  storage pg { type: postgres }
  resource opsState { for: Orders, kind: state, use: pg }
  api A from Ops
  deployable d { platform: python, contexts: [Orders], dataSources: [opsState], serves: A, port: 8000 }
  timerSource healthz { for: SweepTick, every: 30s }
}
`),
    );
    const scheduler = get("d/app/scheduling.py");
    // In-process interval loop, no durable store.
    expect(scheduler).toContain('_interval_loop("healthz", 30, lambda: SweepTick(');
    expect(scheduler).not.toContain("procrastinate");
    expect(scheduler).not.toContain("periodic");
    // No procrastinate dep when there is no cron timer.
    expect(get("d/pyproject.toml")).not.toContain("procrastinate");
    expect(get("d/pyproject.toml")).not.toContain("psycopg[binary]");
  });

  it("is byte-identical for a timer-free deployable (no scheduling artifacts)", async () => {
    const files = await filesFor(NO_TIMERS);
    const get = getter(files);
    expect([...files.keys()].some((k) => k.endsWith("d/app/scheduling.py"))).toBe(false);

    expect(get("d/pyproject.toml")).not.toContain("procrastinate");
    expect(get("d/pyproject.toml")).not.toContain("apscheduler");
    const main = get("d/app/main.py");
    expect(main).not.toContain("start_timer_scheduler");
    expect(main).not.toContain("scheduling");
  });
});
