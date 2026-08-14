// M-T1.3 Phase 4 — `Chart` on Angular: the SEVENTH and last target.
//
// Angular was the one leg with a real wrinkle, and it is worth naming because
// it is the reason this went last rather than first: an Angular template
// resolves identifiers against the COMPONENT INSTANCE, never a module import or
// a JS global.  The page shell already re-exposes `sortRows`, `filterRows`,
// `Math` and `String` as `protected readonly` members for exactly that reason.
//
// Two consequences, both pinned here:
//   1. the geometry lives INSIDE `LoomChart` rather than in a template binding,
//      so no scale-maths helper needs lifting;
//   2. the rows projection uses `Number(...)`, which had no lift yet — the
//      shell now lifts it beside `String`, or the binding fails `ng build` with
//      "Property 'Number' does not exist".

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (body: string, design = "", components = ""): string => `
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
    api Sales: SalesApi${components}
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack { ${body} }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: angular targets: api ui: WebApp { Sales: api }${design} port: 3000 }
}
`;

const CHART = `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue }`;

/** A walked user component that charts — the page invoking it renders only an
 *  `<ng-container [ngComponentOutlet]>`, never the chart tag itself. */
const COMPONENT = `
    component RevenueTile(caption: string) {
      body: Stack { Text { caption }, ${CHART} }
    }`;

async function emitted(body: string, design = "", components = ""): Promise<Map<string, string>> {
  return await generateSystemFiles(SYSTEM(body, design, components));
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const hit = [...files].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no ${suffix}; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("angular Chart — geometry in the component, not the template", () => {
  // `.data()` is CALLED — an Angular api read hoists as a SIGNAL, so the shared
  // JS default's bare `.data` is `Signal<T[] | undefined>` and `.map` does not
  // exist on it.  `ng build` catches that (TS2339); no unit test would have.
  it("renders the loom-chart tag with the rows projected to the point shape", async () => {
    const page = fileEndingWith(await emitted(CHART), "dash.component.ts");
    expect(page).toContain(
      `<loom-chart [isBar]="true" [label]="'Bar chart of SalesByStatus: revenue by status'" ` +
        `[rows]="(salesByStatus.data() ?? []).map((r) => ` +
        `({ label: String(r.status), value: Number(r.revenue) }))" />`,
    );
  });

  it("imports the component and registers it in the standalone imports array", async () => {
    // A tag-used standalone component: one import line + one `imports: []`
    // entry, exactly like a hoisted DataGrid child.
    const page = fileEndingWith(await emitted(CHART), "dash.component.ts");
    expect(page).toContain('import { LoomChart } from "../components/loom-chart.component";');
    expect(page).toMatch(/imports:\s*\[[^\]]*LoomChart/);
  });

  it("lifts Number onto the component — a template cannot see the JS global", async () => {
    // Without this the binding fails `ng build` with "Property 'Number' does
    // not exist on type 'DashPage'".  `String` was already lifted; `Number` had
    // no caller until a chart needed one.
    const page = fileEndingWith(await emitted(CHART), "dash.component.ts");
    expect(page).toContain("protected readonly Number = Number;");
    expect(page).toContain("protected readonly String = String;");
  });

  it("keeps the scale maths inside the component", async () => {
    const chart = fileEndingWith(await emitted(CHART), "loom-chart.component.ts");
    expect(chart).toContain("Math.max(1, ...this.rowsSignal().map((r) => r.value))");
    // Nothing in the page binding computes geometry — that is the whole point.
    const page = fileEndingWith(await emitted(CHART), "dash.component.ts");
    expect(page).not.toContain("Math.max");
  });

  it("renders identically across angular packs — the template is shared", async () => {
    for (const design of ["primeng", "spartanNg"]) {
      const page = fileEndingWith(await emitted(CHART, ` design: ${design}`), "dash.component.ts");
      expect(page).toContain('<loom-chart [isBar]="true"');
      expect(page).toContain('import { LoomChart } from "../components/loom-chart.component";');
    }
  });

  it("adds no charting dependency to package.json", async () => {
    const pkg = fileEndingWith(await emitted(CHART), "package.json");
    expect(pkg).not.toContain("chart");
  });

  it("ships the component ONLY when a page charts", async () => {
    const files = await emitted(`QueryView {
      of: Sales.SalesByStatus,
      empty: Text { "None" },
      data: rows => Group { Text { "loaded" } }
    }`);
    expect(
      [...files.keys()].some((p) => p.endsWith("src/app/components/loom-chart.component.ts")),
    ).toBe(false);
  });

  // The emission used to be keyed on the PAGE text, but the page shell lifts
  // the `LoomChart` import in component mode too (`components-emit.ts` reuses
  // `renderAngularPage`).  A chart that lives in a `component` therefore wrote
  // `import { LoomChart } from "../components/loom-chart.component"` into the
  // component file while the page — which only renders `<ng-container
  // [ngComponentOutlet]>` — never said `<loom-chart`, so the runtime file was
  // never emitted and `ng build` died on TS2307.
  it("ships the component when the chart lives in a ui `component`, not the page", async () => {
    const files = await emitted(`RevenueTile { caption: "Revenue" }`, "", COMPONENT);
    const tile = fileEndingWith(files, "components/RevenueTile.ts");
    expect(tile).toContain("<loom-chart");
    expect(tile).toContain('import { LoomChart } from "../components/loom-chart.component";');
    // The import above is only resolvable if the runtime file rides along.
    expect(
      [...files.keys()].some((p) => p.endsWith("src/app/components/loom-chart.component.ts")),
    ).toBe(true);
    // And the page itself never mentions the tag — the reason the old
    // page-text predicate answered false.
    const page = fileEndingWith(files, "dash.component.ts");
    expect(page).not.toContain("<loom-chart");
  });

  it("carries the a11y contract — role=img plus the derived name", async () => {
    const chart = fileEndingWith(await emitted(CHART), "loom-chart.component.ts");
    expect(chart).toContain('role="img"');
    expect(chart).toContain('[attr.aria-label]="label"');
  });

  it("renders a line chart through the same component", async () => {
    const page = fileEndingWith(
      await emitted(
        `Chart { kind: "line", of: Sales.SalesByStatus, x: r => r.status, y: r => r.orderCount }`,
      ),
      "dash.component.ts",
    );
    expect(page).toContain('<loom-chart [isBar]="false"');
    expect(page).toContain("value: Number(r.orderCount)");
  });
});
