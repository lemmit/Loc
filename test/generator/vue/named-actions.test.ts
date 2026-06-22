// Named, typed page event handlers on Vue (named-actions-and-stores.md,
// Proposal A Stage 1).  Each referenced `action` hoists to a `const <name> =
// (<p>?) => { … }` in `<script setup>`; state reads/writes re-point to
// `.value` for script position.  A bare `onClick: <name>` binds it via
// `@click='<name>'` instead of an inline arrow.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function vueFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: vue, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("Vue named `action` handlers", () => {
  it("hoists a nullary action as a script-setup const and binds it on a button", async () => {
    const files = await vueFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Button { "Bump", onClick: bump } }
      }
    `);
    const sfc = files.get("web/src/pages/p.vue")!;
    // Script-position handler: state reads/writes re-pointed to `.value`.
    expect(sfc).toContain("const bump = () => { n.value = (n.value + 1); };");
    // Bare reference binds the named handler, not an inline arrow.
    expect(sfc).toContain("@click='bump'");
    expect(sfc).not.toContain("@click='() =>");
  });
});
