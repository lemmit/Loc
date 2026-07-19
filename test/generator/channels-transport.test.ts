// M-T4.4 slice 2 — Redis/Valkey broker transport on the Hono backend.
//
// A deployable that wires a redis-bound `broadcast`/`ephemeral`
// channelSource via `channels:` gets: the generated `http/channels.ts`
// transport module (ChannelTransport seam + ioredis driver + producer tee +
// consumer loop), the boot wiring in index.ts, the `ioredis` dep, and — in
// docker-compose.yml — a `valkey/valkey` sidecar (design §6a licensing:
// never the relicensed `redis:` images) plus the `LOOM_CHANNEL_*_URL` env.
//
// The cross-deployable half: the CONSUMER deployable does not host the
// channel's owning context — the wired binding carries the routing
// knowledge, the foreign event joins its `domain/events.ts` vocabulary
// (with the foreign id brand in `domain/ids.ts`), and the in-process
// dispatcher routes the received event to the hosted reactor.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

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
  deployable salesApi { platform: node contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("redis broker transport (M-T4.4 slice 2)", () => {
  it("emits the transport module on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = files.get(`${dep}/http/channels.ts`);
      expect(mod, `${dep}/http/channels.ts`).toBeDefined();
      expect(mod).toContain("export interface ChannelTransport");
      expect(mod).toContain("loomchannel: string;");
      expect(mod).toContain('address: "loom.Orders.Lifecycle"');
      expect(mod).toContain('envVar: "LOOM_CHANNEL_LIFECYCLE_BUS_URL"');
      expect(mod).toContain("createRedisTransport");
      // The delivery-uniformity rule: broker-routed events publish and skip
      // the local fan-out; consumers receive via the subscription.
      expect(mod).toContain("channelPublishTee");
      expect(mod).toContain("startChannelConsumers");
      expect(files.get(`${dep}/package.json`)).toContain('"ioredis"');
    }
  });

  it("boots the tee in both deployables; the consumer loop only where reactors live", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const index = files.get(`${dep}/index.ts`) ?? "";
      expect(index).toContain("createChannelTransports()");
      expect(index).toContain("channelPublishTee(channelTransports,");
    }
    // salesApi is a pure producer (no hosted reactor): no consumer loop, and
    // shutdown closes the transports directly.
    const producer = files.get("sales_api/index.ts") ?? "";
    expect(producer).not.toContain("startChannelConsumers");
    expect(producer).toContain("closeChannelTransports(channelTransports)");
    // shipApi hosts the Fulfil reactor: the consumer loop starts at boot and
    // its stop function (which closes the transports) runs at shutdown.
    const consumer = files.get("ship_api/index.ts") ?? "";
    expect(consumer).toContain("startChannelConsumers(channelTransports, inProcessEvents)");
    expect(consumer).toContain("stopChannelConsumers()");
  });

  it("gives the consumer the foreign event vocabulary and reactor routing", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // shipApi does NOT host Orders, yet consumes OrderPlaced via the wired
    // channel: the event type + id brand + dispatcher arm must all exist.
    expect(files.get("ship_api/domain/events.ts")).toContain("export interface OrderPlaced");
    expect(files.get("ship_api/domain/ids.ts")).toContain("export type OrderId");
    const workflows = files.get("ship_api/http/workflows.ts") ?? "";
    expect(workflows).toContain('case "OrderPlaced"');
  });

  it("provisions the Valkey sidecar and injects the broker URL in compose", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: valkey/valkey:8-alpine");
    expect(compose).not.toContain("image: redis:");
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "redis://bus:6379"');
    // Both deployables order startup after the sidecar's healthcheck.
    expect(compose.split("bus:\n        condition: service_healthy").length - 1).toBe(2);
    expect(compose).toContain('test: ["CMD", "valkey-cli", "ping"]');
  });

  it("keeps a channel-less system free of transport artifacts", async () => {
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
  deployable api { platform: node contexts: [C] dataSources: [cState] port: 3000 }
}
`;
    const files = await generateSystemFiles(bare);
    expect(files.get("api/http/channels.ts")).toBeUndefined();
    expect(files.get("api/package.json")).not.toContain("ioredis");
    expect(files.get("api/index.ts")).not.toContain("channelPublishTee");
    expect(files.get("docker-compose.yml")).not.toContain("valkey");
  });
});
