// timerSource → .NET TimerScheduler emission (scheduling.md, M-T4.1).
//
// The .NET sibling of test/platform/hono-timer-scheduler.test.ts. Pins the
// Phase-1 .NET deliverable at the lowest catching altitude: pure in-memory
// `generateSystems` (no docker, no LOOM_* env). Asserts the emitted
// TimerScheduler.cs shape (transaction-scoped advisory-lock single-fire,
// dispatch through the existing in-process dispatcher, Cronos vs PeriodicTimer
// per cadence, the tick struct), the Program.cs registration, the conditional
// Cronos dep — and that a timer-free deployable is byte-identical (no scheduler
// artifacts at all).

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
  deployable d { platform: dotnet, contexts: [Orders], dataSources: [opsState], serves: A, port: 5000 }
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
  deployable d { platform: dotnet, contexts: [Orders], dataSources: [opsState], serves: A, port: 5000 }
}
`;

const get =
  (files: Map<string, string>) =>
  (suffix: string): string =>
    [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("timerSource → .NET TimerScheduler", () => {
  it("emits TimerScheduler.cs with single-fire, dispatch, and per-cadence drivers", async () => {
    const { model, errors } = await parseString(WITH_TIMERS);
    expect(errors).toEqual([]);
    const g = get(generateSystems(model).files);

    const scheduler = g("Infrastructure/Scheduling/TimerScheduler.cs");
    expect(scheduler).not.toBe("");
    // One BackgroundService per owned timer.
    expect(scheduler).toContain("public sealed class SweepTimerService : BackgroundService");
    expect(scheduler).toContain("public sealed class HealthzTimerService : BackgroundService");
    // Single-fire via a TRANSACTION-SCOPED advisory lock (auto-released on tx
    // commit — a plain session lock + pool would leak the unlock onto a
    // different connection). Keyed per timer via EF Core raw SQL.
    expect(scheduler).toContain("pg_try_advisory_xact_lock");
    expect(scheduler).toContain("BeginTransactionAsync");
    expect(scheduler).toContain("await tx.CommitAsync");
    expect(scheduler).toContain("private const int LockKey =");
    // No manual session-lock unlock (the tx commit releases it).
    expect(scheduler).not.toContain("pg_advisory_unlock");
    // Dispatches through the existing in-process dispatcher, inside the lock tx.
    expect(scheduler).toContain("GetRequiredService<IDomainEventDispatcher>()");
    expect(scheduler).toContain("await events.DispatchAsync(");
    // Catalog obs events (cross-backend parity).
    expect(scheduler).toContain('"timer_fired"');
    expect(scheduler).toContain('"timer_lock_contended"');
    expect(scheduler).toContain('"timer_emit_failed"');
    expect(scheduler).toContain('"timer_skipped_overlap"');
    // cron: → Cronos; every: → PeriodicTimer.
    expect(scheduler).toContain('Cronos.CronExpression.Parse("*/5 * * * *")');
    expect(scheduler).toContain("new PeriodicTimer(TimeSpan.FromMilliseconds(15000))");
    // The tick struct: mint an id per tick, stamp the fire time.
    expect(scheduler).toContain("new SweepTick(SweepId.New(), DateTime.UtcNow)");
    expect(scheduler).toContain("new HealthTick(DateTime.UtcNow)");
  });

  it("registers each TimerService in Program.cs and adds Cronos only for cron timers", async () => {
    const { model } = await parseString(WITH_TIMERS);
    const g = get(generateSystems(model).files);

    const program = g("d/Program.cs");
    expect(program).toContain(
      "builder.Services.AddHostedService<D.Infrastructure.Scheduling.SweepTimerService>();",
    );
    expect(program).toContain(
      "builder.Services.AddHostedService<D.Infrastructure.Scheduling.HealthzTimerService>();",
    );

    const csproj = g("d/D.csproj");
    expect(csproj).toContain('<PackageReference Include="Cronos"');
  });

  it("is byte-identical for a timer-free deployable (no scheduler artifacts)", async () => {
    const { model } = await parseString(NO_TIMERS);
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    expect(keys.some((k) => k.endsWith("Infrastructure/Scheduling/TimerScheduler.cs"))).toBe(false);

    const g = get(files);
    expect(g("d/D.csproj")).not.toContain("Cronos");
    const program = g("d/Program.cs");
    expect(program).not.toContain("TimerService");
    expect(program).not.toContain("AddHostedService");
  });
});
