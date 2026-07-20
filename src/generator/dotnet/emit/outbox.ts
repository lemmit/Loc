// Transactional-outbox tier (dispatch-delivery-semantics.md), .NET slice.
//
// A channel with `retention: log | work` makes its carried events durable:
// the OutboxDomainEventDispatcher records them in the shared `__loom_outbox`
// table (one EF entity mapped onto the MigrationsIR-owned table) instead of
// publishing inline, and the OutboxRelayService BackgroundService drains
// undispatched rows through the in-process Mediator dispatcher —
// at-least-once, dead-lettering after MaxAttempts via the catalog's
// `event_dead_lettered`.  Ephemeral channels keep the inline at-most-once
// path byte-identically.

/** The EF entity + configuration mapped onto `__loom_outbox` (the table
 *  itself ships via the shared MigrationsIR — EF only maps it). */
export function renderOutboxMessage(ns: string): string {
  return `// Auto-generated.
using System;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace ${ns}.Infrastructure.Persistence;

/// <summary>One owed durable event (dispatch-delivery-semantics.md): written
/// by OutboxDomainEventDispatcher, drained by OutboxRelayService.</summary>
public sealed class OutboxMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public DateTime OccurredAt { get; set; } = DateTime.UtcNow;
    public string Type { get; set; } = "";
    public string Payload { get; set; } = "";
    public DateTime? DispatchedAt { get; set; }
    public int Attempts { get; set; }
}

public sealed class OutboxMessageConfiguration : IEntityTypeConfiguration<OutboxMessage>
{
    public void Configure(EntityTypeBuilder<OutboxMessage> builder)
    {
        builder.ToTable("__loom_outbox");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).HasColumnName("id");
        builder.Property(x => x.OccurredAt).HasColumnName("occurred_at");
        builder.Property(x => x.Type).HasColumnName("type");
        builder.Property(x => x.Payload).HasColumnName("payload").HasColumnType("jsonb");
        builder.Property(x => x.DispatchedAt).HasColumnName("dispatched_at");
        builder.Property(x => x.Attempts).HasColumnName("attempts");
    }
}
`;
}

/** The outbox-recording dispatcher: durable events INSERT into the outbox
 *  (the relay delivers); everything else delegates to the inner dispatcher —
 *  the in-process Mediator one where reactors live, the Noop in the
 *  workflow-less durable-broker producer shape (M-T4.4 slice 7b). */
export function renderOutboxDispatcher(
  ns: string,
  durableTypes: readonly string[],
  inner = "InProcessDomainEventDispatcher",
): string {
  const set = durableTypes.map((t) => `"${t}"`).join(", ");
  return `// Auto-generated.
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Infrastructure.Events;

/// <summary>Records durable events (channels with retention: log | work) in
/// the __loom_outbox table instead of dispatching inline; the
/// OutboxRelayService delivers them at-least-once.  Ephemeral events
/// delegate to the inner dispatcher unchanged.</summary>
public sealed class OutboxDomainEventDispatcher : IDomainEventDispatcher
{
    private static readonly HashSet<string> DurableEventTypes = new() { ${set} };
    private readonly AppDbContext _db;
    private readonly ${inner} _inner;

    public OutboxDomainEventDispatcher(AppDbContext db, ${inner} inner)
    {
        _db = db;
        _inner = inner;
    }

    public async Task DispatchAsync(IDomainEvent ev, CancellationToken cancellationToken = default)
    {
        var type = ev.GetType().Name;
        if (DurableEventTypes.Contains(type))
        {
            _db.LoomOutbox.Add(new OutboxMessage
            {
                Type = type,
                Payload = JsonSerializer.Serialize((object)ev),
            });
            await _db.SaveChangesAsync(cancellationToken);
            return; // the relay delivers
        }
        await _inner.DispatchAsync(ev, cancellationToken);
    }
}
`;
}

/** The AsyncLocal carrier for the in-flight outbox row id — set by the
 *  relay around each dispatch so saga handlers' idempotent-consumer
 *  markers (dispatch-delivery-semantics.md §3) can compare/stamp
 *  `LastEventId` without widening the event records. */
export function renderOutboxDelivery(ns: string): string {
  return `// Auto-generated.
using System.Threading;

namespace ${ns}.Domain.Common;

/// <summary>Ambient outbox-delivery context: the id of the outbox row being
/// relayed, or null for inline (ephemeral) dispatch.  Saga handlers no-op
/// when their state row already records this id (idempotent consumer —
/// at-least-once becomes effectively-once).</summary>
public static class OutboxDelivery
{
    private static readonly AsyncLocal<string?> _currentEventId = new();

    public static string? CurrentEventId
    {
        get => _currentEventId.Value;
        set => _currentEventId.Value = value;
    }
}
`;
}

