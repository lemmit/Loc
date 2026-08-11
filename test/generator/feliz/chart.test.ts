// M-T1.3 Phase 4 — `Chart` on Feliz, plus the LIST-shaped projection read it
// stands on.
//
// Two things are pinned here, and the second one is a PRE-EXISTING defect this
// leg had to fix before a chart could work at all:
//
//   1. A GROUPED projection read is `Remote<'Row list>` decoded with
//      `Decode.list` and rendered through `View.remoteList`.  It used to be
//      hard-coded to the singleton `'Row option` / `Decode.map Some` form —
//      `felizProjectionRead` took only the projection's NAME, so the shape
//      question was structurally unaskable — while the WALKER (which does ask,
//      through `queryShape`) rendered `View.remoteList`.  The halves disagreed:
//      the emitted F# named a matcher `renderViewModule` had not emitted AND
//      mistyped the field it passed it, so any Feliz ui reading a grouped
//      projection failed `dotnet fable`.  Both halves now answer from
//      `projectionReadShape`, the same detector every other frontend uses.
//
//   2. `Chart` renders as inline SVG through a `View.chart` helper — no
//      charting library, no `.fsproj` dependency.  Feliz has no `.hbs` pack
//      matrix, so unlike the tsx leg there is no per-pack library to choose.
//
// The emitted F# is Fable-compiled in `generated-feliz-build.yml`; what this
// suite adds is the per-shape pinning that a build gate cannot express.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** A system whose ui reads `SalesByStatus` — a GROUPED projection (one row per
 *  status), i.e. the LIST response shape. */
const GROUPED = (body: string): string => `
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
  deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The same system with the WHOLE-TABLE aggregation instead — the singleton
 *  response shape, whose read must stay on the `option` form. */
const SINGLETON = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
        total: money
        derived display: string = code
      }
      repository Orders for Order {}
      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        select orders = count(), revenue = sum(o.total)
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
      body: Stack {
        QueryView { of: Sales.SalesTotals, empty: Text { "None" }, data: t => Stat { "Orders", t.orders } }
      }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

const CHART = `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue }`;

async function appFs(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const hit = [...files].find(([p]) => p.endsWith("App.fs"));
  if (!hit) throw new Error(`no App.fs emitted; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("feliz projection read — the response SHAPE decides the matcher", () => {
  it("decodes a GROUPED projection as a list, not one object", async () => {
    const fs = await appFs(GROUPED(CHART));
    expect(fs).toContain("let salesByStatus () : Async<Result<SalesByStatusRow list, string>>");
    expect(fs).toContain("(Decode.list Decoders.salesByStatusRow)");
    // The singleton form must be gone — decoding an array with `Decode.map Some`
    // is the bug, and it fails at runtime rather than at the type level.
    expect(fs).not.toContain("(Decode.map Some Decoders.salesByStatusRow)");
  });

  it("types the Model field and Msg case as the list", async () => {
    const fs = await appFs(GROUPED(CHART));
    expect(fs).toContain("SalesByStatus: Remote<SalesByStatusRow list>");
    expect(fs).toContain("| SalesByStatusLoaded of Result<SalesByStatusRow list, string>");
  });

  it("emits the `View.remoteList` matcher the grouped read is rendered through", async () => {
    // The defect: the walker rendered `View.remoteList` while `renderViewModule`
    // emitted only `remoteOne`, so the generated F# called an undefined function.
    const fs = await appFs(
      GROUPED(`QueryView {
      of: Sales.SalesByStatus,
      empty: Text { "None" },
      data: rows => Group { Text { "loaded" } }
    }`),
    );
    expect(fs).toContain("let remoteList (r: Remote<'T list>)");
    expect(fs).toContain("View.remoteList model.SalesByStatus");
  });

  it("keeps the whole-table aggregation on the singleton form", async () => {
    const fs = await appFs(SINGLETON);
    expect(fs).toContain("let salesTotals () : Async<Result<SalesTotalsRow option, string>>");
    expect(fs).toContain("(Decode.map Some Decoders.salesTotalsRow)");
    expect(fs).toContain("SalesTotals: Remote<SalesTotalsRow option>");
    expect(fs).toContain("let remoteOne (r: Remote<'T option>)");
  });
});

describe("feliz Chart — inline SVG, no charting library", () => {
  it("calls View.chart with the Model field and the two accessors", async () => {
    const fs = await appFs(GROUPED(CHART));
    // `model.` prefix: `buildHookUse` returns the bare field (Elmish has no hook
    // to hoist), so each consumer names the record it reads from.
    expect(fs).toContain(
      'View.chart true "Bar chart of SalesByStatus: revenue by status" model.SalesByStatus ' +
        "(fun r -> string r.status) (fun r -> float r.revenue)",
    );
  });

  it("emits the View.chart helper as SVG built from the rows", async () => {
    const fs = await appFs(GROUPED(CHART));
    expect(fs).toContain(
      "let chart (isBar: bool) (label: string) (r: Remote<'T list>) " +
        "(xOf: 'T -> string) (yOf: 'T -> float) : ReactElement =",
    );
    expect(fs).toContain("Svg.svg [");
    expect(fs).toContain("Svg.rect [");
    expect(fs).toContain("Svg.polyline [");
    // A Feliz SVG element takes `ISvgAttribute list`, NOT the `IReactProperty`
    // list `prop.*` builds — mixing them is a hard Fable error ("No overloads
    // match for method 'rect'"), which is why every attribute is `svg.custom`.
    expect(fs).not.toMatch(/Svg\.(svg|rect|polyline) \[[\s\S]{0,400}?prop\./);
  });

  it("carries the a11y contract — role=img plus the derived name", async () => {
    const fs = await appFs(GROUPED(CHART));
    expect(fs).toContain('svg.custom ("role", "img")');
    expect(fs).toContain('svg.custom ("aria-label", label)');
  });

  it("floors the scale so a flat series is not a divide-by-zero", async () => {
    const fs = await appFs(GROUPED(CHART));
    expect(fs).toContain(
      "let maxValue = if List.isEmpty values then 1.0 else max 1.0 (List.max values)",
    );
  });

  it("adds no charting dependency to the .fsproj", async () => {
    const files = await generateSystemFiles(GROUPED(CHART));
    const proj = [...files].find(([p]) => p.endsWith("App.fsproj"))?.[1] ?? "";
    expect(proj).toContain('<PackageReference Include="Feliz"');
    expect(proj.toLowerCase()).not.toContain("chart");
  });

  it("ships the helper ONLY when a chart renders", async () => {
    const fs = await appFs(
      GROUPED(`QueryView {
      of: Sales.SalesByStatus,
      empty: Text { "None" },
      data: rows => Group { Text { "loaded" } }
    }`),
    );
    expect(fs).not.toContain("let chart (isBar: bool)");
  });

  it("renders a line chart through the same helper", async () => {
    const fs = await appFs(
      GROUPED(
        `Chart { kind: "line", of: Sales.SalesByStatus, x: r => r.status, y: r => r.orderCount }`,
      ),
    );
    expect(fs).toContain(
      'View.chart false "Line chart of SalesByStatus: orderCount by status" model.SalesByStatus',
    );
    expect(fs).toContain("(fun r -> float r.orderCount)");
  });
});
