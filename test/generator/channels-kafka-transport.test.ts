// M-T4.4 slice 4 — Kafka log transport on the Hono backend (the reference
// driver; per-backend fan-out rides later slices).
//
// A deployable that wires a kafka-bound channelSource via `channels:` gets:
// the kafkajs driver in the generated `http/channels.ts` (one topic per
// channel address; partition key = `loomkey` ?? envelope id so one
// aggregate's events keep per-partition order; consumption ALWAYS rides
// the deployable's consumer group — broadcast across deployables,
// competing within; dead-letter v1 parks a failed/malformed record onto
// `<address>.dlq` and advances the offset), the §5 producer split (a
// `log`-retention event is durable: the tee defers to the outbox and the
// relay publishes with the row id as the envelope id), the wiring-gated
// kafkajs dep, and — in docker-compose.yml — the official `apache/kafka`
// sidecar (Apache 2.0, KRaft; never bitnami — §6a licensing).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

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
  deployable salesApi { platform: node contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("kafka log transport (M-T4.4 slice 4)", () => {
  it("emits the kafkajs driver with the §4 topology on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = files.get(`${dep}/http/channels.ts`) ?? "";
      expect(mod).toContain(
        'import { type Consumer, Kafka, logLevel, type Producer } from "kafkajs";',
      );
      expect(mod).toContain("createKafkaTransport");
      // Partition key = loomkey ?? envelope id (per-key ordering).
      expect(mod).toContain(
        "messages: [{ key: envelope.loomkey ?? envelope.id, value: JSON.stringify(envelope) }],",
      );
      // Consumption always rides a group on kafka (broadcast across
      // deployables, competing within).
      expect(mod).toContain("const consumer = kafka.consumer({ groupId: group ?? address });");
      expect(mod).toContain(
        't.subscribe(b.address, b.queue || b.transport === "kafka" ? b.group : null, async (envelope) => {',
      );
      // Dead-letter v1: park onto <address>.dlq + advance.
      expect(mod).toContain(
        "await p.send({ topic: `${address}.dlq`, messages: [{ key, value: raw }] });",
      );
      expect(mod).toContain('event: "channel_dead_lettered",');
      // The other drivers stay out of a kafka-only module.
      expect(mod).not.toContain("createRedisTransport");
      expect(mod).not.toContain("createRabbitTransport");
      expect(files.get(`${dep}/package.json`)).toContain('"kafkajs"');
      expect(files.get(`${dep}/package.json`)).not.toContain('"ioredis"');
      expect(files.get(`${dep}/package.json`)).not.toContain('"amqplib"');
    }
    // The consumer group is the deployable-suffixed address; the binding
    // carries the channel's declared partition-key field.
    expect(files.get("ship_api/http/channels.ts")).toContain(
      'group: "loom.Orders.Lifecycle.shipApi", queue: false, key: "order"',
    );
  });

  it("routes broadcast/log events through the outbox: tee defers, relay publishes with loomkey", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("sales_api/http/channels.ts") ?? "";
    // `log` retention is durable — the §5 producer split applies.
    expect(mod).toContain("export const DURABLE_CHANNEL_ROUTING: Record<string, string> = {");
    expect(mod).toContain('  OrderPlaced: "loom.Orders.Lifecycle",');
    expect(mod).toContain(
      "if (!opts.fromRelay) return inner.dispatch(event); // outbox captures; relay publishes",
    );
    // The envelope stamps loomkey from the channel's key: field value.
    expect(mod).toContain("const keyValue = keyField ? data[keyField] : undefined;");
    expect(mod).toContain(
      "...(keyValue === undefined || keyValue === null ? {} : { loomkey: String(keyValue) }),",
    );
    // Workflow-less durable producer still boots outbox + relay through the tee.
    const index = files.get("sales_api/index.ts") ?? "";
    expect(index).toContain(
      "startOutboxRelay(db, channelPublishTee(channelTransports, inProcessEvents, { fromRelay: true }))",
    );
  });

  it("provisions the apache/kafka sidecar (never bitnami) and injects the broker URL", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: apache/kafka:4.1.0");
    expect(compose).not.toContain("bitnami");
    expect(compose).toContain("KAFKA_ADVERTISED_LISTENERS: CLIENT://bus:9092,PLAINTEXT://bus:9094");
    expect(compose).toContain("CLIENT:SASL_PLAINTEXT");
    expect(compose).toContain(
      'KAFKA_LISTENER_NAME_CLIENT_PLAIN_SASL_JAAS_CONFIG: "org.apache.kafka.common.security.plain.PlainLoginModule required user_sales_api=\\"loom-dev-bus-sales_api\\" user_ship_api=\\"loom-dev-bus-ship_api\\";"',
    );
    expect(compose).toContain("KAFKA_NUM_PARTITIONS: 3");
    expect(compose).toContain(
      'LOOM_CHANNEL_LIFECYCLE_BUS_URL: "kafka://sales_api:loom-dev-bus-sales_api@bus:9092"',
    );
  });

  it("keeps the redis and rabbit shapes byte-stable — no kafka artifacts leak", async () => {
    const redisFixture = FIXTURE.replace("type: kafka", "type: redis")
      .replace("retention: log", "retention: ephemeral")
      .replace(/\s*key: order/, "");
    const files = await generateSystemFiles(redisFixture);
    const mod = files.get("sales_api/http/channels.ts") ?? "";
    expect(mod).toContain("createRedisTransport");
    expect(mod).not.toContain("kafka");
    expect(mod).not.toContain("loomkey");
    // The pre-kafka group-selection + binding-row shapes are unchanged.
    expect(mod).toContain("t.subscribe(b.address, b.queue ? b.group : null, async (envelope) => {");
    expect(mod).toContain('group: "loom.Orders.Lifecycle.salesApi", queue: false },');
    expect(files.get("sales_api/package.json")).not.toContain('"kafkajs"');
  });
});
