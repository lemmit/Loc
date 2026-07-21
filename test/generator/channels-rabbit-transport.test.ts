// M-T4.4 slice 3 — RabbitMQ queue transport on the Hono backend.
//
// A deployable that wires a rabbitmq-bound `queue` channelSource via
// `channels:` gets: the amqplib driver in the generated `http/channels.ts`
// (durable fanout exchange per address, one durable queue per consuming
// deployable — the consumer group replicas compete on — manual ack, bounded
// retry, DLX `loom.dlx` → `loom.dlq.<address>` parking), the producer-path
// split (design §5: `queue`/`work` events reach the outbox and publish on
// relay drain; the inline tee only publishes ephemeral events), the
// wiring-gated amqplib dep, and — in docker-compose.yml — the official
// `rabbitmq:` sidecar (MPL 2.0, §6a licensing) with the amqp URL env.

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
  deployable salesApi { platform: node contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("rabbitmq queue transport (M-T4.4 slice 3)", () => {
  it("emits the amqplib driver with the §4 topology on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = files.get(`${dep}/http/channels.ts`) ?? "";
      expect(mod).toContain('import amqp from "amqplib";');
      expect(mod).toContain("createRabbitTransport");
      // Dead-letter topology: DLX exchange + per-address parking queue,
      // wired as the consumer queue's dead-letter target.
      expect(mod).toContain('await ch.assertExchange("loom.dlx", "direct", { durable: true });');
      expect(mod).toContain("const dlq = `loom.dlq.${address}`;");
      expect(mod).toContain('deadLetterExchange: "loom.dlx",');
      expect(mod).toContain('event: "channel_dead_lettered",');
      // The redis driver stays out of a rabbit-only module.
      expect(mod).not.toContain("createRedisTransport");
      expect(files.get(`${dep}/package.json`)).toContain('"amqplib"');
      expect(files.get(`${dep}/package.json`)).toContain('"@types/amqplib"');
      expect(files.get(`${dep}/package.json`)).not.toContain('"ioredis"');
    }
    // The consumer group is the deployable's durable queue name.
    expect(files.get("ship_api/http/channels.ts")).toContain(
      'group: "loom.Orders.Lifecycle.shipApi"',
    );
  });

  it("routes queue/work events through the outbox: tee passes, relay publishes", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("sales_api/http/channels.ts") ?? "";
    // The durable routing table exists and the tee defers to the outbox on
    // the request path (design §5 producer split).
    expect(mod).toContain("export const DURABLE_CHANNEL_ROUTING: Record<string, string> = {");
    expect(mod).toContain('  OrderPlaced: "loom.Orders.Lifecycle",');
    expect(mod).toContain(
      "if (!opts.fromRelay) return inner.dispatch(event); // outbox captures; relay publishes",
    );
    // Relay-published envelopes reuse the outbox row id as the idempotency key.
    expect(mod).toContain("id: __loomEventId ??");
    // The producer hosts NO workflow, yet boots the outbox + relay: the
    // workflow-less producer shape emits the machinery and index.ts wires
    // the relay dispatcher through the tee in relay mode.
    const workflows = files.get("sales_api/http/workflows.ts") ?? "";
    expect(workflows).toContain("export function createOutboxDispatcher(");
    expect(workflows).toContain("export function startOutboxRelay(");
    const index = files.get("sales_api/index.ts") ?? "";
    expect(index).toContain(
      "startOutboxRelay(db, channelPublishTee(channelTransports, inProcessEvents, { fromRelay: true }))",
    );
    expect(index).toContain(
      "createApp(db, channelPublishTee(channelTransports, createOutboxDispatcher(db, inProcessEvents)))",
    );
  });

  it("subscribes the consumer with its competing-consumer group and the id marker", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("ship_api/http/channels.ts") ?? "";
    expect(mod).toContain("t.subscribe(b.address, b.queue ? b.group : null, async (envelope) => {");
    // The envelope id rides into the dispatcher as the idempotency marker.
    expect(mod).toContain("__loomEventId: envelope.id,");
  });

  it("provisions the RabbitMQ sidecar and injects the amqp URL in compose", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: rabbitmq:4-management-alpine");
    expect(compose).toContain('test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]');
    expect(compose).toContain(
      'LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://sales_api:loom-dev-bus-sales_api@bus:5672/loom"',
    );
    expect(compose.split("bus:\n        condition: service_healthy").length - 1).toBe(2);
  });

  it("keeps the redis (slice 2) shape intact — no rabbit artifacts, no outbox forcing", async () => {
    const redisFixture = FIXTURE.replace("type: rabbitmq", "type: redis").replace(
      /delivery: queue\s+retention: work/,
      "delivery: broadcast\n        retention: ephemeral",
    );
    const files = await generateSystemFiles(redisFixture);
    const mod = files.get("sales_api/http/channels.ts") ?? "";
    expect(mod).toContain("createRedisTransport");
    expect(mod).not.toContain("amqplib");
    // Broadcast/ephemeral events stay on the inline tee; no durable routing.
    expect(mod).toContain('  OrderPlaced: "loom.Orders.Lifecycle",');
    const index = files.get("sales_api/index.ts") ?? "";
    expect(index).not.toContain("startOutboxRelay");
    expect(files.get("sales_api/http/workflows.ts")).toBeUndefined();
  });
});
