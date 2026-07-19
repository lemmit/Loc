// M-T4.4 slice 6a — Redis/Valkey broker transport on the .NET backend,
// mirroring the Hono pins in ../channels-transport.test.ts and the Python
// leg in ../python/channels-transport-python.test.ts.
//
// A dotnet deployable that wires a redis-bound `broadcast`/`ephemeral`
// channelSource via `channels:` gets: the generated
// `Infrastructure/Channels/ChannelTransport.cs` (CloudEvents envelope codec
// + StackExchange.Redis driver + publish-tee dispatcher + consumer
// BackgroundService), the Program.cs registrations, and the wiring-gated
// StackExchange.Redis dep.  The cross-deployable half: a consumer that does
// not host the channel's owning context still gets the foreign event
// record, its id brand, and the Mediator reactor handler.

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
  deployable salesApi { platform: dotnet contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: dotnet contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("redis broker transport — dotnet leg (M-T4.4 slice 6a)", () => {
  it("emits the transport module on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = files.get(`${dep}/Infrastructure/Channels/ChannelTransport.cs`);
      expect(mod, `${dep} ChannelTransport.cs`).toBeDefined();
      expect(mod).toContain("public sealed record LoomEventEnvelope(");
      expect(mod).toContain('"loom.Orders.Lifecycle"');
      expect(mod).toContain('"LOOM_CHANNEL_LIFECYCLE_BUS_URL"');
      expect(mod).toContain("public sealed class RedisChannelTransport : IChannelTransport");
      expect(mod).toContain(
        "public sealed class ChannelPublishTeeDispatcher : IDomainEventDispatcher",
      );
      expect(files.get(`${dep}/${dep === "sales_api" ? "SalesApi" : "ShipApi"}.csproj`)).toContain(
        '"StackExchange.Redis"',
      );
    }
  });

  it("registers the tee in both; the consumer hosted service only where reactors live", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const program = files.get(`${dep}/Program.cs`) ?? "";
      expect(program).toContain("builder.Services.AddSingleton<ChannelTransports>();");
      expect(program).toContain(
        "builder.Services.AddScoped<IDomainEventDispatcher, ChannelPublishTeeDispatcher>();",
      );
    }
    // salesApi hosts a workflow (the command handler) but no reactor…
    // actually both host workflows; the split pins on reactor presence: the
    // producer's placeOrder has no on/create subscription, so no consumer
    // loop; shipApi's Fulfil reactor starts one.
    expect(files.get("sales_api/Program.cs")).not.toContain("ChannelConsumerService");
    expect(files.get("sales_api/Infrastructure/Channels/ChannelTransport.cs")).not.toContain(
      "ChannelConsumerService",
    );
    expect(files.get("ship_api/Program.cs")).toContain(
      "builder.Services.AddHostedService<ChannelConsumerService>();",
    );
    expect(files.get("ship_api/Infrastructure/Channels/ChannelTransport.cs")).toContain(
      "class ChannelConsumerService : BackgroundService",
    );
  });

  it("gives the consumer the foreign event vocabulary and reactor routing", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // shipApi does NOT host Orders, yet consumes OrderPlaced via the wired
    // channel: the event record + id brand + Mediator handler must all exist.
    expect(files.get("ship_api/Domain/Events/OrderPlaced.cs")).toContain(
      "public sealed record OrderPlaced(",
    );
    expect(files.get("ship_api/Domain/Ids/OrderId.cs")).toContain("record struct OrderId(");
    const handler = [...files.keys()].find(
      (p) => p.startsWith("ship_api/Application/Workflows/") && p.includes("OrderPlaced"),
    );
    expect(handler, "reactor INotificationHandler for the foreign event").toBeDefined();
    expect(files.get(handler ?? "")).toContain("INotificationHandler<OrderPlaced>");
  });

  it("keeps a channel-less dotnet system free of transport artifacts", async () => {
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
  deployable api { platform: dotnet contexts: [C] dataSources: [cState] port: 3000 }
}
`;
    const files = await generateSystemFiles(bare);
    expect(files.get("api/Infrastructure/Channels/ChannelTransport.cs")).toBeUndefined();
    expect(files.get("api/Api.csproj")).not.toContain("StackExchange.Redis");
    expect(files.get("api/Program.cs")).not.toContain("Channel");
  });
});
