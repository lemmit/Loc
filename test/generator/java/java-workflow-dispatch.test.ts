// In-process saga dispatcher on Java (workflow-debt-backend-parity.md, Java
// saga slice 2): a `<Ctx>Dispatcher` @Component whose @EventListener handlers
// react to channel-carried events — load-or-allocate (event `create`) /
// route-or-drop (`on`) the saga row, run the body, and re-publish so
// choreography chains re-enter. Aggregate services publish drained domain
// events through Spring's ApplicationEventPublisher (gated on subscriptions).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  aggregate Shipment { orderRef: Order id  status: string  operation mark() { status := "T" } }
  repository Shipments for Shipment { }
  event OrderPlaced { order: Order id }
  event ShipmentRequested { shipment: Shipment id, order: Order id }
  channel L { carries: OrderPlaced, ShipmentRequested  delivery: broadcast  retention: ephemeral }
  enum FulfillmentStatus { Pending, Shipped }
  workflow OrderFulfillment { orderId: Order id  attempts: int  status: FulfillmentStatus
    create(p: OrderPlaced) by p.order { let s = Shipment.create({ orderRef: p.order, status: "P" }) emit ShipmentRequested { shipment: s.id, order: p.order } }
    on(s: ShipmentRequested) by s.order { let sh = Shipments.getById(s.shipment) sh.mark() } }
} } api A from O storage pg { type: postgres } deployable api { platform: java contexts: [O] serves: A port: 8080 } }`;

// A context with no channel/subscriptions — proves the log-only path is intact.
const PLAIN = `system S { subdomain O { context O {
  aggregate Customer { name: string  operation rename(n: string) { name := n  emit Renamed { customer: id } } }
  repository Customers for Customer { }
  event Renamed { customer: Customer id }
} } api A from O storage pg { type: postgres } deployable api { platform: java contexts: [O] serves: A port: 8080 } }`;

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

describe("java saga dispatcher", () => {
  it("emits a @Component dispatcher with @EventListener handlers", async () => {
    const files = await gen(SRC);
    const d = [...files.entries()].find(([k]) => k.endsWith("Dispatcher.java"))?.[1];
    expect(d, "dispatcher not emitted").toBeDefined();
    expect(d).toContain("@Component");
    expect(d).toContain("public class ODispatcher {");
    expect(d).toContain("private final ApplicationEventPublisher events;");
    expect(d).toContain(
      "private final OrderFulfillmentStateRepository orderFulfillmentStateRepository;",
    );
    expect(d).toContain("@EventListener");
  });

  it("event-triggered create handler loads-or-allocates the saga row", async () => {
    const d = [...(await gen(SRC)).entries()].find(([k]) => k.endsWith("Dispatcher.java"))![1];
    expect(d).toContain("public void onOrderFulfillmentStartOrderPlaced(OrderPlaced p) {");
    expect(d).toContain("var __key = p.order();");
    expect(d).toContain(
      "var state = orderFulfillmentStateRepository.findById(__key).orElseGet(() -> OrderFulfillmentState._allocate(__key));",
    );
    // Body: create + save the Shipment, then re-publish the workflow event AFTER
    // the save so the on-reactor's getById finds the persisted shipment.
    expect(d).toContain('var s = Shipment.create(p.order(), "P");');
    expect(d).toContain("__events.add(new ShipmentRequested(s.id(), p.order()));");
    expect(d).toContain("shipmentsRepository.save(s);");
    expect(d).toContain("orderFulfillmentStateRepository.save(state);");
    expect(d).toContain("for (var __e : __events) events.publishEvent(__e);");
  });

  it("on-reactor routes-or-drops with event_unrouted", async () => {
    const d = [...(await gen(SRC)).entries()].find(([k]) => k.endsWith("Dispatcher.java"))![1];
    expect(d).toContain("public void onOrderFulfillmentOnShipmentRequested(ShipmentRequested s) {");
    expect(d).toContain(
      "var state = orderFulfillmentStateRepository.findById(__key).orElse(null);",
    );
    expect(d).toContain("if (state == null) {");
    expect(d).toContain(
      'CatalogLog.event("event_unrouted", "warn", "workflow", "OrderFulfillment", "event_type", "ShipmentRequested", "key", __key);',
    );
    expect(d).toContain("var sh = shipmentsRepository.getById(s.shipment());");
    expect(d).toContain("sh.mark();");
  });

  it("aggregate services publish drained events when the context has subscriptions", async () => {
    const svc = [...(await gen(SRC)).entries()].find(([k]) => k.endsWith("OrderService.java"))![1];
    expect(svc).toContain("import org.springframework.context.ApplicationEventPublisher;");
    expect(svc).toContain("private final ApplicationEventPublisher eventPublisher;");
    expect(svc).toContain("eventPublisher.publishEvent(event);");
    expect(svc).not.toContain('CatalogLog.event("event_dispatched"');
  });

  it("stays log-only (no dispatcher, byte-identical publish) without subscriptions", async () => {
    const files = await gen(PLAIN);
    expect([...files.keys()].some((k) => k.endsWith("Dispatcher.java"))).toBe(false);
    const svc = [...files.entries()].find(([k]) => k.endsWith("CustomerService.java"))![1];
    expect(svc).toContain(
      'CatalogLog.event("event_dispatched", "info", "event_type", event.getClass().getSimpleName(), "aggregate", "Customer");',
    );
    expect(svc).not.toContain("ApplicationEventPublisher");
  });

  it("the saga entity exposes a public _allocate factory seeding typed defaults", async () => {
    const ent = [...(await gen(SRC)).entries()].find(([k]) =>
      k.endsWith("OrderFulfillmentState.java"),
    )![1];
    expect(ent).toContain("public static OrderFulfillmentState _allocate(OrderId orderId) {");
    expect(ent).toContain("__s.orderId = orderId;");
    expect(ent).toContain("__s.attempts = 0;");
    expect(ent).toContain("__s.status = FulfillmentStatus.Pending;");
  });
});
