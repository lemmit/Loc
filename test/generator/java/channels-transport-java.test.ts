// M-T4.4 slice 6b — Redis/Valkey broker transport on the Java (Spring Boot)
// backend, mirroring the Hono pins in ../channels-transport.test.ts, the
// Python leg in ../python/channels-transport-python.test.ts, and the .NET
// leg in ../dotnet/channels-transport-dotnet.test.ts.
//
// A java deployable that wires a redis-bound `broadcast`/`ephemeral`
// channelSource via `channels:` gets: the generated channel classes under
// `config` (CloudEvents envelope + per-event codec + Lettuce driver +
// `DomainEvent`-typed publish tee + consumer service), the wiring-gated
// lettuce-core dep, and the §4 delivery-uniformity gate (dispatcher handlers
// for broker-routed events drop their local @EventListener — the consumer
// service invokes them on delivery).  The cross-deployable half: a consumer
// that does not host the channel's owning context still gets the foreign
// event record + its id brand.

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
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: java contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

const CFG = "src/main/java/com/loom";

describe("redis broker transport — java leg (M-T4.4 slice 6b)", () => {
  it("emits the transport classes on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const slug = dep === "sales_api" ? "salesapi" : "shipapi";
      const cfg = `${dep}/${CFG}/${slug}/config`;
      expect(files.get(`${cfg}/LoomEventEnvelope.java`), `${dep} envelope`).toContain(
        "public record LoomEventEnvelope(",
      );
      const bindings = files.get(`${cfg}/ChannelBindings.java`) ?? "";
      expect(bindings).toContain('"loom.Orders.Lifecycle"');
      expect(bindings).toContain('"LOOM_CHANNEL_LIFECYCLE_BUS_URL"');
      expect(files.get(`${cfg}/RedisChannelTransport.java`)).toContain(
        "public final class RedisChannelTransport implements ChannelTransport",
      );
      const tee = files.get(`${cfg}/ChannelPublishTee.java`) ?? "";
      expect(tee).toContain("@EventListener");
      expect(tee).toContain("public void on(DomainEvent event)");
      expect(files.get(`${dep}/build.gradle.kts`)).toContain('"io.lettuce:lettuce-core:');
    }
  });

  it("gates the consumer service on reactor presence; the producer ships publish-only", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // salesApi's placeOrder has no on/create subscription → no consumer loop;
    // shipApi's Fulfil reactor starts one, invoking the dispatcher method.
    expect(
      files.get(`sales_api/${CFG}/salesapi/config/ChannelConsumerService.java`),
    ).toBeUndefined();
    const consumer = files.get(`ship_api/${CFG}/shipapi/config/ChannelConsumerService.java`) ?? "";
    expect(consumer).toContain("implements SmartLifecycle");
    expect(consumer).toContain("shippingDispatcher.onFulfilOnOrderPlaced(e);");
  });

  it("drops the local @EventListener on broker-routed dispatcher handlers (§4 uniformity)", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const dispatcher = [...files.entries()].find(([p]) =>
      p.endsWith("ShippingDispatcher.java"),
    )?.[1];
    expect(dispatcher, "ShippingDispatcher on the consumer").toBeDefined();
    expect(dispatcher).toContain("public void onFulfilOnOrderPlaced(OrderPlaced e)");
    expect(dispatcher).not.toContain("@EventListener\n    public void onFulfilOnOrderPlaced");
  });

  it("gives the consumer the foreign event vocabulary", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // shipApi does NOT host Orders, yet consumes OrderPlaced via the wired
    // channel: the event record + id brand must both exist.
    const eventFile = [...files.entries()].find(
      ([p]) => p.startsWith("ship_api/") && p.endsWith("OrderPlaced.java"),
    )?.[1];
    expect(eventFile, "foreign event record on ship_api").toContain("public record OrderPlaced(");
    const idFile = [...files.entries()].find(
      ([p]) => p.startsWith("ship_api/") && p.endsWith("OrderId.java"),
    )?.[1];
    expect(idFile, "foreign id brand on ship_api").toContain("public record OrderId(");
  });

  it("keeps a channel-less java system free of transport artifacts", async () => {
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
  deployable api { platform: java contexts: [C] dataSources: [cState] port: 3000 }
}
`;
    const files = await generateSystemFiles(bare);
    for (const p of files.keys()) {
      expect(p, "no channel classes in a channel-less system").not.toMatch(
        /Channel(Transport|Bindings|Codec|PublishTee|ConsumerService)/,
      );
    }
    expect(files.get("api/build.gradle.kts")).not.toContain("lettuce");
  });
});
