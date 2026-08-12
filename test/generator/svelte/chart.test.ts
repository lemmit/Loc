// M-T1.3 Phase 4 — `Chart` on Svelte, rendered by a generated component with
// no charting library.
//
// Fourth dependency-free leg (after HEEx, Feliz/Flutter and Vue), and the
// second to ride a framework's SHARED template layer: `sveltekit/`
// primitive-chart.hbs is written once and serves BOTH svelte packs, because
// `loader.ts` merges the shared sources into the same template map a pack
// renders from.  That is what the pack-agnostic assertions below pin.

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
  deployable web { platform: svelte targets: api ui: WebApp { Sales: api }${design} port: 3000 }
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

describe("svelte Chart — one shared template, both packs", () => {
  it("renders LoomChart with the rows projected to the flat point shape", async () => {
    const page = fileEndingWith(await emitted(CHART), "dash/+page.svelte");
    // The expression prop needs BRACES — `rows={ … }`.  A triple-stache
    // consumes them, so the template spells them separately; without that the
    // emitted `rows=(…)` is a Svelte parse error.
    expect(page).toContain(
      '<LoomChart isBar={true} label="Bar chart of SalesByStatus: revenue by status" ' +
        "rows={ (salesByStatus.data ?? []).map((r) => " +
        "({ label: String(r.status), value: Number(r.revenue) })) } />",
    );
  });

  it("emits the component and imports it into the page", async () => {
    const files = await emitted(CHART);
    expect(fileEndingWith(files, "src/lib/components/LoomChart.svelte")).toContain(
      "const { isBar, label, rows }: { isBar: boolean; label: string; rows: LoomChartPoint[] } =",
    );
    expect(fileEndingWith(files, "dash/+page.svelte")).toContain(
      'import LoomChart from "$lib/components/LoomChart.svelte";',
    );
  });

  it("renders identically on the OTHER svelte pack — the template is shared", async () => {
    const shadcn = fileEndingWith(
      await emitted(CHART, " design: shadcnSvelte"),
      "dash/+page.svelte",
    );
    expect(shadcn).toContain("<LoomChart isBar={true}");
    expect(shadcn).toContain('import LoomChart from "$lib/components/LoomChart.svelte";');
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
    expect([...files.keys()].some((p) => p.endsWith("src/lib/components/LoomChart.svelte"))).toBe(
      false,
    );
  });

  it("floors the scale so a flat series is not a divide-by-zero", async () => {
    const chart = fileEndingWith(await emitted(CHART), "src/lib/components/LoomChart.svelte");
    expect(chart).toContain("Math.max(1, ...rows.map((r) => r.value))");
  });

  it("carries the a11y contract — role=img plus the derived name", async () => {
    const chart = fileEndingWith(await emitted(CHART), "src/lib/components/LoomChart.svelte");
    expect(chart).toContain('role="img"');
    expect(chart).toContain("aria-label={label}");
  });

  it("renders a line chart through the same component", async () => {
    const page = fileEndingWith(
      await emitted(
        `Chart { kind: "line", of: Sales.SalesByStatus, x: r => r.status, y: r => r.orderCount }`,
      ),
      "dash/+page.svelte",
    );
    expect(page).toContain("<LoomChart isBar={false}");
    expect(page).toContain("value: Number(r.orderCount)");
  });
});
