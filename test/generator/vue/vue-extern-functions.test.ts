import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Extern frontend functions — Vue flavour
// (extern-function-hook-escape-hatch.md §3).  Mirrors
// test/generator/svelte/svelte-extern-functions.test.ts: the typed
// signature + conformance shim emit per declaration (Vue keeps the api
// modules at `src/api/` like react, so signature DTO imports resolve
// against `../../api`), and page-body calls import the shim via the
// relative `lib/<name>` path.
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
    deployable api { platform: hono, contexts: [Sales], serves: SalesApi, port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp { Sales: api }, port: 3001 }
  }
`;

async function vueFiles(src = SRC): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

describe("extern frontend functions — Vue", () => {
  it("emits the typed signature + conformance shim per declaration", async () => {
    const files = await vueFiles();
    const sig = files.get("src/lib/extern/initials.signature.ts")!;
    expect(sig).toContain("export type InitialsFn = (name: string) => string;");

    const shim = files.get("src/lib/initials.ts")!;
    expect(shim).toContain('import { initials as _impl } from "../helpers/initials";');
    expect(shim).toContain('import type { InitialsFn } from "./extern/initials.signature";');
    expect(shim).toContain("export const initials: InitialsFn = _impl;");
  });

  it("an aggregate-typed param uses the wire DTO from src/api", async () => {
    const files = await vueFiles();
    const sig = files.get("src/lib/extern/orderLabel.signature.ts")!;
    expect(sig).toContain('import type { OrderResponse } from "../../api/order";');
    expect(sig).toContain("export type OrderLabelFn = (order: OrderResponse) => string;");
  });

  it("a body call imports the shim and renders as an interpolation", async () => {
    const files = await vueFiles();
    const home = files.get("src/pages/home.vue")!;
    expect(home).toContain('import { initials } from "../lib/initials";');
    expect(home).toContain('{{ initials("Ada Lovelace") }}');
    // The undeclared function is not imported.
    expect(home).not.toContain("orderLabel");
  });
});
