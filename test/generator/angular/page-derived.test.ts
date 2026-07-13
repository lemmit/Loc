// Page `derived name: T = expr` bindings on Angular — read-only computed
// values in the render scope, hoisted as `readonly <name> = computed(() => …)`
// class fields before the body.  Angular's `computed` auto-tracks the signals
// the expression reads (no deps array).  The hoist is a CLASS-FIELD initializer
// (not a template), so signal/computed reads — bare `name()` in template scope —
// resolve against `this` (`this.n()`); the body interpolates `doubled()`.
// Sequential (a derived may reference an earlier derived).
// See docs/old/proposals/page-derived-bindings.md.

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

function pageFor(files: Map<string, string>): string {
  for (const [p, v] of files) {
    if (p.includes("/pages/") && p.endsWith(".component.ts")) return v;
  }
  throw new Error(`MISSING page component; keys = ${[...files.keys()].join(", ")}`);
}

describe("Angular page `derived` bindings", () => {
  it("hoists a state-derived value as computed (this.-prefixed), body ref resolves", async () => {
    const files = await angularFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        body: Stack { Text { doubled } }
      }
    `);
    const page = pageFor(files);
    expect(page).toContain("readonly n = signal(0);");
    expect(page).toContain("readonly doubled = computed(() => (this.n() + this.n()));");
    expect(page).toContain("{{ doubled() }}");
    expect(page).toContain('import { Component, computed, signal } from "@angular/core";');
    expect(page).not.toContain("ref: doubled");
  });

  it("sequential: a derived may reference an earlier derived (this.<earlier>())", async () => {
    const files = await angularFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        derived quad: int = doubled + doubled
        body: Stack { Text { quad } }
      }
    `);
    const page = pageFor(files);
    expect(page).toContain("readonly doubled = computed(() => (this.n() + this.n()));");
    expect(page).toContain("readonly quad = computed(() => (this.doubled() + this.doubled()));");
    expect(page).toContain("{{ quad() }}");
  });
});
