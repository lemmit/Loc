import type { EventIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import type { BrokerBinding } from "../../_channels/bindings.js";

// ---------------------------------------------------------------------------
// `Infrastructure/Channels/ChannelTransport.cs` — the broker transport module
// (M-T4.4 slice 6a, the .NET leg of the Hono reference driver in
// `src/generator/typescript/emit/channels.ts`).  Emitted only when the
// deployable wires a redis-bound `broadcast`/`ephemeral` channelSource via
// `channels:`; channel-less projects stay byte-identical.
//
// Carries the CloudEvents 1.0 envelope (same field pin —
// `src/util/channels.ts`), a per-event codec over the DSL field names (wire
// parity with the Hono/Python drivers: datetimes as ISO-8601 round-trip
// strings, money as decimal strings, ids as their string form), the
// `IChannelTransport` seam, the StackExchange.Redis pub/sub driver (MIT —
// design §6a), the publish-tee dispatcher decorator enforcing the §4
// delivery-uniformity rule, and — where a hosted reactor subscribes — the
// consumer `BackgroundService` dispatching received envelopes into the same
// Mediator in-process dispatch local reactors use.
// ---------------------------------------------------------------------------

function uniqueBindings(bindings: BrokerBinding[]): BrokerBinding[] {
  const seen = new Set<string>();
  return bindings.filter((b) => {
    if (seen.has(b.csName)) return false;
    seen.add(b.csName);
    return true;
  });
}

/** C# expression serialising one event property into its envelope-data value
 *  (DSL-keyed JSON; parity with the Hono/Python codecs). */
function toDataExpr(prop: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  const access = t.kind === "optional" ? `${prop}?` : prop;
  if (inner.kind === "primitive" && inner.name === "datetime") return `${access}.ToString("o")`;
  if (inner.kind === "primitive" && inner.name === "money")
    return `${access}.ToString(CultureInfo.InvariantCulture)`;
  if (inner.kind === "id") return `${access}.ToString()`;
  if (inner.kind === "enum") return `${access}.ToString()`;
  return prop;
}

/** C# expression reconstructing one event property from `data.GetProperty(...)`. */
function fromDataExpr(name: string, t: TypeIR, idValueTypeOf: (target: string) => string): string {
  const get = `data.GetProperty(${JSON.stringify(name)})`;
  const inner = t.kind === "optional" ? t.inner : t;
  switch (inner.kind) {
    case "primitive":
      switch (inner.name) {
        case "int":
          return `${get}.GetInt32()`;
        case "long":
          return `${get}.GetInt64()`;
        case "bool":
          return `${get}.GetBoolean()`;
        case "decimal":
          return `${get}.GetDecimal()`;
        case "money":
          return `decimal.Parse(${get}.GetString()!, CultureInfo.InvariantCulture)`;
        case "datetime":
          return `DateTime.Parse(${get}.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)`;
        default:
          return `${get}.GetString()!`;
      }
    case "id": {
      const vt = idValueTypeOf(inner.targetName);
      if (vt === "string") return `new ${inner.targetName}Id(${get}.GetString()!)`;
      if (vt === "int") return `new ${inner.targetName}Id(${get}.GetInt32())`;
      if (vt === "long") return `new ${inner.targetName}Id(${get}.GetInt64())`;
      return `new ${inner.targetName}Id(Guid.Parse(${get}.GetString()!))`;
    }
    case "enum":
      return `Enum.Parse<${inner.name}>(${get}.GetString()!)`;
    default:
      return `${get}.GetString()!`;
  }
}

export function renderDotnetChannels(
  ns: string,
  bindings: BrokerBinding[],
  /** The carried events' IRs (foreign ones already resolved system-wide by
   *  the orchestrator) — drives the envelope (de)serialiser arms. */
  carriedEvents: EventIR[],
  /** True when a hosted workflow reactor subscribes to a carried event —
   *  gates the consumer BackgroundService (a pure producer ships
   *  publish-only). */
  hasChannelConsumers: boolean,
  sys: SystemIR,
  /** Concrete inner dispatcher the tee wraps — the head of today's chain
   *  (Outbox where durable channels exist, InProcess where any reactor
   *  lives, else the Noop). */
  innerDispatcherType = "NoopDomainEventDispatcher",
): string {
  const unique = uniqueBindings(bindings);
  const routing = new Map<string, string>();
  for (const b of unique) {
    for (const ev of b.events) {
      if (!routing.has(ev)) routing.set(ev, b.address);
    }
  }
  const carried = carriedEvents.filter((e) => routing.has(e.name));
  const idValueTypeOf = (target: string): string => {
    for (const sub of sys.subdomains) {
      for (const c of sub.contexts) {
        const agg = c.aggregates.find((a) => a.name === target);
        if (agg) return agg.idValueType;
      }
    }
    return "uuid";
  };
  const toArms = carried
    .map(
      (ev) =>
        `            ${ev.name} e => new Dictionary<string, object?> { ${ev.fields
          .map(
            (f) => `[${JSON.stringify(f.name)}] = ${toDataExpr(`e.${upperFirst(f.name)}`, f.type)}`,
          )
          .join(", ")} },`,
    )
    .join("\n");
  const fromArms = carried
    .map(
      (ev) =>
        `            ${JSON.stringify(ev.name)} => new ${ev.name}(${ev.fields
          .map((f) => fromDataExpr(f.name, f.type, idValueTypeOf))
          .join(", ")}),`,
    )
    .join("\n");
  const bindingLines = unique
    .map(
      (b) =>
        `        new(${JSON.stringify(b.csName)}, ${JSON.stringify(b.address)}, ${JSON.stringify(b.envVar)}, ${JSON.stringify(b.contextName)}),`,
    )
    .join("\n");
  const routingLines = [...routing.entries()]
    .map(([ev, addr]) => `        [${JSON.stringify(ev)}] = ${JSON.stringify(addr)},`)
    .join("\n");

  const consumer = hasChannelConsumers
    ? `
/// <summary>Consumer loop — subscribes every wired address and dispatches
/// received envelopes into the same in-process dispatcher local reactors
/// use, so reactors and event-triggered starters run identically for local
/// and remote events.  Each envelope gets its own DI scope (the dispatcher
/// chain is scoped).</summary>
public sealed class ChannelConsumerService : BackgroundService
{
    private readonly ChannelTransports _transports;
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ChannelConsumerService> _log;

    public ChannelConsumerService(
        ChannelTransports transports,
        IServiceScopeFactory scopes,
        ILogger<ChannelConsumerService> log)
    {
        _transports = transports;
        _scopes = scopes;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        foreach (var binding in ChannelBindings.All)
        {
            var transport = _transports.For(binding.CsName);
            await transport.SubscribeAsync(binding.Address, null, async envelope =>
            {
                try
                {
                    var bare = envelope.Type.Contains('.')
                        ? envelope.Type[(envelope.Type.IndexOf('.') + 1)..]
                        : envelope.Type;
                    var ev = ChannelCodec.FromData(bare, envelope.Data);
                    using var scope = _scopes.CreateScope();
                    var dispatcher = scope.ServiceProvider.GetRequiredService<InProcessDomainEventDispatcher>();
                    await dispatcher.DispatchAsync(ev, stoppingToken);
                    _log.LogInformation("{Event} {Address} {Type} {Id}", "channel_consumed", binding.Address, envelope.Type, envelope.Id);
                }
                catch (Exception ex)
                {
                    _log.LogWarning("{Event} {Address} {Type} {Error}", "channel_consume_failed", binding.Address, envelope.Type, ex.Message);
                }
            });
        }
    }
}
`
    : "";

  return `// Auto-generated.
// Broker transport for the deployable's wired channels (channels.md;
// M-T4.4 design §4-5).  Redis/Valkey pub/sub carries CloudEvents 1.0
// envelopes between deployables; the consumer loop feeds received events
// into the same in-process dispatcher local reactors use.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;
using ${ns}.Domain.Common;
using ${ns}.Domain.Enums;
using ${ns}.Domain.Events;
using ${ns}.Domain.Ids;
using ${ns}.Infrastructure.Events;

namespace ${ns}.Infrastructure.Channels;

/// <summary>CloudEvents 1.0 JSON envelope — the cross-backend wire contract
/// (loom envelope pin, src/util/channels.ts).</summary>
public sealed record LoomEventEnvelope(
    [property: JsonPropertyName("specversion")] string SpecVersion,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("time")] string Time,
    [property: JsonPropertyName("datacontenttype")] string DataContentType,
    [property: JsonPropertyName("loomchannel")] string LoomChannel,
    [property: JsonPropertyName("data")] JsonElement Data);

/// <summary>The publish/subscribe seam every transport implements — the
/// in-process dispatcher, every broker driver, and the realtime relay
/// (M-T1.10) all sit on this contract.  A null group is broadcast; a group
/// name makes replicas competing consumers.</summary>
public interface IChannelTransport
{
    Task PublishAsync(string address, LoomEventEnvelope envelope);
    Task SubscribeAsync(string address, string? group, Func<LoomEventEnvelope, Task> handler);
    Task CloseAsync();
}

/// <summary>Redis (Valkey) driver — pub/sub over StackExchange.Redis.</summary>
public sealed class RedisChannelTransport : IChannelTransport
{
    private readonly Lazy<Task<ConnectionMultiplexer>> _connection;
    private readonly ILogger _log;

    public RedisChannelTransport(string url, ILogger log)
    {
        _log = log;
        // redis://host:port URLs come from LOOM_CHANNEL_*_URL; the client
        // wants host:port configuration strings.
        var config = url.StartsWith("redis://", StringComparison.Ordinal) ? url["redis://".Length..] : url;
        _connection = new(() => ConnectionMultiplexer.ConnectAsync(config));
    }

    public async Task PublishAsync(string address, LoomEventEnvelope envelope)
    {
        var mux = await _connection.Value;
        await mux.GetSubscriber().PublishAsync(
            RedisChannel.Literal(address), JsonSerializer.Serialize(envelope));
    }

    public async Task SubscribeAsync(string address, string? group, Func<LoomEventEnvelope, Task> handler)
    {
        var mux = await _connection.Value;
        await mux.GetSubscriber().SubscribeAsync(RedisChannel.Literal(address), (channel, message) =>
        {
            LoomEventEnvelope? envelope;
            try
            {
                envelope = JsonSerializer.Deserialize<LoomEventEnvelope>(message.ToString());
            }
            catch (JsonException)
            {
                _log.LogWarning("{Event} {Address} {Error}", "channel_consume_failed", address, "malformed envelope");
                return;
            }
            if (envelope is null) return;
            _ = handler(envelope);
        });
    }

    public async Task CloseAsync()
    {
        if (!_connection.IsValueCreated) return;
        var mux = await _connection.Value;
        await mux.CloseAsync();
    }
}

public sealed record ChannelBinding(string CsName, string Address, string EnvVar, string Context);

public static class ChannelBindings
{
    /// <summary>The deployable's wired bindings: broker address per
    /// channelSource, with the connection URL injected by compose/k8s as
    /// LOOM_CHANNEL_&lt;NAME&gt;_URL.</summary>
    public static readonly IReadOnlyList<ChannelBinding> All = new List<ChannelBinding>
    {
${bindingLines}
    };

    /// <summary>event type -&gt; broker address (first carrying broker-bound
    /// channel, mirroring the in-process dispatcher's routing rule).</summary>
    public static readonly IReadOnlyDictionary<string, string> Routing = new Dictionary<string, string>
    {
${routingLines}
    };
}

/// <summary>Per-event envelope-data codec over the DSL field names — wire
/// parity with the Hono/Python drivers.</summary>
public static class ChannelCodec
{
    public static Dictionary<string, object?> ToData(IDomainEvent ev)
        => ev switch
        {
${toArms}
            _ => throw new InvalidOperationException($"event not carried by a wired channel: {ev.GetType().Name}"),
        };

    public static IDomainEvent FromData(string eventType, JsonElement data)
        => eventType switch
        {
${fromArms}
            _ => throw new InvalidOperationException($"unknown carried event type: {eventType}"),
        };
}

/// <summary>One shared transport per broker URL for the process (publisher
/// tee + consumer loop reuse the same connections), keyed by channelSource
/// name.  Registered as a singleton; hosted-service shutdown closes it.</summary>
public sealed class ChannelTransports : IAsyncDisposable
{
    private readonly Dictionary<string, IChannelTransport> _byCsName = new();

    public ChannelTransports(ILogger<ChannelTransports> log)
    {
        var byUrl = new Dictionary<string, IChannelTransport>();
        foreach (var binding in ChannelBindings.All)
        {
            var url = Environment.GetEnvironmentVariable(binding.EnvVar)
                ?? throw new InvalidOperationException(
                    $"channel binding '{binding.CsName}' needs {binding.EnvVar} (the broker URL compose/k8s injects)");
            if (!byUrl.TryGetValue(url, out var transport))
            {
                transport = new RedisChannelTransport(url, log);
                byUrl[url] = transport;
            }
            _byCsName[binding.CsName] = transport;
        }
    }

    public IChannelTransport For(string csName) => _byCsName[csName];

    public async ValueTask DisposeAsync()
    {
        foreach (var transport in _byCsName.Values)
        {
            await transport.CloseAsync();
        }
    }
}

/// <summary>Producer tee — the delivery-uniformity rule (design §4): an
/// event carried by a broker-bound channel is PUBLISHED and not fanned out
/// locally; co-located consumers receive it through their subscription
/// exactly like remote ones.  Everything else passes to the inner
/// dispatcher.</summary>
public sealed class ChannelPublishTeeDispatcher : IDomainEventDispatcher
{
    private static long _counter;
    private readonly ChannelTransports _transports;
    private readonly ${ns}.Infrastructure.Events.${innerDispatcherType} _inner;
    private readonly ILogger<ChannelPublishTeeDispatcher> _log;

    public ChannelPublishTeeDispatcher(
        ChannelTransports transports,
        ${ns}.Infrastructure.Events.${innerDispatcherType} inner,
        ILogger<ChannelPublishTeeDispatcher> log)
    {
        _transports = transports;
        _inner = inner;
        _log = log;
    }

    public async Task DispatchAsync(IDomainEvent ev, CancellationToken cancellationToken = default)
    {
        var type = ev.GetType().Name;
        if (!ChannelBindings.Routing.TryGetValue(type, out var address))
        {
            await _inner.DispatchAsync(ev, cancellationToken);
            return;
        }
        ChannelBinding? bound = null;
        foreach (var b in ChannelBindings.All)
        {
            if (b.Address == address) { bound = b; break; }
        }
        if (bound is null)
        {
            throw new InvalidOperationException($"no transport wired for channel address {address}");
        }
        var id = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{Environment.ProcessId:x}-{Interlocked.Increment(ref _counter):x}";
        var data = JsonSerializer.SerializeToElement(ChannelCodec.ToData(ev));
        var envelope = new LoomEventEnvelope(
            "1.0", id, $"{bound.Context}.{type}", $"/loom/{bound.Context}",
            DateTime.UtcNow.ToString("o"), "application/json", address, data);
        await _transports.For(bound.CsName).PublishAsync(address, envelope);
        _log.LogInformation("{Event} {Address} {Type} {Id}", "channel_published", address, type, id);
    }
}
${consumer}`;
}
