// Coverage for inline collection-op lambdas in page-body expression
// position — `orders.filter(o => o.active)`, `.map(o => o.name)`, etc.
//
// Before this, a lambda only ever rendered when a builder primitive
// (`For`, `Table` accessors, `onSubmit`) destructured its `.body` /
// `.block` itself.  A lambda reaching `emitExpr` directly — i.e. as the
// callback arg of a higher-order method-call — fell through to
// `/* unsupported expr: lambda */ undefined`, so list shaping inside a
// page body silently produced broken TSX (the data had to be pre-shaped
// in a backend view/find).  `emitExpr` now has a `lambda` arm, so the
// JS frontends (React/Vue/Svelte all share `walker-core`'s `emitExpr`)
// render the callback.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function reactPage(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p" body: ${body} }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
    }
  `);
  const tsx = files.get("web/src/pages/p.tsx");
  if (!tsx) throw new Error(`MISSING; keys = ${[...files.keys()].join(", ")}`);
  return tsx;
}

async function vuePage(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p" body: ${body} }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: vue, targets: api, ui: WebApp, port: 3002 }
    }
  `);
  const vue = files.get("web/src/pages/p.vue");
  if (!vue) throw new Error(`MISSING p.vue; keys = ${[...files.keys()].join(", ")}`);
  return vue;
}

async function sveltePage(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p" body: ${body} }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: svelte, targets: api, ui: WebApp, port: 3004 }
    }
  `);
  for (const [path, content] of files) {
    if (path.endsWith("p/+page.svelte")) return content;
  }
  throw new Error(`MISSING +page.svelte; keys = ${[...files.keys()].join(", ")}`);
}

describe("walker — inline collection-op lambdas in expression position", () => {
  it("renders a `filter` callback inside a For each: (no unsupported stub)", async () => {
    const tsx = await reactPage(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1), n => Heading { "row " + n } } }`,
    );
    expect(tsx).toContain("[1, 2, 3].filter((n) => (n > 1))");
    expect(tsx).not.toContain("unsupported expr");
    expect(tsx).not.toContain("/* unsupported");
  });

  it("renders a `map` callback as a param-arrow (no unsupported stub)", async () => {
    // NB: a collection lambda param is untyped in the page's neutral
    // lowering env, so arithmetic against a literal lowers as the
    // documented implicit-string-concat (`n + String(1)`).  That's an
    // orthogonal `convert` behaviour — here we only pin the callback
    // structure the lambda arm produces.
    const tsx = await reactPage(
      `Stack { For { each: [1, 2].map(n => n + 1), n => Heading { "x" } } }`,
    );
    expect(tsx).toContain("[1, 2].map((n) =>");
    expect(tsx).not.toContain("unsupported expr");
  });

  it("binds the callback param so its body refs resolve to it (not `unresolved`)", async () => {
    const tsx = await reactPage(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1), n => Heading { "y" } } }`,
    );
    // The `n` inside the filter body must resolve to the lambda param,
    // never the `/* unresolved: n */` sentinel.
    expect(tsx).not.toContain("unresolved: n");
  });

  it("chains filter+map and renders both callbacks", async () => {
    const tsx = await reactPage(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1).map(n => n + 10), n => Heading { "z" } } }`,
    );
    expect(tsx).toContain("[1, 2, 3].filter((n) => (n > 1)).map((n) =>");
    expect(tsx).not.toContain("unsupported expr");
  });

  // The fix lives in the shared `emitExpr` (walker-core), so the same
  // source renders the same callback on every JS frontend.
  it("renders the same callback on Vue (`v-for` over the filtered list)", async () => {
    const vue = await vuePage(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1), n => Heading { "x" } } }`,
    );
    expect(vue).toContain("[1, 2, 3].filter((n) => (n > 1))");
    expect(vue).not.toContain("unsupported expr");
  });

  it("renders the same callback on Svelte (`{#each}` over the filtered list)", async () => {
    const svelte = await sveltePage(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1), n => Heading { "x" } } }`,
    );
    expect(svelte).toContain("[1, 2, 3].filter((n) => (n > 1))");
    expect(svelte).not.toContain("unsupported expr");
  });
});
