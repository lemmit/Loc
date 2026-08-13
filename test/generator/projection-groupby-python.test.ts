// Python/FastAPI emit for a GROUPED query-time projection (`group by` —
// M-T4.2): one row per distinct grouping-key combination, aggregates computed
// per group IN SQL.
//
// Like the whole-table singleton this replaces a rehydrate-and-fold read, so
// the assertions are as much about what is NOT emitted (no repository row
// loading) as about what is: ONE SQLAlchemy query carrying the `where`,
// `.group_by(...)` *and* `.order_by(...)` on exactly the grouping columns (the
// ORDER BY is what makes the read deterministic across backends), the LIST
// response shape (`RootModel[list[<P>Row]]` — imported even when the grouped
// projection is the only one in the file), and per-field coercion — keys to
// their declared wire types, aggregates through the same coercions the
// singleton uses.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SRC = `system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        lineCount: int
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order { }
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      projection SalesByStatus {
        status: OrderStatus
        orders: int
        revenue: money
        from Order as o
        where Confirmed
        group by o.status
        select status = o.status, orders = count(), revenue = sum(o.total)
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: python contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}`;

async function routesFile(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  for (const [path, content] of files) {
    if (path.endsWith("http/query_projections_routes.py")) return content;
  }
  throw new Error("no generated http/query_projections_routes.py");
}

describe("python grouped aggregation (group by)", () => {
  it("emits ONE SQL query with the keys and aggregates, grouped AND ordered by the key column", async () => {
    const routes = await routesFile(SRC);
    expect(routes).toContain("select(OrderRow.status, func.count(), func.sum(OrderRow.total))");
    expect(routes).toContain(".group_by(OrderRow.status)");
    expect(routes).toContain(".order_by(OrderRow.status)");
  });

  it("lowers the `where` into the same query", async () => {
    const routes = await routesFile(SRC);
    expect(routes).toContain(".where(");
    expect(routes).toContain("OrderStatus.Confirmed");
  });

  it("does NOT load rows through the repository", async () => {
    // The rehydrate-and-fold read this shape exists to avoid.
    const routes = await routesFile(SRC);
    expect(routes).not.toContain("OrderRepository");
    expect(routes).not.toContain("repo.");
  });

  it("responds with the LIST shape — RootModel over the row, imported even when grouped is the only projection", async () => {
    const routes = await routesFile(SRC);
    expect(routes).toContain("class SalesByStatusResponse(RootModel[list[SalesByStatusRow]]):");
    expect(routes).toContain("from pydantic import BaseModel, RootModel");
    // Not the singleton object shape.
    expect(routes).not.toContain("class SalesByStatusResponse(SalesByStatusRow):");
    expect(routes).toContain("-> list[dict[str, object]]:");
  });

  it("maps each row: key passed through, aggregates coerced to their declared wire types", async () => {
    // The enum key column stores its wire string on the row (Text) — no
    // rewrap; the aggregates reuse the singleton coercions (`numeric` sum
    // reads back as Decimal/None, so a money row field stringifies, an int
    // count zero-defaults).
    const routes = await routesFile(SRC);
    expect(routes).toContain('"status": r[0],');
    expect(routes).toContain('"orders": int(r[1] or 0),');
    expect(routes).toContain('"revenue": str(r[2] or "0"),');
    expect(routes).toContain("for r in result");
  });
});

// The `requires` gate (403-before-query) — same emission as every other
// query-time projection route: bind `current_user` off the request scope,
// raise ForbiddenError BEFORE the grouped query runs.
const GATED = `system S {
  user { id: string role: string }
  subdomain D { context C {
    enum OrderStatus { Draft Confirmed }
    aggregate Order { status: OrderStatus  total: money }
    repository Orders for Order { }
    projection AdminSalesByStatus requires currentUser.role == "admin" {
      status: OrderStatus
      orders: int
      from Order as o
      group by o.status
      select status = o.status, orders = count()
    }
  }}
  storage primary { type: postgres }
  resource cState { for: C, kind: state, use: primary }
  api Api from D
  deployable api { platform: python  contexts: [C]  dataSources: [cState]  serves: Api  port: 8080  auth: required }
}`;

describe("python grouped aggregation `requires` gate", () => {
  it("binds current_user and raises 403 BEFORE the grouped query", async () => {
    const routes = await routesFile(GATED);
    expect(routes).toContain("current_user: User = request.state.current_user");
    expect(routes).toContain('not (current_user.role == "admin")');
    expect(routes).toContain('raise ForbiddenError("Forbidden: projection AdminSalesByStatus")');
    // The gate precedes the grouped SQL read.
    expect(routes.indexOf("raise ForbiddenError")).toBeLessThan(
      routes.indexOf(".group_by(OrderRow.status)"),
    );
  });
});
