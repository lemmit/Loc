// M-T4.4 slice 8b — Kafka log transport on the .NET (ASP.NET Core)
// backend, mirroring the Hono pins in ../channels-kafka-transport.test.ts
// and the python leg.
//
// A dotnet deployable that wires a kafka-bound channelSource via
// `channels:` gets: the Confluent.Kafka driver (Apache 2.0 — the design
// §6a pick) in the generated ChannelTransport.cs — one topic per channel
// address (idempotently admin-created before the group join), partition
// key = `loomkey` ?? envelope id (the envelope stamps the channel's
// `key:` field value via the binding row), consumption ALWAYS on the
// deployable's consumer group (kafka bindings take the strict subscribe
// path), EnableAutoCommit=false with a commit after the handler resolves,
// dead-letter v1 park onto `<address>.dlq` — plus the §5 producer split
// (`log` retention is durable: tee → outbox → relay publish with the row
// id) and the wiring-gated Confluent.Kafka csproj ref.

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
  deployable salesApi { platform: dotnet contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: dotnet contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

/** Finds the single generated file whose path ends with the given suffix. */
function find(files: Map<string, string>, dep: string, suffix: string): string {
  for (const [path, content] of files) {
    if (path.startsWith(`${dep}/`) && path.endsWith(suffix)) return content;
  }
  return "";
}

describe("kafka log transport — dotnet leg (M-T4.4 slice 8b)", () => {
  it("emits the Confluent.Kafka driver with the §4 topology on both wired deployables", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const dep of ["sales_api", "ship_api"]) {
      const mod = find(files, dep, "ChannelTransport.cs");
      expect(mod).toContain("using Confluent.Kafka;");
      expect(mod).toContain("public sealed class KafkaChannelTransport : IChannelTransport");
      // Partition key = loomkey ?? envelope id (per-key ordering); the
      // binding row carries the channel's declared key field.
      expect(mod).toContain("var key = envelope.LoomKey ?? envelope.Id;");
      expect(mod).toContain(
        '"loom.Orders.Lifecycle.' +
          (dep === "sales_api" ? "salesApi" : "shipApi") +
          '", false, "order"',
      );
      // Idempotent topic ensure before the group join.
      expect(mod).toContain("await EnsureTopicAsync(address);");
      expect(mod).toContain("r.Error.Code == ErrorCode.TopicAlreadyExists");
      // Offset commit after the handler resolves; dead-letter v1 park.
      expect(mod).toContain("EnableAutoCommit = false,");
      expect(mod).toContain("await ParkAsync(address, result.Message);");
      expect(mod).toContain('"channel_dead_lettered"');
      // The other drivers stay out of a kafka-only module.
      expect(mod).not.toContain("RedisChannelTransport");
      expect(mod).not.toContain("RabbitChannelTransport");
      const csproj = find(files, dep, `${dep === "sales_api" ? "SalesApi" : "ShipApi"}.csproj`);
      expect(csproj).toContain('<PackageReference Include="Confluent.Kafka" Version="2.6.1" />');
      expect(csproj).not.toContain("StackExchange.Redis");
      expect(csproj).not.toContain("RabbitMQ.Client");
    }
  });

  it("routes broadcast/log events through the outbox and stamps LoomKey", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = find(files, "sales_api", "ChannelTransport.cs");
    // `log` retention is durable — the §5 split: the tee defers, the relay
    // publishes with the outbox row id.
    expect(mod).toContain(
      '[property: JsonPropertyName("loomkey"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? LoomKey',
    );
    expect(mod).toContain('["OrderPlaced"] = "loom.Orders.Lifecycle",');
    expect(mod).toContain(
      "if (bound.Key is not null && raw.TryGetValue(bound.Key, out var keyValue) && keyValue is not null)",
    );
    // The consumer (ship side): kafka bindings take the strict (group)
    // subscribe path, and the consumed log carries the partition key (the
    // e2e ordering probe reads it).
    const consumer = find(files, "ship_api", "ChannelTransport.cs");
    expect(consumer).toContain('if (binding.Queue || binding.Transport == "kafka")');
    expect(consumer).toContain(
      '"channel_consumed", binding.Address, envelope.Type, envelope.Id, envelope.LoomKey',
    );
  });

  it("keeps the rabbit (7b) shape stable — no kafka artifacts leak", async () => {
    const rabbitFixture = FIXTURE.replace("type: kafka", "type: rabbitmq")
      .replace("delivery: broadcast", "delivery: queue")
      .replace("retention: log", "retention: work")
      .replace(/\s*key: order/, "");
    const files = await generateSystemFiles(rabbitFixture);
    const mod = find(files, "sales_api", "ChannelTransport.cs");
    expect(mod).toContain("RabbitChannelTransport");
    expect(mod).not.toContain("Kafka");
    expect(mod).not.toContain("LoomKey");
    expect(find(files, "sales_api", "SalesApi.csproj")).not.toContain("Confluent.Kafka");
  });
});
