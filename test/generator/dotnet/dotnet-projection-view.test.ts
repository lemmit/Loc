// Projection-sourced views on .NET (projection.md v1.1): `view X = <Proj> where
// <pred>` emits a Mediator query whose handler reads the `<Proj>Row` read-model
// DbSet with the filter, returning the projection's `<Proj>Response`, plus a
// ViewsController action over it.  Shorthand-only on .NET — a full-form bind
// projection over the nullable read-model row is not yet supported (thrown).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = (view: string) => `
  system Shop {
    subdomain Sales {
      context Orders {
        enum OrderStatus { Placed, Shipped }
        event OrderPlaced  { order: Order id, customer: Customer id }
        event OrderShipped { order: Order id }
        aggregate Customer { name: string }
        repository Customers for Customer {}
        aggregate Order { status: OrderStatus  customer: Customer id }
        repository Orders for Order {}
        projection OrderBook keyed by order {
          order: Order id
          customer: Customer id
          status: OrderStatus
          on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
          on(e: OrderShipped) { status := Shipped }
        }
        ${view}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: dotnet  contexts: [Orders]  port: 3000 }
  }
`;

async function files(view: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(SRC(view)))).files;
}

function get(files: Map<string, string>, suffix: string): string {
  const k = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return files.get(k!)!;
}

describe(".NET projection-sourced view", () => {
  it("emits a query + handler reading the read-model DbSet, returning <Proj>Response", async () => {
    const fs = await files("view ShippedRows = OrderBook where status == Shipped");
    const q = get(fs, "Application/Views/ShippedRowsQuery.cs");
    expect(q).toContain(
      "public sealed record ShippedRowsQuery() : IQuery<IReadOnlyList<OrderBookResponse>>;",
    );
    const h = get(fs, "Application/Views/ShippedRowsHandler.cs");
    expect(h).toContain(
      "await _db.OrderBooks.AsNoTracking().Where(r => r.Status == OrderStatus.Shipped).ToListAsync(cancellationToken)",
    );
    // Null-safe projection over the nullable read-model row → <Proj>Response.
    expect(h).toContain("new OrderBookResponse(");
    const c = get(fs, "OrdersViewsController.cs");
    expect(c).toContain('[HttpGet("shipped_rows")]');
    expect(c).toContain("IReadOnlyList<OrderBookResponse>");
  });

  it("throws on a full-form projection view (shorthand-only on .NET)", async () => {
    await expect(
      files(
        `view ShippedLabels {
          label: OrderStatus
          from OrderBook where status == Shipped
          bind label = status
        }`,
      ),
    ).rejects.toThrow(/full-form bind projection/);
  });
});
