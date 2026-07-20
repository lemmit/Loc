// M-T4.4 slice 8a — Kafka log transport on the Python (FastAPI) backend,
// mirroring the Hono pins in ../channels-kafka-transport.test.ts.
//
// A python deployable that wires a kafka-bound channelSource via
// `channels:` gets: the aiokafka driver (Apache 2.0, asyncio-native —
// §6a licensing) in `app/channels.py` — one topic per channel address
// (idempotently admin-created before the group join), partition key =
// `loomkey` ?? envelope id (the envelope stamps the channel's `key:`
// field value), consumption ALWAYS on the deployable's consumer group,
// offset commit after the handler resolves, dead-letter v1 park onto
// `<address>.dlq` — plus the §5 producer split (`log` retention is
// durable: tee → outbox → relay publish with the row id) and the
// wiring-gated aiokafka dep + mypy override (aiokafka ships no py.typed).

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
  deployable salesApi { platform: python contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: python contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("kafka log transport — python leg (M-T4.4 slice 8a)", () => {
  it("emits the aiokafka driver with the §4 topology on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = files.get(`${dep}/app/channels.py`) ?? "";
      expect(mod).toContain("from aiokafka import AIOKafkaConsumer, AIOKafkaProducer");
      expect(mod).toContain("class KafkaChannelTransport:");
      // Partition key = loomkey ?? envelope id (per-key ordering); the
      // binding row carries the channel's declared key field.
      expect(mod).toContain('key = str(envelope.get("loomkey") or envelope["id"])');
      expect(mod).toContain(
        '"group": "loom.Orders.Lifecycle.' +
          (dep === "sales_api" ? "salesApi" : "shipApi") +
          '", "key": "order"',
      );
      // Idempotent topic ensure before the group join.
      expect(mod).toContain("await self._ensure_topic(address)");
      expect(mod).toContain("except TopicAlreadyExistsError:");
      // Offset commit after the handler resolves; dead-letter v1 park.
      expect(mod).toContain("enable_auto_commit=False,");
      expect(mod).toContain('await producer.send_and_wait(f"{address}.dlq", raw, key=key)');
      expect(mod).toContain('"channel_dead_lettered"');
      // The other drivers stay out of a kafka-only module.
      expect(mod).not.toContain("RedisChannelTransport");
      expect(mod).not.toContain("RabbitChannelTransport");
      const pyproject = files.get(`${dep}/pyproject.toml`) ?? "";
      expect(pyproject).toContain('"aiokafka>=0.12,<0.13",');
      expect(pyproject).toContain('module = "aiokafka.*"');
      expect(pyproject).not.toContain("aio-pika");
    }
  });

  it("routes broadcast/log events through the outbox and stamps loomkey", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("sales_api/app/channels.py") ?? "";
    // `log` retention is durable — the §5 split: the inline tee routes
    // nothing, the relay publishes with the outbox row id.
    expect(mod).toContain(
      'DURABLE_CHANNEL_ROUTING: dict[str, str] = {\n    "OrderPlaced": "loom.Orders.Lifecycle",\n}',
    );
    expect(mod).toContain("async def publish_event_from_relay(");
    // The envelope stamps loomkey from the channel's key: field value.
    expect(mod).toContain('envelope["loomkey"] = str(key_value)');
    // Pure producer + realtime (broadcast) compose: the outbox wraps the
    // realtime tee, typed accordingly.
    const dispatch = files.get("sales_api/app/dispatch.py") ?? "";
    expect(dispatch).toContain(
      "ChannelTeeDispatcher(OutboxDispatcher(session, RealtimeDispatcher(NoopDomainEventDispatcher())))",
    );
    expect(dispatch).toContain(
      'def __init__(self, session: AsyncSession, inner: "RealtimeDispatcher | NoopDomainEventDispatcher") -> None:',
    );
  });

  it("subscribes the consumer on its group and logs the partition key", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("ship_api/app/channels.py") ?? "";
    expect(mod).toContain(
      'await transport.subscribe(binding["address"], binding["group"], _consume_one)',
    );
    // The consumed log carries the loomkey (the e2e ordering probe reads it).
    expect(mod).toContain(
      '**({"key": cast(str, envelope["loomkey"])} if "loomkey" in envelope else {}),',
    );
  });

  it("keeps the rabbit (7a) shape byte-stable — no kafka artifacts leak", async () => {
    const rabbitFixture = FIXTURE.replace("type: kafka", "type: rabbitmq")
      .replace("delivery: broadcast", "delivery: queue")
      .replace("retention: log", "retention: work")
      .replace(/\s*key: order/, "");
    const files = await generateSystemFiles(rabbitFixture);
    const mod = files.get("sales_api/app/channels.py") ?? "";
    expect(mod).toContain("RabbitChannelTransport");
    expect(mod).not.toContain("Kafka");
    expect(mod).not.toContain("loomkey");
    expect(mod).not.toContain('"key"');
    const dispatch = files.get("sales_api/app/dispatch.py") ?? "";
    expect(dispatch).toContain(
      "ChannelTeeDispatcher(OutboxDispatcher(session, NoopDomainEventDispatcher()))",
    );
    expect(dispatch).toContain(
      "def __init__(self, session: AsyncSession, inner: NoopDomainEventDispatcher) -> None:",
    );
    const pyproject = files.get("sales_api/pyproject.toml") ?? "";
    expect(pyproject).not.toContain("aiokafka");
    expect(pyproject).not.toContain("tool.mypy.overrides");
  });
});
