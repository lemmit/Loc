// Projection-sourced views (projection.md v1.1) on Java.  A `view` may name a
// `projection` as its `from` source: the views service reads the persisted
// `<Proj>Row` read-model row through its Spring Data repository
// (`findAll()` + in-memory filter — the state-based workflow-view read, no
// aggregate repo).  A full-form view projects the declared bind tail into a
// `<View>Row`; shorthand (`view X = <Proj> where …`) returns the projection's
// own `<Proj>Response` wire shape.
//
// The Java backend does NOT implement cross-aggregate `X id` follows for views
// (it inherits the same `... uses cross-aggregate follows — not yet implemented`
// rejection an aggregate full-form view raises), so the full-form fixture here
// binds PLAIN COLUMNS only; the rejection is asserted separately.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// Full-form fixture — plain-column binds only (no `customer.name` follow).
const SRC = `system Shop { subdomain Sales { context Orders {
  enum OrderStatus { Placed Shipped }
  event OrderPlaced  { order: Order id, customer: Customer id }
  event OrderShipped { order: Order id }
  aggregate Customer { name: string }
  repository Customers for Customer { }
  aggregate Order {
    status: OrderStatus
    create place(customer: Customer id) {}
    operation ship() { emit OrderShipped { order: id } }
  }
  repository Orders for Order { }
  channel Lifecycle { carries: OrderPlaced, OrderShipped  retention: log  key: order }
  projection OrderBook keyed by order {
    order: Order id
    customer: Customer id
    status: OrderStatus
    on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
    on(e: OrderShipped) { status := Shipped }
  }
  view ShippedOrders {
    orderId: Order id
    status: OrderStatus
    from OrderBook where status == Shipped
    bind orderId = order, status = status
  }
  view AllBooks = OrderBook where status == Placed
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [oState] port: 3000 } }`;

// Same system, but the full-form view adds a cross-aggregate `customer.name`
// follow bind — rejected on Java exactly as an aggregate full-form view is.
const FOLLOW_SRC = SRC.replace(
  `  view ShippedOrders {
    orderId: Order id
    status: OrderStatus
    from OrderBook where status == Shipped
    bind orderId = order, status = status
  }`,
  `  view ShippedOrders {
    orderId: Order id
    customerName: string
    status: OrderStatus
    from OrderBook where status == Shipped
    bind orderId = order, customerName = customer.name, status = status
  }`,
);

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const find = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1];

describe("java projection-sourced views", () => {
  it("emits a <View>Row record over the declared full-form fields", async () => {
    const row = find(await gen(SRC), "ShippedOrdersRow.java");
    expect(row, "view row not emitted").toBeDefined();
    expect(row).toContain("public record ShippedOrdersRow(UUID orderId, OrderStatus status) {");
  });

  it("reads the <Proj>Row repository, filters in-memory, projects the bind tail", async () => {
    const svc = find(await gen(SRC), "OrdersViews.java");
    expect(svc, "views service not emitted").toBeDefined();
    // Read-model row repo injected (no aggregate repo — the read is off the row).
    expect(svc).toContain("private final OrderBookRowRepository orderBookRowRepository;");
    expect(svc).toContain("public List<ShippedOrdersRow> shippedOrders() {");
    expect(svc).toContain("return orderBookRowRepository.findAll().stream()");
    // The filter renders to an in-memory Java predicate over the row accessors.
    expect(svc).toContain(".filter(a -> a.status() == OrderStatus.Shipped)");
    // Plain-column binds: `order` (an id) unwraps via `.value()`, `status` passes through.
    expect(svc).toContain(".map(a -> new ShippedOrdersRow(a.order().value(), a.status()))");
    expect(svc).toContain(".toList();");
  });

  it("returns the projection <Proj>Response for a shorthand projection view", async () => {
    const svc = find(await gen(SRC), "OrdersViews.java");
    expect(svc).toContain("public List<OrderBookResponse> allBooks() {");
    expect(svc).toContain(".filter(x -> x.status() == OrderStatus.Placed)");
    expect(svc).toContain(
      ".map(x -> new OrderBookResponse(x.order().value(), x.customer().value(), x.status()))",
    );
  });

  it("routes both projection views under /api/views", async () => {
    const ctrl = find(await gen(SRC), "OrdersViewsController.java");
    expect(ctrl, "views controller not emitted").toBeDefined();
    expect(ctrl).toContain('@RequestMapping("/api/views")');
    expect(ctrl).toContain('@GetMapping("/shipped_orders")');
    expect(ctrl).toContain("public List<ShippedOrdersRow> shippedOrders() {");
    expect(ctrl).toContain('@GetMapping("/all_books")');
    expect(ctrl).toContain("public List<OrderBookResponse> allBooks() {");
  });

  it("rejects a cross-aggregate follow bind (not yet implemented on java)", async () => {
    await expect(gen(FOLLOW_SRC)).rejects.toThrow(
      "java views: view 'ShippedOrders' uses cross-aggregate follows — not yet implemented on the java backend.",
    );
  });
});
