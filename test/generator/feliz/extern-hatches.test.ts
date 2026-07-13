import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Feliz (F#/Fable) frontend extern hatches (extern-{component,function}-escape-
// hatch.md).  Both bind the idiomatic F# way — by MODULE, derived from the
// `from "<path>"` clause (PascalCased segments).  A body reference is emitted
// BARE (`initials(args)` / `OrderChart {| … |}`) and the `App.fs` head `open`s
// exactly the modules used, so a missing module fails `dotnet fable` (the
// fail-fast).  Only USED extern names produce an `open` (F# unused-open warns).
// ---------------------------------------------------------------------------

const SRC = `
  system S {
    subdomain M { context Sales {
      aggregate Order { customerId: string }
      repository Orders for Order { }
    } }
    api SalesApi from M
    ui WebApp {
      api Sales: SalesApi
      function initials(name: string): string extern from "helpers/format"
      function unused(x: string): string extern from "helpers/other"
      component OrderChart(caption: string) extern from "widgets/order_chart"
      page Home { route: "/" body: Stack { Heading { initials("Ada") }, OrderChart(caption: "Q3") } }
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node contexts: [Sales] serves: SalesApi dataSources: [salesState] port: 3000 }
    deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3005 }
  }
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("Feliz extern hatches", () => {
  it("renders an extern function call bare and opens its module", async () => {
    const fs = await appFs(SRC);
    expect(fs).toContain("open Helpers.Format");
    expect(fs).toContain('initials("Ada")');
  });

  it("renders an extern component as `Name {| … |}` and opens its module", async () => {
    const fs = await appFs(SRC);
    expect(fs).toContain("open Widgets.OrderChart");
    expect(fs).toContain('OrderChart {| caption = "Q3" |}');
  });

  it("opens only the extern modules actually used (no unused-open)", async () => {
    const fs = await appFs(SRC);
    // `unused` is declared but never called → its module is NOT opened (F#
    // unused-open would warn and the build treats warnings as errors).
    expect(fs).not.toContain("open Helpers.Other");
  });
});
