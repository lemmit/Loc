// timerSource → Hono scheduler emission (scheduling.md, M-T4.1).
//
// Pins the Phase-1 Hono deliverable at the lowest catching altitude: pure
// in-memory `generateSystems` (no docker, no LOOM_* env). Asserts the emitted
// `scheduler.ts` shape (advisory-lock single-fire, dispatch through the existing
// in-process dispatcher, node-cron vs setInterval per cadence, the tick struct),
// the boot wiring, the conditional node-cron dep — and that a timer-free
// deployable is byte-identical (no scheduler artifacts at all).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";

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
  deployable d { platform: node, contexts: [Orders], dataSources: [opsState], serves: A, port: 4000 }
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
  deployable d { platform: node, contexts: [Orders], dataSources: [opsState], serves: A, port: 4000 }
}
`;

describe("timerSource → Hono scheduler", () => {
  it("emits scheduler.ts with single-fire, dispatch, and per-cadence drivers", async () => {
    const { model, errors } = await parseString(WITH_TIMERS);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const get = (suffix: string): string =>
      [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

    const scheduler = get("d/scheduler.ts");
    expect(scheduler).not.toBe("");
    // Single-fire advisory lock keyed per timer.
    expect(scheduler).toContain("pg_try_advisory_lock");
    expect(scheduler).toContain("pg_advisory_unlock");
    expect(scheduler).toContain("function timerLockKey");
    // Dispatches through the existing in-process dispatcher.
    expect(scheduler).toContain("events.dispatch(build())");
    // Catalog obs events (cross-backend parity).
    expect(scheduler).toContain('event: "timer_fired"');
    expect(scheduler).toContain('event: "timer_lock_contended"');
    expect(scheduler).toContain('event: "timer_emit_failed"');
    // cron: → node-cron; every: → bare setInterval.
    expect(scheduler).toContain('cron.schedule("*/5 * * * *"');
    expect(scheduler).toContain("setInterval(() => void tick(), 15000)");
    // The tick struct: mint an id per tick, stamp the fire time.
    expect(scheduler).toContain("Ids.newSweepId()");
    expect(scheduler).toContain("at: new Date()");
  });

  it("wires the scheduler at boot and adds node-cron only when a cron timer exists", async () => {
    const { model } = await parseString(WITH_TIMERS);
    const files = generateSystems(model).files;
    const get = (suffix: string): string =>
      [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

    const index = get("d/index.ts");
    expect(index).toContain('import { startTimerScheduler } from "./scheduler"');
    expect(index).toContain("const stopTimers = startTimerScheduler(db, inProcessEvents)");
    expect(index).toContain("stopTimers();"); // graceful shutdown

    const pkg = get("d/package.json");
    expect(pkg).toContain("node-cron");
    expect(pkg).toContain("@types/node-cron");
  });

  it("is byte-identical for a timer-free deployable (no scheduler artifacts)", async () => {
    const { model } = await parseString(NO_TIMERS);
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    expect(keys.some((k) => k.endsWith("d/scheduler.ts"))).toBe(false);

    const get = (suffix: string): string =>
      [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";
    expect(get("d/package.json")).not.toContain("node-cron");
    const index = get("d/index.ts");
    expect(index).not.toContain("startTimerScheduler");
    expect(index).not.toContain("scheduler");
    // The plain boot path — no shared dispatcher construction.
    expect(index).toContain("const app = createApp(db);");
  });
});
