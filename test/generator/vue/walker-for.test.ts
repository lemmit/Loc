import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Vue For-comprehension (DEBT-05).  `For` lowers through the shared
// `renderForEach` target seam; Vue renders a non-rendering `<template
// v-for … :key>` rather than React's `.map` + keyed Fragment.
// ---------------------------------------------------------------------------

async function pageVue(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p" body: ${body} }
      }
      deployable api { platform: hono, contexts: [C], port: 3000 }
      deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
    }
  `);
  const vue = files.get("web/src/pages/p.vue");
  if (!vue) throw new Error(`MISSING; keys = ${[...files.keys()].join(", ")}`);
  return vue;
}

describe("vue walker primitive — For", () => {
  it("renders a structural `<template v-for>` with :key (no `.map`)", async () => {
    const vue = await pageVue(`Stack { For { each: [1, 2, 3], n => Heading { "Row" } } }`);
    expect(vue).toContain('<template v-for="(n, nIdx) in [1, 2, 3]"');
    expect(vue).toContain(':key="nIdx"');
    expect(vue).not.toContain(".map(");
    expect(vue).not.toContain("not supported");
  });

  it('renders the `empty:` arm as a sibling `<template v-if="!coll.length">`', async () => {
    const vue = await pageVue(
      `Stack { For { each: [1, 2], empty: Empty("Nothing here"), n => Heading { "Row" } } }`,
    );
    expect(vue).toContain('<template v-for="(n, nIdx) in [1, 2]"');
    expect(vue).toContain('<template v-if="![1, 2].length">');
    expect(vue).toContain("Nothing here");
  });
});
