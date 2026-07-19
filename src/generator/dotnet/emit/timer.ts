// Timer scheduler emission (scheduling.md) — the .NET backend, Phase 2 (durable).
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  This
// emitter renders `Infrastructure/Scheduling/TimerScheduler.cs`, splitting the
// owned timers by cadence:
//
//   • `cron:` timers run on **Hangfire** with **Hangfire.PostgreSql** storage.
//     Hangfire's recurring-job scheduler is coordinated through its Postgres
//     store (single-fire across replicas), persists each run, retries a failed
//     job with backoff, and — because a recurring job's next execution is
//     tracked in the store — **fires an overdue job on server start**, so a
//     boundary missed while every replica was down runs on recovery (native
//     missed-run; no watermark shim).  Standard 5-field cron, no translation.
//
//   • `every:` (sub-minute) timers stay **in-process** (`PeriodicTimer` +
//     transaction-scoped `pg_try_advisory_xact_lock` single-fire).  Durability is
//     meaningless for a high-frequency poll and Hangfire cron is minute-granular.
//
// Every tick constructs its event struct and dispatches it through the SAME
// `IDomainEventDispatcher` the sagas ride.  Emitted ONLY when the deployable owns
// at least one timerSource; a timer-free deployable is byte-identical to before.

import type { EventIR, FieldIR, TimerSourceIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall, renderDotnetLogCallWithException } from "../../_obs/render-dotnet.js";

/** Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource name
 *  into a signed 32-bit int, IDENTICAL to the Hono `timerLockKey` derivation so
 *  a node and a .NET replica of the same `every:` timer contend on the SAME key. */
