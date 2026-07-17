// timerSource → Java/Spring scheduler emission (scheduling.md, M-T4.1).
//
// The Java sibling of test/platform/hono-timer-scheduler.test.ts, pinned at the
// lowest catching altitude: pure in-memory `generateSystems` (no docker, no
// gradle, no LOOM_* env). Asserts the emitted `TimerScheduler.java` shape
// (transaction-scoped advisory-lock single-fire, dispatch through Spring's
// ApplicationEventPublisher, @Scheduled cron→6-field vs fixedRate per cadence,
// the tick construction, @EnableScheduling) — and that a timer-free java
// deployable is byte-identical (no scheduler artifacts at all).

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

describe("timerSource → Java scheduler", () => {
  it("emits TimerScheduler.java with single-fire, dispatch, and per-cadence @Scheduled", async () => {
    const { model, errors } = await parseString(WITH_TIMERS);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const get = (suffix: string): string =>
      [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

    const scheduler = get("d/src/main/java/com/loom/d/TimerScheduler.java");
    expect(scheduler).not.toBe("");
    // @Component enabled via @EnableScheduling (no other file changes).
    expect(scheduler).toContain("@Component");
    expect(scheduler).toContain("@EnableScheduling");
    // Single-fire via a TRANSACTION-SCOPED advisory lock (auto-released on tx
    // commit — a plain session lock + pool would leak the unlock onto a
    // different connection). Keyed per timer, same FNV-1a derivation as Hono.
    expect(scheduler).toContain("pg_try_advisory_xact_lock");
    expect(scheduler).toContain("tx.executeWithoutResult");
    expect(scheduler).toContain("static int timerLockKey");
    expect(scheduler).toContain("h = 0x811c9dc5");
    // No manual session-lock unlock (the tx commit releases it).
    expect(scheduler).not.toContain("pg_advisory_unlock");
    // Dispatches through Spring's in-process publisher, inside the lock tx.
    expect(scheduler).toContain("events.publishEvent(build.get())");
    // Catalog obs events (cross-backend parity).
    expect(scheduler).toContain('CatalogLog.event("timer_fired"');
    expect(scheduler).toContain('CatalogLog.event("timer_lock_contended"');
    expect(scheduler).toContain('CatalogLog.event("timer_skipped_overlap"');
    // The failure path wraps across lines — assert the event token + call.
    expect(scheduler).toContain('"timer_emit_failed"');
    expect(scheduler).toContain("String.valueOf(err.getMessage())");
    // cron: → 5-field lifted to Spring's 6-field (prepended seconds);
    // every: → fixedRate in ms.
    expect(scheduler).toContain('@Scheduled(cron = "0 */5 * * * *")');
    expect(scheduler).toContain("@Scheduled(fixedRate = 15000)");
    // The tick construction: mint an id per tick, stamp the fire time.
    expect(scheduler).toContain("new SweepTick(SweepId.newId(), Instant.now())");
    expect(scheduler).toContain("new HealthTick(Instant.now())");
  });

  it("is byte-identical for a timer-free deployable (no scheduler artifacts)", async () => {
    const { model } = await parseString(NO_TIMERS);
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    expect(keys.some((k) => k.endsWith("TimerScheduler.java"))).toBe(false);
    // No @EnableScheduling anywhere in the emitted java tree.
    expect([...files.values()].some((c) => c.includes("@EnableScheduling"))).toBe(false);
  });
});
