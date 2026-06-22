// Named, typed page event handlers on Svelte (named-actions-and-stores.md,
// Proposal A Stage 1).  Each referenced `action` hoists to a `const <name> =
// (<p>?) => { … }` in `<script>`; Svelte 5 `$state` reads/writes are bare
// names (no `.value`).  A bare `onClick: <name>` binds it via `onclick={<name>}`
// instead of an inline arrow.

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

describe("Svelte named `action` handlers", () => {
  it("hoists a nullary action as a script const and binds it on a button", async () => {
    const files = await svelteFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Button { "Bump", onClick: bump } }
      }
    `);
    // The page lands at `+page.svelte` under the route group.
    const page = [...files].find(([p]) => p.endsWith("+page.svelte"))?.[1] ?? "";
    expect(page).toContain("const bump = () => { n = (n + 1); };");
    expect(page).toContain("onclick={bump}");
    expect(page).not.toContain("onclick={() =>");
  });

  it("closes a 3-action transitive chain A→B→C — all three handlers emit (Fix 1)", async () => {
    const files = await svelteFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action a() { b() }
        action b() { c() }
        action c() { n := n + 1 }
        body: Stack { Button { "A", onClick: a } }
      }
    `);
    const page = [...files].find(([p]) => p.endsWith("+page.svelte"))?.[1] ?? "";
    expect(page).toContain("const a = () => { b(); };");
    expect(page).toContain("const b = () => { c(); };");
    expect(page).toContain("const c = () => { n = (n + 1); };");
  });
});
