// M-T1.3 Phase 4 — the `Chart` primitive on react + mantine v9.
//
// `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r =>
// r.revenue }` plots a GROUPED query-time projection's LIST response.  What
// this pins, per piece:
//
//   - the `of:` member rides the detector's Pattern H, so the projection hook
//     is HOISTED (`useSalesByStatus()`) and the chart reads the hook variable
//     — never an unresolved receiver;
//   - the data binding is `.data ?? []` (the parsed `z.array` response; an
//     empty chart mid-load, not a crash);
//   - the `x:`/`y:` lambdas unwrap to accessor field STRINGS — the chart's
//     `dataKey` and series name;
//   - the kind discriminator picks `<BarChart>` vs `<LineChart>`, and the
//     import merge registers only what renders;
//   - a chart is an image of data: `role="img"` + a derived `aria-label` on
//     the wrapper (the registry's a11y contract).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Shop {
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
      repository Orders for Order {}
      projection SalesByStatus {
        status: OrderStatus
        orders: int
        revenue: money
        from Order as o
        group by o.status
        select status = o.status, orders = count(), revenue = sum(o.total)
      }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue },
        Chart { kind: "line", of: Sales.SalesByStatus, x: r => r.status, y: r => r.orders, testid: "orders-chart" }
      }
    }
  }

  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The react deployable's emitted page, path-stripped off the system tree. */
async function dashPage(): Promise<string> {
  const all = await generateSystemFiles(SRC);
  const page = all.get("web/src/pages/dash.tsx");
  expect(page, "expected web/src/pages/dash.tsx to be emitted").toBeDefined();
  return page!;
}

describe("Chart walker emit (react + mantine v9)", () => {
  it("hoists the projection hook and binds `.data ?? []`", async () => {
    const page = await dashPage();
    expect(page).toContain('import { useSalesByStatus } from "../api/projections";');
    expect(page).toContain("const salesByStatus = useSalesByStatus();");
    // The row is projected to the two plotted columns, with the SERIES coerced
    // to a number.  Both halves are load-bearing, and neither was in the
    // original Phase 4 emit: a `money` field parses client-side into a
    // `Decimal`, which no chart library can plot — `@mui/x-charts` rejects it
    // at compile time while recharts / `@mantine/charts` accept it and then
    // render nothing.  Projecting (rather than spreading `...r`) also drops
    // sibling money columns that would fail the same dataset type.
    expect(page).toContain(
      "data={ (salesByStatus.data ?? []).map((r) => ({ status: r.status, revenue: Number(r.revenue) })) }",
    );
    // The pre-Phase-4 failure mode this closes.
    expect(page).not.toContain("unresolved");
    expect(page).not.toContain("undefined.SalesByStatus");
  });

  it("discriminates the kind — <BarChart> for bar, <LineChart> for line", async () => {
    const page = await dashPage();
    expect(page).toContain("<BarChart");
    expect(page).toContain("<LineChart");
    expect(page).toContain('import { BarChart, LineChart } from "@mantine/charts";');
  });

  it("unwraps x/y accessor lambdas to the dataKey and series field strings", async () => {
    const page = await dashPage();
    expect(page).toContain('dataKey="status"');
    expect(page).toContain('series={[{ name: "revenue" }]}');
    expect(page).toContain('series={[{ name: "orders" }]}');
    expect(page).toContain("h={300}");
  });

  it("wraps the chart in role=img with a derived aria-label", async () => {
    const page = await dashPage();
    expect(page).toContain('role="img"');
    expect(page).toContain('aria-label="Bar chart of SalesByStatus: revenue by status"');
    expect(page).toContain('aria-label="Line chart of SalesByStatus: orders by status"');
  });

  it("passes testid: through to the wrapper", async () => {
    expect(await dashPage()).toContain('data-testid="orders-chart"');
  });

  it("adds the chart dependency to package.json only for chart-using apps", async () => {
    const all = await generateSystemFiles(SRC);
    const pkg = all.get("web/package.json")!;
    expect(pkg).toContain('"@mantine/charts"');
    expect(pkg).toContain('"recharts"');
  });
});
