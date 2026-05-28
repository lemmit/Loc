// UI-level helper imports.
//
// New DSL syntax:
//
//   ui WebApp {
//     import helper formatPrice from "./helpers/price"
//     page X {
//       route: "/x"
//       body:  Text { formatPrice(99) }
//     }
//   }
//
// Body refs to `formatPrice(...)` emit as plain JS calls; the
// generated page TSX gets a matching `import { formatPrice } from
// "./helpers/price";` line at the top.  Helpers actually USED
// become imports — declared-but-unused helpers don't pollute the
// page TSX.
//
// Validator rejects helper names that shadow walker stdlib
// primitives (Stack / Form / Heading / etc.) so a typo never
// silently overrides the primitive.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

async function parse(src: string): Promise<{
  files: Map<string, string>;
  diagnostics: ReadonlyArray<{ severity?: number; message: string }>;
}> {
  const { model, diagnostics } = await parseString(src);
  return { files: generateSystems(model).files, diagnostics };
}

describe("UI-level helper imports", () => {
  it("emits an import line for a helper actually used in a body", async () => {
    const { files, diagnostics } = await parse(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          import helper formatPrice from "./helpers/price"
          page X {
            route: "/x"
            body:  Text { formatPrice(99) }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 1)).toHaveLength(0);
    const tsx = files.get("web/src/pages/x.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/import \{ formatPrice \} from "\.\/helpers\/price";/);
    // Body emits a plain JS call wrapped as a JSX expression.
    expect(tsx).toMatch(/<Text>\{formatPrice\(99\)\}<\/Text>/);
  });

  it("declared-but-unused helpers don't emit an import line", async () => {
    const { files, diagnostics } = await parse(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          import helper formatPrice from "./helpers/price"
          import helper formatDate  from "./helpers/date"
          page X {
            route: "/x"
            body:  Text { formatPrice(99) }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 1)).toHaveLength(0);
    const tsx = files.get("web/src/pages/x.tsx")!;
    expect(tsx).toMatch(/import \{ formatPrice \} from "\.\/helpers\/price";/);
    expect(tsx).not.toMatch(/formatDate/);
  });

  it("multiple helpers from the same path collapse into one import line", async () => {
    const { files } = await parse(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          import helper formatPrice    from "./helpers/format"
          import helper formatQuantity from "./helpers/format"
          page X {
            route: "/x"
            body:  Stack {
              Text { formatPrice(99) },
              Text { formatQuantity(3) }
            }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/x.tsx")!;
    expect(tsx).toMatch(/import \{ formatPrice, formatQuantity \} from "\.\/helpers\/format";/);
    // Should NOT have two separate import lines.
    const matches = tsx.match(/from "\.\/helpers\/format"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("helper as a top-level body call emits a brace-wrapped JSX expression", async () => {
    const { files } = await parse(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          import helper RenderBanner from "./helpers/banner"
          page X {
            route: "/x"
            body:  RenderBanner("hi")
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/x.tsx")!;
    expect(tsx).toMatch(/import \{ RenderBanner \} from "\.\/helpers\/banner";/);
    // Top-level body emits the call inside a JSX-child brace.
    expect(tsx).toMatch(/\{RenderBanner\("hi"\)\}/);
  });

  it("validator rejects helper names that shadow stdlib primitives", async () => {
    const { diagnostics } = await parse(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          import helper Stack from "./helpers/stack"
          page X { route: "/x"  body: Heading { "hi" } }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const errors = diagnostics.filter((d) => d.severity === 1);
    expect(errors.some((e) => /shadows.*'Stack'/.test(e.message))).toBe(true);
  });

  it("validator rejects duplicate helper imports within the same UI", async () => {
    const { diagnostics } = await parse(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          import helper formatPrice from "./helpers/a"
          import helper formatPrice from "./helpers/b"
          page X { route: "/x"  body: Heading { "hi" } }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const errors = diagnostics.filter((d) => d.severity === 1);
    expect(errors.some((e) => /Duplicate helper import 'formatPrice'/.test(e.message))).toBe(true);
  });
});
