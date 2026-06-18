// Read-only workflow-instance endpoints (workflow-instance-visibility.md) on
// Java — saga slice 3.  A correlation-bearing workflow gets a
// <Wf>InstanceResponse record and a <Ctx>WorkflowInstancesController exposing
// GET workflows/<snake>/instances + .../instances/{id} over the persisted
// <Wf>State saga row (read through its Spring Data repository) — the read-side
// analogue of an aggregate's GET list / GET-by-id, parity with .NET / python.

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

// A workflow with no correlation field — a pure command workflow, no saga row,
// so no instance surface.
const PLAIN = `system S { subdomain O { context O {
  aggregate Order { total: int  operation bump() { total := total + 1 } }
  repository Orders for Order { }
  workflow BumpAll { create(order: Order id) { let o = Orders.getById(order) o.bump() } }
} } api A from O storage pg { type: postgres } deployable api { platform: java contexts: [O] serves: A port: 8080 } }`;

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const find = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1];

describe("java workflow instance read endpoints", () => {
  it("emits the instance Response record from the saga wire shape", async () => {
    const dto = find(await gen(SRC), "OrderFulfillmentInstanceResponse.java");
    expect(dto, "instance response not emitted").toBeDefined();
    // Correlation id crosses as UUID (the value type), attempts int, status enum.
    expect(dto).toContain(
      "public record OrderFulfillmentInstanceResponse(UUID orderId, int attempts, FulfillmentStatus status) {",
    );
    expect(dto).toContain("import java.util.UUID;");
  });

  it("emits a controller with GET list + GET by-id over the saga repository", async () => {
    const ctrl = find(await gen(SRC), "OWorkflowInstancesController.java");
    expect(ctrl, "instance controller not emitted").toBeDefined();
    expect(ctrl).toContain('@RequestMapping("/api/workflows")');
    expect(ctrl).toContain(
      "private final OrderFulfillmentStateRepository orderFulfillmentStateRepository;",
    );
    // List.
    expect(ctrl).toContain('@GetMapping("/order_fulfillment/instances")');
    expect(ctrl).toContain(
      "public List<OrderFulfillmentInstanceResponse> allOrderFulfillmentInstances() {",
    );
    expect(ctrl).toContain("return orderFulfillmentStateRepository.findAll().stream()");
    expect(ctrl).toContain(
      "new OrderFulfillmentInstanceResponse(x.orderId().value(), x.attempts(), x.status())",
    );
    // By id — 404 via Optional.orElse(notFound).
    expect(ctrl).toContain('@GetMapping("/order_fulfillment/instances/{id}")');
    expect(ctrl).toContain(
      "public ResponseEntity<OrderFulfillmentInstanceResponse> getOrderFulfillmentInstanceById(@PathVariable UUID id) {",
    );
    expect(ctrl).toContain("orderFulfillmentStateRepository.findById(new OrderId(id))");
    expect(ctrl).toContain(".orElse(ResponseEntity.notFound().build());");
    expect(ctrl).toContain("import java.util.UUID;");
  });

  it("emits no instance surface for a workflow without a correlation field", async () => {
    const files = await gen(PLAIN);
    expect([...files.keys()].some((k) => k.endsWith("WorkflowInstancesController.java"))).toBe(
      false,
    );
    expect([...files.keys()].some((k) => k.endsWith("InstanceResponse.java"))).toBe(false);
  });
});
