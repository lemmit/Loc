import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Svelte For-comprehension (DEBT-05).  `For` lowers through the shared
// `renderForEach` target seam; Svelte renders its native keyed
// `{#each … as item, idx (key)}` block rather than React's `.map`.
// ---------------------------------------------------------------------------

async function pageSvelte(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p" body: ${body} }
      }
      deployable api { platform: hono, contexts: [C], port: 3000 }
      deployable web { platform: svelte, targets: api, ui: WebApp, port: 3004 }
    }
  `);
  for (const [path, content] of files) {
    if (path.endsWith("p/+page.svelte")) return content;
  }
  throw new Error(`MISSING +page.svelte; keys = ${[...files.keys()].join(", ")}`);
}

describe("svelte walker primitive — For", () => {
  it("renders a native keyed `{#each}` block (no `.map`, no Fragment)", async () => {
    const svelte = await pageSvelte(`Stack { For { each: [1, 2, 3], n => Heading { "Row" } } }`);
    expect(svelte).toContain("{#each [1, 2, 3] as n, nIdx (nIdx)}");
    expect(svelte).toContain("{/each}");
    expect(svelte).not.toContain(".map(");
    expect(svelte).not.toContain("Fragment");
    expect(svelte).not.toContain("not supported");
  });
});
