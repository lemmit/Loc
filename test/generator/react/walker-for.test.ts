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
      deployable api { platform: node, contexts: [C], port: 3000 }
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

  it("resolves a BARE loop-bound ref in text position (not a `/* ref */` comment)", async () => {
    // Regression: a bare item ref used as a Card/Heading title went through
    // `renderTextContent`, which lacked the `lambdaParams` lookup and degraded
    // the value to an unresolved-ref comment — so the row rendered blank.
    const card = await emit(`Stack { For { each: ["a", "b"], item => Card { item } } }`);
    expect(card).toMatch(/<Title order=\{3\}[^>]*>\{item\}<\/Title>/);
    expect(card).not.toContain("/* ref: item */");

    const heading = await emit(`Stack { For { each: ["a", "b"], item => Heading { item } } }`);
    expect(heading).toMatch(/<Title order=\{2\}[^>]*>\{item\}<\/Title>/);
    expect(heading).not.toContain("/* ref: item */");
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

  it("renders the `empty:` arm as a `length === 0 ? … : .map(…)` ternary", async () => {
    const tsx = await emit(
      `Stack { For { each: [1, 2], empty: Empty("Nothing here"), n => Heading { "x" } } }`,
    );
    expect(tsx).toContain("[1, 2].length === 0 ? (");
    expect(tsx).toContain("Nothing here");
    expect(tsx).toContain("[1, 2].map(");
    // The map is still the populated branch.
    expect(tsx).toMatch(/\) : \([\s\S]*\[1, 2\]\.map\(/);
  });

  it("omits the ternary entirely when no `empty:` arm is given", async () => {
    const tsx = await emit(`Stack { For { each: [1, 2], n => Heading { "x" } } }`);
    expect(tsx).not.toContain("length === 0");
  });
});
