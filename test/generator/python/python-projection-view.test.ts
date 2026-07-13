// Projection-sourced views on Python (projection.md v1.1): `view X = <Proj>
// where <pred>` emits a GET /views/<x> route reading the `<Proj>Row` read-model
// table with the predicate lowered to a SQLAlchemy `where`; a full-form view may
// bind-follow `X id` columns into repositories.  The first-hop follow re-brands
// the nullable read-model column with `<Agg>Id(...)` (dropping NULLs) before
// `find_many_by_ids` so mypy --strict stays green.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
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
        view ShippedRows = OrderBook where status == Shipped
        view ShippedOrders {
          customerName: string
          from OrderBook where status == Shipped
          bind customerName = customer.name
        }
      }
    }
    storage primary { type: postgres }
    deployable api { platform: python  contexts: [Orders]  port: 3000 }
  }
`;

async function viewsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("app/http/views_routes.py"));
  expect(path, "views_routes.py not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Python projection-sourced view", () => {
  it("emits a shorthand route reading the read-model row table with the lowered filter", async () => {
    const vf = await viewsFile();
    expect(vf).toContain("from app.db.schema import OrderBookRow");
    expect(vf).toContain(
      "rows = (await session.execute(select(OrderBookRow).where((OrderBookRow.status == OrderStatus.Shipped)))).scalars().all()",
    );
  });

  it("emits a full-form bind-follow that re-brands the nullable row column before find_many_by_ids", async () => {
    const vf = await viewsFile();
    expect(vf).toContain("from app.domain.ids import CustomerId");
    expect(vf).toContain(
      "await customer_repo.find_many_by_ids([CustomerId(r.customer) for r in rows if r.customer is not None])",
    );
    expect(vf).toContain('"customerName": customer_by_id[str(r.customer)].name');
  });
});
