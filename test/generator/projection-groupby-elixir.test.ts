// M-T4.2 — the GROUPED read model on the Elixir/Phoenix (vanilla Ecto)
// backend: `group by` in a query-time projection emits ONE Ecto query with
// `group_by:` over the grouping columns, the aggregates in the `select`, and —
// load-bearing for cross-backend determinism — an `order_by:` over the SAME
// columns.  The response is the LIST shape (`Repo.all/1`, `[map()]`), never
// the singleton map, and the coercions follow the DECLARED row type: an enum
// key passes through (Ecto.Enum atom, Jason-encoded as the declared string),
// a money sum ships as a string, a plain decimal as a number (RS-24).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SRC = `system Shop {
  user { id: string role: string }
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        lineCount: int
        status: OrderStatus
      }
      repository Orders for Order { }
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      projection SalesByStatus {
        status: OrderStatus
        orders: int
        revenue: money
        avgLines: decimal
        from Order as o
        where Confirmed
        group by o.status
        select status = o.status, orders = count(), revenue = sum(o.total), avgLines = avg(o.lineCount)
      }
      projection SalesByStatusAndCode {
        status: OrderStatus
        code: string
        orders: int
        from Order as o
        group by o.status, o.code
        select status = o.status, code = o.code, orders = count()
      }
      projection AdminSalesByStatus requires currentUser.role == "admin" {
        status: OrderStatus
        orders: int
        from Order as o
        group by o.status
        select status = o.status, orders = count()
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 auth: required }
}`;

let cache: Map<string, string> | undefined;
async function fileEndingWith(suffix: string): Promise<string> {
  cache ??= await generateSystemFiles(SRC);
  for (const [path, content] of cache) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix}`);
}

describe("elixir grouped projection — the query", () => {
  it("groups AND orders by the key in one Ecto query, with the where folded in", async () => {
    const mod = await fileEndingWith("query_projections/sales_by_status.ex");
    // ONE query: filter + group_by + order_by + aggregate select, nothing
    // hydrated into structs.  order_by over the grouping column is REQUIRED
    // (deterministic cross-backend reads).
    expect(mod).toMatch(
      /from\(record in [\w.]+, where: .+, group_by: record\.status, order_by: record\.status, select: %\{status: record\.status, orders: count\(record\.id\), revenue: sum\(record\.total\), avgLines: avg\(record\.line_count\)\}\)/,
    );
    // The `where Confirmed` criterion is in the same query.
    expect(mod).toContain('"Confirmed"');
  });

  it("returns the LIST shape — Repo.all, one map per group, never the singleton", async () => {
    const mod = await fileEndingWith("query_projections/sales_by_status.ex");
    expect(mod).toContain("|> Repo.all()");
    expect(mod).not.toContain("Repo.one()");
    expect(mod).toContain("@spec run(any()) :: [map()]");
    expect(mod).toContain(
      "Form: query-time GROUPED aggregation (one row per group, computed in SQL).",
    );
  });

  it("multi-key grouping lists every column in group_by AND order_by", async () => {
    const mod = await fileEndingWith("query_projections/sales_by_status_and_code.ex");
    expect(mod).toContain(
      "group_by: [record.status, record.code], order_by: [record.status, record.code]",
    );
  });
});

describe("elixir grouped projection — coercions follow the DECLARED row type", () => {
  it("enum key passes through; count zero-defaults; money → string; decimal → float (RS-24)", async () => {
    const mod = await fileEndingWith("query_projections/sales_by_status.ex");
    // Ecto.Enum loads the key as an atom — Jason encodes it as the declared
    // string, exactly like the per-row arm's struct read.
    expect(mod).toContain("status: row.status,");
    expect(mod).toContain("orders: row.orders || 0,");
    // Jason encodes a bare %Decimal{} as a JSON string — what money wants and
    // what a plain decimal must NOT be (the other four backends ship a number).
    // money pins the fixed wire scale (RS-12 / #2549) through the emitted
    // `__money_wire/1`, rather than stringifying the aggregate as it arrived.
    expect(mod).toContain("revenue: __money_wire(row.revenue || 0),");
    expect(mod).toContain("Decimal.to_float(");
  });
});

describe("elixir grouped projection — the controller", () => {
  it("emits the requires gate (403 before the query) for the gated projection only", async () => {
    const ctrl = await fileEndingWith("controllers/query_projections_controller.ex");
    expect(ctrl).toContain("def admin_sales_by_status(conn, _params) do");
    expect(ctrl).toContain('"Forbidden: projection AdminSalesByStatus"');
    // Exactly one gated action — the ungated grouped siblings stay gate-free.
    const gates = ctrl.match(/problem_response\(conn, 403, "Forbidden"/g) ?? [];
    expect(gates.length).toBe(1);
    // The gate wraps the run/1 call (403 BEFORE the query runs).
    const start = ctrl.indexOf("def admin_sales_by_status");
    const body = ctrl.slice(start, ctrl.indexOf("end\n", ctrl.indexOf("AdminSalesByStatus.run")));
    expect(body.indexOf("problem_response")).toBeLessThan(body.indexOf(".run(current_user)"));
  });

  it("routes every grouped projection through GET /projections/<slug>", async () => {
    const ctrl = await fileEndingWith("controllers/query_projections_controller.ex");
    expect(ctrl).toContain('@doc "GET /api/projections/sales_by_status"');
    expect(ctrl).toContain('@doc "GET /api/projections/sales_by_status_and_code"');
  });
});
