// M-T4.4 slice 7b — RabbitMQ queue transport on the .NET (ASP.NET Core)
// backend, mirroring the Hono pins in ../channels-rabbit-transport.test.ts
// and the Python leg in ../python/channels-rabbit-python.test.ts.
//
// A dotnet deployable that wires a rabbitmq-bound `queue` channelSource via
// `channels:` gets: the RabbitMQ.Client driver in the generated
// ChannelTransport.cs (durable fanout exchange per address, one durable
// queue per consuming deployable — the consumer group replicas compete on —
// manual ack, bounded retry, DLX `loom.dlx` → `loom.dlq.<address>` parking),
// the producer-path split (design §5: `queue`/`work` events reach the outbox
// and publish on relay drain; the inline tee only publishes ephemeral
// events), the wiring-gated RabbitMQ.Client dep, and the workflow-less
// durable producer's outbox + relay shape.

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
  deployable salesApi { platform: dotnet contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: dotnet contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("rabbitmq queue transport — dotnet leg (M-T4.4 slice 7b)", () => {
  it("emits the RabbitMQ.Client driver with the §4 topology on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"] as const) {
      const mod = files.get(`${dep}/Infrastructure/Channels/ChannelTransport.cs`) ?? "";
      expect(mod, `${dep} ChannelTransport.cs`).toContain("using RabbitMQ.Client;");
      // IDisposable: the transport owns a SemaphoreSlim connect gate —
      // without it CA1001 fails `dotnet build /warnaserror`.
      expect(mod).toContain(
        "public sealed class RabbitChannelTransport : IChannelTransport, IDisposable",
      );
      expect(mod).toContain("public void Dispose()");
      // Dead-letter topology: DLX exchange + per-address parking queue,
      // wired as the consumer queue's dead-letter target.
      expect(mod).toContain(
        'await ch.ExchangeDeclareAsync("loom.dlx", ExchangeType.Direct, durable: true);',
      );
      expect(mod).toContain('var dlq = $"loom.dlq.{address}";');
      expect(mod).toContain('["x-dead-letter-exchange"] = "loom.dlx",');
      expect(mod).toContain('"channel_dead_lettered"');
      // The redis driver stays out of a rabbit-only module.
      expect(mod).not.toContain("RedisChannelTransport");
      const csproj =
        files.get(`${dep}/${dep === "sales_api" ? "SalesApi" : "ShipApi"}.csproj`) ?? "";
      expect(csproj).toContain('PackageReference Include="RabbitMQ.Client"');
      expect(csproj).not.toContain("StackExchange.Redis");
    }
    // The consumer group is the deployable's durable queue name.
    expect(files.get("ship_api/Infrastructure/Channels/ChannelTransport.cs")).toContain(
      '"loom.Orders.Lifecycle.shipApi"',
    );
  });

  it("routes queue/work events through the outbox: tee passes, relay publishes", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("sales_api/Infrastructure/Channels/ChannelTransport.cs") ?? "";
    // The durable routing table exists and the tee defers those events to the
    // inner dispatcher (design §5 producer split).
    expect(mod).toContain(
      "public static readonly IReadOnlyDictionary<string, string> DurableRouting",
    );
    expect(mod).toContain('        ["OrderPlaced"] = "loom.Orders.Lifecycle",');
    expect(mod).toContain("if (ChannelBindings.DurableRouting.ContainsKey(type)");
    // Relay-published envelopes reuse the outbox row id as the idempotency key.
    expect(mod).toContain("public static class ChannelRelayPublisher");
    // The producer hosts NO workflow, yet gets the outbox + relay (the Hono
    // forceOutbox / python pure-producer twin) wrapping the Noop.
    const dispatcher =
      files.get("sales_api/Infrastructure/Events/OutboxDomainEventDispatcher.cs") ?? "";
    expect(dispatcher).toContain(
      "OutboxDomainEventDispatcher(AppDbContext db, NoopDomainEventDispatcher inner)",
    );
    const relay = files.get("sales_api/Infrastructure/Events/OutboxRelayService.cs") ?? "";
    expect(relay).toContain(
      "ChannelRelayPublisher.TryPublishAsync(_transports, ev, row.Id.ToString(), _log)",
    );
    expect(relay).not.toContain("GetRequiredService<InProcessDomainEventDispatcher>");
    const program = files.get("sales_api/Program.cs") ?? "";
    expect(program).toContain("builder.Services.AddSingleton<NoopDomainEventDispatcher>();");
    expect(program).toContain("builder.Services.AddHostedService<OutboxRelayService>();");
  });

  it("subscribes the consumer on its competing group and stamps no idempotency marker without a local outbox", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("ship_api/Infrastructure/Channels/ChannelTransport.cs") ?? "";
    // Queue subscriptions ride the strict handler — the driver's bounded
    // retry/park owns failures — with the deployable's consumer group.
    expect(mod).toContain("await transport.SubscribeAsync(binding.Address, binding.Group,");
    // The consumer does NOT host the durable channel's context: no outbox
    // tier, no OutboxDelivery marker — broker ack semantics carry the
    // redelivery contract (the slice-3 stance).
    expect(mod).not.toContain("OutboxDelivery.CurrentEventId");
    expect(files.get("ship_api/Infrastructure/Events/OutboxRelayService.cs")).toBeUndefined();
    // Foreign vocabulary still lands: event record + id brand + routing.
    expect(files.get("ship_api/Domain/Events/OrderPlaced.cs")).toBeDefined();
    expect(files.get("ship_api/Domain/Ids/OrderId.cs")).toBeDefined();
  });

  it("provisions the RabbitMQ sidecar and injects the amqp URL in compose", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const compose = files.get("docker-compose.yml") ?? "";
    expect(compose).toContain("image: rabbitmq:4-management-alpine");
    expect(compose).toContain('LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://guest:guest@bus:5672"');
  });

  it("keeps the redis (slice 6a) shape intact — no rabbit artifacts, no outbox forcing", async () => {
    const redisFixture = FIXTURE.replace("type: rabbitmq", "type: redis").replace(
      /delivery: queue\s+retention: work/,
      "delivery: broadcast\n        retention: ephemeral",
    );
    const files = await generateSystemFiles(redisFixture);
    const mod = files.get("sales_api/Infrastructure/Channels/ChannelTransport.cs") ?? "";
    expect(mod).toContain("RedisChannelTransport");
    expect(mod).not.toContain("RabbitMQ.Client");
    // Broadcast/ephemeral events stay on the inline tee; no durable routing.
    expect(mod).toContain('        ["OrderPlaced"] = "loom.Orders.Lifecycle",');
    expect(files.get("sales_api/Infrastructure/Events/OutboxRelayService.cs")).toBeUndefined();
    expect(files.get("sales_api/SalesApi.csproj")).not.toContain("RabbitMQ.Client");
  });
});
