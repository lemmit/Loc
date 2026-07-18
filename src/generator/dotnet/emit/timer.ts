// Timer scheduler emission (scheduling.md, M-T4.1) — the .NET half of Phase 1,
// a fast-follow on the Hono `scheduler-builder.ts`.
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  This
// emitter renders `Infrastructure/Scheduling/TimerScheduler.cs`: one
// `BackgroundService` per owned timer that, on each tick, opens an EF Core
// transaction, takes a TRANSACTION-SCOPED Postgres advisory lock (single-fire
// across replicas), builds the tick event struct, and dispatches it through the
// SAME `IDomainEventDispatcher` the sagas already route through — so an
// `on(t: Tick)` / `create(t: Tick) by …` reactor fires with no new dispatch
// machinery.
//
// The lock primitive mirrors the Hono reference exactly: `pg_try_advisory_xact_lock`
// held on the transaction's single pinned connection and released automatically
// when the tx commits — NOT a session-level `pg_advisory_lock` + `unlock`, which
// leaks the unlock onto a different pooled connection.  `cron:` cadences drive a
// Cronos next-occurrence loop; `every:` cadences drive a `PeriodicTimer`.
//
// Emitted ONLY when the deployable owns at least one timerSource; a timer-free
// deployable is byte-identical to before (no file, no registration, no dep).

import type { EventIR, FieldIR, TimerSourceIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall, renderDotnetLogCallWithException } from "../../_obs/render-dotnet.js";

/** Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource name
 *  into a signed 32-bit int, IDENTICAL to the Hono `timerLockKey` derivation so
 *  a node and a .NET replica of the same timer contend on the SAME key. */
export function timerLockKey(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** Whether any owned timer uses a real cron expression (vs a bare-interval
 *  `every:`).  Gates the `Cronos` using + the csproj `PackageReference`. */
export function anyTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/** The C# value expression a scheduler tick uses to fill one tick-event field.
 *  A tick is infrastructure-emitted, so every field is synthesised: id fields
 *  get a fresh id (`<Id>.New()` — a new saga instance per tick), datetimes get
 *  the fire time (`DateTime.UtcNow`), and any other scalar gets a type-safe
 *  zero so the positional record ctor still compiles. */
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
        // json (JsonElement) and any future scalar: `default` keeps the ctor
        // call type-safe (ticks meaningfully carry only at/id).
        return "default!";
    }
  }
  // enum / valueobject / entity — not meaningful tick fields; a type-safe
  // default keeps the emitted `new <Event>(…)` compiling.
  return "default!";
}

/** The `new <Event>(<positional args>)` expression that constructs one tick
 *  event (the .NET event record is a positional `sealed record`). */
function tickStruct(event: EventIR | undefined, eventName: string): string {
  if (!event) return `new ${eventName}()`;
  const args = event.fields.map(tickFieldValue).join(", ");
  return `new ${eventName}(${args})`;
}

/** Render one `<Pascal>TimerService : BackgroundService`.  The tick body opens
 *  a transaction, tries the advisory lock, dispatches on success, and logs the
 *  catalog obs events (`timer_fired` / `timer_lock_contended` /
 *  `timer_emit_failed` / `timer_skipped_overlap`).  Cadence drives the loop:
 *  cron → Cronos next-occurrence delay loop; every → PeriodicTimer. */
function renderTimerService(ts: TimerSourceIR, eventByName: Map<string, EventIR>): string {
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

  // Per-cadence driver.  cron: Cronos parses the 5-field expression (or an
  // `@nickname` macro) and yields the next UTC occurrence; every: a fixed
  // PeriodicTimer interval.
  const loop =
    ts.cadence.kind === "cron"
      ? `        var cron = Cronos.CronExpression.Parse(${JSON.stringify(ts.cadence.cron)});
        while (!stoppingToken.IsCancellationRequested)
        {
            var next = cron.GetNextOccurrence(DateTime.UtcNow, TimeZoneInfo.Utc);
            if (next is null) break;
            var delay = next.Value - DateTime.UtcNow;
            if (delay > TimeSpan.Zero)
            {
                try { await Task.Delay(delay, stoppingToken); }
                catch (OperationCanceledException) { break; }
            }
            await TickAsync(stoppingToken);
        }`
      : `        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(${ts.cadence.everyMs}));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await TickAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) { }`;

  return `/// <summary>timerSource ${ts.name} { for: ${ts.event}, ${
    ts.cadence.kind === "cron"
      ? `cron: ${JSON.stringify(ts.cadence.cron)}`
      : `every: ${ts.cadence.everyMs}ms`
  } }.  Single-fire across replicas via a transaction-scoped advisory lock;
/// dispatches the tick through the in-process dispatcher the sagas ride.</summary>
public sealed class ${cls} : BackgroundService
{
    // FNV-1a hash of the timer name into a signed 32-bit int (identical to the
    // Hono key derivation) — two replicas contend on the SAME advisory key.
    private const int LockKey = ${lockKey};

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<${cls}> _log;
    // In-process no-overlap guard: a tick that overlaps a slow body on THIS
    // replica is skipped (not queued), mirroring the Hono \`running\` flag.
    private int _running;

    public ${cls}(IServiceScopeFactory scopes, ILogger<${cls}> log)
    {
        _scopes = scopes;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
${loop}
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
            // connection and released automatically on commit — so there is no
            // manual unlock to leak onto a different pooled connection (a plain
            // session-level pg_advisory_lock + pool would).  pg_try_advisory_xact_lock
            // is non-blocking: a peer replica's concurrent tick fails the try
            // and skips.
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
 * timers.  `eventByName` resolves each timer's `for:` event to its declared
 * field shape (for the tick struct).
 */
export function renderTimerScheduler(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  ns: string,
): string {
  const services = timers.map((ts) => renderTimerService(ts, eventByName)).join("\n\n");
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

${services}
`;
}

/** The FULLY-QUALIFIED hosted-service type names Program.cs registers, one per
 *  owned timer (`AddHostedService<…>()`).  FQNs so Program.cs needs no extra
 *  `using` for the scheduling namespace. */
export function timerServiceFqns(timers: readonly TimerSourceIR[], ns: string): string[] {
  return timers.map((ts) => `${ns}.Infrastructure.Scheduling.${upperFirst(ts.name)}TimerService`);
}
