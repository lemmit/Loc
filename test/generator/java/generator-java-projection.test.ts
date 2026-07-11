import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Java backend — projection read models (projection.md, v1).  A projection
// folds foreign events into a `<Proj>Row` JPA read-model @Entity (non-key
// columns nullable), dispatched in-process via a pure @EventListener fold on
// the `<Ctx>Dispatcher`, and read through GET /api/projections/<snake>[/{key}].
// Parity with the shipped Hono + Python runtimes (3rd backend).
// ---------------------------------------------------------------------------

const SRC = `system Shop { subdomain Sales { context Orders {
  enum OrderStatus { Placed Shipped }
  event OrderPlaced  { order: Order id, customer: Customer id }
  event OrderShipped { order: Order id }
  aggregate Customer { name: string }
  aggregate Order {
    status: OrderStatus
    create place(customer: Customer id) {}
    operation ship() { emit OrderShipped { order: id } }
  }
  channel Lifecycle { carries: OrderPlaced, OrderShipped  retention: log  key: order }
  projection OrderBook keyed by order {
    order: Order id
    customer: Customer id
    status: OrderStatus
    on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
    on(e: OrderShipped) { status := Shipped }
  }
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [oState] port: 8080 } }`;

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

describe("java projection runtime", () => {
  it("emits a nullable-non-key JPA read-model row @Entity keyed by the correlation id", async () => {
    const row = file(await build(), "infrastructure/persistence/OrderBookRow.java");
    expect(row).toContain("public class OrderBookRow {");
    expect(row).toContain('@Table(name = "order_books", schema = "orders")');
    // correlation field is the @EmbeddedId
    expect(row).toContain("@EmbeddedId");
    expect(row).toContain('@AttributeOverride(name = "value", column = @Column(name = "order"))');
    expect(row).toContain("OrderId order;");
    // empty-seed allocate (every non-key column is nullable)
    expect(row).toContain("public static OrderBookRow _allocate(OrderId order) {");
    expect(row).toMatch(
      /_allocate\(OrderId order\) \{\s*var __s = new OrderBookRow\(\);\s*__s\.order = order;\s*return __s;/,
    );
    // non-key columns get JavaBean setters (the fold writes through them)
    expect(row).toContain("public void setCustomer(CustomerId customer) {");
    expect(row).toContain("public void setStatus(OrderStatus status) {");
  });

  it("emits a Spring Data repository keyed by the correlation id", async () => {
    const repo = file(await build(), "infrastructure/repositories/OrderBookRowRepository.java");
    expect(repo).toContain(
      "public interface OrderBookRowRepository extends JpaRepository<OrderBookRow, OrderId> {",
    );
  });

  it("emits a pure fold @EventListener wired into the dispatcher, repo-injected", async () => {
    const disp = file(await build(), "application/workflows/OrdersDispatcher.java");
    expect(disp).toContain(
      "public OrdersDispatcher(ApplicationEventPublisher events, OrderBookRowRepository orderBookRowRepository) {",
    );
    expect(disp).toContain("public void onOrderBookOnOrderPlaced(OrderPlaced e) {");
    expect(disp).toContain("var __key = e.order();");
    expect(disp).toContain(
      "var state = orderBookRowRepository.findById(__key).orElseGet(() -> OrderBookRow._allocate(__key));",
    );
    expect(disp).toContain("state.setCustomer(e.customer());");
    expect(disp).toContain("state.setStatus(OrderStatus.Placed);");
    expect(disp).toContain("orderBookRowRepository.save(state);");
    // the correlation `:=` is skipped (immutable @EmbeddedId key)
    expect(disp).not.toContain("state.setOrder(");
    expect(disp).toContain("public void onOrderBookOnOrderShipped(OrderShipped e) {");
  });

  it("emits list + by-key read routes under /api/projections", async () => {
    const ctrl = file(await build(), "api/OrdersProjectionsController.java");
    expect(ctrl).toContain('@RequestMapping("/api/projections")');
    expect(ctrl).toContain('@GetMapping("/order_book")');
    expect(ctrl).toContain("public List<OrderBookResponse> listOrderBook() {");
    expect(ctrl).toContain('@GetMapping("/order_book/{key}")');
    expect(ctrl).toContain(
      "public ResponseEntity<OrderBookResponse> getOrderBook(@PathVariable UUID key) {",
    );
    expect(ctrl).toContain("orderBookRowRepository.findById(new OrderId(key))");
    // row → wire via the projection wireShape (id → .value())
    expect(ctrl).toContain("x.order().value(), x.customer().value(), x.status()");
  });

  it("emits a Response DTO off the projection wire shape", async () => {
    const dto = file(await build(), "application/workflows/OrderBookResponse.java");
    expect(dto).toContain(
      "public record OrderBookResponse(UUID order, UUID customer, OrderStatus status) {",
    );
  });
});