/** The polling relay: a BackgroundService draining undispatched outbox rows
 *  (ordered by occurred_at) through the in-process dispatcher; failures bump
 *  `attempts` and dead-letter (log only — the row stays) after MaxAttempts.
 *
 *  `durableBroker` (M-T4.4 slice 7b, design §5): drained rows whose channel
 *  is broker-bound publish via `ChannelRelayPublisher` (envelope id = row
 *  id) instead of redelivering locally.  `hasSubscriptions: false` is the
 *  workflow-less durable-broker producer — there is no in-process dispatcher
 *  to fall back to, so unpublishable rows simply complete. */
export function renderOutboxRelay(
  ns: string,
  durableTypes: readonly string[],
  opts: { durableBroker: boolean; hasSubscriptions: boolean } = {
    durableBroker: false,
    hasSubscriptions: true,
  },
): string {
  const arms = durableTypes
    .map((t) => `            "${t}" => JsonSerializer.Deserialize<${t}>(payload),`)
    .join("\n");
  const channelsUsing = opts.durableBroker ? `using ${ns}.Infrastructure.Channels;\n` : "";
  const transportsField = opts.durableBroker
    ? "\n    private readonly ChannelTransports _transports;"
    : "";
  const ctorParams = opts.durableBroker
    ? `IServiceScopeFactory scopes, ChannelTransports transports, ILogger<OutboxRelayService> log`
    : `IServiceScopeFactory scopes, ILogger<OutboxRelayService> log`;
  const ctorAssign = opts.durableBroker ? "\n        _transports = transports;" : "";
  const innerResolve = opts.hasSubscriptions
    ? "\n        var inner = scope.ServiceProvider.GetRequiredService<InProcessDomainEventDispatcher>();"
    : "";
  const localDispatch = `// The row id rides on an AsyncLocal so saga handlers'
                // idempotent-consumer markers can no-op on redelivery
                // (dispatch-delivery-semantics.md §3).
                OutboxDelivery.CurrentEventId = row.Id.ToString();
                try
                {
                    if (ev is not null) await inner.DispatchAsync(ev, cancellationToken);
                }
                finally
                {
                    OutboxDelivery.CurrentEventId = null;
                }`;
  const dispatchBlock = opts.durableBroker
    ? opts.hasSubscriptions
      ? `// Design §5: a broker-bound durable row publishes on drain (the
                // envelope carries the row id — the consumer-side idempotency
                // key); the rest redeliver through the local dispatcher.
                if (ev is null || !await ChannelRelayPublisher.TryPublishAsync(_transports, ev, row.Id.ToString(), _log))
                {
                    ${localDispatch.split("\n").join("\n    ")}
                }`
      : `// Design §5: broker-bound durable rows publish on drain (the
                // envelope carries the row id — the consumer-side idempotency
                // key).  A non-broker durable row has no subscriber in this
                // shape; either way the row completes.
                if (ev is not null)
                {
                    await ChannelRelayPublisher.TryPublishAsync(_transports, ev, row.Id.ToString(), _log);
                }`
    : localDispatch;
  return `// Auto-generated.
using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;
${channelsUsing}using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Infrastructure.Events;

/// <summary>Drains __loom_outbox at-least-once — consumers must tolerate
/// redelivery.  Rows that exhaust MaxAttempts stay in the table and log
/// event_dead_lettered once.</summary>
public sealed class OutboxRelayService : BackgroundService
{
    private const int MaxAttempts = 5;
    private const int BatchSize = 50;
    private static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(500);

    private readonly IServiceScopeFactory _scopes;${transportsField}
    private readonly ILogger<OutboxRelayService> _log;

    public OutboxRelayService(${ctorParams})
    {
        _scopes = scopes;${ctorAssign}
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await DrainAsync(stoppingToken);
                await Task.Delay(Interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task DrainAsync(CancellationToken cancellationToken)
    {
        await using var scope = _scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();${innerResolve}
        var rows = await db.LoomOutbox
            .Where(m => m.DispatchedAt == null && m.Attempts < MaxAttempts)
            .OrderBy(m => m.OccurredAt)
            .Take(BatchSize)
            .ToListAsync(cancellationToken);
        foreach (var row in rows)
        {
            try
            {
                var ev = Deserialize(row.Type, row.Payload);
                ${dispatchBlock}
                row.DispatchedAt = DateTime.UtcNow;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                row.Attempts++;
                if (row.Attempts >= MaxAttempts)
                {
                    _log.LogWarning("{Event} type={Type} attempts={Attempts} error={Error}", "event_dead_lettered", row.Type, row.Attempts, ex.Message);
                }
            }
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    private static IDomainEvent? Deserialize(string type, string payload) =>
        type switch
        {
${arms}
            _ => null,
        };
}
`;
}