export function timerLockKey(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** The `cron:` timers of a set — run on Hangfire. */
export function cronTimers(timers: readonly TimerSourceIR[]): TimerSourceIR[] {
  return timers.filter((ts) => ts.cadence.kind === "cron");
}

/** The `every:` timers of a set — run in-process (PeriodicTimer + advisory lock). */
export function everyTimers(timers: readonly TimerSourceIR[]): TimerSourceIR[] {
  return timers.filter((ts) => ts.cadence.kind === "every");
}

/** Whether any owned timer uses a real cron expression.  Gates the Hangfire
 *  package references + the Hangfire DI block + recurring-job registration. */
export function anyTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/** The C# value expression a scheduler tick uses to fill one tick-event field. */
function tickFieldValue(field: FieldIR): string {
  const t = field.type;
  if (t.kind === "id") return `${t.targetName}Id.New()`;
  if (t.kind === "optional") return "null";
  if (t.kind === "array") return "new()";
  if (t.kind === "primitive") {
    switch (t.name) {
      case "datetime":
        return "DateTime.UtcNow";
      case "int":
        return "0";
      case "long":
        return "0L";
      case "decimal":
      case "money":
        return "0m";
      case "bool":
        return "false";
      case "string":
        return '""';
      case "guid":
        return "Guid.Empty";
      case "duration":
        return "TimeSpan.Zero";
      default:
        return "default!";
    }
  }
  return "default!";
}

/** The `new <Event>(<positional args>)` expression that constructs one tick
 *  event (the .NET event record is a positional `sealed record`). */
function tickStruct(event: EventIR | undefined, eventName: string): string {
  if (!event) return `new ${eventName}()`;
  const args = event.fields.map(tickFieldValue).join(", ");
  return `new ${eventName}(${args})`;
}

/** The Hangfire recurring-job id for a timer (stable across boots so
 *  `AddOrUpdate` upserts the same schedule). */
function jobId(ts: TimerSourceIR): string {
  return `timer:${ts.name}`;
}

/** The job class name for a cron timer. */
function jobClass(ts: TimerSourceIR): string {
  return `${upperFirst(ts.name)}TimerJob`;
}

/** Render one Hangfire job class for a `cron:` timer.  Hangfire owns single-fire
 *  (store-coordinated) + retry + missed-run replay, so the body just resolves
 *  the dispatcher (Hangfire creates a DI scope per job) and dispatches.  On
 *  failure it logs and rethrows so Hangfire's automatic retry engages. */
function renderCronJob(ts: TimerSourceIR, eventByName: Map<string, EventIR>): string {
  const cls = jobClass(ts);
  const struct = tickStruct(eventByName.get(ts.event), ts.event);
  const timerLit = `"${ts.name}"`;
  const firedLog = renderDotnetLogCall("timerFired", [{ name: "timer", valueExpr: timerLit }]);
  const failedLog = renderDotnetLogCallWithException("timerEmitFailed", "ex", [
    { name: "timer", valueExpr: timerLit },
    { name: "error", valueExpr: "ex.Message" },
  ]);
  return `/// <summary>timerSource ${ts.name} { for: ${ts.event}, cron: ${JSON.stringify(
    ts.cadence.kind === "cron" ? ts.cadence.cron : "",
  )} } — durable (Hangfire recurring job).  Single-fire + retry + missed-run
/// replay owned by Hangfire; dispatches the tick through the in-process
/// dispatcher the sagas ride.  Hangfire opens a DI scope per execution, so the
/// scoped dispatcher resolves directly.</summary>
public sealed class ${cls}
{
    private readonly IDomainEventDispatcher _events;
    private readonly ILogger<${cls}> _log;

    public ${cls}(IDomainEventDispatcher events, ILogger<${cls}> log)
    {
        _events = events;
        _log = log;
    }

    public async Task ExecuteAsync()
    {
        try
        {
            await _events.DispatchAsync(${struct}, CancellationToken.None);
            ${firedLog}
        }
        catch (Exception ex)
        {
            ${failedLog}
            throw; // let Hangfire's automatic retry engage
        }
    }
}`;
}

/** Render one `<Pascal>TimerService : BackgroundService` for an `every:` timer.
 *  Unchanged from Phase 1: PeriodicTimer + transaction-scoped advisory lock. */
function renderEveryService(ts: TimerSourceIR, eventByName: Map<string, EventIR>): string {
  const cls = `${upperFirst(ts.name)}TimerService`;
  const lockKey = timerLockKey(ts.name);
  const struct = tickStruct(eventByName.get(ts.event), ts.event);
  const timerLit = `"${ts.name}"`;
  const firedLog = renderDotnetLogCall("timerFired", [{ name: "timer", valueExpr: timerLit }]);
  const overlapLog = renderDotnetLogCall("timerSkippedOverlap", [
    { name: "timer", valueExpr: timerLit },
  ]);
  const contendedLog = renderDotnetLogCall("timerLockContended", [
    { name: "timer", valueExpr: timerLit },
  ]);
  const failedLog = renderDotnetLogCallWithException("timerEmitFailed", "ex", [
    { name: "timer", valueExpr: timerLit },
    { name: "error", valueExpr: "ex.Message" },
  ]);
  const everyMs = ts.cadence.kind === "every" ? ts.cadence.everyMs : 0;

  return `/// <summary>timerSource ${ts.name} { for: ${ts.event}, every: ${everyMs}ms } —
/// in-process PeriodicTimer; single-fire across replicas via a transaction-scoped
/// advisory lock; dispatches the tick through the in-process dispatcher.</summary>
public sealed class ${cls} : BackgroundService
{
    // FNV-1a hash of the timer name into a signed 32-bit int (identical to the
    // Hono key derivation) — two replicas contend on the SAME advisory key.
    private const int LockKey = ${lockKey};

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<${cls}> _log;
    private int _running;

    public ${cls}(IServiceScopeFactory scopes, ILogger<${cls}> log)
    {
        _scopes = scopes;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(${everyMs}));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await TickAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task TickAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0)
        {
            ${overlapLog}
            return;
        }
        try
        {
            await using var scope = _scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var events = scope.ServiceProvider.GetRequiredService<IDomainEventDispatcher>();
            // TRANSACTION-SCOPED advisory lock: held on the tx's single pinned
            // connection and released automatically on commit (no unlock to leak
            // onto a different pooled connection).  Non-blocking: a peer replica's
            // concurrent tick fails the try and skips.
            await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
            var locked = await db.Database
                .SqlQuery<bool>($"SELECT pg_try_advisory_xact_lock({LockKey}) AS \\"Value\\"")
                .SingleAsync(cancellationToken);
            if (!locked)
            {
                ${contendedLog}
                return;
            }
            await events.DispatchAsync(${struct}, cancellationToken);
            await tx.CommitAsync(cancellationToken);
            ${firedLog}
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            ${failedLog}
        }
        finally
        {
            Interlocked.Exchange(ref _running, 0);
        }
    }
}`;
}

/**
 * Render `Infrastructure/Scheduling/TimerScheduler.cs` for a deployable's owned
 * timers: Hangfire job classes (cron) + `BackgroundService`s (every).
 */
export function renderTimerScheduler(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  ns: string,
): string {
  const jobs = cronTimers(timers)
    .map((ts) => renderCronJob(ts, eventByName))
    .join("\n\n");
  const services = everyTimers(timers)
    .map((ts) => renderEveryService(ts, eventByName))
    .join("\n\n");

  return `// Auto-generated — emitted only when this deployable owns timerSources (scheduling.md).
using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;
using ${ns}.Domain.Ids;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Infrastructure.Scheduling;

${[jobs, services].filter(Boolean).join("\n\n")}
`;
}

/** The FULLY-QUALIFIED `every:`-timer hosted-service type names Program.cs
 *  registers (`AddHostedService<…>()`).  Cron timers are Hangfire recurring jobs,
 *  not hosted services. */
export function timerServiceFqns(timers: readonly TimerSourceIR[], ns: string): string[] {
  return everyTimers(timers).map(
    (ts) => `${ns}.Infrastructure.Scheduling.${upperFirst(ts.name)}TimerService`,
  );
}

/** The `AddScoped<…Job>()` DI lines for the Hangfire cron-job classes (Hangfire
 *  resolves each job from DI per execution). */
export function hangfireJobDiRegistrations(timers: readonly TimerSourceIR[], ns: string): string[] {
  return cronTimers(timers).map(
    (ts) => `builder.Services.AddScoped<${ns}.Infrastructure.Scheduling.${jobClass(ts)}>();`,
  );
}

/** The recurring-job registration lines (run after `app.Build()` inside a scope
 *  that resolves `IRecurringJobManager` — the service-based API; the static
 *  `RecurringJob` needs `JobStorage.Current`, which isn't set on the DI path).
 *  One per cron timer, keyed by a stable id and the standard 5-field cron
 *  expression (Hangfire's Cronos parser takes it verbatim). */
export function hangfireRecurringRegistrations(
  timers: readonly TimerSourceIR[],
  ns: string,
): string[] {
  return cronTimers(timers).map((ts) => {
    const fqn = `${ns}.Infrastructure.Scheduling.${jobClass(ts)}`;
    const cron = (ts.cadence as { cron: string }).cron;
    return `    recurring.AddOrUpdate<${fqn}>(${JSON.stringify(jobId(ts))}, job => job.ExecuteAsync(), ${JSON.stringify(
      cron,
    )});`;
  });
}
