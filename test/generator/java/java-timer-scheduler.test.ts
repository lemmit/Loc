// timerSource → Java/Spring scheduler emission (scheduling.md, M-T4.1 + Phase 2).
//
// The Java sibling of test/platform/hono-timer-scheduler.test.ts, pinned at the
// lowest catching altitude: pure in-memory `generateSystems` (no docker, no
// gradle, no LOOM_* env). Asserts that `cron:` timers run on JobRunr (a job bean
// + JobRunrConfig wiring the core: SQL storage + background server + Spring
// activator + scheduleRecurrently with the standard cron verbatim), `every:`
// timers keep the in-process `@Scheduled(fixedRate)` + advisory lock in
// TimerScheduler.java, the JobRunr gradle dep — and that a timer-free java
// deployable is byte-identical.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

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
  deployable d { platform: java, contexts: [Orders], dataSources: [opsState], serves: A, port: 4000 }
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
  deployable d { platform: java, contexts: [Orders], dataSources: [opsState], serves: A, port: 4000 }
}
`;

const get =
  (files: Map<string, string>) =>
  (suffix: string): string =>
    [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("timerSource → Java durable scheduler", () => {
  it("runs cron: on a JobRunr job bean + JobRunrConfig", async () => {
    const { model, errors } = await parseString(WITH_TIMERS);
    expect(errors).toEqual([]);
    const g = get(generateSystems(model).files);

    // cron: → a JobRunr job bean (no advisory lock — JobRunr owns single-fire;
    // rethrows so JobRunr's automatic retry engages).
    const job = g("d/src/main/java/com/loom/d/SweepTimerJob.java");
    expect(job).not.toBe("");
    expect(job).toContain("public class SweepTimerJob");
    expect(job).toContain("public void execute()");
    expect(job).toContain("events.publishEvent(new SweepTick(SweepId.newId(), Instant.now()))");
    expect(job).toContain("throw err; // let JobRunr's automatic retry engage");
    expect(job).not.toContain("pg_try_advisory_xact_lock");

    // JobRunrConfig wires the core (no SB starter): SQL storage + background
    // server + Spring activator + a recurring job with the STANDARD cron verbatim.
    const cfg = g("d/src/main/java/com/loom/d/config/JobRunrConfig.java");
    expect(cfg).not.toBe("");
    expect(cfg).toContain("JobRunr.configure()");
    expect(cfg).toContain(".useJobActivator(ctx::getBean)");
    expect(cfg).toContain(".useBackgroundJobServer()");
    expect(cfg).toContain("SqlStorageProviderFactory.using(dataSource)");
    expect(cfg).toContain(
      'scheduler.<SweepTimerJob>scheduleRecurrently("timerSweep", "*/5 * * * *", SweepTimerJob::execute);',
    );

    // JobRunr core dep, gated on the owned cron timer.
    expect(g("d/build.gradle.kts")).toContain('implementation("org.jobrunr:jobrunr:');
  });

  it("keeps every: timers in-process (@Scheduled + advisory lock), not JobRunr", async () => {
    const { model } = await parseString(WITH_TIMERS);
    const g = get(generateSystems(model).files);

    const scheduler = g("d/src/main/java/com/loom/d/TimerScheduler.java");
    expect(scheduler).not.toBe("");
    expect(scheduler).toContain("@EnableScheduling");
    expect(scheduler).toContain("@Scheduled(fixedRate = 15000)");
    expect(scheduler).toContain("pg_try_advisory_xact_lock");
    expect(scheduler).toContain("static int timerLockKey");
    expect(scheduler).toContain("new HealthTick(Instant.now())");
    // The cron timer is NOT a @Scheduled method here — it lives on JobRunr.
    expect(scheduler).not.toContain("SweepTick");
    expect(scheduler).not.toContain("@Scheduled(cron");
  });

  it("is byte-identical for a timer-free deployable (no scheduler artifacts)", async () => {
    const { model } = await parseString(NO_TIMERS);
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    expect(keys.some((k) => k.endsWith("TimerScheduler.java"))).toBe(false);
    expect(keys.some((k) => k.endsWith("JobRunrConfig.java"))).toBe(false);
    expect([...files.values()].some((c) => c.includes("@EnableScheduling"))).toBe(false);
    expect(get(files)("d/build.gradle.kts")).not.toContain("jobrunr");
  });
});
