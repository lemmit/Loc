import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Extern frontend components — Angular flavour
// (extern-component-escape-hatch.md).  The Angular sibling of the react/vue
// extern-component slices: each `component <Name>(…) extern from "<path>"`
// emits a typed props interface + a class re-export shim under
// `src/components/`, and a body call renders through Angular's
// `NgComponentOutlet` (the selector-free, class-reference binding) — Angular
// has no JSX-family `<Name prop={…} />` tag, so the shared `emitUserComponent`
// is bypassed via the `renderUserComponent` WalkerTarget seam.
// ---------------------------------------------------------------------------

async function angularFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

const sys = (uiBody: string) => `
  system S {
    subdomain M { context Sales {
      aggregate Order { customerId: string }
      repository Orders for Order { }
    } }
    api SalesApi from M
    ui WebApp {
      api Sales: SalesApi
${uiBody}
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, dataSources: [salesState], port: 3000 }
    deployable web { platform: angular, targets: api, port: 3001, ui: WebApp { Sales: api } }
  }
`;

describe("extern frontend components — Angular", () => {
  it("emits a typed props file + a class re-export shim, no walked component", async () => {
    const files = await angularFiles(
      sys(`
      component Banner(caption: string) extern from "widgets/banner"
      page Home { route: "/" body: Heading { "hi" } }`),
    );
    const props = files.get("src/components/Banner.props.ts")!;
    expect(props).toContain("export interface BannerProps {");
    expect(props).toContain("caption: string;");

    const shim = files.get("src/components/Banner.ts")!;
    // Re-exports the NAMED class (not `default`, unlike react/vue) — an Angular
    // component is a named class.
    expect(shim).toContain('export { Banner } from "../widgets/banner";');
    expect(shim).toContain('export type { BannerProps } from "./Banner.props";');
    // No walked component file for an extern component.
    expect(files.has("src/components/Banner.component.ts")).toBe(false);
  });

  it("an aggregate-typed prop pulls in the wire DTO", async () => {
    const files = await angularFiles(
      sys(`
      component OrderChart(order: Order, caption: string) extern from "widgets/order-chart"
      page Home { route: "/" body: Heading { "hi" } }`),
    );
    const props = files.get("src/components/OrderChart.props.ts")!;
    expect(props).toContain('import type { OrderResponse } from "../api/order";');
    expect(props).toContain("order: OrderResponse;");
    expect(props).toContain("caption: string;");
  });

  it("a body call renders ngComponentOutlet, imports the class, registers the directive", async () => {
    const files = await angularFiles(
      sys(`
      component Banner(caption: string) extern from "widgets/banner"
      page Home { route: "/" body: Stack { Heading { "Dashboard" }, Banner(caption: "Q3") } }`),
    );
    const home = files.get("src/app/pages/home.component.ts")!;
    // NgComponentOutlet directive registered + class imported from the shim.
    expect(home).toContain('import { NgComponentOutlet } from "@angular/common";');
    expect(home).toContain('import { Banner } from "../../components/Banner";');
    expect(home).toContain("imports: [NgComponentOutlet],");
    // The class is re-exposed as a member (the outlet reads it against the
    // component instance) and rendered as a class-reference outlet with inputs.
    expect(home).toContain("protected readonly Banner = Banner;");
    expect(home).toContain(
      `<ng-container [ngComponentOutlet]="Banner" [ngComponentOutletInputs]='{ caption: "Q3" }'></ng-container>`,
    );
  });
});
