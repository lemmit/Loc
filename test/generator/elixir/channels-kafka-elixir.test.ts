// M-T4.4 slice 8d — Kafka log transport on the Phoenix (Elixir) backend,
// mirroring the Hono pins in ../channels-kafka-transport.test.ts and the
// Python/.NET/Java legs — the final cell of the broker × backend matrix.
//
// An elixir deployable that wires a kafka-bound `log` channelSource via
// `channels:` gets: the brod driver (Apache 2.0 — Klarna's plain Erlang
// client, the Redix/amqp plain-driver choice; pulls the crc32cer C NIF, so
// the generated Dockerfile gains cmake), topic-per-address with idempotent
// admin creation (3 partitions / rf 1, the compose sidecar's defaults),
// `loomkey` partition-key stamping from the channel's `key:` field
// (partition key = loomkey ?? envelope id via brod's :hash partitioner), a
// `brod_group_subscriber_v2` consumer on the deployable's group
// (`<address>.<deployable>` — broadcast ACROSS deployables, competing
// WITHIN), commit-after-handler offsets, and dead-letter v1 (log + park
// onto `<address>.dlq` and advance).  The producer path reuses the 7d
// outbox tier (design §5: log events are durable).
//
// Two brod-specific pins encode runtime findings, not style: the
// subscriber MUST set `message_type: :message` (the message_set default
// hands handle_message/2 a batch record) and `group_instance_id: :null`
// (brod defaults to a STATIC id derived from node()/pid — unnamed nodes
// collide across replicas and fence each other out of the group).

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
        operation shipIt() {
          precondition status == "Placed"
          status := "Shipped"
          emit OrderShipped { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      event OrderShipped { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced, OrderShipped
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
  deployable salesApi { platform: elixir contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: elixir contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("kafka log transport — elixir leg (M-T4.4 slice 8d)", () => {
  it("routes log events through the outbox tee and stamps loomkey on the envelope", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const tee = files.get("sales_api/lib/sales_api/channels.ex") ?? "";
    // log retention is durable: both events ride the 7d outbox tier.
    expect(tee).toContain(
      '"OrderPlaced" => {"loom.Orders.Lifecycle", "Orders", :loom_channels_0, :kafka}',
    );
    expect(tee).toContain(
      '"OrderShipped" => {"loom.Orders.Lifecycle", "Orders", :loom_channels_0, :kafka}',
    );
    expect(tee).toContain("record_durable(type, ev)");
    // The channel's `key:` field per address → `loomkey` on the envelope.
    expect(tee).toContain('@channel_keys %{\n    "loom.Orders.Lifecycle" => "order"\n  }');
    expect(tee).toContain('Map.put(envelope, "loomkey", to_string(key_value))');
    // Transmit goes 5-arity when kafka is wired: partition key =
    // loomkey ?? envelope id.
    expect(tee).toContain(
      'transmit(transport, conn, address, Map.get(envelope, "loomkey", event_id), Jason.encode!(envelope))',
    );
    expect(tee).toContain("defp transmit(:kafka, conn, address, key, json) do");
    expect(tee).toContain("GenServer.call(conn, {:publish, address, key, json}, 30_000)");
    const outbox = files.get("sales_api/lib/sales_api/loom_outbox.ex") ?? "";
    expect(outbox).toContain('schema "__loom_outbox"');
  });

  it("emits the brod publisher: keyed produce_sync via :hash + idempotent topic ensure", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const broker = files.get("sales_api/lib/sales_api/kafka_broker.ex") ?? "";
    expect(broker).toContain(
      ":ok = :brod.start_client(state.endpoints, state.client, auto_start_producers: true)",
    );
    // One aggregate's events keep order: :hash partitioner over the key.
    expect(broker).toContain(":ok = :brod.produce_sync(state.client, address, :hash, key, json)");
    // Idempotent admin create before first publish — 3 partitions / rf 1
    // matches the compose sidecar's KAFKA_NUM_PARTITIONS.
    expect(broker).toContain(
      "%{name: address, num_partitions: 3, replication_factor: 1, assignments: [], configs: []}",
    );
    expect(broker).toContain('|> String.replace_prefix("kafka://", "")');
    const app = files.get("sales_api/lib/sales_api/application.ex") ?? "";
    expect(app).toContain(
      'Supervisor.child_spec({SalesApi.KafkaBroker, [env_var: "LOOM_CHANNEL_LIFECYCLE_BUS_URL", name: :loom_channels_0]}, id: :loom_channels_0)',
    );
  });

  it("emits the group subscriber with the §4 group topology and the two brod runtime pins", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const wiring = files.get("ship_api/lib/ship_api/channel_consumer.ex") ?? "";
    // Consumption is ALWAYS on the deployable's group.
    expect(wiring).toContain(
      '{:ok, _} = ShipApi.KafkaConsumer.start("LOOM_CHANNEL_LIFECYCLE_BUS_URL", :loom_kafka_sub_0, "loom.Orders.Lifecycle", "loom.Orders.Lifecycle.shipApi")',
    );
    expect(wiring).toContain("def route_decoded(ev), do: route(ev)");
    const consumer = files.get("ship_api/lib/ship_api/kafka_consumer.ex") ?? "";
    expect(consumer).toContain("@behaviour :brod_group_subscriber_v2");
    // Runtime finding #1: single-message delivery, not message sets.
    expect(consumer).toContain("message_type: :message");
    // Runtime finding #2: dynamic membership — brod's static default
    // (node()/pid) fences unnamed-node replicas out of the group.
    expect(consumer).toContain(
      "group_config: [offset_commit_policy: :commit_to_kafka_v2, group_instance_id: :null]",
    );
    // Offsets commit after the handler resolves.
    expect(consumer).toContain("{:ok, :commit, state}");
    // Consumed log carries the partition key for the ordering e2e probe.
    expect(consumer).toContain('key: Map.get(envelope, "loomkey")');
    // Dead-letter v1: park onto <address>.dlq; the first park can race the
    // dlq topic's creation + metadata propagation, so ensure + bounded retry.
    expect(consumer).toContain(
      ':brod.produce_sync(client, address <> ".dlq", :hash, key || "", raw)',
    );
    expect(consumer).toContain("retry_park(client, address, key, raw, 5)");
    expect(consumer).toContain('"channel_dead_lettered"');
    // The consumer joins from a latest offset, not a full-log replay.
    expect(consumer).toContain("consumer_config: [begin_offset: :latest]");
  });

  it("gates the brod hex dep + Dockerfile cmake (crc32cer NIF) on the kafka wiring", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mix = files.get(`${dep}/mix.exs`) ?? "";
      expect(mix).toContain('{:brod, "~> 4.4"}');
      expect(mix).not.toContain(":redix");
      expect(mix).not.toContain(":amqp");
      // brod pulls crc32cer — a C NIF whose build needs cmake on top of
      // build-essential in the builder stage.
      const dockerfile = files.get(`${dep}/Dockerfile`) ?? "";
      expect(dockerfile).toContain("build-essential cmake git ca-certificates");
    }
  });

  it("provisions the apache/kafka KRaft sidecar and injects the broker URL in compose", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    // Apache 2.0 image (§6a licensing — never bitnami).
    expect(compose).toContain("image: apache/kafka:4.1.0");
    expect(compose).toContain("KAFKA_NUM_PARTITIONS: 3");
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "bus:9092"');
  });

  it("keeps the rabbit (7d) shape intact — 4-arity transmit, no kafka artifacts, no cmake", async () => {
    const rabbitFixture = FIXTURE.replace("type: kafka", "type: rabbitmq")
      .replace(
        /delivery: broadcast\s+retention: log\s+key: order/,
        "delivery: queue\n        retention: work",
      )
      .replace(/\s*operation shipIt\(\) \{[\s\S]*?\n {8}\}/, "")
      .replace(/\s*carries: OrderPlaced, OrderShipped/, "\n        carries: OrderPlaced")
      .replace(/\s*event OrderShipped \{[^}]*\}/, "");
    const files = await generateSystemFiles(rabbitFixture);
    const tee = files.get("sales_api/lib/sales_api/channels.ex") ?? "";
    // No kafka in the wiring → the transmit spine stays 4-arity and
    // key-less, byte-identical to the 7d shape.
    expect(tee).toContain("GenServer.call(conn, {:publish, address, json})");
    expect(tee).not.toContain("@channel_keys");
    expect(tee).not.toContain("loomkey");
    expect(files.has("sales_api/lib/sales_api/kafka_broker.ex")).toBe(false);
    expect(files.has("ship_api/lib/ship_api/kafka_consumer.ex")).toBe(false);
    const mix = files.get("sales_api/mix.exs") ?? "";
    expect(mix).toContain('{:amqp, "~> 4.0"}');
    expect(mix).not.toContain(":brod");
    const dockerfile = files.get("sales_api/Dockerfile") ?? "";
    expect(dockerfile).toContain("build-essential git ca-certificates");
    expect(dockerfile).not.toContain("cmake");
  });
});
