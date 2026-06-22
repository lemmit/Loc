// Named, typed page event handlers on Angular (named-actions-and-stores.md,
// Proposal A Stage 1).  Each referenced `action` emits a class METHOD
// (`<name>(<p>?) { … }`) — signal reads (`n()`) and writes (`n.set(…)`) are
// `this.`-prefixed for class-method scope.  A bare `onClick: <name>` binds it
// via `(click)='<name>()'` (Angular `(click)` is a statement binding).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function angularFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: angular, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("Angular named `action` handlers", () => {
  it("emits a class method for a nullary action and binds it via (click)", async () => {
    const files = await angularFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Button { "Bump", onClick: bump } }
      }
    `);
    const comp = [...files].find(([p]) => p.endsWith(".component.ts"))?.[1] ?? "";
    // Class method with `this.`-prefixed signal read + write.
    expect(comp).toContain("bump() { this.n.set((this.n() + 1)); }");
    // Statement binding calls the method (Angular `(click)` binds a statement).
    expect(comp).toContain("(click)='bump()'");
  });
});
