// M-T4.4 slice 2b — Redis/Valkey broker transport on the Python (FastAPI)
// backend, mirroring the Hono pins in ../channels-transport.test.ts.
//
// A python deployable that wires a redis-bound `broadcast`/`ephemeral`
// channelSource via `channels:` gets: the generated `app/channels.py`
// transport module (CloudEvents envelope codec + redis.asyncio driver +
// publish half of the tee + consumer loop), the ChannelTeeDispatcher inside
// `make_dispatcher`, the lifespan boot wiring, and the wiring-gated `redis`
// dep.  The cross-deployable half: a consumer that does not host the
// channel's owning context still gets the foreign event dataclass, its id
// brand, and the dispatcher routing.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order { customerId: string }
      repository Orders for Order {}
      event OrderPlaced { orderId: Order id }
      channel Lifecycle { carries: OrderPlaced }
      workflow placeOrder {
        orderId: Order id
        handle place(orderId: Order id) {
          emit OrderPlaced { orderId: orderId }
        }
      }
    }
    context Shipping {
      aggregate Shipment { orderRef: string }
      repository Shipments for Shipment {}
      workflow Fulfil {
        orderId: Order id
        on(e: OrderPlaced) by e.orderId {
          let s = Shipment.create({ orderRef: "from-broker" })
        }
      }
    }
  }
  storage primary { type: postgres }
  storage bus { type: redis }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: python contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: python contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("redis broker transport — python leg (M-T4.4 slice 2b)", () => {
  it("emits the transport module on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = files.get(`${dep}/app/channels.py`);
      expect(mod, `${dep}/app/channels.py`).toBeDefined();
      expect(mod).toContain('"loomchannel": address,');
      expect(mod).toContain('"address": "loom.Orders.Lifecycle"');
      expect(mod).toContain('"env_var": "LOOM_CHANNEL_LIFECYCLE_BUS_URL"');
      expect(mod).toContain("class RedisChannelTransport:");
      expect(mod).toContain("async def publish_event(event: DomainEvent) -> bool:");
      expect(files.get(`${dep}/pyproject.toml`)).toContain('"redis>=');
    }
  });

  it("wraps make_dispatcher in the tee on both; the consumer loop only where reactors live", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const dispatch = files.get(`${dep}/app/dispatch.py`) ?? "";
      expect(dispatch).toContain("class ChannelTeeDispatcher:");
      expect(dispatch).toContain("return ChannelTeeDispatcher(");
      const main = files.get(`${dep}/app/main.py`) ?? "";
      expect(main).toContain("init_channel_transports()");
      expect(main).toContain("await close_channel_transports()");
    }
    // salesApi is a pure producer (no hosted reactor): its dispatch.py is the
    // tee over the Noop, and no consumer loop starts.  The broadcast channel
    // also makes its events UI-observable, so the realtime tee sits inside
    // the broker tee (channels.md Part I).
    const producerDispatch = files.get("sales_api/app/dispatch.py") ?? "";
    expect(producerDispatch).toContain(
      "ChannelTeeDispatcher(RealtimeDispatcher(NoopDomainEventDispatcher()))",
    );
    expect(files.get("sales_api/app/main.py")).not.toContain("start_channel_consumers");
    expect(files.get("sales_api/app/channels.py")).not.toContain("_run_channel_consumers");
    // shipApi hosts the Fulfil reactor: the consumer loop starts at boot and
    // dispatches into the same in-process dispatcher local reactors use.
    expect(files.get("ship_api/app/main.py")).toContain(
      "_channel_consumers = start_channel_consumers()",
    );
    expect(files.get("ship_api/app/channels.py")).toContain(
      "InProcessDispatcher(session).dispatch(event)",
    );
  });

  it("gives the consumer the foreign event vocabulary and reactor routing", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // shipApi does NOT host Orders, yet consumes OrderPlaced via the wired
    // channel: the event dataclass + id brand + dispatch arm must all exist.
    expect(files.get("ship_api/app/domain/events.py")).toContain("class OrderPlaced:");
    expect(files.get("ship_api/app/domain/ids.py")).toContain('OrderId = NewType("OrderId", str)');
    expect(files.get("ship_api/app/dispatch.py")).toContain("isinstance(event, OrderPlaced)");
  });

  it("provisions the Valkey sidecar and injects the broker URL in compose", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: valkey/valkey:8-alpine");
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "redis://bus:6379"');
  });

  it("keeps a channel-less python system free of transport artifacts", async () => {
    const bare = `
system Bare {
  subdomain S {
    context C {
      aggregate Item with crudish { name: string }
      repository Items for Item {}
    }
  }
  storage primary { type: postgres }
  resource cState { for: C, kind: state, use: primary }
  deployable api { platform: python contexts: [C] dataSources: [cState] port: 3000 }
}
`;
    const files = await generateSystemFiles(bare);
    expect(files.get("api/app/channels.py")).toBeUndefined();
    expect(files.get("api/pyproject.toml")).not.toContain('"redis>=');
    expect(files.get("api/app/main.py")).not.toContain("channel");
    expect(files.get("api/app/dispatch.py")).toBeUndefined();
  });
});
