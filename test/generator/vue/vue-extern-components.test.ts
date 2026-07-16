import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Extern components — Vue flavour (the UI escape hatch, Tier 1).
//
// A `component X(...) extern from "<path>"` makes Loom emit, mirroring the
// react/svelte contract (walker-extern-components.test.ts,
// svelte-extern-components.test.ts):
//   - a re-export shim at `src/components/<Name>.ts` that forwards its default
//     export to the hand-written module at the `from` path (so call sites
//     import `../components/<Name>` unchanged);
//   - a typed `src/components/<Name>.props.ts` from the params' wire shape
//     (aggregate → `<Agg>Response`; slot → a Vue `Slots` interface entry);
// and NOT a walked body.
//
// Vue was the one frontend without extern-component generator coverage (it
// had `vue-extern-functions.test.ts` only) — this closes that asymmetry.
// ---------------------------------------------------------------------------

function sys(uiBody: string, pageBody = 'Heading { "hi" }'): string {
  return `
    system S {
      subdomain M { context C { aggregate Order { customerId: string } } }
      ui WebApp {
        framework: vue
        ${uiBody}
        page Home { route: "/" body: ${pageBody} }
      }
      deployable api { platform: node, contexts: [C], serves: SApi, port: 3000 }
      api SApi from M
      deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
    }
  `;
}

describe("extern components — Vue", () => {
  it("emits a forwarding shim + typed props file, no walked body", async () => {
    const files = await generateSystemFiles(
      sys(
        `component OrderChart(order: Order, caption: string, aside: slot?)
           extern from "widgets/order-chart"`,
      ),
    );

    // Shim re-exports the hand-written module + the props/slots types.
    const shim = files.get("web/src/components/OrderChart.ts");
    expect(shim, "shim emitted").toBeDefined();
    expect(shim).toContain('export { default } from "../widgets/order-chart";');
    expect(shim).toContain(
      'export type { OrderChartProps, OrderChartSlots } from "./OrderChart.props";',
    );
    // No body was walked — the shim is a pure re-export (no ref/state).
    expect(shim).not.toContain("ref(");

    // Props: aggregate → wire DTO import, primitive → string; the optional
    // slot lands on a separate Vue `Slots` interface, not the props.
    const props = files.get("web/src/components/OrderChart.props.ts");
    expect(props, "props file emitted").toBeDefined();
    expect(props).toContain('import type { OrderResponse } from "../api/order";');
    expect(props).toContain("export interface OrderChartProps {");
    expect(props).toContain("order: OrderResponse;");
    expect(props).toContain("caption: string;");
    expect(props).toContain("export interface OrderChartSlots {");
    expect(props).toContain("aside?(): unknown;");
  });

  it("call sites import ../components/<Name> unchanged and render the element", async () => {
    const files = await generateSystemFiles(
      sys('component Banner(text: string) extern from "widgets/banner"', 'Banner { text: "hi" }'),
    );
    const home = files.get("web/src/pages/home.vue");
    expect(home, "page emitted").toBeDefined();
    expect(home).toContain('import Banner from "../components/Banner";');
    expect(home).toContain("<Banner");
  });

  it("a param-less extern component still emits a shim + props file", async () => {
    const files = await generateSystemFiles(
      sys('component Spinner() extern from "widgets/spinner"'),
    );
    const shim = files.get("web/src/components/Spinner.ts");
    expect(shim).toContain('export { default } from "../widgets/spinner";');
    expect(files.get("web/src/components/Spinner.props.ts")).toBeDefined();
  });
});
