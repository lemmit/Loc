import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Extern frontend functions — SvelteKit flavour
// (extern-function-hook-escape-hatch.md §3).  Mirrors
// test/generator/react/extern-functions.test.ts: the typed signature +
// conformance shim emit per declaration (signature DTO imports resolve
// against SvelteKit's `src/lib/api/`), and page-body calls import the
// shim via the `$lib/<name>` alias.
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
      function initials(name: string): string extern from "./helpers/initials"
      function orderLabel(order: Order): string extern from "./helpers/order-label"
      page Home { route: "/" body: Heading { initials("Ada Lovelace") } }
    }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
    deployable web { platform: svelte, targets: api, ui: WebApp { Sales: api }, port: 3001 }
  }
`;

describe("extern frontend functions — SvelteKit", () => {
  it("emits the typed signature + conformance shim per declaration", async () => {
    const files = await generateSystemFiles(SRC);
    const sig = files.get("web/src/lib/extern/initials.signature.ts")!;
    expect(sig).toContain("export type InitialsFn = (name: string) => string;");

    const shim = files.get("web/src/lib/initials.ts")!;
    expect(shim).toContain('import { initials as _impl } from "../helpers/initials";');
    expect(shim).toContain('import type { InitialsFn } from "./extern/initials.signature";');
    expect(shim).toContain("export const initials: InitialsFn = _impl;");
  });

  it("an aggregate-typed param uses the wire DTO from src/lib/api", async () => {
    const files = await generateSystemFiles(SRC);
    const sig = files.get("web/src/lib/extern/orderLabel.signature.ts")!;
    expect(sig).toContain('import type { OrderResponse } from "../api/order";');
    expect(sig).toContain("export type OrderLabelFn = (order: OrderResponse) => string;");
  });

  it("a body call imports the shim via $lib and renders as an expression", async () => {
    const files = await generateSystemFiles(SRC);
    const home = files.get("web/src/routes/(app)/+page.svelte")!;
    expect(home).toContain('import { initials } from "$lib/initials";');
    expect(home).toContain('{initials("Ada Lovelace")}');
    // The undeclared function is not imported.
    expect(home).not.toContain("orderLabel");
  });

  it("a component-body call imports the shim too", async () => {
    const src = SRC.replace(
      'page Home { route: "/" body: Heading { initials("Ada Lovelace") } }',
      `component Badge(name: string) { body: Text { initials(name) } }
      page Home { route: "/" body: Badge { "Ada" } }`,
    );
    const files = await generateSystemFiles(src);
    const badge = files.get("web/src/lib/components/Badge.svelte")!;
    expect(badge).toContain('import { initials } from "$lib/initials";');
    expect(badge).toContain("{initials(name)}");
  });
});
