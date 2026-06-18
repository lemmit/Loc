// Coverage for the `For { each:, item => markup }` list-comprehension
// primitive on the React/TSX walker (DEBT-05).  Before this, `For` was
// source-admissible but rendered as a `// not supported` comment; it now
// lowers to a keyed `.map` through the `renderForEach` target seam.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function emit(body: string, state = ""): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p" ${state} body: ${body} }
      }
      deployable api { platform: hono, contexts: [C], port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
    }
  `);
  const tsx = files.get("web/src/pages/p.tsx");
  if (!tsx) throw new Error(`MISSING; keys = ${[...files.keys()].join(", ")}`);
  return tsx;
}

// `For` is a CHILD primitive (it renders JSX children, not a whole page
// body — see NON_PAGE_BODY_LAYOUT_PRIMITIVES in walker-core.ts), so each
// case nests it inside a `Stack`.
describe("walker primitive — For (list comprehension)", () => {
  it("renders a keyed `.map` over the `each:` collection (no leftover stub comment)", async () => {
    const tsx = await emit(`Stack { For { each: [1, 2, 3], n => Heading { "Row" } } }`);
    expect(tsx).toMatch(/\[1, 2, 3\]\.map\(\(n, nIdx\) =>/);
    expect(tsx).toContain("<Fragment key={nIdx}>");
    expect(tsx).toMatch(/<Title order=\{2\}[^>]*>Row<\/Title>/);
    // The legacy "not supported" stub must be gone.
    expect(tsx).not.toContain("not supported by the React walker");
  });

  it("imports Fragment from react only when a For is present", async () => {
    const withFor = await emit(`Stack { For { each: [1], n => Heading { "x" } } }`);
    expect(withFor).toMatch(/import \{[^}]*\bFragment\b[^}]*\} from "react";/);
    const without = await emit(`Stack { Heading { "x" } }`);
    expect(without).not.toMatch(/import \{[^}]*\bFragment\b[^}]*\} from "react";/);
  });

  it("binds the item param inside the body (refs resolve to the loop var)", async () => {
    const tsx = await emit(`Stack { For { each: [1, 2], n => Heading { "row " + n } } }`);
    // The item ref `n` resolves to the emitted iteration variable.
    expect(tsx).toMatch(/<Title order=\{2\}[^>]*>\{\("row " \+ n\)\}<\/Title>/);
  });

  it("accepts the `render:` named-lambda surface for the item renderer", async () => {
    const tsx = await emit(`Stack { For { each: [1, 2], render: r => Heading { "x" } } }`);
    expect(tsx).toMatch(/\[1, 2\]\.map\(\(r, rIdx\) =>/);
    expect(tsx).toContain("<Fragment key={rIdx}>");
  });

  it("nests cleanly as a JSX child (brace-wrapped `.map` below the page root)", async () => {
    const tsx = await emit(`Stack { For { each: [1], n => Heading { "x" } } }`);
    expect(tsx).toMatch(/\{\[1\]\.map\(/);
  });
});
