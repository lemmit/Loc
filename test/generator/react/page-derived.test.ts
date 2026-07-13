// Page & component `derived name: T = expr` bindings on React — read-only
// computed values in the render scope, hoisted as `useMemo` before the
// body.  Reactive over `state` (deps array), sequential (a derived may
// reference earlier derived).  See docs/old/proposals/page-derived-bindings.md.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function reactFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("React page/component `derived` bindings", () => {
  it("hoists a state-derived value as useMemo with a state dep, body ref resolves", async () => {
    const files = await reactFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        body: Stack { Text { doubled } }
      }
    `);
    const tsx = files.get("web/src/pages/p.tsx")!;
    expect(tsx).toContain("const doubled = useMemo(() => (n + n), [n]);");
    expect(tsx).toContain("<Text>{doubled}</Text>");
    expect(tsx).toContain('import { useState, useMemo } from "react";');
    // No unresolved-ref comment.
    expect(tsx).not.toContain("ref: doubled");
  });

  it("sequential: a derived may reference an earlier derived (dep is the earlier one)", async () => {
    const files = await reactFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        derived quad: int = doubled + doubled
        body: Stack { Text { quad } }
      }
    `);
    const tsx = files.get("web/src/pages/p.tsx")!;
    expect(tsx).toContain("const doubled = useMemo(() => (n + n), [n]);");
    expect(tsx).toContain("const quad = useMemo(() => (doubled + doubled), [doubled]);");
    expect(tsx).toContain("<Text>{quad}</Text>");
  });

  it("works on a component (param-derived value hoists with the param dep)", async () => {
    const files = await reactFiles(`
      component Cart(count: int) {
        derived label: string = "Items: " + count
        body: Stack { Text { label } }
      }
      page P { route: "/p" body: Stack { Cart(3) } }
    `);
    let comp = "";
    for (const [p, v] of files) if (p.endsWith("components/Cart.tsx")) comp = v;
    expect(comp).toContain('const label = useMemo(() => ("Items: " + String(count)), [count]);');
    expect(comp).toContain("<Text>{label}</Text>");
    expect(comp).not.toContain("ref: label");
  });
});
