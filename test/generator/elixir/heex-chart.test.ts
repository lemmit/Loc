// M-T1.3 Phase 4 — the `Chart` primitive on Phoenix/LiveView.
//
// The parity ledger carried Chart as a pinned HEEx gap, with the reason "no
// JS-free LiveView charting; the story is a Chart.js hook".  The premise was
// wrong, and this suite is what shows it: a chart plots a GROUPED query-time
// projection's rows, and on LiveView those rows are ALREADY on the server in an
// assign.  So the geometry is arithmetic, the output is inline SVG, and the
// emitted app carries no charting library and no JavaScript at all.
//
// What that costs, and what is pinned here:
//
//   - the call site is a COMPONENT invocation, not inline markup — the
//     scale/axis maths is Elixir, and HEEx is a markup template;
//   - the `LoomChart` component is emitted once per deployable, and only when a
//     chart is actually rendered;
//   - the data binding rides the SAME projection QueryBinding a `QueryView`
//     pushes, so the page gets its `defp load_<proj>/1` loader;
//   - `x:`/`y:` unwrap to the SNAKE keys the loader rekeys the wire row to;
//   - the a11y contract (`role="img"` + a derived name) reads the same sentence
//     the TSX emit derives, so a screen reader hears the same thing on both.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        placedAt: datetime
        total: money
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order {}
      projection SalesByStatus {
        status: OrderStatus
        orderCount: int
        revenue: money
        from Order as o
        group by o.status
        select status = o.status, orderCount = count(), revenue = sum(o.total)
      }
      projection RevenueByDay {
        day: datetime
        revenue: money
        from Order as o
        group by o.placedAt.startOfDay()
        select day = o.placedAt.startOfDay(), revenue = sum(o.total)
      }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.orderCount },
        Chart { kind: "line", of: Sales.RevenueByDay, x: r => r.day, y: r => r.revenue, testid: "rev-chart" }
      }
    }
  }

  deployable web {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    ui: WebApp { Sales: web }
    port: 4000
  }
}
`;

async function files(src = SRC): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [path, content] of all) {
    if (path.startsWith("web/")) out.set(path.slice("web/".length), content);
  }
  return out;
}

describe("HEEx Chart — the call site", () => {
  it("invokes the shared component, kind-discriminated", async () => {
    const page = (await files()).get("lib/web_web/live/dash_live.ex")!;
    expect(page).toContain(`<WebWeb.Components.LoomChart.chart kind="bar"`);
    expect(page).toContain(`<WebWeb.Components.LoomChart.chart kind="line"`);
  });

  it("binds the projection assign and the SNAKE-rekeyed accessor keys", async () => {
    const page = (await files()).get("lib/web_web/live/dash_live.ex")!;
    // `orderCount` on the wire → `:order_count` in the assign (the loader
    // rekeys), so the component's `Map.get(row, @y)` finds it.
    expect(page).toContain("rows={@sales_by_status} x={:status} y={:order_count}");
    expect(page).toContain("rows={@revenue_by_day} x={:day} y={:revenue}");
  });

  it("pushes the projection load — the chart's rows come from the same loader", async () => {
    const page = (await files()).get("lib/web_web/live/dash_live.ex")!;
    expect(page).toContain(
      "socket = assign(socket, :sales_by_status, load_sales_by_status(socket))",
    );
    expect(page).toContain("defp load_sales_by_status(socket) do");
    expect(page).toContain("Web.Orders.QueryProjections.SalesByStatus.run(current_user)");
  });

  it("carries the derived accessible name and the testid", async () => {
    const page = (await files()).get("lib/web_web/live/dash_live.ex")!;
    expect(page).toContain(`label="Bar chart of SalesByStatus: order_count by status"`);
    expect(page).toContain(`label="Line chart of RevenueByDay: revenue by day"`);
    expect(page).toContain(`testid="rev-chart"`);
  });
});

describe("HEEx Chart — the emitted component", () => {
  it("is emitted once per deployable, and only for a chart-using app", async () => {
    expect((await files()).has("lib/web_web/components/loom_chart.ex")).toBe(true);
    // Same system with the charts removed emits nothing.
    const noChart = SRC.replace(/Chart \{[^}]*\},?\n?/g, "").replace(
      "body: Stack {\n      }",
      `body: Stack { Text { "hi" } }`,
    );
    expect((await files(noChart)).has("lib/web_web/components/loom_chart.ex")).toBe(false);
  });

  it("renders inline SVG — no charting library, no JS hook", async () => {
    const comp = (await files()).get("lib/web_web/components/loom_chart.ex")!;
    expect(comp).toContain("<svg");
    expect(comp).toContain("<rect :for={m <- @marks}");
    expect(comp).toContain("<polyline points={@polyline}");
    expect(comp).not.toContain("phx-hook");
    // The deployable's package/asset surface gains no chart dependency: there
    // is no npm package to add, which is the whole point.
    const all = await files();
    for (const [path, content] of all) {
      if (path.endsWith("package.json")) expect(content).not.toContain("chart");
    }
  });

  it("is an image of data — role=img with the passed accessible name", async () => {
    const comp = (await files()).get("lib/web_web/components/loom_chart.ex")!;
    expect(comp).toContain(`role="img" aria-label={@label}`);
  });

  it("coerces every plottable wire type, and degrades rather than raising", async () => {
    const comp = (await files()).get("lib/web_web/components/loom_chart.ex")!;
    // money rides the wire as a STRING, decimal as a float, count as an int.
    expect(comp).toContain("defp number_of(%Decimal{} = v), do: Decimal.to_float(v)");
    expect(comp).toContain("defp number_of(v) when is_binary(v) do");
    expect(comp).toContain("defp number_of(v) when is_number(v), do: v * 1.0");
    // A failed read assigns the `:error` sentinel; the chart shows an empty
    // axis instead of raising on a non-list.
    expect(comp).toContain("defp rows_of(rows) when is_list(rows), do: rows");
    expect(comp).toContain("defp rows_of(_), do: []");
    // A flat or empty series must not divide by zero, and a negative sum must
    // not produce a negative SVG rect height.
    expect(comp).toContain("peak = if peak > 0.0, do: peak, else: 1.0");
    expect(comp).toContain("h = max(value / peak * @height, 0.0)");
  });
});
