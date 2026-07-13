// Page & component `derived name: T = expr` bindings on Svelte — read-only
// computed values in the render scope, hoisted as `const <name> = $derived(…)`
// runes before the body.  Svelte 5's `$derived` takes the expression directly
// (not a thunk) and auto-tracks its `$state` / `$props` deps.  Sequential
// (a derived may reference an earlier derived; runes reads are bare names).
// See docs/old/proposals/page-derived-bindings.md.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function svelteFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: svelte, targets: api, ui: Web, port: 3001 }
    }
  `);
}

function pageFor(files: Map<string, string>): string {
  for (const [p, v] of files) if (p.endsWith("p/+page.svelte")) return v;
  throw new Error(`MISSING +page.svelte; keys = ${[...files.keys()].join(", ")}`);
}

describe("Svelte page/component `derived` bindings", () => {
  it("hoists a state-derived value as $derived, body ref resolves", async () => {
    const files = await svelteFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        body: Stack { Text { doubled } }
      }
    `);
    const page = pageFor(files);
    expect(page).toContain("const doubled = $derived((n + n));");
    expect(page).toContain("let n = $state<number>(0);");
    expect(page).toContain("{doubled}");
    expect(page).not.toContain("ref: doubled");
  });

  it("sequential: a derived may reference an earlier derived (bare runes read)", async () => {
    const files = await svelteFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        derived quad: int = doubled + doubled
        body: Stack { Text { quad } }
      }
    `);
    const page = pageFor(files);
    expect(page).toContain("const doubled = $derived((n + n));");
    expect(page).toContain("const quad = $derived((doubled + doubled));");
    expect(page).toContain("{quad}");
  });

  it("works on a component (param-derived value hoists with the prop)", async () => {
    const files = await svelteFiles(`
      component Cart(count: int) {
        derived label: string = "Items: " + count
        body: Stack { Text { label } }
      }
      page P { route: "/p" body: Stack { Cart(3) } }
    `);
    let comp = "";
    for (const [p, v] of files) if (p.endsWith("components/Cart.svelte")) comp = v;
    expect(comp).toContain('const label = $derived(("Items: " + String(count)));');
    expect(comp).toContain("{label}");
    expect(comp).not.toContain("ref: label");
  });
});
