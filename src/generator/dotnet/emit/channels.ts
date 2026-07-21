import type { EventIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import type { BrokerBinding } from "../../_channels/bindings.js";

// ---------------------------------------------------------------------------
// `Infrastructure/Channels/ChannelTransport.cs` — the broker transport module
// (M-T4.4 slices 6a + 7b, the .NET leg of the Hono reference driver in
// `src/generator/typescript/emit/channels.ts`).  Emitted only when the
// deployable wires a broker-bound channelSource via `channels:`;
// channel-less projects stay byte-identical.
//
// Carries the CloudEvents 1.0 envelope (same field pin —
// `src/util/channels.ts`), a per-event codec over the DSL field names (wire
// parity with the Hono/Python drivers: datetimes as ISO-8601 round-trip
// strings, money as decimal strings, ids as their string form), the
// `IChannelTransport` seam, the StackExchange.Redis pub/sub driver (MIT —
// design §6a; `broadcast`/`ephemeral`), the RabbitMQ.Client driver
// (Apache-2.0 — §6a; `queue`/`ephemeral`+`work`, design §4 topology: durable
// fanout exchange per address, one durable queue per consuming deployable so
// replicas compete, manual ack → bounded retry → DLX `loom.dlx` →
// `loom.dlq.<address>` parking), the publish-tee dispatcher decorator
// enforcing the §4 delivery-uniformity rule, and — where a hosted reactor
// subscribes — the consumer `BackgroundService` dispatching received
// envelopes into the same Mediator in-process dispatch local reactors use.
//
// Producer path split (design §5): the tee publishes EPHEMERAL broker-routed
// events inline; DURABLE (`work`) events pass through to the outbox
// dispatcher and are published by the relay on drain via
// `ChannelRelayPublisher`, with the outbox row id as the envelope id — the
// stable consumer-side idempotency key across broker redeliveries.
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
  /** M-T4.4 slice 7b knobs.  `hasOutbox`: the outbox tier exists on THIS
   *  deployable (the `OutboxDelivery` marker class is emitted), so the
   *  consumer stamps each envelope id for the saga handlers' idempotent
   *  no-op.  `durableBroker`: hosted durable events ride a broker-bound
   *  `queue`/`work` channel — emit the `ChannelRelayPublisher` the outbox
   *  relay publishes through (design §5). */
  opts: { hasOutbox: boolean; durableBroker: boolean } = { hasOutbox: false, durableBroker: false },
): string {
  const unique = uniqueBindings(bindings);
  const hasRedis = unique.some((b) => b.transport === "redis");
  const hasRabbit = unique.some((b) => b.transport === "rabbitmq");
  const hasKafka = unique.some((b) => b.transport === "kafka");
  // event type -> address, split by durability (design §5): ephemeral events
  // publish inline in the tee; durable (`work`) events ride the outbox relay.
  // First-by-declaration within each tier, mirroring the in-process
  // dispatcher's routing rule.
  const ephemeralRouting = new Map<string, string>();
  const durableRouting = new Map<string, string>();
  for (const b of unique) {
    const target = b.retention === "ephemeral" ? ephemeralRouting : durableRouting;
    for (const ev of b.events) {
      if (!target.has(ev)) target.set(ev, b.address);
    }
  }
  const routed = new Set([...ephemeralRouting.keys(), ...durableRouting.keys()]);
  const carried = carriedEvents.filter((e) => routed.has(e.name));
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
        `        new(${JSON.stringify(b.csName)}, ${JSON.stringify(b.address)}, ${JSON.stringify(b.envVar)}, ${JSON.stringify(b.contextName)}, ${JSON.stringify(b.transport)}, ${JSON.stringify(b.group)}, ${b.delivery === "queue"}${hasKafka ? `, ${b.key === undefined ? "null" : JSON.stringify(b.key)}` : ""}),`,
    )
    .join("\n");
  const routingLines = [...ephemeralRouting.entries()]
    .map(([ev, addr]) => `        [${JSON.stringify(ev)}] = ${JSON.stringify(addr)},`)
    .join("\n");
  const durableRoutingLines = [...durableRouting.entries()]
    .map(([ev, addr]) => `        [${JSON.stringify(ev)}] = ${JSON.stringify(addr)},`)
    .join("\n");

  // Fixed kafka -> rabbitmq -> redis order; the last wired driver is the
  // fallback arm, so pre-kafka outputs stay byte-identical.
  const transportCtors: [string, string][] = [];
  if (hasKafka) transportCtors.push(["kafka", "new KafkaChannelTransport(url, log)"]);
  if (hasRabbit) transportCtors.push(["rabbitmq", "new RabbitChannelTransport(url, log)"]);
  if (hasRedis) transportCtors.push(["redis", "new RedisChannelTransport(url, log)"]);
  const lastCtor = transportCtors[transportCtors.length - 1];
  if (!lastCtor) throw new Error("renderDotnetChannels called with no wired broker transport");
  const newTransportExpr =
    transportCtors.length === 1
      ? lastCtor[1]
      : transportCtors
          .slice(0, -1)
          .map(
            ([t, ctor]) =>
              `binding.Transport == ${JSON.stringify(t)}\n                    ? ${ctor}\n                    : `,
          )
          .join("") + lastCtor[1];

  const redisDriver = hasRedis
    ? `
/// <summary>Redis (Valkey) driver — pub/sub over StackExchange.Redis.</summary>
public sealed class RedisChannelTransport : IChannelTransport
{
    private readonly Lazy<Task<ConnectionMultiplexer>> _connection;
    private readonly ILogger _log;

    public RedisChannelTransport(string url, ILogger log)
    {
        _log = log;
        // redis://[:pass@]host:port URLs come from LOOM_CHANNEL_*_URL; the
        // client wants host:port configuration strings, with the requirepass
        // credential (M-T4.4 \u00a77) as a password= option.
        var config = url.StartsWith("redis://", StringComparison.Ordinal) ? url["redis://".Length..] : url;
        var at = config.LastIndexOf('@');
        if (at >= 0)
        {
            var userinfo = config[..at];
            var pass = userinfo.StartsWith(':') ? userinfo[1..] : userinfo[(userinfo.IndexOf(':') + 1)..];
            config = $"{config[(at + 1)..]},password={Uri.UnescapeDataString(pass)}";
        }
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
`
    : "";

  const rabbitDriver = hasRabbit
    ? `
/// <summary>RabbitMQ driver — RabbitMQ.Client over AMQP 0-9-1 (design §4
/// topology): a durable fanout exchange per channel address; one durable
/// queue per consuming deployable (the consumer group) so replicas compete;
/// manual ack; a failed handler republishes with an attempt header up to
/// MaxAttempts, then parks via DLX <c>loom.dlx</c> into
/// <c>loom.dlq.&lt;address&gt;</c>.</summary>
public sealed class RabbitChannelTransport : IChannelTransport, IDisposable
{
    /// <summary>Bounded per-message retries before a poisoned message parks
    /// in the DLQ (mirrors the outbox relay's MaxAttempts).</summary>
    private const int MaxAttempts = 5;

    private readonly string _url;
    private readonly ILogger _log;
    private readonly SemaphoreSlim _connect = new(1, 1);
    private IConnection? _connection;
    private IChannel? _channel;

    public RabbitChannelTransport(string url, ILogger log)
    {
        _url = url;
        _log = log;
    }

    /// <summary>Process-lifetime transport (held by the ChannelTransports
    /// singleton); Dispose runs at host shutdown — release the connect gate
    /// and drop the channel/connection (CA1001).</summary>
    public void Dispose()
    {
        _connect.Dispose();
        _channel?.Dispose();
        _connection?.Dispose();
    }

    private async Task<IChannel> ChannelAsync()
    {
        await _connect.WaitAsync();
        try
        {
            _connection ??= await new ConnectionFactory { Uri = new Uri(_url) }.CreateConnectionAsync();
            if (_channel is null)
            {
                _channel = await _connection.CreateChannelAsync();
                await _channel.BasicQosAsync(0, 1, false);
            }
            return _channel;
        }
        finally
        {
            _connect.Release();
        }
    }

    public async Task PublishAsync(string address, LoomEventEnvelope envelope)
    {
        var ch = await ChannelAsync();
        await ch.ExchangeDeclareAsync(address, ExchangeType.Fanout, durable: true);
        var props = new BasicProperties
        {
            ContentType = "application/json",
            DeliveryMode = DeliveryModes.Persistent,
        };
        await ch.BasicPublishAsync(address, "", mandatory: false, props,
            new ReadOnlyMemory<byte>(JsonSerializer.SerializeToUtf8Bytes(envelope)));
    }

    public async Task SubscribeAsync(string address, string? group, Func<LoomEventEnvelope, Task> handler)
    {
        // The queue name IS the consumer group: replicas of one deployable
        // share it and compete; other deployables bind their own queue to the
        // same exchange (fan-out across deployables, one-of-N within).
        var queue = group ?? address;
        var ch = await ChannelAsync();
        await ch.ExchangeDeclareAsync(address, ExchangeType.Fanout, durable: true);
        await ch.ExchangeDeclareAsync("loom.dlx", ExchangeType.Direct, durable: true);
        var dlq = $"loom.dlq.{address}";
        await ch.QueueDeclareAsync(dlq, durable: true, exclusive: false, autoDelete: false);
        await ch.QueueBindAsync(dlq, "loom.dlx", address);
        await ch.QueueDeclareAsync(queue, durable: true, exclusive: false, autoDelete: false,
            arguments: new Dictionary<string, object?>
            {
                ["x-dead-letter-exchange"] = "loom.dlx",
                ["x-dead-letter-routing-key"] = address,
            });
        await ch.QueueBindAsync(queue, address, "");
        var consumer = new AsyncEventingBasicConsumer(ch);
        consumer.ReceivedAsync += async (_, ea) =>
        {
            LoomEventEnvelope? envelope;
            try
            {
                envelope = JsonSerializer.Deserialize<LoomEventEnvelope>(ea.Body.Span);
            }
            catch (JsonException)
            {
                envelope = null;
            }
            if (envelope is null)
            {
                // Malformed body: no retry can fix it — nack without requeue
                // routes through the queue's DLX into loom.dlq.<address>.
                await ch.BasicNackAsync(ea.DeliveryTag, false, requeue: false);
                _log.LogWarning("{Event} {Address} {Error}", "channel_dead_lettered", address, "malformed envelope");
                return;
            }
            try
            {
                await handler(envelope);
                await ch.BasicAckAsync(ea.DeliveryTag, false);
            }
            catch (Exception ex)
            {
                var attempts = 1;
                if (ea.BasicProperties.Headers is { } headers
                    && headers.TryGetValue("x-loom-attempts", out var raw))
                {
                    attempts = Convert.ToInt32(raw, CultureInfo.InvariantCulture) + 1;
                }
                if (attempts >= MaxAttempts)
                {
                    // Parked, not lost: the DLX routes it into loom.dlq.<address>.
                    await ch.BasicNackAsync(ea.DeliveryTag, false, requeue: false);
                    _log.LogWarning("{Event} {Address} {Type} {Id} attempts={Attempts} error={Error}",
                        "channel_dead_lettered", address, envelope.Type, envelope.Id, attempts, ex.Message);
                }
                else
                {
                    // Bounded retry: republish with the attempt header and ack
                    // the original (immediate nack-requeue would hot-loop).
                    var retry = new BasicProperties
                    {
                        ContentType = "application/json",
                        DeliveryMode = DeliveryModes.Persistent,
                        Headers = new Dictionary<string, object?> { ["x-loom-attempts"] = attempts },
                    };
                    await ch.BasicPublishAsync("", queue, mandatory: false, retry, ea.Body);
                    await ch.BasicAckAsync(ea.DeliveryTag, false);
                }
            }
        };
        await ch.BasicConsumeAsync(queue, autoAck: false, consumer);
    }

    public async Task CloseAsync()
    {
        if (_channel is not null) await _channel.CloseAsync();
        if (_connection is not null) await _connection.CloseAsync();
    }
}
`
    : "";

  const relayPublisher = opts.durableBroker
    ? `
/// <summary>Design §5, the relay half of the producer split: a drained
/// durable outbox row whose channel is broker-bound publishes here, carrying
/// its outbox row id as the envelope id (the consumer-side idempotency key).
/// Rows on non-broker durable channels return false and stay on the local
/// redelivery path.</summary>
public static class ChannelRelayPublisher
{
    public static async Task<bool> TryPublishAsync(
        ChannelTransports transports, IDomainEvent ev, string eventId, ILogger log)
    {
        var type = ev.GetType().Name;
        if (!ChannelBindings.DurableRouting.TryGetValue(type, out var address)) return false;
        var envelope = ChannelEnvelopes.For(ev, type, address, eventId);
        await transports.ForAddress(address).PublishAsync(address, envelope);
        log.LogInformation("{Event} {Address} {Type} {Id}", "channel_published", address, type, eventId);
        return true;
    }
}
`
    : "";

  const kafkaDriver = hasKafka
    ? `
/// <summary>Kafka driver — Confluent.Kafka over the log (design §4
/// topology): one topic per channel address (idempotently admin-created
/// before the group join); per-partition ordering with partition key =
/// loomkey ?? envelope id; consumption always rides the deployable's
/// consumer GROUP (broadcast across deployables, competing within).
/// Offsets commit after the handler resolves.  Dead-letter v1: a failed or
/// malformed record parks onto &lt;address&gt;.dlq and the offset advances —
/// logged and kept, never a hot-loop.</summary>
public sealed class KafkaChannelTransport : IChannelTransport, IDisposable
{
    private readonly string _bootstrap;
    private readonly ILogger _log;
    private readonly Lazy<IProducer<string, string>> _producer;
    private readonly List<Task> _loops = new();
    private readonly CancellationTokenSource _stopping = new();
    private readonly string? _saslUser;
    private readonly string? _saslPass;

    private T ApplySasl<T>(T config) where T : ClientConfig
    {
        if (_saslUser is null) return config;
        config.SecurityProtocol = SecurityProtocol.SaslPlaintext;
        config.SaslMechanism = SaslMechanism.Plain;
        config.SaslUsername = _saslUser;
        config.SaslPassword = _saslPass;
        return config;
    }

    public KafkaChannelTransport(string url, ILogger log)
    {
        _log = log;
        // kafka://user:pass@host:port[,host2] — userinfo (when present)
        // becomes SASL/PLAIN (M-T4.4 §7); a credential-less URL stays on
        // PLAINTEXT, the pre-auth contract.
        var bare = url.StartsWith("kafka://", StringComparison.Ordinal) ? url["kafka://".Length..] : url;
        var at = bare.LastIndexOf('@');
        if (at >= 0)
        {
            var userinfo = bare[..at];
            var colon = userinfo.IndexOf(':');
            _saslUser = Uri.UnescapeDataString(colon >= 0 ? userinfo[..colon] : userinfo);
            _saslPass = Uri.UnescapeDataString(colon >= 0 ? userinfo[(colon + 1)..] : "");
        }
        _bootstrap = at >= 0 ? bare[(at + 1)..] : bare;
        _producer = new(() =>
            new ProducerBuilder<string, string>(ApplySasl(new ProducerConfig { BootstrapServers = _bootstrap })).Build());
    }

    private async Task EnsureTopicAsync(string topic)
    {
        // Subscribing to a not-yet-produced topic stalls the group join;
        // idempotently create it (3 partitions / rf 1 — the compose
        // sidecar's defaults; an existing topic keeps its own shape).
        using var admin = new AdminClientBuilder(ApplySasl(new AdminClientConfig { BootstrapServers = _bootstrap })).Build();
        try
        {
            await admin.CreateTopicsAsync(new[]
            {
                new TopicSpecification { Name = topic, NumPartitions = 3, ReplicationFactor = 1 },
            });
        }
        catch (CreateTopicsException ex) when (ex.Results.TrueForAll(
            r => r.Error.Code == ErrorCode.TopicAlreadyExists))
        {
            // Already there — the idempotent path.
        }
    }

    public async Task PublishAsync(string address, LoomEventEnvelope envelope)
    {
        var key = envelope.LoomKey ?? envelope.Id;
        await _producer.Value.ProduceAsync(address, new Message<string, string>
        {
            Key = key,
            Value = JsonSerializer.Serialize(envelope),
        });
    }

    public async Task SubscribeAsync(string address, string? group, Func<LoomEventEnvelope, Task> handler)
    {
        await EnsureTopicAsync(address);
        var consumer = new ConsumerBuilder<string, string>(ApplySasl(new ConsumerConfig
        {
            BootstrapServers = _bootstrap,
            GroupId = group ?? address,
            EnableAutoCommit = false,
            AutoOffsetReset = AutoOffsetReset.Latest,
        })).Build();
        consumer.Subscribe(address);
        _loops.Add(Task.Run(async () =>
        {
            while (!_stopping.IsCancellationRequested)
            {
                ConsumeResult<string, string> result;
                try
                {
                    result = consumer.Consume(_stopping.Token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                LoomEventEnvelope? envelope = null;
                try
                {
                    envelope = JsonSerializer.Deserialize<LoomEventEnvelope>(result.Message.Value);
                }
                catch (JsonException)
                {
                    // Malformed record: park + advance (v1 log + park).
                }
                if (envelope is null)
                {
                    await ParkAsync(address, result.Message);
                    _log.LogWarning("{Event} {Address} {Error}", "channel_dead_lettered", address, "malformed envelope");
                }
                else
                {
                    try
                    {
                        await handler(envelope);
                    }
                    catch (Exception ex)
                    {
                        // v1 log + park: keep the partition moving (a raw retry
                        // would stall every record behind the poisoned one).
                        await ParkAsync(address, result.Message);
                        _log.LogWarning("{Event} {Address} {Type} {Id} {Error}", "channel_dead_lettered", address, envelope.Type, envelope.Id, ex.Message);
                    }
                }
                // Offset commits after the handler resolved (or the record
                // parked) — at-least-once with the envelope id as the
                // consumer-side dedup key.
                consumer.Commit(result);
            }
            consumer.Close();
        }));
    }

    private async Task ParkAsync(string address, Message<string, string> message)
    {
        await _producer.Value.ProduceAsync($"{address}.dlq", new Message<string, string>
        {
            Key = message.Key,
            Value = message.Value,
        });
    }

    public async Task CloseAsync()
    {
        _stopping.Cancel();
        await Task.WhenAll(_loops);
        if (_producer.IsValueCreated) _producer.Value.Dispose();
    }

    // CA1001 (the disposal path already downcasts after CloseAsync): the
    // cancellation source is the one field CloseAsync doesn't release.
    public void Dispose() => _stopping.Dispose();
}
`
    : "";

  const consumerMarkedDispatch = opts.hasOutbox
    ? `        // The envelope id rides in as the idempotency marker: saga rows
        // stamped with it no-op on broker redelivery (design §5).
        OutboxDelivery.CurrentEventId = envelope.Id;
        try
        {
            await dispatcher.DispatchAsync(ev, cancellationToken);
        }
        finally
        {
            OutboxDelivery.CurrentEventId = null;
        }`
    : "        await dispatcher.DispatchAsync(ev, cancellationToken);";

  // Queue (rabbit) subscriptions get the STRICT handler — a failed dispatch
  // must propagate so the driver's bounded-retry/park owns it.  Broadcast
  // (redis) subscriptions keep the logged handler (fire-and-forget contract).
  const strictSubscribe = `await transport.SubscribeAsync(binding.Address, binding.Group,
                    envelope => ConsumeAsync(binding, envelope, stoppingToken));`;
  const loggedSubscribe = `await transport.SubscribeAsync(binding.Address, null, async envelope =>
                {
                    try
                    {
                        await ConsumeAsync(binding, envelope, stoppingToken);
                    }
                    catch (Exception ex)
                    {
                        _log.LogWarning("{Event} {Address} {Type} {Error}", "channel_consume_failed", binding.Address, envelope.Type, ex.Message);
                    }
                });`;
  const subscribeBody = hasKafka
    ? `if (binding.Queue || binding.Transport == "kafka")
            {
                ${strictSubscribe}
            }
            else
            {
                ${loggedSubscribe}
            }`
    : hasRedis && hasRabbit
      ? `if (binding.Queue)
            {
                ${strictSubscribe}
            }
            else
            {
                ${loggedSubscribe}
            }`
      : hasRabbit
        ? strictSubscribe
        : loggedSubscribe;

  const consumer = hasChannelConsumers
    ? `
/// <summary>Consumer loop — subscribes every wired address (competing-consumer
/// group on queue channels, broadcast otherwise) and dispatches received
/// envelopes into the same in-process dispatcher local reactors use, so
/// reactors and event-triggered starters run identically for local and
/// remote events.  Each envelope gets its own DI scope (the dispatcher
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
            ${subscribeBody}
        }
    }

    private async Task ConsumeAsync(ChannelBinding binding, LoomEventEnvelope envelope, CancellationToken cancellationToken)
    {
        var bare = envelope.Type.Contains('.')
            ? envelope.Type[(envelope.Type.IndexOf('.') + 1)..]
            : envelope.Type;
        var ev = ChannelCodec.FromData(bare, envelope.Data);
        using var scope = _scopes.CreateScope();
        var dispatcher = scope.ServiceProvider.GetRequiredService<InProcessDomainEventDispatcher>();
${consumerMarkedDispatch}
        ${
          hasKafka
            ? `_log.LogInformation("{Event} {Address} {Type} {Id} {Key}", "channel_consumed", binding.Address, envelope.Type, envelope.Id, envelope.LoomKey);`
            : `_log.LogInformation("{Event} {Address} {Type} {Id}", "channel_consumed", binding.Address, envelope.Type, envelope.Id);`
        }
    }
}
`
    : "";

  return `// Auto-generated.
// Broker transport for the deployable's wired channels (channels.md;
// M-T4.4 design §4-5).  CloudEvents 1.0 envelopes between deployables; the
// consumer loop feeds received events into the same in-process dispatcher
// local reactors use.  Ephemeral events publish inline in the tee; durable
// (work) events ride the outbox relay (design §5).
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
${hasKafka ? "using Confluent.Kafka;\nusing Confluent.Kafka.Admin;\n" : ""}${hasRabbit ? "using RabbitMQ.Client;\nusing RabbitMQ.Client.Events;\n" : ""}${hasRedis ? "using StackExchange.Redis;\n" : ""}using ${ns}.Domain.Common;
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
    [property: JsonPropertyName("loomchannel")] string LoomChannel,${
      hasKafka
        ? `
    [property: JsonPropertyName("loomkey"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? LoomKey,`
        : ""
    }
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
${redisDriver}${rabbitDriver}${kafkaDriver}
public sealed record ChannelBinding(
    string CsName, string Address, string EnvVar, string Context, string Transport, string Group, bool Queue${hasKafka ? ", string? Key" : ""});

public static class ChannelBindings
{
    /// <summary>The deployable's wired bindings: broker address + consumer
    /// group per channelSource, with the connection URL injected by
    /// compose/k8s as LOOM_CHANNEL_&lt;NAME&gt;_URL.</summary>
    public static readonly IReadOnlyList<ChannelBinding> All = new List<ChannelBinding>
    {
${bindingLines}
    };

    /// <summary>event type -&gt; broker address (first carrying broker-bound
    /// channel, mirroring the in-process dispatcher's routing rule).
    /// Ephemeral events publish inline in the tee.</summary>
    public static readonly IReadOnlyDictionary<string, string> Routing = new Dictionary<string, string>
    {
${routingLines}
    };

    /// <summary>Durable (work) events pass through to the outbox and publish
    /// on relay drain (design §5).</summary>
    public static readonly IReadOnlyDictionary<string, string> DurableRouting = new Dictionary<string, string>
    {
${durableRoutingLines}
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

/// <summary>Envelope construction shared by the inline tee and the outbox
/// relay publisher.  Relay-published (durable) events pass their outbox row
/// id — the stable consumer-side idempotency key; inline (ephemeral)
/// publishes mint a process-local one.</summary>
public static class ChannelEnvelopes
{
    private static long _counter;

    public static LoomEventEnvelope For(IDomainEvent ev, string type, string address, string? eventId = null)
    {
        ChannelBinding? bound = null;
        foreach (var b in ChannelBindings.All)
        {
            if (b.Address == address) { bound = b; break; }
        }
        if (bound is null)
        {
            throw new InvalidOperationException($"no transport wired for channel address {address}");
        }
        var id = eventId
            ?? $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{Environment.ProcessId:x}-{Interlocked.Increment(ref _counter):x}";
        var raw = ChannelCodec.ToData(ev);
        var data = JsonSerializer.SerializeToElement(raw);${
          hasKafka
            ? `
        // The channel's key: field value rides as loomkey — kafka's
        // partition key (design §4), so one aggregate's events keep order.
        string? loomKey = null;
        if (bound.Key is not null && raw.TryGetValue(bound.Key, out var keyValue) && keyValue is not null)
        {
            loomKey = keyValue.ToString();
        }
        return new LoomEventEnvelope(
            "1.0", id, $"{bound.Context}.{type}", $"/loom/{bound.Context}",
            DateTime.UtcNow.ToString("o"), "application/json", address, loomKey, data);`
            : `
        return new LoomEventEnvelope(
            "1.0", id, $"{bound.Context}.{type}", $"/loom/{bound.Context}",
            DateTime.UtcNow.ToString("o"), "application/json", address, data);`
        }
    }
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
                transport = ${newTransportExpr};
                byUrl[url] = transport;
            }
            _byCsName[binding.CsName] = transport;
        }
    }

    public IChannelTransport For(string csName) => _byCsName[csName];

    public IChannelTransport ForAddress(string address)
    {
        foreach (var binding in ChannelBindings.All)
        {
            if (binding.Address == address) return _byCsName[binding.CsName];
        }
        throw new InvalidOperationException($"no transport wired for channel address {address}");
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var transport in _byCsName.Values)
        {
            await transport.CloseAsync();
            if (transport is IDisposable disposable) disposable.Dispose();
        }
    }
}

/// <summary>Producer tee — the delivery-uniformity rule (design §4): an
/// event carried by a broker-bound channel is PUBLISHED and not fanned out
/// locally; co-located consumers receive it through their subscription
/// exactly like remote ones.  Durable (work) events pass through to the
/// inner dispatcher — the outbox captures them in the write transaction and
/// the relay publishes on drain (design §5).  Everything else passes to the
/// inner dispatcher unchanged.</summary>
public sealed class ChannelPublishTeeDispatcher : IDomainEventDispatcher
{
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
        if (ChannelBindings.DurableRouting.ContainsKey(type)
            || !ChannelBindings.Routing.TryGetValue(type, out var address))
        {
            await _inner.DispatchAsync(ev, cancellationToken);
            return;
        }
        var envelope = ChannelEnvelopes.For(ev, type, address);
        await _transports.ForAddress(address).PublishAsync(address, envelope);
        _log.LogInformation("{Event} {Address} {Type} {Id}", "channel_published", address, type, envelope.Id);
    }
}
${relayPublisher}${consumer}`;
}
