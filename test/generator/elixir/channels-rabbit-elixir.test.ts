// M-T4.4 slice 7d — RabbitMQ queue transport on the Phoenix (Elixir)
// backend, mirroring the Hono pins in ../channels-rabbit-transport.test.ts
// and the Python/.NET/Java legs.
//
// An elixir deployable that wires a rabbitmq-bound `queue` channelSource via
// `channels:` gets: the hex `amqp` driver (MIT — durable fanout exchange per
// address, one durable queue per consuming deployable that its replicas
// compete on, manual ack, bounded `x-loom-attempts` retry, DLX `loom.dlx` →
// `loom.dlq.<address>` parking), the producer-path split (design §5:
// `queue`/`work` events land in `__loom_outbox` via the tee — elixir's NEW
// outbox tier: `LoomOutbox` Ecto schema + `OutboxRelay` GenServer — and
// publish on relay drain with the row id as the envelope id; the inline tee
// only publishes ephemeral events), and the wiring-gated `amqp` hex dep.

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
  deployable salesApi { platform: elixir contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: elixir contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("rabbitmq queue transport — elixir leg (M-T4.4 slice 7d)", () => {
  it("routes queue/work events through the NEW elixir outbox: tee records, relay publishes", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const tee = files.get("sales_api/lib/sales_api/channels.ex") ?? "";
    // §5 producer split: durable events land in __loom_outbox inside the
    // caller's Repo transaction; the ephemeral routing table stays empty.
    expect(tee).toContain("@routing %{}");
    expect(tee).toContain(
      '"OrderPlaced" => {"loom.Orders.Lifecycle", "Orders", :loom_channels_0, :rabbitmq}',
    );
    expect(tee).toContain("record_durable(type, ev)");
    expect(tee).toContain("|> SalesApi.Repo.insert!()");
    // The relay half publishes the drained row with ITS id as the envelope
    // id — the consumer-side idempotency key.
    expect(tee).toContain("def publish_from_relay(type, data, event_id) do");
    expect(tee).toContain("GenServer.call(conn, {:publish, address, json})");
    const outbox = files.get("sales_api/lib/sales_api/loom_outbox.ex") ?? "";
    expect(outbox).toContain('schema "__loom_outbox"');
    const relay = files.get("sales_api/lib/sales_api/outbox_relay.ex") ?? "";
    expect(relay).toContain("SalesApi.Channels.publish_from_relay(row.type, row.payload, row.id)");
    expect(relay).toContain("where: is_nil(o.dispatched_at) and o.attempts < @max_attempts");
    // The outbox migration must NOT bundle Ecto timestamps() — the relay
    // writers never populate inserted_at.
    const migration =
      files.get("sales_api/priv/repo/migrations/20260101000000_create___loom_outbox.exs") ?? "";
    expect(migration).toContain("create table(:__loom_outbox");
    expect(migration).not.toContain("timestamps()");
    // Supervision: broker conn process + relay on the producer.
    const app = files.get("sales_api/lib/sales_api/application.ex") ?? "";
    expect(app).toContain("SalesApi.ChannelBroker");
    expect(app).toContain("SalesApi.OutboxRelay");
  });

  it("emits the amqp consumer with the §4 topology on the competing group queue", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const consumer = files.get("ship_api/lib/ship_api/channel_consumer.ex") ?? "";
    // One durable queue per consuming deployable — the consumer group.
    expect(consumer).toContain(
      'consume(chan_loom_channels_0, "loom.Orders.Lifecycle", "loom.Orders.Lifecycle.shipApi")',
    );
    expect(consumer).toContain("AMQP.Basic.qos(chan, prefetch_count: 1)");
    // Dead-letter topology: DLX exchange + per-address parking queue, wired
    // as the group queue's dead-letter target.
    expect(consumer).toContain(
      ':ok = AMQP.Exchange.declare(chan, "loom.dlx", :direct, durable: true)',
    );
    expect(consumer).toContain('{"x-dead-letter-exchange", :longstr, "loom.dlx"}');
    // Bounded retry: header republish + ack; exhaustion/malformed park.
    expect(consumer).toContain('List.keyfind(headers, "x-loom-attempts", 0)');
    expect(consumer).toContain("AMQP.Basic.reject(chan, meta.delivery_tag, requeue: false)");
    expect(consumer).toContain('"channel_dead_lettered"');
    // The consumer does NOT host the durable channel's context: no outbox
    // tier — broker ack semantics carry the redelivery contract (the
    // slice-3 stance; elixir saga last_event_id dedup is the documented
    // in-mission residual).
    expect(files.has("ship_api/lib/ship_api/loom_outbox.ex")).toBe(false);
    expect(files.has("ship_api/lib/ship_api/outbox_relay.ex")).toBe(false);
    // Foreign vocabulary still lands: event struct + dispatcher route.
    expect(files.has("ship_api/lib/ship_api/orders/events/order_placed.ex")).toBe(true);
    expect(consumer).toContain("defp route(%ShipApi.Orders.Events.OrderPlaced{} = ev) do");
  });

  it("gates the amqp hex dep on the wiring — same version line as the queue resource adapter", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mix = files.get(`${dep}/mix.exs`) ?? "";
      expect(mix).toContain('{:amqp, "~> 4.0"}');
      expect(mix).not.toContain(":redix");
    }
  });

  it("provisions the RabbitMQ sidecar and injects the amqp URL in compose", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: rabbitmq:4-management-alpine");
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://guest:guest@bus:5672"');
  });

  it("keeps the redis (slice 6c) shape intact — no rabbit artifacts, no outbox", async () => {
    const redisFixture = FIXTURE.replace("type: rabbitmq", "type: redis").replace(
      /delivery: queue\s+retention: work/,
      "delivery: broadcast\n        retention: ephemeral",
    );
    const files = await generateSystemFiles(redisFixture);
    const tee = files.get("sales_api/lib/sales_api/channels.ex") ?? "";
    // Broadcast/ephemeral events stay on the inline tee; no outbox tier.
    expect(tee).toContain(
      '"OrderPlaced" => {"loom.Orders.Lifecycle", "Orders", :loom_channels_0, :redis}',
    );
    expect(tee).not.toContain("@durable_routing");
    expect(tee).toContain('Redix.command!(conn, ["PUBLISH", address, json])');
    expect(files.has("sales_api/lib/sales_api/loom_outbox.ex")).toBe(false);
    expect(files.has("sales_api/lib/sales_api/channel_broker.ex")).toBe(false);
    const consumer = files.get("ship_api/lib/ship_api/channel_consumer.ex") ?? "";
    expect(consumer).toContain("Redix.PubSub.subscribe");
    expect(consumer).not.toContain("open_rabbit");
    const mix = files.get("sales_api/mix.exs") ?? "";
    expect(mix).toContain('{:redix, "~> 1.5"}');
    expect(mix).not.toContain(":amqp");
  });
});
