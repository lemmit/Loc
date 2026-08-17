// M-T1.3 Phase 2 — `scaffoldDashboard`: a dashboard whose numbers come from
// the DATABASE.
//
// Two halves, because a macro attaches to exactly one host (`MacroTarget`,
// define.ts): the `context` macro emits one SINGLETON query-time projection per
// aggregate (aggregated in SQL — `.all` is paged by default, so counting rows
// in the browser counts ONE PAGE), and the ui-side scaffold grows `Home` a row
// of `Stat` tiles bound to it.  Both derive the projection name from
// `_dashboard-shared.ts`, so a tile can never bind a projection the other half
// didn't emit — the `scaffoldPaged`/`scaffoldPagedApi` split, applied again.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const system = (
  contextWith: string,
  uiWith = "with scaffold(subdomains: [Sales])",
) => `system Shop {
  subdomain Sales {
    context Orders ${contextWith} {
      aggregate Order {
        code: string
        total: money
        lineCount: int
        note: string?
        derived display: string = code
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  ui WebApp ${uiWith} { api Sales: SalesApi }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3000 }
}`;

const WITH_DASHBOARD = system("with scaffoldDashboard");
const WITHOUT = system("");

describe("scaffoldDashboard — the projection half", () => {
  it("aggregates in SQL, not by folding rows", async () => {
    // The whole point: one `SELECT` with `COUNT(*)`/`SUM(...)`, nothing
    // materialised.  A page-side fold over `.all` would see one PAGE.
    const routes = (await generateSystemFiles(WITH_DASHBOARD)).get(
      "api/http/query-projections.ts",
    )!;
    expect(routes).toContain(
      "const [row] = await db.select({ rowCount: count(), totalSum: sum(schema.orders.total), " +
        "lineCountSum: sum(schema.orders.lineCount) }).from(schema.orders);",
    );
  });

  it("returns ONE row — the response is the row, not an array", async () => {
    const routes = (await generateSystemFiles(WITH_DASHBOARD)).get(
      "api/http/query-projections.ts",
    )!;
    expect(routes).toContain("const OrderTotalsResponse = OrderTotalsRow.openapi(");
  });

  it("coerces each field to its DECLARED row type", async () => {
    // The response schema is built from the declared row, so a coercion that
    // followed the select's INFERRED type could emit `Number(...)` into a field
    // the schema declares `z.string()` (money) — which `.parse` then rejects at
    // runtime.  The declared field is the contract.
    const routes = (await generateSystemFiles(WITH_DASHBOARD)).get(
      "api/http/query-projections.ts",
    )!;
    expect(routes).toContain("totalSum: z.string(),");
    // …and a money sum is formatted to the FIXED wire scale, not shipped at
    // whatever scale SQL returned (RS-12 / #2549), so the dashboard tile reads
    // the same value the aggregate's own route sends.
    expect(routes).toContain("totalSum: new Decimal(row?.totalSum ?? 0).toFixed(4),");
  });

  it("skips a nullable column, whose SUM would describe a different row set", async () => {
    // SQL `SUM` skips NULLs, so a `note: string?`-shaped nullable numeric tile
    // would silently cover fewer rows than the `rowCount` beside it.  (`note`
    // is also non-numeric — both reasons exclude it.)
    const routes = (await generateSystemFiles(WITH_DASHBOARD)).get(
      "api/http/query-projections.ts",
    )!;
    expect(routes).not.toContain("noteSum");
  });

  it("emits nothing without the macro", async () => {
    expect((await generateSystemFiles(WITHOUT)).has("api/http/query-projections.ts")).toBe(false);
  });
});

describe("scaffoldDashboard — the page half", () => {
  it("grows Home a KPI row bound to the projection", async () => {
    const home = (await generateSystemFiles(WITH_DASHBOARD)).get("web/src/pages/home.tsx")!;
    expect(home).toContain('import { useOrderTotals } from "../api/projections";');
    expect(home).toContain("const orderTotals = useOrderTotals();");
    expect(home).toContain('data-testid="order-totals"');
    expect(home).toContain("{orderTotals.data.rowCount}");
  });

  it("renders a money tile through `Money`", async () => {
    // A `money` is a decimal.js `Decimal` client-side; a bare React child is a
    // TS2322.  The projection row carries no type the walker can read, so the
    // SOURCE field's type decides which tiles get wrapped.
    const home = (await generateSystemFiles(WITH_DASHBOARD)).get("web/src/pages/home.tsx")!;
    expect(home).toContain("<MoneyValue value={ orderTotals.data.totalSum } />");
    // …and an int tile is NOT wrapped.
    expect(home).toContain("{orderTotals.data.lineCountSum}");
  });

  it("labels the row count after the aggregate, and a sum after its field", async () => {
    const home = (await generateSystemFiles(WITH_DASHBOARD)).get("web/src/pages/home.tsx")!;
    expect(home).toContain('"Orders")}');
    // A field already named `total` must not read "Total total".
    expect(home).toContain('"Total")}');
    expect(home).toContain('"Total line count")}');
  });

  it("leaves Home byte-identical without the macro", async () => {
    // The welcome page is unchanged for every system that never opted in — the
    // KPI row is additive, not a rewrite of the scaffold.
    const home = (await generateSystemFiles(WITHOUT)).get("web/src/pages/home.tsx")!;
    expect(home).not.toContain("useOrderTotals");
    expect(home).not.toContain("QueryView");
    expect(home).toContain('"Welcome")}');
  });
});

describe("scaffoldDashboard — agreement between the halves", () => {
  it("binds the page to a HAND-WRITTEN projection of the same name", async () => {
    // The ui side detects the projection structurally, so an author who writes
    // `OrderTotals` themselves gets the dashboard without the macro — and the
    // tiles follow THEIR field list, not the scaffold's.
    const handWritten = `system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  total: money  derived display: string = code }
      repository Orders for Order { }
      projection OrderTotals { placed: int
        from Order as o
        select placed = count() }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  ui WebApp with scaffold(subdomains: [Sales]) { api Sales: SalesApi }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3000 }
}`;
    const home = (await generateSystemFiles(handWritten)).get("web/src/pages/home.tsx")!;
    expect(home).toContain("const orderTotals = useOrderTotals();");
    expect(home).toContain("{orderTotals.data.placed}");
    // The scaffold's own field names are absent — the projection won.
    expect(home).not.toContain("rowCount");
  });

  it("does not re-emit a projection the context already declares", async () => {
    // A hand-written one wins; re-emitting would be a duplicate declaration.
    const both = `system Shop {
  subdomain Sales {
    context Orders with scaffoldDashboard {
      aggregate Order { code: string  derived display: string = code }
      repository Orders for Order { }
      projection OrderTotals { placed: int
        from Order as o
        select placed = count() }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}`;
    const routes = (await generateSystemFiles(both)).get("api/http/query-projections.ts")!;
    expect(routes).toContain("placed: count()");
    expect(routes).not.toContain("rowCount");
  });
});
