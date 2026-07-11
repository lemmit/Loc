// Projection-sourced views on Python (projection.md v1.1): a `view` may name a
// `projection` as its `from` source.  The route reads the projection's
// `<Proj>Row` read-model table directly (no aggregate repository) with the
// filter lowered to a SQLAlchemy `where`, then either:
//   - full form (`view X { fields … from <Proj> where … bind … }`) — runs the
//     shared aggregate bind tail (bulk-load `X id` follow foreign aggregates via
//     `find_many_by_ids`, project each row through the binds), or
//   - shorthand (`view X = <Proj> where …`) — returns the raw rows as the
//     projection's `<Proj>ListResponse` (reused from the v1 read endpoint).
// The Python sibling of the workflow-sourced-view emitter (python-workflow-view).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Shop { subdomain Sales { context Orders {
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
    customerName: string
    status: OrderStatus
    from OrderBook where status == Shipped
    bind orderId = order, customerName = customer.name, status = status
  }
  view PlacedOrderBooks = OrderBook where status == Placed
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: python contexts: [Orders] dataSources: [oState] port: 3000 } }
`;

async function viewsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("app/http/views_routes.py"));
  expect(path, "views_routes.py not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Python projection-sourced view — full form", () => {
  it("selects the <Proj>Row read model with the filter lowered to a SQLAlchemy where", async () => {
    const vf = await viewsFile();
    expect(vf).toContain(
      "rows = (await session.execute(select(OrderBookRow).where((OrderBookRow.status == OrderStatus.Shipped)))).scalars().all()",
    );
    // Reads the row model + select + the enum directly — no aggregate repo for
    // the projection SOURCE.
    expect(vf).toContain("from app.db.schema import OrderBookRow");
    expect(vf).toContain("from sqlalchemy import select");
    expect(vf).toContain("from app.domain.value_objects import OrderStatus");
  });

  it("bulk-loads the `X id` follow aggregate via find_many_by_ids", async () => {
    const vf = await viewsFile();
    expect(vf).toContain("from app.db.repositories.customer_repository import CustomerRepository");
    expect(vf).toContain("customer_repo = CustomerRepository(session, make_dispatcher(session))");
    expect(vf).toContain(
      "customer_by_id = {str(a.id): a for a in await customer_repo.find_many_by_ids([CustomerId(r.customer) for r in rows if r.customer is not None])}",
    );
    // length-1 follow ids get wrapped in the target aggregate's id NewType.
    expect(vf).toContain("from app.domain.ids import CustomerId");
  });

  it("projects each row through the bind dict with the follow rewrite", async () => {
    const vf = await viewsFile();
    expect(vf).toContain('"orderId": r.order,');
    expect(vf).toContain('"customerName": customer_by_id[str(r.customer)].name,');
    expect(vf).toContain('"status": r.status,');
  });

  it("emits its own <View>Row / <View>Response DTO from the declared fields", async () => {
    const vf = await viewsFile();
    expect(vf).toContain("class ShippedOrdersRow(BaseModel):");
    expect(vf).toContain("    orderId: str");
    expect(vf).toContain("    status: OrderStatus");
    expect(vf).toContain("class ShippedOrdersResponse(RootModel[list[ShippedOrdersRow]]):");
  });
});

describe("Python projection-sourced view — shorthand", () => {
  it("selects the <Proj>Row table and returns the projection's <Proj>ListResponse", async () => {
    const vf = await viewsFile();
    expect(vf).toContain(
      '@router.get("/placed_order_books", response_model=OrderBookListResponse, operation_id="placedOrderBooksView")',
    );
    expect(vf).toContain(
      "rows = (await session.execute(select(OrderBookRow).where((OrderBookRow.status == OrderStatus.Placed)))).scalars().all()",
    );
    // Shorthand reuses the projection's existing list response (v1 read endpoint).
    expect(vf).toContain("from app.http.projections_routes import OrderBookListResponse");
  });
});
