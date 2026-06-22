// `loom.duplicate-action` (named-actions-and-stores.md, Proposal A Stage 1,
// Fix 2).  Action names must be unique on a page/component surface — the IR's
// `indexActions` Map keys by name and would silently overwrite the first body,
// so a re-declared `action <name>(…)` is rejected at the AST validator (before
// lowering).  AST-level diagnostic: collected via the document builder's
// validation pass (`parseString`).

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

/** All validation-error messages flagging a duplicate action. */
async function duplicateActionErrors(source: string): Promise<string[]> {
  const { errors } = await parseString(source);
  return errors.filter((e) => e.includes("Duplicate action"));
}

const wrapPage = (decls: string) => `
  system Demo {
    subdomain S { context C { aggregate Order { code: string } repository Orders for Order {} } }
    ui Web {
      page P {
        route: "/p"
        state { n: int = 0 }
        ${decls}
        body: Stack { Button { "Go", onClick: next } }
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: react, targets: api, ui: Web, port: 3001 }
  }
`;

const wrapComponent = (decls: string) => `
  system Demo {
    subdomain S { context C { aggregate Order { code: string } repository Orders for Order {} } }
    ui Web {
      component Counter() {
        state { n: int = 0 }
        ${decls}
        body: Stack { Button { "B", onClick: bump } }
      }
      page P { route: "/p" body: Stack { Counter() } }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: react, targets: api, ui: Web, port: 3001 }
  }
`;

describe("loom.duplicate-action", () => {
  it("flags a second `action next()` on the same page", async () => {
    const errors = await duplicateActionErrors(
      wrapPage(`action next() { n := n + 1 }  action next() { n := n + 2 }`),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Duplicate action 'next' on page 'P'");
  });

  it("flags a second `action bump()` on the same component", async () => {
    const errors = await duplicateActionErrors(
      wrapComponent(`action bump() { n := n + 1 }  action bump() { n := n + 2 }`),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Duplicate action 'bump' on component 'Counter'");
  });

  it("does NOT flag two distinct action names on a page", async () => {
    const errors = await duplicateActionErrors(
      wrapPage(`action next() { n := n + 1 }  action prev() { n := n - 1 }`),
    );
    expect(errors).toEqual([]);
  });

  it("does NOT flag two distinct action names on a component", async () => {
    const errors = await duplicateActionErrors(
      wrapComponent(`action bump() { n := n + 1 }  action reset() { n := 0 }`),
    );
    expect(errors).toEqual([]);
  });
});
