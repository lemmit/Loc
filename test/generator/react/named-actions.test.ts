// Named, typed page/component event handlers on React (named-actions-and-
// stores.md, Proposal A Stage 1).  Each referenced `action` hoists to a
// `const <name> = (<p>?) => { … }` handler at the component top; a bare
// `onClick: <name>` / `onSubmit: <name>` reference binds the named handler
// instead of an inline arrow.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function reactFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { aggregate Customer { name: string } } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("React named `action` handlers", () => {
  it("hoists a nullary action as a const arrow and binds it on a Button", async () => {
    const files = await reactFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Button { "Bump", onClick: bump } }
      }
    `);
    const tsx = files.get("web/src/pages/p.tsx")!;
    // Hoisted named handler — body lowers the `:=` write to the setter.
    expect(tsx).toContain("const bump = () => { setN((n + 1)); };");
    // Bare reference binds the named handler, not an inline arrow.
    expect(tsx).toContain("onClick={bump}");
    expect(tsx).not.toContain("onClick={() =>");
  });

  it("emits a component action handler too", async () => {
    const files = await reactFiles(`
      component Counter() {
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Button { "Bump", onClick: bump } }
      }
      page P { route: "/p" body: Stack { Counter() } }
    `);
    const tsx = files.get("web/src/components/Counter.tsx")!;
    expect(tsx).toContain("const bump = () => { setN((n + 1)); };");
    expect(tsx).toContain("onClick={bump}");
  });
});
