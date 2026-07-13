import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Extern frontend functions — Angular flavour
// (extern-function-hook-escape-hatch.md §3).  Mirrors
// test/generator/svelte/svelte-extern-functions.test.ts: the typed signature +
// conformance shim emit per declaration (signature DTO imports resolve against
// the Angular `src/api/` modules), and a page-body call imports the shim from
// `../../lib/<name>` AND re-exposes it as a component member so the Angular
// template interpolation resolves it against the component instance.
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
    deployable web { platform: angular, targets: api, ui: WebApp { Sales: api }, port: 3001 }
  }
`;

describe("extern frontend functions — Angular", () => {
  it("emits the typed signature + conformance shim per declaration", async () => {
    const files = await generateSystemFiles(SRC);
    const sig = files.get("web/src/lib/extern/initials.signature.ts")!;
    expect(sig).toContain("export type InitialsFn = (name: string) => string;");

    const shim = files.get("web/src/lib/initials.ts")!;
    expect(shim).toContain('import { initials as _impl } from "../helpers/initials";');
    expect(shim).toContain('import type { InitialsFn } from "./extern/initials.signature";');
    expect(shim).toContain("export const initials: InitialsFn = _impl;");
  });

  it("an aggregate-typed param uses the wire DTO from src/api", async () => {
    const files = await generateSystemFiles(SRC);
    const sig = files.get("web/src/lib/extern/orderLabel.signature.ts")!;
    expect(sig).toContain('import type { OrderResponse } from "../../api/order";');
    expect(sig).toContain("export type OrderLabelFn = (order: OrderResponse) => string;");
  });

  it("a body call imports the shim, re-exposes it as a member, and interpolates it", async () => {
    const files = await generateSystemFiles(SRC);
    const home = files.get("web/src/app/pages/home.component.ts")!;
    expect(home).toContain('import { initials } from "../../lib/initials";');
    expect(home).toContain("protected readonly initials = initials;");
    expect(home).toContain('{{ initials("Ada Lovelace") }}');
    // The undeclared function is not imported / exposed.
    expect(home).not.toContain("orderLabel");
  });
});
