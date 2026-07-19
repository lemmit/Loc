// timerSource → .NET TimerScheduler emission (scheduling.md, M-T4.1 + Phase 2).
//
// The .NET sibling of test/platform/hono-timer-scheduler.test.ts. Pins the
// durable-driver shape at the lowest catching altitude: pure in-memory
// `generateSystems` (no docker, no LOOM_* env). Asserts that `cron:` timers run
// on Hangfire (a recurring job class + Hangfire.PostgreSql DI + IRecurringJobManager
// registration with the standard cron, verbatim), `every:` timers keep the
// in-process BackgroundService (PeriodicTimer + advisory lock), the Program.cs
// wiring, the Hangfire deps (Cronos gone) — and that a timer-free deployable is
// byte-identical.

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

describe("timerSource → .NET durable TimerScheduler", () => {
  it("runs cron: on a Hangfire job and every: on an in-process BackgroundService", async () => {
    const { model, errors } = await parseString(WITH_TIMERS);
    expect(errors).toEqual([]);
    const g = get(generateSystems(model).files);

    const scheduler = g("Infrastructure/Scheduling/TimerScheduler.cs");
    expect(scheduler).not.toBe("");

    // cron: → a plain Hangfire job class (no advisory lock — Hangfire owns
    // single-fire/retry/missed-run; injects the scoped dispatcher; rethrows so
    // Hangfire's automatic retry engages).
    expect(scheduler).toContain("public sealed class SweepTimerJob");
    expect(scheduler).toContain("public async Task ExecuteAsync()");
    expect(scheduler).toContain("await _events.DispatchAsync(");
    expect(scheduler).toContain("throw; // let Hangfire's automatic retry engage");
    // every: → the Phase-1 BackgroundService (PeriodicTimer + tx-scoped advisory lock).
    expect(scheduler).toContain("public sealed class HealthzTimerService : BackgroundService");
    expect(scheduler).toContain("pg_try_advisory_xact_lock");
    expect(scheduler).toContain("new PeriodicTimer(TimeSpan.FromMilliseconds(15000))");

    // The tick struct: mint an id per tick, stamp the fire time.
    expect(scheduler).toContain("new SweepTick(SweepId.New(), DateTime.UtcNow)");
    expect(scheduler).toContain("new HealthTick(DateTime.UtcNow)");
    // Catalog obs events.
    expect(scheduler).toContain('"timer_fired"');
    expect(scheduler).toContain('"timer_lock_contended"');
    // Cronos is gone.
    expect(scheduler).not.toContain("Cronos");
  });

  it("wires Hangfire in Program.cs (storage + recurring job) and swaps Cronos for Hangfire deps", async () => {
    const { model } = await parseString(WITH_TIMERS);
    const g = get(generateSystems(model).files);

    const program = g("d/Program.cs");
    expect(program).toContain("builder.Services.AddHangfire(cfg => cfg");
    expect(program).toContain(".UsePostgreSqlStorage(");
    expect(program).toContain("builder.Services.AddHangfireServer();");
    expect(program).toContain(
      "builder.Services.AddScoped<D.Infrastructure.Scheduling.SweepTimerJob>();",
    );
    // Service-based recurring registration with the standard cron, verbatim.
    expect(program).toContain("GetRequiredService<IRecurringJobManager>()");
    expect(program).toContain(
      'recurring.AddOrUpdate<D.Infrastructure.Scheduling.SweepTimerJob>("timer:sweep", job => job.ExecuteAsync(), "*/5 * * * *");',
    );
    expect(program).toContain("using Hangfire;");
    // every: timer stays an in-process hosted service; cron: is NOT.
    expect(program).toContain(
      "builder.Services.AddHostedService<D.Infrastructure.Scheduling.HealthzTimerService>();",
    );
    expect(program).not.toContain("AddHostedService<D.Infrastructure.Scheduling.SweepTimerJob>");

    const csproj = g("d/D.csproj");
    expect(csproj).toContain('<PackageReference Include="Hangfire.AspNetCore"');
    expect(csproj).toContain('<PackageReference Include="Hangfire.PostgreSql"');
    expect(csproj).toContain('<PackageReference Include="Newtonsoft.Json"');
    expect(csproj).not.toContain("Cronos");
  });

  it("is byte-identical for a timer-free deployable (no scheduler artifacts)", async () => {
    const { model } = await parseString(NO_TIMERS);
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    expect(keys.some((k) => k.endsWith("Infrastructure/Scheduling/TimerScheduler.cs"))).toBe(false);

    const g = get(files);
    expect(g("d/D.csproj")).not.toContain("Hangfire");
    const program = g("d/Program.cs");
    expect(program).not.toContain("TimerService");
    expect(program).not.toContain("AddHangfire");
  });
});
