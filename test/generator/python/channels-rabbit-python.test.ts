// M-T4.4 slice 7a — RabbitMQ queue transport on the Python (FastAPI)
// backend, mirroring the Hono pins in ../channels-rabbit-transport.test.ts.
//
// A python deployable that wires a rabbitmq-bound `queue` channelSource via
// `channels:` gets: the aio-pika driver in the generated `app/channels.py`
// (durable fanout exchange per address, one durable queue per consuming
// deployable — the consumer group replicas compete on — manual ack, bounded
// retry, DLX `loom.dlx` → `loom.dlq.<address>` parking), the producer-path
// split (design §5: `queue`/`work` events reach the outbox and publish on
// relay drain; the inline tee only publishes ephemeral events), the
// wiring-gated aio-pika dep, and the workflow-less durable producer's outbox
// + relay shape.

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
  deployable salesApi { platform: python contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: python contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("rabbitmq queue transport — python leg (M-T4.4 slice 7a)", () => {
  it("emits the aio-pika driver with the §4 topology on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = files.get(`${dep}/app/channels.py`) ?? "";
      expect(mod, `${dep}/app/channels.py`).toContain("import aio_pika");
      expect(mod).toContain("class RabbitChannelTransport:");
      // Dead-letter topology: DLX exchange + per-address parking queue,
      // wired as the consumer queue's dead-letter target.
      expect(mod).toContain(
        'dlx = await ch.declare_exchange("loom.dlx", aio_pika.ExchangeType.DIRECT, durable=True)',
      );
      expect(mod).toContain('dlq = await ch.declare_queue(f"loom.dlq.{address}", durable=True)');
      expect(mod).toContain('"x-dead-letter-exchange": "loom.dlx",');
      expect(mod).toContain('"channel_dead_lettered"');
      // The redis driver stays out of a rabbit-only module.
      expect(mod).not.toContain("RedisChannelTransport");
      const pyproject = files.get(`${dep}/pyproject.toml`) ?? "";
      expect(pyproject).toContain('"aio-pika>=');
      expect(pyproject).not.toContain('"redis>=');
    }
    // The consumer group is the deployable's durable queue name.
    expect(files.get("ship_api/app/channels.py")).toContain(
      '"group": "loom.Orders.Lifecycle.shipApi"',
    );
  });

  it("routes queue/work events through the outbox: tee passes, relay publishes", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const channels = files.get("sales_api/app/channels.py") ?? "";
    // The durable routing table exists and the inline tee half only routes
    // ephemeral events (design §5 producer split).
    expect(channels).toContain("DURABLE_CHANNEL_ROUTING: dict[str, str] = {");
    expect(channels).toContain('    "OrderPlaced": "loom.Orders.Lifecycle",');
    expect(channels).toContain("CHANNEL_ROUTING: dict[str, str] = {\n}");
    // Relay-published envelopes reuse the outbox row id as the idempotency key.
    expect(channels).toContain(
      "async def publish_event_from_relay(event: DomainEvent, event_id: str) -> bool:",
    );
    // The producer hosts NO workflow, yet gets the outbox + relay: the
    // workflow-less durable-producer shape (the Hono forceOutbox twin).
    const dispatch = files.get("sales_api/app/dispatch.py") ?? "";
    expect(dispatch).toContain(
      "ChannelTeeDispatcher(OutboxDispatcher(session, NoopDomainEventDispatcher()))",
    );
    expect(dispatch).toContain("await publish_event_from_relay(");
    expect(dispatch).toContain("def start_outbox_relay()");
    // The lifespan boots the relay on the workflow-less producer.
    expect(files.get("sales_api/app/main.py")).toContain("_outbox_relay = start_outbox_relay()");
    // The producer's schema carries the outbox table (module migrations back it).
    expect(files.get("sales_api/app/db/schema.py")).toContain("class LoomOutboxRow(Base):");
  });

  it("subscribes the consumer on its competing-consumer group without a local outbox", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const channels = files.get("ship_api/app/channels.py") ?? "";
    expect(channels).toContain(
      'await transport.subscribe(binding["address"], binding["group"], _consume_one)',
    );
    expect(channels).toContain("InProcessDispatcher(session).dispatch(event)");
    // The consumer does NOT host the durable channel's context: no outbox
    // tier, no relay, no id-dedup marker — broker ack semantics carry the
    // redelivery contract (the slice-3 stance).
    expect(channels).not.toContain("publish_event_from_relay");
    expect(channels).not.toContain("_current_event_id");
    const dispatch = files.get("ship_api/app/dispatch.py") ?? "";
    expect(dispatch).not.toContain("OutboxDispatcher");
    expect(files.get("ship_api/app/main.py")).not.toContain("start_outbox_relay");
    // Foreign vocabulary still lands: event dataclass + id brand + routing.
    expect(files.get("ship_api/app/domain/events.py")).toContain("class OrderPlaced:");
    expect(dispatch).toContain("isinstance(event, OrderPlaced)");
  });

  it("provisions the RabbitMQ sidecar and injects the amqp URL in compose", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: rabbitmq:4-management-alpine");
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://guest:guest@bus:5672"');
  });

  it("keeps the redis (slice 2b) shape intact — no rabbit artifacts, no outbox forcing", async () => {
    const redisFixture = FIXTURE.replace("type: rabbitmq", "type: redis").replace(
      /delivery: queue\s+retention: work/,
      "delivery: broadcast\n        retention: ephemeral",
    );
    const files = await generateSystemFiles(redisFixture);
    const mod = files.get("sales_api/app/channels.py") ?? "";
    expect(mod).toContain("class RedisChannelTransport:");
    expect(mod).not.toContain("aio_pika");
    // Broadcast/ephemeral events stay on the inline tee; no durable routing.
    expect(mod).toContain('    "OrderPlaced": "loom.Orders.Lifecycle",');
    expect(mod).not.toContain("publish_event_from_relay");
    expect(files.get("sales_api/app/main.py")).not.toContain("start_outbox_relay");
    expect(files.get("sales_api/pyproject.toml")).not.toContain("aio-pika");
  });
});
