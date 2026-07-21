// M-T4.4 slice 7c — RabbitMQ queue transport on the Java (Spring Boot)
// backend, mirroring the Hono pins in ../channels-rabbit-transport.test.ts
// and the Python/.NET legs.
//
// A java deployable that wires a rabbitmq-bound `queue` channelSource via
// `channels:` gets: the com.rabbitmq:amqp-client driver (durable fanout
// exchange per address, one durable queue per consuming deployable — the
// consumer group replicas compete on — manual ack, bounded retry, DLX
// `loom.dlx` → `loom.dlq.<address>` parking), the producer-path split
// (design §5: `queue`/`work` events land in __loom_outbox via the tee —
// java's NEW transactional-outbox tier — and publish on relay drain; the
// inline tee only publishes ephemeral events), and the wiring-gated
// amqp-client gradle dep.

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
        delivery: queue
        retention: work
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
  storage bus { type: rabbitmq }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: java contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

async function javaFiles(fixture: string): Promise<Map<string, string>> {
  return await generateSystemFiles(fixture);
}

/** Finds the single generated file whose path ends with the given suffix. */
function find(files: Map<string, string>, dep: string, suffix: string): string {
  for (const [path, content] of files) {
    if (path.startsWith(`${dep}/`) && path.endsWith(suffix)) return content;
  }
  return "";
}

describe("rabbitmq queue transport — java leg (M-T4.4 slice 7c)", () => {
  it("emits the amqp-client driver with the §4 topology on both wired deployables", async () => {
    const files = await javaFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = find(files, dep, "RabbitChannelTransport.java");
      expect(mod, `${dep} RabbitChannelTransport`).toContain("import com.rabbitmq.client.Channel;");
      // Dead-letter topology: DLX exchange + per-address parking queue,
      // wired as the consumer queue's dead-letter target.
      expect(mod).toContain('ch.exchangeDeclare("loom.dlx", BuiltinExchangeType.DIRECT, true);');
      expect(mod).toContain('var dlq = "loom.dlq." + address;');
      expect(mod).toContain('args.put("x-dead-letter-exchange", "loom.dlx");');
      expect(mod).toContain('"channel_dead_lettered"');
      // The redis driver stays out of a rabbit-only project.
      expect(find(files, dep, "RedisChannelTransport.java")).toBe("");
      const gradle = find(files, dep, "build.gradle.kts");
      expect(gradle).toContain("com.rabbitmq:amqp-client");
      expect(gradle).not.toContain("lettuce-core");
    }
    // The consumer group is the deployable's durable queue name.
    expect(find(files, "ship_api", "ChannelBindings.java")).toContain(
      '"loom.Orders.Lifecycle.shipApi"',
    );
  });

  it("routes queue/work events through the NEW java outbox: tee records, relay publishes", async () => {
    const files = await javaFiles(FIXTURE);
    const bindings = find(files, "sales_api", "ChannelBindings.java");
    // The durable routing table exists and the ephemeral one is empty.
    expect(bindings).toContain("public static final Map<String, String> DURABLE_ROUTING");
    expect(bindings).toContain('Map.entry("OrderPlaced", "loom.Orders.Lifecycle")');
    const tee = find(files, "sales_api", "ChannelPublishTee.java");
    // §5 producer split: the tee records durable events in __loom_outbox
    // inside the caller's @Transactional write; the relay publishes on drain.
    expect(tee).toContain("if (ChannelBindings.DURABLE_ROUTING.containsKey(type)) {");
    expect(tee).toContain("outbox.save(new LoomOutboxMessage(type, ChannelCodec.toData(event)));");
    const relay = find(files, "sales_api", "OutboxRelayService.java");
    expect(relay).toContain(
      "ChannelRelayPublisher.tryPublish(transports, row.getType(), row.getPayload(),",
    );
    const entity = find(files, "sales_api", "LoomOutboxMessage.java");
    expect(entity).toContain('@Table(name = "__loom_outbox")');
    expect(entity).toContain("@JdbcTypeCode(SqlTypes.JSON)");
    expect(find(files, "sales_api", "LoomOutboxRepository.java")).toContain(
      "findTop50ByDispatchedAtIsNullAndAttemptsLessThanOrderByOccurredAtAsc",
    );
  });

  it("subscribes the consumer on its competing group without a local outbox", async () => {
    const files = await javaFiles(FIXTURE);
    const consumer = find(files, "ship_api", "ChannelConsumerService.java");
    // Queue subscriptions dispatch ON the driver thread (strict path — its
    // bounded retry/park owns failures) with the deployable's group.
    expect(consumer).toContain(
      "transports.forSource(binding.csName()).subscribe(binding.address(), binding.group(),",
    );
    expect(consumer).not.toContain("executor.submit");
    // The consumer does NOT host the durable channel's context: no outbox
    // tier — broker ack semantics carry the redelivery contract (the
    // slice-3 stance; java saga last_event_id dedup is the documented
    // in-mission residual).
    expect(find(files, "ship_api", "OutboxRelayService.java")).toBe("");
    expect(find(files, "ship_api", "LoomOutboxMessage.java")).toBe("");
    const tee = find(files, "ship_api", "ChannelPublishTee.java");
    expect(tee).toContain("// relay — never an inline publish.");
    // Foreign vocabulary still lands: event record + dispatcher arm.
    expect(find(files, "ship_api", "OrderPlaced.java")).not.toBe("");
    expect(consumer).toContain("(OrderPlaced) ChannelCodec.fromData(bare, envelope.data())");
  });

  it("provisions the RabbitMQ sidecar and injects the amqp URL in compose", async () => {
    const files = await javaFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: rabbitmq:4-management-alpine");
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://guest:guest@bus:5672"');
  });

  it("keeps the redis (slice 6b) shape intact — no rabbit artifacts, no outbox", async () => {
    const redisFixture = FIXTURE.replace("type: rabbitmq", "type: redis").replace(
      /delivery: queue\s+retention: work/,
      "delivery: broadcast\n        retention: ephemeral",
    );
    const files = await javaFiles(redisFixture);
    expect(find(files, "sales_api", "RedisChannelTransport.java")).not.toBe("");
    expect(find(files, "sales_api", "RabbitChannelTransport.java")).toBe("");
    // Broadcast/ephemeral events stay on the inline tee; no outbox tier.
    expect(find(files, "sales_api", "ChannelBindings.java")).toContain(
      'Map.entry("OrderPlaced", "loom.Orders.Lifecycle")',
    );
    expect(find(files, "sales_api", "LoomOutboxMessage.java")).toBe("");
    expect(find(files, "sales_api", "build.gradle.kts")).not.toContain("amqp-client");
  });
});
