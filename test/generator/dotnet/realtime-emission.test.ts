import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — .NET (channels.md Part I).  The .NET mirror of the Hono
// slice: a `delivery: broadcast` channel makes its carried events UI-observable
// at GET /api/realtime/events.  The RealtimeHub (thread-safe subscriber
// registry + wire serializer) fans events out; the RealtimeDomainEventDispatcher
// tee wraps the registered IDomainEventDispatcher so every dispatched event also
// reaches the wire.  A broadcast-free deployable emits none of it (byte-identical).
// The `dotnet build /warnaserror` gate is verified end-to-end in the compile tier.
// ---------------------------------------------------------------------------

function system(platform: string, channel: string): string {
  return `
system RealtimeShop {
  subdomain Shipping {
  context Fulfillment {
    aggregate Order { customerId: string  status: string  total: int  derived display: string = customerId }
    repository Orders for Order { }
    aggregate Shipment {
      orderRef: Order id
      status: string
      operation markTracked() { status := "Tracked" }
    }
    repository Shipments for Shipment { }

    event OrderPlaced { order: Order id, at: datetime }
    event ShipmentRequested { shipment: Shipment id, order: Order id, at: datetime }
${channel}
    workflow OrderFulfillment {
      orderId: Order id
      create(p: OrderPlaced) by p.order {
        let ship = Shipment.create({ orderRef: p.order, status: "Pending" })
        emit ShipmentRequested { shipment: ship.id, order: p.order, at: now() }
      }
      on(s: ShipmentRequested) by s.order {
        let ship = Shipments.getById(s.shipment)
        ship.markTracked()
      }
    }
  }
  }
  api FulfillmentApi from Shipping
  storage primary { type: postgres }
  resource fulfillmentState { for: Fulfillment, kind: state, use: primary }
  deployable backend {
    platform: ${platform}
    contexts: [Fulfillment]
    dataSources: [fulfillmentState]
    serves: FulfillmentApi
    port: 8080
  }
}
`;
}

const BROADCAST = `
    channel Lifecycle {
      carries: OrderPlaced, ShipmentRequested
      delivery: broadcast
      retention: ephemeral
    }
`;

// A `queue` channel is work distribution, never UI-observable — no realtime wire.
const QUEUE = `
    channel Lifecycle {
      carries: OrderPlaced, ShipmentRequested
      delivery: queue
      retention: ephemeral
    }
`;

async function generate(src: string): Promise<Map<string, string>> {
  const model = await parseValid(src);
  return generateSystems(model).files;
}

const get = (files: Map<string, string>, suffix: string): string =>
  files.get([...files.keys()].find((k) => k.endsWith(suffix)) ?? "") ?? "";

describe("realtime SSE wire — .NET (delivery: broadcast)", () => {
  it("emits the hub, the dispatcher tee, and the SSE endpoint", async () => {
    const files = await generate(system("dotnet", BROADCAST));

    // (a) The SSE endpoint file + route.
    const hub = get(files, "Infrastructure/Realtime/RealtimeHub.cs");
    expect(hub).toContain("public sealed class RealtimeHub");
    expect(hub).toContain(
      'public static readonly IReadOnlySet<string> EventTypes = new HashSet<string> { "OrderPlaced", "ShipmentRequested" };',
    );
    expect(hub).toContain("public void Publish(IDomainEvent domainEvent)");
    expect(hub).toContain('node["type"] = type;');
    const program = get(files, "backend/Program.cs");
    expect(program).toContain('app.MapGet("/api/realtime/events", async (HttpContext http,');
    expect(program).toContain('"event: ping\\ndata: \\n\\n"');
    expect(program).toContain(
      "builder.Services.AddSingleton<Backend.Infrastructure.Realtime.RealtimeHub>();",
    );

    // (c) The tee wraps the in-process dispatcher.
    const dispatcher = get(files, "Infrastructure/Events/RealtimeDomainEventDispatcher.cs");
    expect(dispatcher).toContain(
      "public sealed class RealtimeDomainEventDispatcher : IDomainEventDispatcher",
    );
    expect(dispatcher).toContain("_hub.Publish(ev);");
    expect(dispatcher).toContain("return _inner.DispatchAsync(ev, cancellationToken);");
    expect(program).toContain(
      "new RealtimeDomainEventDispatcher(sp.GetRequiredService<InProcessDomainEventDispatcher>(), sp.GetRequiredService<Backend.Infrastructure.Realtime.RealtimeHub>())",
    );
  });

  it("(b) a non-broadcast channel keeps the wire-free output (byte-identical)", async () => {
    const files = await generate(system("dotnet", QUEUE));
    expect(
      [...files.keys()].some((k) => k.endsWith("Infrastructure/Realtime/RealtimeHub.cs")),
    ).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith("RealtimeDomainEventDispatcher.cs"))).toBe(
      false,
    );
    const program = get(files, "backend/Program.cs");
    expect(program).not.toContain("RealtimeHub");
    expect(program).not.toContain("/api/realtime/events");
  });
});

