// M-T1.3 Phase 4 — `Chart` on Flutter: a `CustomPainter` over the rows the
// page already watches, with NO charting package.
//
// The rows are decoded on this side (a Riverpod `FutureProvider<List<Row>>`),
// so plotting them is arithmetic — the same conclusion the Feliz and HEEx legs
// reached in their own languages.  Flutter has no `.hbs` pack matrix either, so
// unlike the tsx leg there is no per-pack library to choose.
//
// The sharpest thing pinned here is the READ COLLECTION: a `Chart`'s `of:` is a
// projection read that is NOT wrapped in a `QueryView`, and the collector used
// to look for `QueryView` only.  A chart-only page therefore imported
// `reads.dart` and watched a provider the emitter never wrote — two
// `flutter analyze` errors (`uri_does_not_exist` + `undefined_identifier`),
// found by running the real analyzer over the generated project.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (body: string): string => `
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
  deployable mobile { platform: flutter targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

const CHART = `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue }`;

async function emitted(src: string): Promise<Map<string, string>> {
  return await generateSystemFiles(src);
}

async function dashPage(src: string): Promise<string> {
  const files = await emitted(src);
  const hit = [...files].find(([p]) => p.endsWith("lib/pages/dash_page.dart"));
  if (!hit) throw new Error(`no dash_page.dart; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("flutter Chart — a CustomPainter, no charting package", () => {
  it("renders LoomChart over the loaded rows, mapped to points", async () => {
    const page = await dashPage(SYSTEM(CHART));
    expect(page).toContain(
      'LoomChart(isBar: true, label: "Bar chart of SalesByStatus: revenue by status", ' +
        "points: (salesByStatusRead.asData?.value ?? const []).map((r) => " +
        "LoomChartPoint(r.status.toString(), (r.revenue as num).toDouble())).toList())",
    );
  });

  it("emits lib/chart.dart and imports it from the page", async () => {
    const files = await emitted(SYSTEM(CHART));
    const chart = [...files].find(([p]) => p.endsWith("lib/chart.dart"))?.[1];
    expect(chart).toBeDefined();
    expect(chart).toContain("class LoomChart extends StatelessWidget");
    expect(chart).toContain("class _LoomChartPainter extends CustomPainter");
    expect(await dashPage(SYSTEM(CHART))).toContain("import '../chart.dart';");
  });

  it("collects the chart's own read — a chart-only page still gets its provider", async () => {
    // The defect: `queryViewOfArgs` matched `QueryView` only, so this page
    // imported `reads.dart` and watched a provider that was never emitted.
    const files = await emitted(SYSTEM(CHART));
    const reads = [...files].find(([p]) => p.endsWith("lib/reads.dart"))?.[1];
    expect(reads).toBeDefined();
    expect(reads).toContain(
      "final salesByStatusReadProvider = FutureProvider<List<SalesByStatusRow>>",
    );
    const page = await dashPage(SYSTEM(CHART));
    expect(page).toContain("import '../reads.dart';");
    expect(page).toContain("final salesByStatusRead = ref.watch(salesByStatusReadProvider);");
  });

  it("carries the a11y contract — Semantics(image:) plus the derived name", async () => {
    const files = await emitted(SYSTEM(CHART));
    const chart = [...files].find(([p]) => p.endsWith("lib/chart.dart"))?.[1] ?? "";
    expect(chart).toContain("image: true,");
    expect(chart).toContain("label: label,");
  });

  it("floors the scale so a flat series is not a divide-by-zero", async () => {
    const files = await emitted(SYSTEM(CHART));
    const chart = [...files].find(([p]) => p.endsWith("lib/chart.dart"))?.[1] ?? "";
    expect(chart).toContain(".fold<double>(1, (a, b) => a > b ? a : b)");
  });

  it("adds no charting package to pubspec.yaml", async () => {
    const files = await emitted(SYSTEM(CHART));
    const pubspec = [...files].find(([p]) => p.endsWith("pubspec.yaml"))?.[1] ?? "";
    expect(pubspec).toContain("flutter_riverpod:");
    expect(pubspec).not.toContain("fl_chart");
    expect(pubspec).not.toContain("charts_flutter");
  });

  it("ships chart.dart ONLY when a chart renders", async () => {
    const files = await emitted(
      SYSTEM(`QueryView {
        of: Sales.SalesByStatus,
        empty: Text { "None" },
        data: rows => Group { Text { "loaded" } }
      }`),
    );
    expect([...files.keys()].some((p) => p.endsWith("lib/chart.dart"))).toBe(false);
  });

  it("renders a line chart through the same widget", async () => {
    const page = await dashPage(
      SYSTEM(
        `Chart { kind: "line", of: Sales.SalesByStatus, x: r => r.status, y: r => r.orderCount }`,
      ),
    );
    expect(page).toContain("LoomChart(isBar: false,");
    expect(page).toContain("(r.orderCount as num).toDouble()");
  });
});
