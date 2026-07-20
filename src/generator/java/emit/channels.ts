import type { EventIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import type { BrokerBinding } from "../../_channels/bindings.js";

// ---------------------------------------------------------------------------
// Broker transport classes (M-T4.4 slice 6b — the Java/Spring Boot leg of the
// Hono reference driver in `src/generator/typescript/emit/channels.ts`).
// Emitted only when the deployable wires a redis-bound `broadcast`/`ephemeral`
// channelSource via `channels:`; channel-less projects stay byte-identical.
//
// Carries the CloudEvents 1.0 envelope (same field pin —
// `src/util/channels.ts`), a per-event codec over the DSL field names (wire
// parity with the Hono/Python/.NET drivers: datetimes as ISO-8601 round-trip
// strings, money as decimal strings, ids as their string form), the
// `ChannelTransport` seam, the Lettuce pub/sub driver (Apache 2.0 — design
// §6a), the `DomainEvent`-typed publish-tee `@EventListener` enforcing the §4
// delivery-uniformity rule (its counterpart: dispatcher handlers for
// broker-routed events DROP their local `@EventListener` — see
// `DispatchCtx.brokerEvents`), and — where a hosted reactor subscribes — the
// `ChannelConsumerService` invoking the SAME dispatcher handler methods
// local events would reach.
//
// Java one-public-class-per-file: this module returns one rendered file per
// class, all placed under the `config` category (the CatalogLog package).
// ---------------------------------------------------------------------------

/** Lettuce (Apache 2.0) — the redis pub/sub client; wiring-gated into
 *  build.gradle.kts by the orchestrator. */
export const LETTUCE_CORE_VERSION = "6.5.5.RELEASE";

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
): Map<string, string> {
  const pkg = `${basePkg}.config`;
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

  out.set(
    "ChannelBindings.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.util.List;`,
      `import java.util.Map;`,
      ``,
      `/** The deployable's wired broker bindings (connection URL injected by`,
      ` *  compose/k8s as LOOM_CHANNEL_&lt;NAME&gt;_URL) + the event-type → address`,
      ` *  routing (first carrying broker-bound channel — mirrors the in-process`,
      ` *  dispatcher's routing rule). */`,
      `public final class ChannelBindings {`,
      `    public record Binding(String csName, String address, String envVar, String context) {`,
      `    }`,
      ``,
      `    public static final List<Binding> ALL = List.of(`,
      unique
        .map(
          (b) =>
            `            new Binding(${JSON.stringify(b.csName)}, ${JSON.stringify(b.address)}, ${JSON.stringify(b.envVar)}, ${JSON.stringify(b.contextName)})`,
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
      `            byCsName.put(binding.csName(), byUrl.computeIfAbsent(url, RedisChannelTransport::new));`,
      `        }`,
      `    }`,
      ``,
      `    public ChannelTransport forSource(String csName) {`,
      `        return byCsName.get(csName);`,
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
    "ChannelPublishTee.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.time.Instant;`,
      `import java.util.concurrent.atomic.AtomicLong;`,
      ``,
      `import org.springframework.context.event.EventListener;`,
      `import org.springframework.stereotype.Component;`,
      ``,
      `import ${basePkg}.domain.events.DomainEvent;`,
      ``,
      `/** Producer tee — the delivery-uniformity rule (design §4): an event`,
      ` *  carried by a broker-bound channel is PUBLISHED and not fanned out`,
      ` *  locally (its dispatcher handlers drop their local @EventListener);`,
      ` *  co-located consumers receive it through their subscription exactly`,
      ` *  like remote ones.  Events on no broker-bound channel are ignored here`,
      ` *  — Spring's local fan-out already reaches their listeners. */`,
      `@Component`,
      `public class ChannelPublishTee {`,
      `    private static final AtomicLong COUNTER = new AtomicLong();`,
      `    private final ChannelTransports transports;`,
      ``,
      `    public ChannelPublishTee(ChannelTransports transports) {`,
      `        this.transports = transports;`,
      `    }`,
      ``,
      `    @EventListener`,
      `    public void on(DomainEvent event) {`,
      `        var type = event.getClass().getSimpleName();`,
      `        var address = ChannelBindings.ROUTING.get(type);`,
      `        if (address == null) {`,
      `            return;`,
      `        }`,
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
      `        var id = Long.toHexString(System.currentTimeMillis()) + "-"`,
      `                + Long.toHexString(ProcessHandle.current().pid()) + "-"`,
      `                + Long.toHexString(COUNTER.incrementAndGet());`,
      `        var envelope = new LoomEventEnvelope("1.0", id, bound.context() + "." + type,`,
      `                "/loom/" + bound.context(), Instant.now().toString(), "application/json",`,
      `                address, ChannelCodec.toData(event));`,
      `        transports.forSource(bound.csName()).publish(address, envelope);`,
      `        CatalogLog.event("channel_published", "info", "address", address, "type", type, "id", id);`,
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
        `                                case ${JSON.stringify(event)} -> {`,
        `                                    var e = (${event}) ChannelCodec.fromData(bare, envelope.data());`,
        ...hs.map(
          (h) =>
            `                                    ${lowerFirst(h.dispatcherClass)}.${h.method}(e);`,
        ),
        `                                }`,
      ].join("\n"),
    );
    out.set(
      "ChannelConsumerService.java",
      lines(
        `package ${pkg};`,
        ``,
        `import java.util.concurrent.ExecutorService;`,
        `import java.util.concurrent.Executors;`,
        ``,
        `import org.springframework.context.SmartLifecycle;`,
        `import org.springframework.stereotype.Component;`,
        ``,
        ...dispatchers
          .filter((h) => h.dispatcherPkg !== pkg)
          .map((h) => `import ${h.dispatcherPkg}.${h.dispatcherClass};`),
        `import ${basePkg}.domain.events.*;`,
        ``,
        `/** Consumer loop — subscribes every wired address and invokes the SAME`,
        ` *  dispatcher handler methods local events would reach, so reactors and`,
        ` *  event-triggered starters run identically for local and remote events.`,
        ` *  Handler work leaves the driver's event loop through a single-thread`,
        ` *  executor (per-connection ordering preserved). */`,
        `@Component`,
        `public class ChannelConsumerService implements SmartLifecycle {`,
        `    private final ChannelTransports transports;`,
        ...dispatchers.map(
          (h) => `    private final ${h.dispatcherClass} ${lowerFirst(h.dispatcherClass)};`,
        ),
        `    private final ExecutorService executor = Executors.newSingleThreadExecutor();`,
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
        `    @Override`,
        `    public void start() {`,
        `        for (var binding : ChannelBindings.ALL) {`,
        `            transports.forSource(binding.csName()).subscribe(binding.address(), null,`,
        `                    envelope -> executor.submit(() -> {`,
        `                        var bare = envelope.type().contains(".")`,
        `                                ? envelope.type().substring(envelope.type().indexOf('.') + 1)`,
        `                                : envelope.type();`,
        `                        try {`,
        `                            switch (bare) {`,
        ...arms,
        `                                default -> {`,
        `                                }`,
        `                            }`,
        `                            CatalogLog.event("channel_consumed", "info", "address", binding.address(),`,
        `                                    "type", envelope.type(), "id", envelope.id());`,
        `                        } catch (RuntimeException e) {`,
        `                            CatalogLog.event("channel_consume_failed", "warn", "address", binding.address(),`,
        `                                    "type", envelope.type(), "error", String.valueOf(e.getMessage()));`,
        `                        }`,
        `                    }));`,
        `        }`,
        `        running = true;`,
        `    }`,
        ``,
        `    @Override`,
        `    public void stop() {`,
        `        executor.shutdown();`,
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
