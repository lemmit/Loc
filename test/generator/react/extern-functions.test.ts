// Extern frontend functions — the logic escape hatch
// (extern-function-hook-escape-hatch.md §3).  A
// `function f(params): T extern from "<path>"` ui member makes Loom emit:
//   - a typed signature at `src/lib/extern/<name>.signature.ts`
//     (wire-DTO-typed: aggregate → `<Agg>Response`);
//   - a conformance shim at `src/lib/<name>.ts`
//     (`export const <name>: <Name>Fn = _impl;`) — a missing module or
//     mismatched signature fails `tsc`, the fail-fast;
// and page-body calls import the shim and render as JSX expressions.

import { describe, expect, it } from "vitest";
import { generateSystemFiles, parseString } from "../../_helpers/index.js";

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
    deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
  }
`;

describe("extern frontend functions", () => {
  it("emits the typed signature + conformance shim per declaration", async () => {
    const files = await generateSystemFiles(SRC);
    const sig = files.get("web/src/lib/extern/initials.signature.ts")!;
    expect(sig).toContain("export type InitialsFn = (name: string) => string;");

    const shim = files.get("web/src/lib/initials.ts")!;
    expect(shim).toContain('import { initials as _impl } from "../helpers/initials";');
    expect(shim).toContain('import type { InitialsFn } from "./extern/initials.signature";');
    expect(shim).toContain("export const initials: InitialsFn = _impl;");
  });

  it("an aggregate-typed param uses the wire DTO in the signature", async () => {
    const files = await generateSystemFiles(SRC);
    const sig = files.get("web/src/lib/extern/orderLabel.signature.ts")!;
    expect(sig).toContain('import type { OrderResponse } from "../../api/order";');
    expect(sig).toContain("export type OrderLabelFn = (order: OrderResponse) => string;");
  });

  it("a body call imports the shim and renders as a JSX expression", async () => {
    const files = await generateSystemFiles(SRC);
    const home = files.get("web/src/pages/home.tsx")!;
    expect(home).toContain('import { initials } from "../lib/initials";');
    expect(home).toContain('{initials("Ada Lovelace")}');
    // The undeclared function is not imported.
    expect(home).not.toContain("orderLabel");
  });

  it("rejects a name shadowing a walker-stdlib primitive", async () => {
    const { errors } = await parseString(`
      system S { subdomain M { context C { } }
        ui W {
          function Heading(name: string): string extern from "./helpers/h"
          page Home { route: "/" body: Heading { "hi" } }
        }
      }
    `);
    expect(errors.some((e) => /shadows a walker-stdlib primitive/.test(e))).toBe(true);
  });

  it("rejects a duplicate function name within the ui", async () => {
    const { errors } = await parseString(`
      system S { subdomain M { context C { } }
        ui W {
          function f(name: string): string extern from "./helpers/a"
          function f(name: string): string extern from "./helpers/b"
          page Home { route: "/" body: Heading { "hi" } }
        }
      }
    `);
    expect(errors.some((e) => /declares function 'f' more than once/.test(e))).toBe(true);
  });

  it("a bodied (non-extern) ui-level function does not parse", async () => {
    const { errors } = await parseString(`
      system S { subdomain M { context C { } }
        ui W {
          function f(name: string): string = name
          page Home { route: "/" body: Heading { "hi" } }
        }
      }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});
