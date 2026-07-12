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
    // By id — 404 via Optional.orElse(notFound).  The guid correlation id
    // binds `UUID` so springdoc emits `format: uuid` (parity with Hono's
    // `z.string().uuid()` / .NET's `Guid id`).
    expect(ctrl).toContain('@GetMapping("/order_fulfillment/instances/{id}")');
    expect(ctrl).toContain(
      "public ResponseEntity<OrderFulfillmentInstanceResponse> getOrderFulfillmentInstanceById(@PathVariable UUID id) {",
    );
    expect(ctrl).toContain("orderFulfillmentStateRepository.findById(new OrderId(id))");
    expect(ctrl).toContain(".orElse(ResponseEntity.notFound().build());");
    expect(ctrl).toContain("import java.util.UUID;");
  });

  it("covers the instance routes in the OpenAPI contract customizer", async () => {
    // springdoc inlines `List<T>` and declares no 404s — the customizer must
    // register the named `<Wf>InstanceListResponse` wrapper, the byId 404,
    // and the instance DTO's required set (every non-optional wire field),
    // matching Hono / .NET / Python / Phoenix.
    const c = find(await gen(SRC), "OpenApiContractCustomizer.java");
    expect(c, "customizer not emitted").toBeDefined();
    expect(c).toContain(
      'new Wrapper("OrderFulfillmentInstanceListResponse", "OrderFulfillmentInstanceResponse")',
    );
    expect(c).toContain(
      'new Route("get", "/api/workflows/order_fulfillment/instances", "OrderFulfillmentInstanceListResponse", new int[] {}, null)',
    );
    expect(c).toContain(
      'new Route("get", "/api/workflows/order_fulfillment/instances/{id}", null, new int[] {404}, null)',
    );
    expect(c).toContain(
      'new RequiredSet("OrderFulfillmentInstanceResponse", List.of("attempts", "orderId", "status"))',
    );
  });

  it("emits no instance surface for a workflow without a correlation field", async () => {
    const files = await gen(PLAIN);
    expect([...files.keys()].some((k) => k.endsWith("WorkflowInstancesController.java"))).toBe(
      false,
    );
    expect([...files.keys()].some((k) => k.endsWith("InstanceResponse.java"))).toBe(false);
  });
});

// An event-sourced workflow (workflow-and-applier.md A2-S5b): correlation field
// + state field + applier.  The instance reads fold the per-context `<ctx>_events`
// log (`stream_type = "<Wf>"` rows)
// over a shared JdbcTemplate (no mutable state repo); the `<Wf>State` fold class
// carries record-style accessors so the api-package controller can project it.
const ES = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentRegistered { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentRegistered  delivery: broadcast  retention: ephemeral }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
    on(pr: PaymentRegistered) by pr.order { precondition total >= 0  emit PaymentRegistered { order: pr.order, amount: total } }
    apply(pr: PaymentRegistered) { total := total + pr.amount }
  }
} } api A from O storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: java contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

describe("java event-sourced workflow instance read endpoints", () => {
  it("injects a JdbcTemplate (no state repo) and folds the stream for LIST", async () => {
    const ctrl = find(await gen(ES), "OWorkflowInstancesController.java");
    expect(ctrl, "instance controller not emitted").toBeDefined();
    expect(ctrl).toContain("private final JdbcTemplate jdbc;");
    expect(ctrl).toContain("import org.springframework.jdbc.core.JdbcTemplate;");
    // No mutable state repo for the ES workflow.
    expect(ctrl).not.toContain("TallyStateRepository");
    expect(ctrl).toContain('@GetMapping("/tally/instances")');
    expect(ctrl).toContain("public List<TallyInstanceResponse> allTallyInstances() {");
    expect(ctrl).toContain(
      '"select stream_id, type, data from o.o_events where stream_type = ? order by stream_id, version", "Tally");',
    );
    expect(ctrl).toContain("var __byStream = new LinkedHashMap<String, List<DomainEvent>>();");
    expect(ctrl).toContain(
      ".map(__e -> TallyState._fromEvents(new OrderId(UUID.fromString(__e.getKey())), __e.getValue()))",
    );
    expect(ctrl).toContain("import java.util.LinkedHashMap;");
  });

  it("byId folds a single stream + 404s on an empty one", async () => {
    const ctrl = find(await gen(ES), "OWorkflowInstancesController.java");
    expect(ctrl).toContain('@GetMapping("/tally/instances/{id}")');
    expect(ctrl).toContain(
      "public ResponseEntity<TallyInstanceResponse> getTallyInstanceById(@PathVariable UUID id) {",
    );
    expect(ctrl).toContain("var __sid = String.valueOf(id);");
    expect(ctrl).toContain("if (__rows.isEmpty()) return ResponseEntity.notFound().build();");
    expect(ctrl).toContain("var x = TallyState._fromEvents(new OrderId(id), __loaded);");
  });

  it("the <Wf>State fold class exposes record-style accessors for the projection", async () => {
    const files = await gen(ES);
    const state = find(files, "TallyState.java")!;
    expect(state).toContain("public OrderId orderId() { return this.orderId; }");
    expect(state).toContain("public int total() { return this.total; }");
  });
});
