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
