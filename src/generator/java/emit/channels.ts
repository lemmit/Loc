import type { EventIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import type { BrokerBinding } from "../../_channels/bindings.js";

// ---------------------------------------------------------------------------
// Broker transport classes (M-T4.4 slices 6b + 7c — the Java/Spring Boot leg
// of the Hono reference driver in `src/generator/typescript/emit/channels.ts`).
// Emitted only when the deployable wires a broker-bound channelSource via
// `channels:`; channel-less projects stay byte-identical.
//
// Carries the CloudEvents 1.0 envelope (same field pin —
// `src/util/channels.ts`), a per-event codec over the DSL field names (wire
// parity with the Hono/Python/.NET drivers: datetimes as ISO-8601 round-trip
// strings, money as decimal strings, ids as their string form), the
// `ChannelTransport` seam, the Lettuce pub/sub driver (Apache 2.0 — design
// §6a; `broadcast`/`ephemeral`), the com.rabbitmq:amqp-client driver
// (Apache 2.0 — §6a; `queue`/`ephemeral`+`work`, design §4 topology: durable
// fanout exchange per address, one durable queue per consuming deployable so
// replicas compete, manual ack → bounded retry → DLX `loom.dlx` →
// `loom.dlq.<address>` parking), the `DomainEvent`-typed publish-tee
// `@EventListener` enforcing the §4 delivery-uniformity rule (its
// counterpart: dispatcher handlers for broker-routed events DROP their local
// `@EventListener` — see `DispatchCtx.brokerEvents`), and — where a hosted
// reactor subscribes — the `ChannelConsumerService` invoking the SAME
// dispatcher handler methods local events would reach.
//
// Producer path split (design §5, slice 7c): the tee publishes EPHEMERAL
// broker-routed events inline; DURABLE (`work`) events land in
// `__loom_outbox` inside the caller's @Transactional write (the tee IS the
// outbox recorder on java) and are published by the `OutboxRelayService` on
// drain via `ChannelRelayPublisher`, with the outbox row id as the envelope
// id — the stable consumer-side idempotency key across broker redeliveries.
//
// Java one-public-class-per-file: this module returns one rendered file per
// class, all placed under the `config` category (the CatalogLog package);
// the outbox entity/repository render separately (persistence categories).
// ---------------------------------------------------------------------------

/** Lettuce (Apache 2.0) — the redis pub/sub client; wiring-gated into
 *  build.gradle.kts by the orchestrator. */
export const LETTUCE_CORE_VERSION = "6.5.5.RELEASE";

/** com.rabbitmq:amqp-client (Apache 2.0) — the plain AMQP 0-9-1 driver
 *  (consistent with the Lettuce plain-driver choice; never MassTransit-style
 *  frameworks); wiring-gated into build.gradle.kts by the orchestrator. */
export const AMQP_CLIENT_VERSION = "5.25.0";

/** org.apache.kafka:kafka-clients (Apache 2.0) — the plain Kafka driver
 *  (design §6a; the Lettuce/amqp-client plain-driver choice). */
export const KAFKA_CLIENTS_VERSION = "3.9.1";

/** One consumer dispatch target: a dispatcher handler method the
 *  ChannelConsumerService invokes when the named event arrives. */
export interface ChannelConsumerHandler {
  dispatcherClass: string;
  /** The dispatcher's package (layout-routed `workflow-service`). */
  dispatcherPkg: string;
  method: string;
  event: string;
}

function uniqueBindings(bindings: BrokerBinding[]): BrokerBinding[] {
  const seen = new Set<string>();
  return bindings.filter((b) => {
    if (seen.has(b.csName)) return false;
    seen.add(b.csName);
    return true;
  });
}

/** The per-binding driver pick in `ChannelTransports` — a ctor reference
 *  when one driver is wired, a transport-discriminated conditional chain
 *  when several are (fixed kafka → rabbitmq → redis order; the last wired
 *  driver is the fallback arm, so pre-kafka outputs stay byte-identical). */
function transportPickLine(hasRedis: boolean, hasRabbit: boolean, hasKafka: boolean): string {
  const drivers: [string, string][] = [];
  if (hasKafka) drivers.push(["kafka", "KafkaChannelTransport"]);
  if (hasRabbit) drivers.push(["rabbitmq", "RabbitChannelTransport"]);
  if (hasRedis) drivers.push(["redis", "RedisChannelTransport"]);
  const last = drivers[drivers.length - 1];
  if (!last) throw new Error("renderJavaChannelFiles called with no wired broker transport");
  if (drivers.length === 1) {
    return `            byCsName.put(binding.csName(), byUrl.computeIfAbsent(url, ${last[1]}::new));`;
  }
  const arms = drivers
    .slice(0, -1)
    .map(
      ([t, cls]) =>
        `${JSON.stringify(t)}.equals(binding.transport())\n                            ? new ${cls}(u)\n                            : `,
    )
    .join("");
  return `            byCsName.put(binding.csName(), byUrl.computeIfAbsent(url,\n                    u -> ${arms}new ${last[1]}(u)));`;
}

/** Java expression serialising one event record component into its
 *  envelope-data value (DSL-keyed JSON; parity with the Hono/Python/.NET
 *  codecs). */
function toDataExpr(access: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  const conv = (): string | null => {
    if (inner.kind === "primitive" && inner.name === "datetime") return `${access}.toString()`;
    if (inner.kind === "primitive" && inner.name === "money") return `${access}.toPlainString()`;
    if (inner.kind === "id") return `${access}.toString()`;
    if (inner.kind === "enum") return `${access}.name()`;
    return null;
  };
  const converted = conv();
  if (converted === null) return access;
  return t.kind === "optional" ? `${access} == null ? null : ${converted}` : converted;
}

/** Java expression reconstructing one event record component from the
 *  envelope's `data` map. */
function fromDataExpr(
  name: string,
  t: TypeIR,
  idValueTypeOf: (target: string) => string,
  imports: Set<string>,
): string {
  const get = `data.get(${JSON.stringify(name)})`;
  const inner = t.kind === "optional" ? t.inner : t;
  const conv = (): string => {
    switch (inner.kind) {
      case "primitive":
        switch (inner.name) {
          case "int":
            return `((Number) ${get}).intValue()`;
          case "long":
            return `((Number) ${get}).longValue()`;
          case "bool":
            return `(Boolean) ${get}`;
          case "decimal":
            imports.add("java.math.BigDecimal");
            return `new BigDecimal(String.valueOf(${get}))`;
          case "money":
            imports.add("java.math.BigDecimal");
            return `new BigDecimal((String) ${get})`;
          case "datetime":
            imports.add("java.time.Instant");
            return `Instant.parse((String) ${get})`;
          default:
            return `(String) ${get}`;
        }
      case "id": {
        const vt = idValueTypeOf(inner.targetName);
        if (vt === "string") return `new ${inner.targetName}Id((String) ${get})`;
        if (vt === "int") return `new ${inner.targetName}Id(((Number) ${get}).intValue())`;
        if (vt === "long") return `new ${inner.targetName}Id(((Number) ${get}).longValue())`;
        imports.add("java.util.UUID");
        return `new ${inner.targetName}Id(UUID.fromString((String) ${get}))`;
      }
      case "enum":
        return `${inner.name}.valueOf((String) ${get})`;
      default:
        return `(String) ${get}`;
    }
  };
  return t.kind === "optional" ? `${get} == null ? null : ${conv()}` : conv();
}

/** All broker transport files for the deployable, keyed by file name (placed
 *  under the `config` category alongside CatalogLog). */
export function renderJavaChannelFiles(
  basePkg: string,
  bindings: BrokerBinding[],
  /** The carried events' IRs (foreign ones already resolved system-wide by
   *  the orchestrator) — drives the codec arms. */
  carriedEvents: EventIR[],
  /** Dispatcher handler methods for broker-routed events — gates the
   *  ChannelConsumerService (a pure producer ships publish-only). */
  consumerHandlers: ChannelConsumerHandler[],
  sys: SystemIR,
  /** M-T4.4 slice 7c: hosted durable events ride a broker-bound
   *  `queue`/`work` channel — the tee records them in `__loom_outbox` and
   *  the relay publishes on drain (design §5).  False on consumers that
   *  don't host the durable channel's context (their module migrations
   *  carry no outbox table; broker ack semantics own redelivery).  The two
   *  packages are the layout-routed homes of the outbox entity/repository
   *  (`renderJavaOutboxFiles`). */
  opts: { durableBroker: boolean; outboxEntityPkg?: string; outboxRepoPkg?: string } = {
    durableBroker: false,
  },
): Map<string, string> {
  const pkg = `${basePkg}.config`;
  const unique = uniqueBindings(bindings);
  const hasRedis = unique.some((b) => b.transport === "redis");
  const hasRabbit = unique.some((b) => b.transport === "rabbitmq");
  const hasKafka = unique.some((b) => b.transport === "kafka");
  // event type -> address, split by durability (design §5): ephemeral events
  // publish inline in the tee; durable (`work`) events ride the outbox relay.
  // First-by-declaration within each tier, mirroring the in-process
  // dispatcher's routing rule.
  const routing = new Map<string, string>();
  const durableRouting = new Map<string, string>();
  for (const b of unique) {
    const target = b.retention === "ephemeral" ? routing : durableRouting;
    for (const ev of b.events) {
      if (!target.has(ev)) target.set(ev, b.address);
    }
  }
  const routed = new Set([...routing.keys(), ...durableRouting.keys()]);
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

  const out = new Map<string, string>();

  out.set(
    "LoomEventEnvelope.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.util.LinkedHashMap;`,
      `import java.util.Map;`,
      ``,
      `import tools.jackson.databind.json.JsonMapper;`,
      ``,
      `/** CloudEvents 1.0 JSON envelope — the cross-backend wire contract`,
      ` *  (loom envelope pin, src/util/channels.ts). */`,
      `public record LoomEventEnvelope(`,
      `        String specVersion,`,
      `        String id,`,
      `        String type,`,
      `        String source,`,
      `        String time,`,
      `        String dataContentType,`,
      `        String loomChannel,`,
      ...(hasKafka
        ? [
            `        /** The channel's key: field value — kafka's partition key`,
            `         *  (loomkey ?? id, design §4); null off the kafka path. */`,
            `        String loomKey,`,
          ]
        : []),
      `        Map<String, Object> data) {`,
      ``,
      `    private static final JsonMapper JSON = JsonMapper.builder().build();`,
      ``,
      `    public String toJson() {`,
      `        var m = new LinkedHashMap<String, Object>();`,
      `        m.put("specversion", specVersion);`,
      `        m.put("id", id);`,
      `        m.put("type", type);`,
      `        m.put("source", source);`,
      `        m.put("time", time);`,
      `        m.put("datacontenttype", dataContentType);`,
      `        m.put("loomchannel", loomChannel);`,
      ...(hasKafka
        ? [`        if (loomKey != null) {`, `            m.put("loomkey", loomKey);`, `        }`]
        : []),
      `        m.put("data", data);`,
      `        return JSON.writeValueAsString(m);`,
      `    }`,
      ``,
      `    @SuppressWarnings("unchecked")`,
      `    public static LoomEventEnvelope fromJson(String json) {`,
      `        Map<String, Object> m = JSON.readValue(json, Map.class);`,
      `        return new LoomEventEnvelope(`,
      `                (String) m.get("specversion"),`,
      `                (String) m.get("id"),`,
      `                (String) m.get("type"),`,
      `                (String) m.get("source"),`,
      `                (String) m.get("time"),`,
      `                (String) m.get("datacontenttype"),`,
      `                (String) m.get("loomchannel"),`,
      ...(hasKafka ? [`                (String) m.get("loomkey"),`] : []),
      `                (Map<String, Object>) m.get("data"));`,
      `    }`,
      `}`,
      ``,
    ),
  );

  out.set(
    "ChannelTransport.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.util.function.Consumer;`,
      ``,
      `/** The publish/subscribe seam every broker driver implements (M-T4.4;`,
      ` *  shared with the realtime relay).  A null group is broadcast; a group`,
      ` *  name makes replicas competing consumers. */`,
      `public interface ChannelTransport {`,
      `    void publish(String address, LoomEventEnvelope envelope);`,
      ``,
      `    void subscribe(String address, String group, Consumer<LoomEventEnvelope> handler);`,
      ``,
      `    void close();`,
      `}`,
      ``,
    ),
  );

  if (hasRedis)
    out.set(
      "RedisChannelTransport.java",
      lines(
        `package ${pkg};`,
        ``,
        `import java.util.function.Consumer;`,
        ``,
        `import io.lettuce.core.RedisClient;`,
        `import io.lettuce.core.api.StatefulRedisConnection;`,
        `import io.lettuce.core.pubsub.RedisPubSubAdapter;`,
        `import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;`,
        ``,
        `/** Redis (Valkey) driver — pub/sub over Lettuce (Apache 2.0, design §6a).`,
        ` *  \`redis://host:port\` URLs come from LOOM_CHANNEL_*_URL; Lettuce parses`,
        ` *  them natively. */`,
        `public final class RedisChannelTransport implements ChannelTransport {`,
        `    private final RedisClient client;`,
        `    private StatefulRedisConnection<String, String> pub;`,
        `    private StatefulRedisPubSubConnection<String, String> sub;`,
        ``,
        `    public RedisChannelTransport(String url) {`,
        `        this.client = RedisClient.create(url);`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void publish(String address, LoomEventEnvelope envelope) {`,
        `        if (pub == null) {`,
        `            pub = client.connect();`,
        `        }`,
        `        pub.sync().publish(address, envelope.toJson());`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void subscribe(String address, String group, Consumer<LoomEventEnvelope> handler) {`,
        `        if (sub == null) {`,
        `            sub = client.connectPubSub();`,
        `        }`,
        `        sub.addListener(new RedisPubSubAdapter<String, String>() {`,
        `            @Override`,
        `            public void message(String channel, String message) {`,
        `                if (!address.equals(channel)) {`,
        `                    return;`,
        `                }`,
        `                LoomEventEnvelope envelope;`,
        `                try {`,
        `                    envelope = LoomEventEnvelope.fromJson(message);`,
        `                } catch (RuntimeException e) {`,
        `                    CatalogLog.event("channel_consume_failed", "warn", "address", address, "error", "malformed envelope");`,
        `                    return;`,
        `                }`,
        `                handler.accept(envelope);`,
        `            }`,
        `        });`,
        `        sub.sync().subscribe(address);`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void close() {`,
        `        if (pub != null) {`,
        `            pub.close();`,
        `        }`,
        `        if (sub != null) {`,
        `            sub.close();`,
        `        }`,
        `        client.shutdown();`,
        `    }`,
        `}`,
        ``,
      ),
    );

  if (hasRabbit)
    out.set(
      "RabbitChannelTransport.java",
      lines(
        `package ${pkg};`,
        ``,
        `import java.io.IOException;`,
        `import java.nio.charset.StandardCharsets;`,
        `import java.util.HashMap;`,
        `import java.util.function.Consumer;`,
        ``,
        `import com.rabbitmq.client.AMQP;`,
        `import com.rabbitmq.client.BuiltinExchangeType;`,
        `import com.rabbitmq.client.Channel;`,
        `import com.rabbitmq.client.Connection;`,
        `import com.rabbitmq.client.ConnectionFactory;`,
        `import com.rabbitmq.client.DefaultConsumer;`,
        `import com.rabbitmq.client.Envelope;`,
        ``,
        `/** RabbitMQ driver — com.rabbitmq:amqp-client over AMQP 0-9-1 (design §4`,
        ` *  topology): a durable fanout exchange per channel address; one durable`,
        ` *  queue per consuming deployable (the consumer group) so replicas`,
        ` *  compete; manual ack; a failed handler republishes with an attempt`,
        ` *  header up to MAX_ATTEMPTS, then parks via DLX \`loom.dlx\` into`,
        ` *  \`loom.dlq.&lt;address&gt;\`. */`,
        `public final class RabbitChannelTransport implements ChannelTransport {`,
        `    /** Bounded per-message retries before a poisoned message parks in the`,
        `     *  DLQ (mirrors the outbox relay's MAX_ATTEMPTS). */`,
        `    private static final int MAX_ATTEMPTS = 5;`,
        ``,
        `    private final String url;`,
        `    private Connection connection;`,
        `    private Channel channel;`,
        ``,
        `    public RabbitChannelTransport(String url) {`,
        `        this.url = url;`,
        `    }`,
        ``,
        `    private synchronized Channel channel() {`,
        `        try {`,
        `            if (connection == null) {`,
        `                var factory = new ConnectionFactory();`,
        `                factory.setUri(url);`,
        `                connection = factory.newConnection();`,
        `            }`,
        `            if (channel == null) {`,
        `                channel = connection.createChannel();`,
        `                channel.basicQos(1);`,
        `            }`,
        `            return channel;`,
        `        } catch (Exception e) {`,
        `            throw new IllegalStateException("rabbitmq connection failed: " + e.getMessage(), e);`,
        `        }`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void publish(String address, LoomEventEnvelope envelope) {`,
        `        try {`,
        `            var ch = channel();`,
        `            ch.exchangeDeclare(address, BuiltinExchangeType.FANOUT, true);`,
        `            var props = new AMQP.BasicProperties.Builder()`,
        `                    .contentType("application/json").deliveryMode(2).build();`,
        `            ch.basicPublish(address, "", props, envelope.toJson().getBytes(StandardCharsets.UTF_8));`,
        `        } catch (IOException e) {`,
        `            throw new IllegalStateException("rabbitmq publish failed: " + e.getMessage(), e);`,
        `        }`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void subscribe(String address, String group, Consumer<LoomEventEnvelope> handler) {`,
        `        // The queue name IS the consumer group: replicas of one deployable`,
        `        // share it and compete; other deployables bind their own queue to`,
        `        // the same exchange (fan-out across deployables, one-of-N within).`,
        `        var queue = group == null ? address : group;`,
        `        try {`,
        `            var ch = channel();`,
        `            ch.exchangeDeclare(address, BuiltinExchangeType.FANOUT, true);`,
        `            ch.exchangeDeclare("loom.dlx", BuiltinExchangeType.DIRECT, true);`,
        `            var dlq = "loom.dlq." + address;`,
        `            ch.queueDeclare(dlq, true, false, false, null);`,
        `            ch.queueBind(dlq, "loom.dlx", address);`,
        `            var args = new HashMap<String, Object>();`,
        `            args.put("x-dead-letter-exchange", "loom.dlx");`,
        `            args.put("x-dead-letter-routing-key", address);`,
        `            ch.queueDeclare(queue, true, false, false, args);`,
        `            ch.queueBind(queue, address, "");`,
        `            ch.basicConsume(queue, false, new DefaultConsumer(ch) {`,
        `                @Override`,
        `                public void handleDelivery(String consumerTag, Envelope delivery,`,
        `                        AMQP.BasicProperties properties, byte[] body) throws IOException {`,
        `                    LoomEventEnvelope envelope;`,
        `                    try {`,
        `                        envelope = LoomEventEnvelope.fromJson(new String(body, StandardCharsets.UTF_8));`,
        `                    } catch (RuntimeException e) {`,
        `                        // Malformed body: no retry can fix it — nack without`,
        `                        // requeue routes through the queue's DLX into the DLQ.`,
        `                        ch.basicNack(delivery.getDeliveryTag(), false, false);`,
        `                        CatalogLog.event("channel_dead_lettered", "warn", "address", address,`,
        `                                "error", "malformed envelope");`,
        `                        return;`,
        `                    }`,
        `                    try {`,
        `                        handler.accept(envelope);`,
        `                        ch.basicAck(delivery.getDeliveryTag(), false);`,
        `                    } catch (RuntimeException e) {`,
        `                        var headers = properties.getHeaders();`,
        `                        var attempts = 1;`,
        `                        if (headers != null && headers.get("x-loom-attempts") != null) {`,
        `                            attempts = Integer.parseInt(String.valueOf(headers.get("x-loom-attempts"))) + 1;`,
        `                        }`,
        `                        if (attempts >= MAX_ATTEMPTS) {`,
        `                            // Parked, not lost: the DLX routes it into the DLQ.`,
        `                            ch.basicNack(delivery.getDeliveryTag(), false, false);`,
        `                            CatalogLog.event("channel_dead_lettered", "warn", "address", address,`,
        `                                    "type", envelope.type(), "id", envelope.id(),`,
        `                                    "attempts", String.valueOf(attempts), "error", String.valueOf(e.getMessage()));`,
        `                        } else {`,
        `                            // Bounded retry: republish with the attempt header and`,
        `                            // ack the original (immediate nack-requeue would hot-loop).`,
        `                            var retryHeaders = new HashMap<String, Object>();`,
        `                            if (headers != null) {`,
        `                                retryHeaders.putAll(headers);`,
        `                            }`,
        `                            retryHeaders.put("x-loom-attempts", attempts);`,
        `                            var props = new AMQP.BasicProperties.Builder()`,
        `                                    .contentType("application/json").deliveryMode(2)`,
        `                                    .headers(retryHeaders).build();`,
        `                            ch.basicPublish("", queue, props, body);`,
        `                            ch.basicAck(delivery.getDeliveryTag(), false);`,
        `                        }`,
        `                    }`,
        `                }`,
        `            });`,
        `        } catch (IOException e) {`,
        `            throw new IllegalStateException("rabbitmq subscribe failed: " + e.getMessage(), e);`,
        `        }`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void close() {`,
        `        try {`,
        `            if (channel != null) {`,
        `                channel.close();`,
        `            }`,
        `            if (connection != null) {`,
        `                connection.close();`,
        `            }`,
        `        } catch (Exception e) {`,
        `            // Already closed / never connected — shutdown is best-effort.`,
        `        }`,
        `    }`,
        `}`,
        ``,
      ),
    );

  if (hasKafka)
    out.set(
      "KafkaChannelTransport.java",
      lines(
        `package ${pkg};`,
        ``,
        `import java.time.Duration;`,
        `import java.util.ArrayList;`,
        `import java.util.List;`,
        `import java.util.Properties;`,
        `import java.util.function.Consumer;`,
        ``,
        `import org.apache.kafka.clients.admin.Admin;`,
        `import org.apache.kafka.clients.admin.NewTopic;`,
        `import org.apache.kafka.clients.consumer.ConsumerConfig;`,
        `import org.apache.kafka.clients.consumer.KafkaConsumer;`,
        `import org.apache.kafka.clients.producer.KafkaProducer;`,
        `import org.apache.kafka.clients.producer.ProducerConfig;`,
        `import org.apache.kafka.clients.producer.ProducerRecord;`,
        `import org.apache.kafka.common.errors.TopicExistsException;`,
        `import org.apache.kafka.common.errors.WakeupException;`,
        `import org.apache.kafka.common.serialization.StringDeserializer;`,
        `import org.apache.kafka.common.serialization.StringSerializer;`,
        ``,
        `/** Kafka driver — kafka-clients over the log (design §4 topology): one`,
        ` *  topic per channel address (idempotently admin-created before the`,
        ` *  group join); per-partition ordering with partition key = loomkey ??`,
        ` *  envelope id; consumption always rides the deployable's consumer`,
        ` *  GROUP (broadcast across deployables, competing within).  Offsets`,
        ` *  commit after the batch's handlers resolve.  Dead-letter v1: a`,
        ` *  failed or malformed record parks onto &lt;address&gt;.dlq and the`,
        ` *  offset advances — logged and kept, never a hot-loop. */`,
        `public final class KafkaChannelTransport implements ChannelTransport {`,
        `    private final String bootstrap;`,
        `    private final String saslUser;`,
        `    private final String saslPass;`,
        `    private KafkaProducer<String, String> producer;`,
        `    private final List<KafkaConsumer<String, String>> consumers = new ArrayList<>();`,
        `    private final List<Thread> loops = new ArrayList<>();`,
        `    private volatile boolean closing;`,
        ``,
        `    public KafkaChannelTransport(String url) {`,
        `        // kafka://user:pass@host:port[,host2] — userinfo (when present)`,
        `        // becomes SASL/PLAIN (M-T4.4 \u00a77); a credential-less URL stays`,
        `        // on PLAINTEXT, the pre-auth contract.`,
        `        var bare = url.startsWith("kafka://") ? url.substring("kafka://".length()) : url;`,
        `        var at = bare.lastIndexOf('@');`,
        `        if (at >= 0) {`,
        `            var userinfo = bare.substring(0, at);`,
        `            var colon = userinfo.indexOf(':');`,
        `            this.saslUser = urlDecode(colon >= 0 ? userinfo.substring(0, colon) : userinfo);`,
        `            this.saslPass = urlDecode(colon >= 0 ? userinfo.substring(colon + 1) : "");`,
        `        } else {`,
        `            this.saslUser = null;`,
        `            this.saslPass = null;`,
        `        }`,
        `        this.bootstrap = at >= 0 ? bare.substring(at + 1) : bare;`,
        `    }`,
        ``,
        `    private static String urlDecode(String s) {`,
        `        return java.net.URLDecoder.decode(s, java.nio.charset.StandardCharsets.UTF_8);`,
        `    }`,
        ``,
        `    private void applySasl(Properties props) {`,
        `        if (saslUser == null) return;`,
        `        props.put("security.protocol", "SASL_PLAINTEXT");`,
        `        props.put("sasl.mechanism", "PLAIN");`,
        `        props.put("sasl.jaas.config",`,
        `                "org.apache.kafka.common.security.plain.PlainLoginModule required username=\\""`,
        `                        + saslUser + "\\" password=\\"" + saslPass + "\\";");`,
        `    }`,
        ``,
        `    private synchronized KafkaProducer<String, String> producer() {`,
        `        if (producer == null) {`,
        `            var props = new Properties();`,
        `            props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap);`,
        `            applySasl(props);`,
        `            producer = new KafkaProducer<>(props, new StringSerializer(), new StringSerializer());`,
        `        }`,
        `        return producer;`,
        `    }`,
        ``,
        `    private void ensureTopic(String topic) {`,
        `        // Subscribing to a not-yet-produced topic stalls the group join;`,
        `        // idempotently create it (3 partitions / rf 1 — the compose`,
        `        // sidecar's defaults; an existing topic keeps its own shape).`,
        `        var props = new Properties();`,
        `        props.put("bootstrap.servers", bootstrap);`,
        `        applySasl(props);`,
        `        try (var admin = Admin.create(props)) {`,
        `            admin.createTopics(List.of(new NewTopic(topic, 3, (short) 1))).all().get();`,
        `        } catch (Exception e) {`,
        `            if (!(e.getCause() instanceof TopicExistsException)) {`,
        `                throw new IllegalStateException("kafka topic ensure failed: " + e.getMessage(), e);`,
        `            }`,
        `        }`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void publish(String address, LoomEventEnvelope envelope) {`,
        `        var key = envelope.loomKey() != null ? envelope.loomKey() : envelope.id();`,
        `        try {`,
        `            producer().send(new ProducerRecord<>(address, key, envelope.toJson())).get();`,
        `        } catch (InterruptedException e) {`,
        `            Thread.currentThread().interrupt();`,
        `            throw new IllegalStateException("kafka publish interrupted", e);`,
        `        } catch (Exception e) {`,
        `            throw new IllegalStateException("kafka publish failed: " + e.getMessage(), e);`,
        `        }`,
        `    }`,
        ``,
        `    private void park(String address, String key, String raw) {`,
        `        try {`,
        `            producer().send(new ProducerRecord<>(address + ".dlq", key, raw)).get();`,
        `        } catch (InterruptedException e) {`,
        `            Thread.currentThread().interrupt();`,
        `        } catch (Exception e) {`,
        `            CatalogLog.event("channel_consume_failed", "warn", "address", address,`,
        `                    "error", "dlq park failed: " + e.getMessage());`,
        `        }`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void subscribe(String address, String group, Consumer<LoomEventEnvelope> handler) {`,
        `        ensureTopic(address);`,
        `        var props = new Properties();`,
        `        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap);`,
        `        props.put(ConsumerConfig.GROUP_ID_CONFIG, group != null ? group : address);`,
        `        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");`,
        `        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "latest");`,
        `        applySasl(props);`,
        `        var consumer = new KafkaConsumer<>(props, new StringDeserializer(), new StringDeserializer());`,
        `        consumer.subscribe(List.of(address));`,
        `        consumers.add(consumer);`,
        `        var loop = new Thread(() -> {`,
        `            try {`,
        `                while (!closing) {`,
        `                    var records = consumer.poll(Duration.ofMillis(500));`,
        `                    for (var record : records) {`,
        `                        LoomEventEnvelope envelope;`,
        `                        try {`,
        `                            envelope = LoomEventEnvelope.fromJson(record.value());`,
        `                        } catch (RuntimeException e) {`,
        `                            // Malformed record: park + advance (v1 log + park).`,
        `                            park(address, record.key(), record.value());`,
        `                            CatalogLog.event("channel_dead_lettered", "warn", "address", address,`,
        `                                    "error", "malformed envelope");`,
        `                            continue;`,
        `                        }`,
        `                        try {`,
        `                            handler.accept(envelope);`,
        `                        } catch (RuntimeException e) {`,
        `                            // v1 log + park: keep the partition moving (a raw`,
        `                            // retry would stall every record behind this one).`,
        `                            park(address, record.key(), record.value());`,
        `                            CatalogLog.event("channel_dead_lettered", "warn", "address", address,`,
        `                                    "type", envelope.type(), "id", envelope.id(),`,
        `                                    "error", String.valueOf(e.getMessage()));`,
        `                        }`,
        `                    }`,
        `                    // Offsets commit after the batch's handlers resolved (or`,
        `                    // parked) — at-least-once with the envelope id as the`,
        `                    // consumer-side dedup key.`,
        `                    if (!records.isEmpty()) {`,
        `                        consumer.commitSync();`,
        `                    }`,
        `                }`,
        `            } catch (WakeupException e) {`,
        `                // close() woke the poll — the shutdown path.`,
        `            } finally {`,
        `                consumer.close();`,
        `            }`,
        `        }, "loom-kafka-" + (group != null ? group : address));`,
        `        loop.setDaemon(true);`,
        `        loop.start();`,
        `        loops.add(loop);`,
        `    }`,
        ``,
        `    @Override`,
        `    public synchronized void close() {`,
        `        closing = true;`,
        `        for (var consumer : consumers) {`,
        `            consumer.wakeup();`,
        `        }`,
        `        for (var loop : loops) {`,
        `            try {`,
        `                loop.join(5000);`,
        `            } catch (InterruptedException e) {`,
        `                Thread.currentThread().interrupt();`,
        `            }`,
        `        }`,
        `        if (producer != null) {`,
        `            producer.close();`,
        `        }`,
        `    }`,
        `}`,
        ``,
      ),
    );

  out.set(
    "ChannelBindings.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.util.List;`,
      `import java.util.Map;`,
      ``,
      `/** The deployable's wired broker bindings (connection URL injected by`,
      ` *  compose/k8s as LOOM_CHANNEL_&lt;NAME&gt;_URL; \`group\` is the durable`,
      ` *  queue the deployable's replicas COMPETE on for \`queue\` channels) +`,
      ` *  the event-type → address routing (first carrying broker-bound channel`,
      ` *  — mirrors the in-process dispatcher's routing rule).  Ephemeral`,
      ` *  events publish inline in the tee; durable (\`work\`) events pass`,
      ` *  through the outbox and publish on relay drain (design §5). */`,
      `public final class ChannelBindings {`,
      hasKafka
        ? `    public record Binding(String csName, String address, String envVar, String context,`
        : `    public record Binding(String csName, String address, String envVar, String context,`,
      hasKafka
        ? `            String transport, String group, boolean queue, String key) {`
        : `            String transport, String group, boolean queue) {`,
      `    }`,
      ``,
      `    public static final List<Binding> ALL = List.of(`,
      unique
        .map(
          (b) =>
            `            new Binding(${JSON.stringify(b.csName)}, ${JSON.stringify(b.address)}, ${JSON.stringify(b.envVar)}, ${JSON.stringify(b.contextName)}, ${JSON.stringify(b.transport)}, ${JSON.stringify(b.group)}, ${b.delivery === "queue"}${hasKafka ? `, ${b.key === undefined ? "null" : JSON.stringify(b.key)}` : ""})`,
        )
        .join(",\n") + ");",
      ``,
      `    public static final Map<String, String> ROUTING = Map.ofEntries(`,
      [...routing.entries()]
        .map(
          ([ev, addr]) => `            Map.entry(${JSON.stringify(ev)}, ${JSON.stringify(addr)})`,
        )
        .join(",\n") + ");",
      ``,
      `    public static final Map<String, String> DURABLE_ROUTING = Map.ofEntries(`,
      [...durableRouting.entries()]
        .map(
          ([ev, addr]) => `            Map.entry(${JSON.stringify(ev)}, ${JSON.stringify(addr)})`,
        )
        .join(",\n") + ");",
      ``,
      `    private ChannelBindings() {`,
      `    }`,
      `}`,
      ``,
    ),
  );

  const codecImports = new Set<string>(["java.util.LinkedHashMap", "java.util.Map"]);
  const toArms = carried.map((ev) => {
    const puts = ev.fields.map(
      (f) =>
        `                m.put(${JSON.stringify(f.name)}, ${toDataExpr(`e.${f.name}()`, f.type)});`,
    );
    return [
      `            case ${ev.name} e -> {`,
      `                var m = new LinkedHashMap<String, Object>();`,
      ...puts,
      `                yield m;`,
      `            }`,
    ].join("\n");
  });
  const fromArms = carried.map(
    (ev) =>
      `            case ${JSON.stringify(ev.name)} -> new ${ev.name}(${ev.fields
        .map((f) => fromDataExpr(f.name, f.type, idValueTypeOf, codecImports))
        .join(", ")});`,
  );
  out.set(
    "ChannelCodec.java",
    lines(
      `package ${pkg};`,
      ``,
      ...[...codecImports].sort().map((i) => `import ${i};`),
      ``,
      `import ${basePkg}.domain.enums.*;`,
      `import ${basePkg}.domain.events.*;`,
      `import ${basePkg}.domain.ids.*;`,
      ``,
      `/** Per-event envelope-data codec over the DSL field names — wire parity`,
      ` *  with the Hono/Python/.NET drivers (datetimes as ISO-8601 round-trip`,
      ` *  strings, money as decimal strings, ids by string form). */`,
      `public final class ChannelCodec {`,
      `    public static Map<String, Object> toData(DomainEvent ev) {`,
      `        return switch (ev) {`,
      ...toArms,
      `            default -> throw new IllegalStateException(`,
      `                    "event not carried by a wired channel: " + ev.getClass().getSimpleName());`,
      `        };`,
      `    }`,
      ``,
      `    public static DomainEvent fromData(String eventType, Map<String, Object> data) {`,
      `        return switch (eventType) {`,
      ...fromArms,
      `            default -> throw new IllegalStateException("unknown carried event type: " + eventType);`,
      `        };`,
      `    }`,
      ``,
      `    private ChannelCodec() {`,
      `    }`,
      `}`,
      ``,
    ),
  );

  out.set(
    "ChannelTransports.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.util.HashMap;`,
      `import java.util.HashSet;`,
      ``,
      `import jakarta.annotation.PreDestroy;`,
      `import org.springframework.stereotype.Component;`,
      ``,
      `/** One shared transport per broker URL for the process (publisher tee +`,
      ` *  consumer loop reuse the same connections), keyed by channelSource`,
      ` *  name.  Closed on context shutdown. */`,
      `@Component`,
      `public class ChannelTransports {`,
      `    private final HashMap<String, ChannelTransport> byCsName = new HashMap<>();`,
      ``,
      `    public ChannelTransports() {`,
      `        var byUrl = new HashMap<String, ChannelTransport>();`,
      `        for (var binding : ChannelBindings.ALL) {`,
      `            var url = System.getenv(binding.envVar());`,
      `            if (url == null || url.isEmpty()) {`,
      `                throw new IllegalStateException("channel binding '" + binding.csName()`,
      `                        + "' needs " + binding.envVar() + " (the broker URL compose/k8s injects)");`,
      `            }`,
      transportPickLine(hasRedis, hasRabbit, hasKafka),
      `        }`,
      `    }`,
      ``,
      `    public ChannelTransport forSource(String csName) {`,
      `        return byCsName.get(csName);`,
      `    }`,
      ``,
      `    public ChannelTransport forAddress(String address) {`,
      `        for (var b : ChannelBindings.ALL) {`,
      `            if (b.address().equals(address)) {`,
      `                return byCsName.get(b.csName());`,
      `            }`,
      `        }`,
      `        throw new IllegalStateException("no transport wired for channel address " + address);`,
      `    }`,
      ``,
      `    @PreDestroy`,
      `    public void close() {`,
      `        for (var transport : new HashSet<>(byCsName.values())) {`,
      `            transport.close();`,
      `        }`,
      `    }`,
      `}`,
      ``,
    ),
  );

  out.set(
    "ChannelEnvelopes.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.time.Instant;`,
      `import java.util.Map;`,
      `import java.util.concurrent.atomic.AtomicLong;`,
      ``,
      `/** Envelope construction shared by the inline tee and the outbox relay`,
      ` *  publisher.  Relay-published (durable) events pass their outbox row`,
      ` *  id — the stable consumer-side idempotency key; inline (ephemeral)`,
      ` *  publishes mint a process-local one. */`,
      `public final class ChannelEnvelopes {`,
      `    private static final AtomicLong COUNTER = new AtomicLong();`,
      ``,
      `    public static LoomEventEnvelope forData(String type, Map<String, Object> data,`,
      `            String address, String eventId) {`,
      `        ChannelBindings.Binding bound = null;`,
      `        for (var b : ChannelBindings.ALL) {`,
      `            if (b.address().equals(address)) {`,
      `                bound = b;`,
      `                break;`,
      `            }`,
      `        }`,
      `        if (bound == null) {`,
      `            throw new IllegalStateException("no transport wired for channel address " + address);`,
      `        }`,
      `        var id = eventId != null ? eventId`,
      `                : Long.toHexString(System.currentTimeMillis()) + "-"`,
      `                        + Long.toHexString(ProcessHandle.current().pid()) + "-"`,
      `                        + Long.toHexString(COUNTER.incrementAndGet());`,
      ...(hasKafka
        ? [
            `        // The channel's key: field value rides as loomkey — kafka's`,
            `        // partition key (design §4), so one aggregate's events keep order.`,
            `        String loomKey = null;`,
            `        if (bound.key() != null && data.get(bound.key()) != null) {`,
            `            loomKey = String.valueOf(data.get(bound.key()));`,
            `        }`,
            `        return new LoomEventEnvelope("1.0", id, bound.context() + "." + type,`,
            `                "/loom/" + bound.context(), Instant.now().toString(), "application/json",`,
            `                address, loomKey, data);`,
          ]
        : [
            `        return new LoomEventEnvelope("1.0", id, bound.context() + "." + type,`,
            `                "/loom/" + bound.context(), Instant.now().toString(), "application/json",`,
            `                address, data);`,
          ]),
      `    }`,
      ``,
      `    private ChannelEnvelopes() {`,
      `    }`,
      `}`,
      ``,
    ),
  );

  out.set(
    "ChannelPublishTee.java",
    lines(
      `package ${pkg};`,
      ``,
      `import org.springframework.context.event.EventListener;`,
      `import org.springframework.stereotype.Component;`,
      ``,
      `import ${basePkg}.domain.events.DomainEvent;`,
      opts.durableBroker ? `import ${opts.outboxEntityPkg}.LoomOutboxMessage;` : null,
      opts.durableBroker ? `import ${opts.outboxRepoPkg}.LoomOutboxRepository;` : null,
      ``,
      `/** Producer tee — the delivery-uniformity rule (design §4): an event`,
      ` *  carried by a broker-bound channel is PUBLISHED and not fanned out`,
      ` *  locally (its dispatcher handlers drop their local @EventListener);`,
      ` *  co-located consumers receive it through their subscription exactly`,
      ` *  like remote ones.  Events on no broker-bound channel are ignored here`,
      ` *  — Spring's local fan-out already reaches their listeners.`,
      ...(opts.durableBroker
        ? [
            ` *`,
            ` *  Durable (\`work\`) events land in __loom_outbox instead (design §5):`,
            ` *  this listener runs inside the service's @Transactional write, so`,
            ` *  the row commits atomically with the aggregate change; the`,
            ` *  OutboxRelayService publishes on drain. */`,
          ]
        : [` */`]),
      `@Component`,
      `public class ChannelPublishTee {`,
      `    private final ChannelTransports transports;`,
      opts.durableBroker ? `    private final LoomOutboxRepository outbox;` : null,
      ``,
      opts.durableBroker
        ? `    public ChannelPublishTee(ChannelTransports transports, LoomOutboxRepository outbox) {`
        : `    public ChannelPublishTee(ChannelTransports transports) {`,
      `        this.transports = transports;`,
      opts.durableBroker ? `        this.outbox = outbox;` : null,
      `    }`,
      ``,
      `    @EventListener`,
      `    public void on(DomainEvent event) {`,
      `        var type = event.getClass().getSimpleName();`,
      ...(durableRouting.size > 0
        ? opts.durableBroker
          ? [
              `        if (ChannelBindings.DURABLE_ROUTING.containsKey(type)) {`,
              `            // Design §5: durable events ride the outbox — the relay publishes.`,
              `            outbox.save(new LoomOutboxMessage(type, ChannelCodec.toData(event)));`,
              `            return;`,
              `        }`,
            ]
          : [
              `        if (ChannelBindings.DURABLE_ROUTING.containsKey(type)) {`,
              `            // Design §5: a durable event rides its OWNING producer's outbox`,
              `            // relay — never an inline publish.`,
              `            return;`,
              `        }`,
            ]
        : []),
      `        var address = ChannelBindings.ROUTING.get(type);`,
      `        if (address == null) {`,
      `            return;`,
      `        }`,
      `        var envelope = ChannelEnvelopes.forData(type, ChannelCodec.toData(event), address, null);`,
      `        transports.forAddress(address).publish(address, envelope);`,
      `        CatalogLog.event("channel_published", "info", "address", address, "type", type, "id", envelope.id());`,
      `    }`,
      `}`,
      ``,
    ),
  );

  if (opts.durableBroker)
    out.set(
      "ChannelRelayPublisher.java",
      lines(
        `package ${pkg};`,
        ``,
        `import java.util.Map;`,
        ``,
        `/** Design §5, the relay half of the producer split: a drained durable`,
        ` *  outbox row whose channel is broker-bound publishes here, carrying`,
        ` *  its outbox row id as the envelope id (the consumer-side idempotency`,
        ` *  key).  Rows on non-broker durable channels return false. */`,
        `public final class ChannelRelayPublisher {`,
        `    public static boolean tryPublish(ChannelTransports transports, String type,`,
        `            Map<String, Object> data, String eventId) {`,
        `        var address = ChannelBindings.DURABLE_ROUTING.get(type);`,
        `        if (address == null) {`,
        `            return false;`,
        `        }`,
        `        var envelope = ChannelEnvelopes.forData(type, data, address, eventId);`,
        `        transports.forAddress(address).publish(address, envelope);`,
        `        CatalogLog.event("channel_published", "info", "address", address, "type", type, "id", eventId);`,
        `        return true;`,
        `    }`,
        ``,
        `    private ChannelRelayPublisher() {`,
        `    }`,
        `}`,
        ``,
      ),
    );

  if (consumerHandlers.length > 0) {
    // One switch arm per event; each arm invokes every subscribed handler
    // method (a projection fold + a workflow reactor can share an event).
    const byEvent = new Map<string, ChannelConsumerHandler[]>();
    for (const h of consumerHandlers) {
      const list = byEvent.get(h.event) ?? [];
      list.push(h);
      byEvent.set(h.event, list);
    }
    const dispatchers = [
      ...new Map(consumerHandlers.map((h) => [h.dispatcherClass, h] as const)).values(),
    ].sort((a, b) => a.dispatcherClass.localeCompare(b.dispatcherClass));
    const arms = [...byEvent.entries()].map(([event, hs]) =>
      [
        `            case ${JSON.stringify(event)} -> {`,
        `                var e = (${event}) ChannelCodec.fromData(bare, envelope.data());`,
        ...hs.map((h) => `                ${lowerFirst(h.dispatcherClass)}.${h.method}(e);`),
        `            }`,
      ].join("\n"),
    );
    // Queue (rabbit) subscriptions ride the STRICT path — a failed dispatch
    // must propagate on the driver's delivery thread so its bounded-retry /
    // DLX-park owns it.  Broadcast (redis) subscriptions keep the logged
    // single-thread-executor path (fire-and-forget contract).
    const strictSubscribe = [
      `            transports.forSource(binding.csName()).subscribe(binding.address(), binding.group(),`,
      `                    envelope -> {`,
      `                        dispatch(envelope);`,
      hasKafka
        ? `                        CatalogLog.event("channel_consumed", "info", "address", binding.address(),\n                                "type", envelope.type(), "id", envelope.id(),\n                                "key", String.valueOf(envelope.loomKey()));`
        : `                        CatalogLog.event("channel_consumed", "info", "address", binding.address(),\n                                "type", envelope.type(), "id", envelope.id());`,
      `                    });`,
    ];
    const loggedSubscribe = [
      `            transports.forSource(binding.csName()).subscribe(binding.address(), null,`,
      `                    envelope -> executor.submit(() -> {`,
      `                        try {`,
      `                            dispatch(envelope);`,
      `                            CatalogLog.event("channel_consumed", "info", "address", binding.address(),`,
      `                                    "type", envelope.type(), "id", envelope.id());`,
      `                        } catch (RuntimeException e) {`,
      `                            CatalogLog.event("channel_consume_failed", "warn", "address", binding.address(),`,
      `                                    "type", envelope.type(), "error", String.valueOf(e.getMessage()));`,
      `                        }`,
      `                    }));`,
    ];
    const subscribeBody =
      hasRedis && (hasRabbit || hasKafka)
        ? [
            hasKafka
              ? `            if (binding.queue() || "kafka".equals(binding.transport())) {`
              : `            if (binding.queue()) {`,
            ...strictSubscribe.map((l) => `    ${l}`),
            `            } else {`,
            ...loggedSubscribe.map((l) => `    ${l}`),
            `            }`,
          ]
        : hasRabbit || hasKafka
          ? // rabbit and kafka both dispatch strictly on the driver thread.
            strictSubscribe
          : loggedSubscribe;
    out.set(
      "ChannelConsumerService.java",
      lines(
        `package ${pkg};`,
        ``,
        hasRedis ? `import java.util.concurrent.ExecutorService;` : null,
        hasRedis ? `import java.util.concurrent.Executors;` : null,
        hasRedis ? `` : null,
        `import org.springframework.context.SmartLifecycle;`,
        `import org.springframework.stereotype.Component;`,
        ``,
        ...dispatchers
          .filter((h) => h.dispatcherPkg !== pkg)
          .map((h) => `import ${h.dispatcherPkg}.${h.dispatcherClass};`),
        `import ${basePkg}.domain.events.*;`,
        ``,
        `/** Consumer loop — subscribes every wired address (competing-consumer`,
        ` *  group on \`queue\` channels, broadcast otherwise) and invokes the SAME`,
        ` *  dispatcher handler methods local events would reach, so reactors and`,
        ` *  event-triggered starters run identically for local and remote events.`,
        ...(hasRabbit
          ? [
              ` *  Queue deliveries dispatch ON the driver's delivery thread so a`,
              ` *  failure propagates into its bounded-retry / DLX-park path.`,
            ]
          : []),
        ...(hasRedis
          ? [
              ` *  Broadcast handler work leaves the driver's event loop through a`,
              ` *  single-thread executor (per-connection ordering preserved).`,
            ]
          : []),
        ` */`,
        `@Component`,
        `public class ChannelConsumerService implements SmartLifecycle {`,
        `    private final ChannelTransports transports;`,
        ...dispatchers.map(
          (h) => `    private final ${h.dispatcherClass} ${lowerFirst(h.dispatcherClass)};`,
        ),
        hasRedis
          ? `    private final ExecutorService executor = Executors.newSingleThreadExecutor();`
          : null,
        `    private volatile boolean running;`,
        ``,
        `    public ChannelConsumerService(ChannelTransports transports${dispatchers
          .map((h) => `, ${h.dispatcherClass} ${lowerFirst(h.dispatcherClass)}`)
          .join("")}) {`,
        `        this.transports = transports;`,
        ...dispatchers.map(
          (h) =>
            `        this.${lowerFirst(h.dispatcherClass)} = ${lowerFirst(h.dispatcherClass)};`,
        ),
        `    }`,
        ``,
        `    private void dispatch(LoomEventEnvelope envelope) {`,
        `        var bare = envelope.type().contains(".")`,
        `                ? envelope.type().substring(envelope.type().indexOf('.') + 1)`,
        `                : envelope.type();`,
        `        switch (bare) {`,
        ...arms,
        `            default -> {`,
        `            }`,
        `        }`,
        `    }`,
        ``,
        `    @Override`,
        `    public void start() {`,
        `        for (var binding : ChannelBindings.ALL) {`,
        ...subscribeBody,
        `        }`,
        `        running = true;`,
        `    }`,
        ``,
        `    @Override`,
        `    public void stop() {`,
        hasRedis ? `        executor.shutdown();` : null,
        `        running = false;`,
        `    }`,
        ``,
        `    @Override`,
        `    public boolean isRunning() {`,
        `        return running;`,
        `    }`,
        `}`,
        ``,
      ),
    );
  }

  return out;
}

/** The transactional-outbox tier (M-T4.4 slice 7c — dispatch-delivery-
 *  semantics.md on java): the JPA entity mapped onto the MigrationsIR-owned
 *  `__loom_outbox` table, its Spring Data repository, and the polling relay
 *  that publishes drained rows to the broker (design §5; the tee in
 *  `renderJavaChannelFiles` is the recording half).  The payload stores the
 *  DSL-keyed `ChannelCodec.toData` map, so the relay builds envelopes
 *  without reconstructing event records.  Emitted only when hosted durable
 *  events ride a broker-bound channel.
 *
 *  Consumer-side saga `last_event_id` dedup is NOT wired on java yet — the
 *  documented in-mission residual; broker ack semantics + idempotent
 *  reactors carry redelivery (the slice-3 stance). */
export function renderJavaOutboxFiles(
  basePkg: string,
  pkgs: { configPkg: string; entityPkg: string; repoPkg: string },
): {
  name: string;
  category: "infra-persistence" | "spring-data-repository" | "config";
  content: string;
}[] {
  return [
    {
      name: "LoomOutboxMessage.java",
      category: "infra-persistence",
      content: lines(
        `package ${pkgs.entityPkg};`,
        ``,
        `import java.time.Instant;`,
        `import java.util.Map;`,
        `import java.util.UUID;`,
        ``,
        `import org.hibernate.annotations.JdbcTypeCode;`,
        `import org.hibernate.type.SqlTypes;`,
        ``,
        `import jakarta.persistence.Column;`,
        `import jakarta.persistence.Entity;`,
        `import jakarta.persistence.Id;`,
        `import jakarta.persistence.Table;`,
        ``,
        `/** One owed durable event (dispatch-delivery-semantics.md): written by`,
        ` *  the ChannelPublishTee inside the caller's transaction, drained by`,
        ` *  the OutboxRelayService (M-T4.4 design §5).  Maps the shared`,
        ` *  __loom_outbox table the module migrations own. */`,
        `@Entity`,
        `@Table(name = "__loom_outbox")`,
        `public class LoomOutboxMessage {`,
        `    @Id`,
        `    private UUID id = UUID.randomUUID();`,
        ``,
        `    @Column(name = "occurred_at", nullable = false)`,
        `    private Instant occurredAt = Instant.now();`,
        ``,
        `    @Column(nullable = false)`,
        `    private String type;`,
        ``,
        `    @JdbcTypeCode(SqlTypes.JSON)`,
        `    @Column(nullable = false)`,
        `    private Map<String, Object> payload;`,
        ``,
        `    @Column(name = "dispatched_at")`,
        `    private Instant dispatchedAt;`,
        ``,
        `    @Column(nullable = false)`,
        `    private int attempts;`,
        ``,
        `    protected LoomOutboxMessage() {`,
        `    }`,
        ``,
        `    public LoomOutboxMessage(String type, Map<String, Object> payload) {`,
        `        this.type = type;`,
        `        this.payload = payload;`,
        `    }`,
        ``,
        `    public UUID getId() {`,
        `        return id;`,
        `    }`,
        ``,
        `    public String getType() {`,
        `        return type;`,
        `    }`,
        ``,
        `    public Map<String, Object> getPayload() {`,
        `        return payload;`,
        `    }`,
        ``,
        `    public int getAttempts() {`,
        `        return attempts;`,
        `    }`,
        ``,
        `    public void setAttempts(int attempts) {`,
        `        this.attempts = attempts;`,
        `    }`,
        ``,
        `    public void setDispatchedAt(Instant dispatchedAt) {`,
        `        this.dispatchedAt = dispatchedAt;`,
        `    }`,
        `}`,
        ``,
      ),
    },
    {
      name: "LoomOutboxRepository.java",
      category: "spring-data-repository",
      content: lines(
        `package ${pkgs.repoPkg};`,
        ``,
        `import java.util.List;`,
        `import java.util.UUID;`,
        ``,
        `import org.springframework.data.jpa.repository.JpaRepository;`,
        ``,
        `import ${pkgs.entityPkg}.LoomOutboxMessage;`,
        ``,
        `public interface LoomOutboxRepository extends JpaRepository<LoomOutboxMessage, UUID> {`,
        `    List<LoomOutboxMessage> findTop50ByDispatchedAtIsNullAndAttemptsLessThanOrderByOccurredAtAsc(`,
        `            int attempts);`,
        `}`,
        ``,
      ),
    },
    {
      name: "OutboxRelayService.java",
      category: "config",
      content: lines(
        `package ${pkgs.configPkg};`,
        ``,
        `import java.time.Instant;`,
        `import java.util.concurrent.ExecutorService;`,
        `import java.util.concurrent.Executors;`,
        ``,
        `import org.springframework.context.SmartLifecycle;`,
        `import org.springframework.stereotype.Component;`,
        ``,
        `import ${pkgs.repoPkg}.LoomOutboxRepository;`,
        ``,
        `/** Drains __loom_outbox to the broker at-least-once (design §5) —`,
        ` *  consumers must tolerate redelivery; the envelope carries the row id`,
        ` *  as the idempotency key.  Rows that exhaust MAX_ATTEMPTS stay in the`,
        ` *  table and log event_dead_lettered once.  Handlers for broker-routed`,
        ` *  events are invoked by the ChannelConsumerService on delivery, never`,
        ` *  locally (§4 delivery uniformity). */`,
        `@Component`,
        `public class OutboxRelayService implements SmartLifecycle {`,
        `    private static final int MAX_ATTEMPTS = 5;`,
        `    private static final long INTERVAL_MS = 500;`,
        ``,
        `    private final LoomOutboxRepository outbox;`,
        `    private final ChannelTransports transports;`,
        `    private final ExecutorService executor = Executors.newSingleThreadExecutor();`,
        `    private volatile boolean running;`,
        ``,
        `    public OutboxRelayService(LoomOutboxRepository outbox, ChannelTransports transports) {`,
        `        this.outbox = outbox;`,
        `        this.transports = transports;`,
        `    }`,
        ``,
        `    @Override`,
        `    public void start() {`,
        `        running = true;`,
        `        executor.submit(() -> {`,
        `            while (running) {`,
        `                try {`,
        `                    drain();`,
        `                } catch (RuntimeException e) {`,
        `                    CatalogLog.event("outbox_relay_error", "warn", "error", String.valueOf(e.getMessage()));`,
        `                }`,
        `                try {`,
        `                    Thread.sleep(INTERVAL_MS);`,
        `                } catch (InterruptedException e) {`,
        `                    Thread.currentThread().interrupt();`,
        `                    return;`,
        `                }`,
        `            }`,
        `        });`,
        `    }`,
        ``,
        `    private void drain() {`,
        `        var rows = outbox.findTop50ByDispatchedAtIsNullAndAttemptsLessThanOrderByOccurredAtAsc(`,
        `                MAX_ATTEMPTS);`,
        `        for (var row : rows) {`,
        `            try {`,
        `                // Design §5: broker-bound durable rows publish on drain (the`,
        `                // envelope carries the row id — the consumer-side idempotency`,
        `                // key).  A non-broker durable row has no local redelivery path`,
        `                // on java; either way the row completes.`,
        `                ChannelRelayPublisher.tryPublish(transports, row.getType(), row.getPayload(),`,
        `                        row.getId().toString());`,
        `                row.setDispatchedAt(Instant.now());`,
        `                outbox.save(row);`,
        `            } catch (RuntimeException e) {`,
        `                row.setAttempts(row.getAttempts() + 1);`,
        `                outbox.save(row);`,
        `                if (row.getAttempts() >= MAX_ATTEMPTS) {`,
        `                    CatalogLog.event("event_dead_lettered", "warn", "type", row.getType(),`,
        `                            "attempts", String.valueOf(row.getAttempts()),`,
        `                            "error", String.valueOf(e.getMessage()));`,
        `                }`,
        `            }`,
        `        }`,
        `    }`,
        ``,
        `    @Override`,
        `    public void stop() {`,
        `        running = false;`,
        `        executor.shutdown();`,
        `    }`,
        ``,
        `    @Override`,
        `    public boolean isRunning() {`,
        `        return running;`,
        `    }`,
        `}`,
        ``,
      ),
    },
  ];
}