// ─── Rooms + policy-derived routing v1 (tenant-scoped delivery) ─────────────

// A tenant-owned realtime context: OrderPlaced references the `tenantOwned`
// Order (tenant-scoped), PlanPublished references the `crossTenant` Plan
// (stays global broadcast).
const TENANT_SYSTEM = `
system TenantShop {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Organization
  subdomain Core {
    context Fulfillment {
      aggregate Order with tenantOwned, crudish { status: string }
      repository Orders for Order { }
      crossTenant aggregate Plan with crudish { title: string }
      repository Plans for Plan { }
      event OrderPlaced { order: Order id, at: datetime }
      event PlanPublished { plan: Plan id, at: datetime }
      channel Lifecycle { carries: OrderPlaced, PlanPublished  delivery: broadcast  retention: ephemeral }
    }
    context Accounts {
      aggregate Organization with crudish { name: string }
    }
  }
  api FulfillmentApi from Core
  storage primary { type: postgres }
  resource coreSt { for: Fulfillment, kind: state, use: primary }
  resource acctSt { for: Accounts, kind: state, use: primary }
  deployable backend {
    platform: dotnet
    contexts: [Fulfillment, Accounts]
    dataSources: [coreSt, acctSt]
    serves: FulfillmentApi
    port: 8080
    auth: required
  }
}
`;

describe("realtime rooms — .NET (tenant-scoped delivery)", () => {
  it("keys the hub by tenant and scopes only tenantOwned-referencing events", async () => {
    const files = await generate(TENANT_SYSTEM);
    const hub = get(files, "Infrastructure/Realtime/RealtimeHub.cs");
    // Both carried events are UI-observable...
    expect(hub).toContain(
      'public static readonly IReadOnlySet<string> EventTypes = new HashSet<string> { "OrderPlaced", "PlanPublished" };',
    );
    // ...but only OrderPlaced references the tenant-owned Order.
    expect(hub).toContain(
      'private static readonly HashSet<string> TenantScopedEventTypes = new() { "OrderPlaced" };',
    );
    expect(hub).toContain('{ "OrderPlaced", new[] { "order" } },');
    // Per-tenant rooms + subscriber-tenant tracking.
    expect(hub).toContain(
      "private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Channel<string>>> _rooms = new();",
    );
    expect(hub).toContain(
      "public (Guid Id, ChannelReader<string> Reader) Subscribe(string? tenant)",
    );
    // Publish routes tenant-scoped events off the ambient RequestContext tenant.
    expect(hub).toContain("if (!TenantScopedEventTypes.Contains(type))");
    expect(hub).toContain(
      "var tenant = RequestContext.Current?.CurrentUser is { } user ? user.TenantId.ToString() : null;",
    );
    expect(hub).toContain("var ticket = Ticket(type, node);");
    // The SSE endpoint joins the connecting principal's tenant room.
    const program = get(files, "backend/Program.cs");
    expect(program).toContain(
      "var tenant = Backend.Domain.Common.RequestContext.Current?.CurrentUser is { } __rtUser ? __rtUser.TenantId.ToString() : null;",
    );
    expect(program).toContain("var (id, reader) = hub.Subscribe(tenant);");
  });

  it("an untenanted broadcast context keeps the broadcast-to-all hub (no rooms)", async () => {
    const hub = get(await generate(system("dotnet", BROADCAST)), "RealtimeHub.cs");
    expect(hub).not.toContain("TenantScopedEventTypes");
    expect(hub).not.toContain("_rooms");
    expect(hub).toContain("public (Guid Id, ChannelReader<string> Reader) Subscribe()");
  });
});
