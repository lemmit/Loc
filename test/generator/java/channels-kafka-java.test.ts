// M-T4.4 slice 8c — Kafka log transport on the Java (Spring Boot) backend,
// mirroring the Hono pins in ../channels-kafka-transport.test.ts and the
// python/dotnet legs.
//
// A java deployable that wires a kafka-bound channelSource via `channels:`
// gets: the plain org.apache.kafka:kafka-clients driver (Apache 2.0 — the
// Lettuce/amqp-client plain-driver choice) — one topic per channel address
// (idempotently admin-created before the group join), partition key =
// `loomkey` ?? envelope id (the envelope + binding gain the channel's
// `key:` field), consumption ALWAYS on the deployable's consumer group
// (the strict driver-thread path), commitSync after the batch's handlers
// resolve, dead-letter v1 park onto `<address>.dlq` — plus the §5 producer
// split (`log` retention is durable: tee → outbox → relay publish with the
// row id) and the wiring-gated kafka-clients gradle dep.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: log
        key: order
      }
    }
  }
  subdomain Fulfilment {
    context Shipping {
      aggregate Shipment with crudish {
        orderRef: Order id
        status: string
      }
      repository Shipments for Shipment {}
      workflow Fulfil {
        orderId: Order id
        create(p: OrderPlaced) by p.order {
          let s = Shipment.create({ orderRef: p.order, status: "Pending" })
        }
      }
    }
  }
  storage primary { type: postgres }
  storage bus { type: kafka }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: java contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

/** Finds the single generated file whose path ends with the given suffix. */
function find(files: Map<string, string>, dep: string, suffix: string): string {
  for (const [path, content] of files) {
    if (path.startsWith(`${dep}/`) && path.endsWith(suffix)) return content;
  }
  return "";
}

describe("kafka log transport — java leg (M-T4.4 slice 8c)", () => {
  it("emits the kafka-clients driver with the §4 topology on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = find(files, dep, "KafkaChannelTransport.java");
      expect(mod).toContain("import org.apache.kafka.clients.producer.KafkaProducer;");
      // Partition key = loomkey ?? envelope id (per-key ordering); the
      // binding row carries the channel's declared key field.
      expect(mod).toContain(
        "var key = envelope.loomKey() != null ? envelope.loomKey() : envelope.id();",
      );
      expect(find(files, dep, "ChannelBindings.java")).toContain(
        '"loom.Orders.Lifecycle.' +
          (dep === "sales_api" ? "salesApi" : "shipApi") +
          '", false, "order")',
      );
      // Idempotent topic ensure before the group join.
      expect(mod).toContain("admin.createTopics(List.of(new NewTopic(topic, 3, (short) 1)))");
      expect(mod).toContain("instanceof TopicExistsException");
      // Offset commit after the batch's handlers; dead-letter v1 park.
      expect(mod).toContain('props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");');
      expect(mod).toContain(
        'producer().send(new ProducerRecord<>(address + ".dlq", key, raw)).get();',
      );
      expect(mod).toContain('"channel_dead_lettered"');
      // The other drivers stay out of a kafka-only project.
      expect(find(files, dep, "RedisChannelTransport.java")).toBe("");
      expect(find(files, dep, "RabbitChannelTransport.java")).toBe("");
      const gradle = find(files, dep, "build.gradle.kts");
      expect(gradle).toContain("org.apache.kafka:kafka-clients:3.9.1");
      expect(gradle).not.toContain("lettuce-core");
      expect(gradle).not.toContain("amqp-client");
    }
  });

  it("routes broadcast/log events through the outbox and stamps loomKey", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // `log` retention is durable — the §5 split applies (the tee records
    // in __loom_outbox; the relay publishes with the row id).
    expect(find(files, "sales_api", "ChannelBindings.java")).toContain(
      'Map.entry("OrderPlaced", "loom.Orders.Lifecycle")',
    );
    expect(find(files, "sales_api", "OutboxRelayService.java")).not.toBe("");
    const envelope = find(files, "sales_api", "LoomEventEnvelope.java");
    expect(envelope).toContain("String loomKey,");
    expect(envelope).toContain('m.put("loomkey", loomKey);');
    const envelopes = find(files, "sales_api", "ChannelEnvelopes.java");
    expect(envelopes).toContain("if (bound.key() != null && data.get(bound.key()) != null) {");
    // The consumer subscribes on its group (strict path) and the consumed
    // log carries the partition key (the e2e ordering probe reads it).
    const consumer = find(files, "ship_api", "ChannelConsumerService.java");
    expect(consumer).toContain("subscribe(binding.address(), binding.group(),");
    expect(consumer).toContain('"key", String.valueOf(envelope.loomKey())');
  });

  it("keeps the rabbit (7c) shape stable — no kafka artifacts leak", async () => {
    const rabbitFixture = FIXTURE.replace("type: kafka", "type: rabbitmq")
      .replace("delivery: broadcast", "delivery: queue")
      .replace("retention: log", "retention: work")
      .replace(/\s*key: order/, "");
    const files = await generateSystemFiles(rabbitFixture);
    expect(find(files, "sales_api", "RabbitChannelTransport.java")).not.toBe("");
    expect(find(files, "sales_api", "KafkaChannelTransport.java")).toBe("");
    expect(find(files, "sales_api", "LoomEventEnvelope.java")).not.toContain("loomKey");
    expect(find(files, "sales_api", "build.gradle.kts")).not.toContain("kafka-clients");
  });
});
