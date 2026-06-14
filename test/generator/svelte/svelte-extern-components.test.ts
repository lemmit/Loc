import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Extern components — SvelteKit flavour (the UI escape hatch, Tier 1).
//
// A `component X(...) extern from "<path>"` makes Loom emit, mirroring
// the react contract (walker-extern-components.test.ts):
//   - a re-export wrapper at `src/lib/components/<Name>.svelte` that
//     forwards its typed `$props()` to the hand-written module at the
//     `from` path (so call sites import `$lib/components/<Name>.svelte`
//     unchanged);
//   - a typed `src/lib/components/<Name>.props.ts` from the params' wire
//     shape (aggregate → `<Agg>Response`, slot → Svelte 5 `Snippet`);
// and NOT a walked body.
// ---------------------------------------------------------------------------

function sys(uiBody: string, pageBody = 'Heading { "hi" }'): string {
  return `
    system S {
      subdomain M { context C { aggregate Order { customerId: string } } }
      ui WebApp {
        ${uiBody}
        page Home { route: "/" body: ${pageBody} }
      }
      deployable api { platform: hono, contexts: [C], serves: SApi, port: 3000 }
      api SApi from M
      deployable web { platform: svelte, targets: api, ui: WebApp, port: 3001 }
    }
  `;
}

describe("extern components — SvelteKit", () => {
  it("emits a forwarding wrapper + typed props file, no walked body", async () => {
    const files = await generateSystemFiles(
      sys(
        `component OrderChart(order: Order, caption: string, aside: slot?)
           extern from "widgets/order-chart"`,
      ),
    );

    // Wrapper forwards to the hand-written module (two `../` hops from
    // src/lib/components/ to the src-relative `from` path) + props type.
    const shim = files.get("web/src/lib/components/OrderChart.svelte");
    expect(shim, "wrapper emitted").toBeDefined();
    expect(shim).toContain('import Impl from "../../widgets/order-chart";');
    expect(shim).toContain('import type { OrderChartProps } from "./OrderChart.props";');
    expect(shim).toContain("const props: OrderChartProps = $props();");
    expect(shim).toContain("<Impl {...props} />");
    // No body was walked — the wrapper is a pure forward.
    expect(shim).not.toContain("$state");

    // Props: aggregate → wire DTO import, primitive → string, optional
    // slot → optional Snippet.
    const props = files.get("web/src/lib/components/OrderChart.props.ts");
    expect(props, "props file emitted").toBeDefined();
    expect(props).toContain('import type { Snippet } from "svelte";');
    expect(props).toContain('import type { OrderResponse } from "$lib/api/order";');
    expect(props).toContain("export interface OrderChartProps {");
    expect(props).toContain("order: OrderResponse;");
    expect(props).toContain("caption: string;");
    expect(props).toContain("aside?: Snippet;");
  });

  it("call sites import $lib/components/<Name>.svelte unchanged and render the element", async () => {
    const files = await generateSystemFiles(
      sys('component Banner(text: string) extern from "widgets/banner"', 'Banner { "hello" }'),
    );
    const home = files.get("web/src/routes/(app)/+page.svelte");
    expect(home, "page emitted").toBeDefined();
    expect(home).toContain('import Banner from "$lib/components/Banner.svelte";');
    expect(home).toContain("<Banner");
  });

  it("a param-less extern component emits an empty-object props type", async () => {
    const files = await generateSystemFiles(
      sys('component Spinner() extern from "widgets/spinner"'),
    );
    const props = files.get("web/src/lib/components/Spinner.props.ts");
    expect(props).toContain("export type SpinnerProps = Record<string, never>;");
    const shim = files.get("web/src/lib/components/Spinner.svelte");
    expect(shim).toContain('import Impl from "../../widgets/spinner";');
  });
});
