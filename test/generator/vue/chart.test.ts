// M-T1.3 Phase 4 — `Chart` on Vue, rendered by a generated component with no
// charting library.
//
// THE POINT OF THIS LEG IS WHERE THE TEMPLATE LIVES.  Every earlier Chart PR
// described vue/svelte/angular as needing "a charting library chosen per pack",
// which put 7 pack integrations in front of them.  Two facts make that false:
// four of seven targets already chart with no library at all (the rows are
// decoded client-side, so the geometry is arithmetic), and a framework's SHARED
// template layer (`vue/`) registers into the same template map a pack renders
// from.  So `primitive-chart.hbs` written ONCE serves every vue pack — which is
// what the pack-agnostic assertions below pin.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (body: string, design = ""): string => `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
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
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui WebApp {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack { ${body} }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: vue targets: api ui: WebApp { Sales: api }${design} port: 3000 }
}
`;

const CHART = `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue }`;

async function emitted(body: string, design = ""): Promise<Map<string, string>> {
  return await generateSystemFiles(SYSTEM(body, design));
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const hit = [...files].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no ${suffix}; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("vue Chart — one shared template, every pack", () => {
  it("renders LoomChart with the rows projected to the flat point shape", async () => {
    const page = fileEndingWith(await emitted(CHART), "src/pages/dash.vue");
    expect(page).toContain(
      '<LoomChart :is-bar="true" label="Bar chart of SalesByStatus: revenue by status" ' +
        ':rows="(salesByStatus.data ?? []).map((r) => ' +
        '({ label: String(r.status), value: Number(r.revenue) }))" />',
    );
  });

  it("emits the component and imports it into the page", async () => {
    const files = await emitted(CHART);
    expect(fileEndingWith(files, "src/components/LoomChart.vue")).toContain(
      "defineProps<{ isBar: boolean; label: string; rows: LoomChartPoint[] }>()",
    );
    // A DEFAULT import: an SFC has no named export, which is one of the two
    // reasons this cannot ride the walker's named-import map (the other is that
    // the Vue shell drops every relative specifier from it).
    expect(fileEndingWith(files, "src/pages/dash.vue")).toContain(
      'import LoomChart from "../components/LoomChart.vue";',
    );
  });

  it("renders identically on the OTHER vue pack — the template is shared, not per-pack", async () => {
    // shadcnVue and vuetify share one `vue/primitive-chart.hbs`.  If this ever
    // needs a per-pack template, a pack can override `primitive-chart` by name —
    // but nothing about a chart requires it, which is the whole finding.
    const shadcn = fileEndingWith(await emitted(CHART, " design: shadcnVue"), "src/pages/dash.vue");
    expect(shadcn).toContain('<LoomChart :is-bar="true"');
    expect(shadcn).toContain('import LoomChart from "../components/LoomChart.vue";');
  });

  it("adds no charting dependency to package.json", async () => {
    const pkg = fileEndingWith(await emitted(CHART), "package.json");
    expect(pkg).not.toContain("chart");
    expect(pkg).not.toContain("recharts");
  });

  it("ships the component ONLY when a page charts", async () => {
    const files = await emitted(`QueryView {
      of: Sales.SalesByStatus,
      empty: Text { "None" },
      data: rows => Group { Text { "loaded" } }
    }`);
    expect([...files.keys()].some((p) => p.endsWith("src/components/LoomChart.vue"))).toBe(false);
  });

  it("floors the scale so a flat series is not a divide-by-zero", async () => {
    const chart = fileEndingWith(await emitted(CHART), "src/components/LoomChart.vue");
    expect(chart).toContain("Math.max(1, ...props.rows.map((r) => r.value))");
  });

  it("carries the a11y contract — role=img plus the derived name", async () => {
    const chart = fileEndingWith(await emitted(CHART), "src/components/LoomChart.vue");
    expect(chart).toContain('role="img"');
    expect(chart).toContain(':aria-label="label"');
  });

  it("renders a line chart through the same component", async () => {
    const page = fileEndingWith(
      await emitted(
        `Chart { kind: "line", of: Sales.SalesByStatus, x: r => r.status, y: r => r.orderCount }`,
      ),
      "src/pages/dash.vue",
    );
    expect(page).toContain('<LoomChart :is-bar="false"');
    expect(page).toContain("value: Number(r.orderCount)");
  });
});
