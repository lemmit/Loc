// timerSource → Python/FastAPI scheduler emission (scheduling.md, M-T4.1 Phase 2).
//
// The Python sibling of test/platform/hono-timer-scheduler.test.ts.  Pins the
// emitted `app/scheduling.py` shape (transaction-scoped advisory-lock single-fire,
// dispatch through the existing in-process dispatcher, CronTrigger vs
// IntervalTrigger per cadence, the tick struct), the FastAPI lifespan wiring, the
// conditional apscheduler dep + mypy override — and that a timer-free deployable
// is byte-identical (no scheduling.py, no apscheduler, no lifespan wiring).

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
  it("emits app/scheduling.py with single-fire, dispatch, and per-cadence drivers", async () => {
    const get = getter(await filesFor(WITH_TIMERS));

    const scheduler = get("d/app/scheduling.py");
    expect(scheduler).not.toBe("");
    // Single-fire via a TRANSACTION-SCOPED advisory lock (auto-released on tx
    // commit — a plain session lock + pool would leak the unlock onto a
    // different pooled connection). Keyed per timer via the SAME FNV-1a hash
    // the Hono backend uses, so a cross-backend replica contends on one key.
    expect(scheduler).toContain("pg_try_advisory_xact_lock");
    expect(scheduler).toContain("async with session_factory() as session, session.begin():");
    expect(scheduler).toContain("def _timer_lock_key(name: str) -> int:");
    expect(scheduler).toContain("h = 0x811C9DC5");
    // No session-level unlock (the tx commit releases the xact lock).
    expect(scheduler).not.toContain("pg_advisory_unlock");
    // Dispatches through the existing in-process dispatcher, inside the lock tx.
    expect(scheduler).toContain("await make_dispatcher(session).dispatch(build())");
    // Catalog obs events (cross-backend parity — same four the Hono/.NET emit).
    expect(scheduler).toContain('"timer_fired"');
    expect(scheduler).toContain('"timer_lock_contended"');
    expect(scheduler).toContain('"timer_emit_failed"');
    expect(scheduler).toContain('"timer_skipped_overlap"');
    // cron: → CronTrigger.from_crontab; every: → IntervalTrigger(seconds=…).
    expect(scheduler).toContain('CronTrigger.from_crontab("*/5 * * * *")');
    expect(scheduler).toContain("IntervalTrigger(seconds=15)");
    // The tick struct: mint an id per tick, stamp the fire time.
    expect(scheduler).toContain("new_sweep_id()");
    expect(scheduler).toContain("at=datetime.now(UTC)");
    // The overlap guard skips (does not queue) a still-running tick.
    expect(scheduler).toContain("nonlocal running");
  });

  it("wires the scheduler into the FastAPI lifespan and adds apscheduler", async () => {
    const get = getter(await filesFor(WITH_TIMERS));

    const main = get("d/app/main.py");
    expect(main).toContain("from app.scheduling import start_timer_scheduler");
    expect(main).toContain("_timer_scheduler = start_timer_scheduler()");
    expect(main).toContain("_timer_scheduler.shutdown(wait=False)"); // graceful drain

    const pyproject = get("d/pyproject.toml");
    expect(pyproject).toContain("apscheduler>=3.10,<4");
    // APScheduler ships no py.typed marker — a per-module mypy override keeps
    // `--strict` from flagging import-untyped.
    expect(pyproject).toContain(`module = "apscheduler.*"`);
    expect(pyproject).toContain("ignore_missing_imports = true");
  });

  it("only imports the trigger it needs (interval-only project skips CronTrigger)", async () => {
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
    expect(scheduler).toContain("IntervalTrigger(seconds=30)");
    expect(scheduler).not.toContain("CronTrigger");
  });

  it("is byte-identical for a timer-free deployable (no scheduling artifacts)", async () => {
    const files = await filesFor(NO_TIMERS);
    const get = getter(files);
    expect([...files.keys()].some((k) => k.endsWith("d/app/scheduling.py"))).toBe(false);

    expect(get("d/pyproject.toml")).not.toContain("apscheduler");
    expect(get("d/pyproject.toml")).not.toContain("apscheduler.*");
    const main = get("d/app/main.py");
    expect(main).not.toContain("start_timer_scheduler");
    expect(main).not.toContain("scheduling");
  });
});
