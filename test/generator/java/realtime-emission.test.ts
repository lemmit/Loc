import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — Java / Spring (channels.md Part I).  A `delivery:
// broadcast` channel makes its carried events UI-observable at GET
// /api/realtime/events.  The RealtimeController holds a thread-safe
// CopyOnWriteArrayList of SseEmitters and tees off the always-present
// ApplicationEventPublisher bus (service.ts publishes every drained event)
// via a native @EventListener — no parallel dispatch path.  A broadcast-free
// deployable emits no controller (byte-identical).  The `gradle testClasses
// bootJar` gate is verified end-to-end in the compile tier.
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

describe("realtime SSE wire — Java (delivery: broadcast)", () => {
  it("emits the SseEmitter controller with the @EventListener tee", async () => {
    const files = await generate(system("java", BROADCAST));

    // (a) The SSE endpoint file + route.
    const rc = get(files, "api/RealtimeController.java");
    expect(rc).toContain("public class RealtimeController {");
    expect(rc).toContain(
      'private static final Set<String> REALTIME_EVENT_TYPES = Set.of("OrderPlaced", "ShipmentRequested");',
    );
    expect(rc).toContain('@GetMapping("/api/realtime/events")');
    expect(rc).toContain("public SseEmitter events() {");
    expect(rc).toContain('emitter.send(SseEmitter.event().name("ping").data(""));');
    // camelCase wire payload with the `type` tag + unwrapped ids.
    expect(rc).toContain('m.put("type", "OrderPlaced");');
    expect(rc).toContain('m.put("order", e.order().value());');

    // (c) The tee is the @EventListener on the always-published domain-event bus.
    expect(rc).toContain("@EventListener");
    expect(rc).toContain("public void onDomainEvent(DomainEvent event) {");
    expect(rc).toContain(
      "if (!REALTIME_EVENT_TYPES.contains(event.getClass().getSimpleName())) return;",
    );
    const svc = get(files, "OrderService.java");
    expect(svc).toContain("eventPublisher.publishEvent(event);");
  });

  it("(b) a non-broadcast channel emits no controller (byte-identical)", async () => {
    const files = await generate(system("java", QUEUE));
    expect([...files.keys()].some((k) => k.endsWith("api/RealtimeController.java"))).toBe(false);
  });
});

// ─── Rooms + policy-derived routing v1 (tenant-scoped delivery) ─────────────

const TENANT_SYSTEM = `
system TenantShop {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Organization
  subdomain Core {
    context Fulfillment {
      aggregate Order with tenantOwned, crudish { status: string }
      repository Orders for Order { }
      aggregate Plan crossTenant with crudish { title: string }
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
    platform: java
    contexts: [Fulfillment, Accounts]
    dataSources: [coreSt, acctSt]
    serves: FulfillmentApi
    port: 8080
    auth: required
  }
}
`;

describe("realtime rooms — Java (tenant-scoped delivery)", () => {
  it("keys the SseEmitter registry by tenant and scopes only tenantOwned events", async () => {
    const rc = get(await generate(TENANT_SYSTEM), "api/RealtimeController.java");
    expect(rc).toContain(
      'private static final Set<String> REALTIME_EVENT_TYPES = Set.of("OrderPlaced", "PlanPublished");',
    );
    expect(rc).toContain(
      'private static final Set<String> TENANT_SCOPED_EVENT_TYPES = Set.of("OrderPlaced");',
    );
    expect(rc).toContain('Map.entry("OrderPlaced", List.of("order"))');
    // Per-tenant rooms keyed by the principal's tenant claim.
    expect(rc).toContain(
      "private final ConcurrentHashMap<String, CopyOnWriteArrayList<SseEmitter>> rooms = new ConcurrentHashMap<>();",
    );
    expect(rc).toContain("var tenant = tenantOf(CurrentUserAccessor.currentOrNull());");
    expect(rc).toContain("import com.loom.backend.auth.CurrentUserAccessor;");
    // Publish routes tenant-scoped events to the emitter's room; global stays fan-out.
    expect(rc).toContain("if (!TENANT_SCOPED_EVENT_TYPES.contains(type)) {");
    expect(rc).toContain("if (room != null) fanOut(room, type, wire(event));");
    expect(rc).toContain("fanOut(emitters, type, ticket(event));");
    expect(rc).toContain(
      "return user == null || user.tenantId() == null ? null : String.valueOf(user.tenantId());",
    );
  });

  it("an untenanted broadcast context keeps the broadcast-to-all controller (no rooms)", async () => {
    const rc = get(await generate(system("java", BROADCAST)), "api/RealtimeController.java");
    expect(rc).not.toContain("TENANT_SCOPED_EVENT_TYPES");
    expect(rc).not.toContain("private final ConcurrentHashMap");
  });
});
