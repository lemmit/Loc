// Projection-sourced views (projection.md v1.1) on .NET.  A `view` may name a
// `projection` as its `from` source: the Mediator handler reads the `<Proj>Row`
// EF DbSet directly (no repository) with the view filter pushed to a SQL
// `WHERE`, then — full form — bulk-loads the foreign aggregates an `X id` follow
// bind references (`FindManyByIdsAsync` into a dictionary, the shared aggregate
// full-form tail) and projects each row through the binds into `<View>Row`.
// Shorthand (`view X = <Proj> where …`) returns the projection's own
// `<Proj>Response` wire shape.  .NET DOES support the `X id` follow, so the
// full-form fixture uses `customer.name`.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

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
    customerName: string
    status: OrderStatus
    from OrderBook where status == Shipped
    bind orderId = order, customerName = customer.name, status = status
  }
  view AllBooks = OrderBook where status == Placed
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: dotnet contexts: [Orders] dataSources: [oState] port: 3000 } }`;

async function files(): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(SRC))).files;
}

function get(files: Map<string, string>, suffix: string): string {
  const k = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return files.get(k!)!;
}

describe(".NET projection-sourced view (full form)", () => {
  it("emits a <View>Row record + query over the declared fields", async () => {
    const f = await files();
    const row = get(f, "Application/Views/ShippedOrdersRow.cs");
    expect(row).toContain("public sealed record ShippedOrdersRow(");
    const q = get(f, "Application/Views/ShippedOrdersQuery.cs");
    expect(q).toContain(
      "public sealed record ShippedOrdersQuery() : IQuery<IReadOnlyList<ShippedOrdersRow>>;",
    );
  });

  it("reads the <Proj>Row DbSet with a SQL WHERE, bulk-loads the follow, projects binds", async () => {
    const h = get(await files(), "Application/Views/ShippedOrdersHandler.cs");
    expect(h).toContain("private readonly AppDbContext _db;");
    // Row read straight off the projection DbSet, filter pushed to SQL.
    expect(h).toContain(
      "var rows = await _db.OrderBooks.AsNoTracking().Where(r => r.Status == OrderStatus.Shipped).ToListAsync(cancellationToken);",
    );
    // `X id` follow: bulk-load the foreign aggregate into a dictionary (nulls
    // dropped, non-key id column unwrapped through the null-forgiving `!`).
    expect(h).toContain(
      "var customerById = (await _customerRepo.FindManyByIdsAsync(rows.Where(d => d.Customer.HasValue).Select(d => d.Customer!.Value).ToList(), cancellationToken)).ToDictionary(__a => __a.Id);",
    );
    // Projection: plain-column `order`/`status` normalized off the row, follow
    // leaf read out of the dictionary.
    expect(h).toContain(
      "return rows.Select(d => new ShippedOrdersRow(d.Order.Value, customerById[d.Customer!.Value].Name, d.Status!.Value)).ToList();",
    );
  });

  it("exposes the full-form view on the ViewsController", async () => {
    const c = get(await files(), "ViewsController.cs");
    expect(c).toContain('[HttpGet("shipped_orders")]');
    expect(c).toContain("IReadOnlyList<ShippedOrdersRow>");
  });
});

describe(".NET projection-sourced view (shorthand)", () => {
  it("emits a query + handler returning the projection <Proj>Response", async () => {
    const f = await files();
    const q = get(f, "Application/Views/AllBooksQuery.cs");
    expect(q).toContain(
      "public sealed record AllBooksQuery() : IQuery<IReadOnlyList<OrderBookResponse>>;",
    );
    const h = get(f, "Application/Views/AllBooksHandler.cs");
    // Same DbSet read (filter → SQL WHERE), projecting the projection wire shape.
    expect(h).toContain(
      "var rows = await _db.OrderBooks.AsNoTracking().Where(r => r.Status == OrderStatus.Placed).ToListAsync(cancellationToken);",
    );
    expect(h).toContain("return rows.Select(d => new OrderBookResponse(");
  });

  it("exposes the shorthand view on the ViewsController", async () => {
    const c = get(await files(), "ViewsController.cs");
    expect(c).toContain('[HttpGet("all_books")]');
    expect(c).toContain("IReadOnlyList<OrderBookResponse>");
  });
});
