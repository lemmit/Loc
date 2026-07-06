// LSP completion for typed capabilities (typed-capabilities.md, Phase 5).
//
// In `with <Cap>` / `implements <Cap>` position the name is a plain ID token the
// macro expander resolves by name (built-in prelude + declared `capability`s),
// not a Langium cross-reference — so the default completion offers nothing
// there.  These tests pin the custom arm: both built-ins and workspace-declared
// capabilities are offered, and the member-access arm is left untouched.

import { NodeFileSystem } from "langium/node";
import { expectCompletion } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// Fresh services per call so the workspace holds exactly one document — the
// workspace-wide capability scan would otherwise see leftover docs from sibling
// tests.
function freshServices() {
  return createDddServices(NodeFileSystem).Ddd;
}

describe("capability LSP completion (typed-capabilities.md Phase 5)", () => {
  it("offers built-ins + declared capabilities after `with`", async () => {
    const text = `
capability orgScoped { note: string }
system D { subdomain M { context C {
  aggregate Org with <|>
}}}
`;
    const completion = expectCompletion(freshServices());
    await completion({
      text,
      index: 0,
      expectedItems: [
        "auditable",
        "softDeletable",
        "tenantOwned",
        "tenantRegistry",
        "versioned",
        "orgScoped",
      ],
      disposeAfterCheck: true,
    });
  });

  it("offers built-ins + declared capabilities after `implements`", async () => {
    const text = `
capability orgScoped { note: string }
system D { subdomain M { context C {
  aggregate Org { label: string  implements <|> }
}}}
`;
    const completion = expectCompletion(freshServices());
    await completion({
      text,
      index: 0,
      expectedItems: [
        "auditable",
        "softDeletable",
        "tenantOwned",
        "tenantRegistry",
        "versioned",
        "orgScoped",
      ],
      disposeAfterCheck: true,
    });
  });

  it("does not offer capability names in member-access position", async () => {
    const text = `
system D { subdomain M { context C {
  aggregate Org { name: string  derived greeting: string = this.<|> }
}}}
`;
    const completion = expectCompletion(freshServices());
    await completion({
      text,
      index: 0,
      assert: (items) => {
        const labels = items.items.map((i) => i.label);
        expect(labels).not.toContain("auditable");
        expect(labels).not.toContain("softDeletable");
      },
      disposeAfterCheck: true,
    });
  });
});
