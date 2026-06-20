// Typed `capability` declaration (typed-capabilities.md, Phase 1).
//
// Surface-only coverage: a top-level `capability { fields + filter + stamp }`
// pure-mixin declaration parses, its members populate, and it coexists with
// the rest of a system.  No lowering / behavior yet — the decl is inert until
// the expander consumes it (Phase 2); lowering ignores unknown top-level
// members (filter-based dispatch in lower.ts), so it must not perturb parsing
// or validation of a surrounding model.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Capability, Model } from "../../../src/language/generated/ast.js";

async function parse(src: string) {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  return { model: doc.parseResult.value as Model, errors };
}

function firstCapability(model: Model): Capability {
  return model.members.find((m) => m.$type === "Capability") as Capability;
}

describe("typed capability declaration (typed-capabilities.md Phase 1)", () => {
  it("parses a filter-only capability (softDeletable)", async () => {
    const { model, errors } = await parse(`
      capability softDeletable {
        isDeleted: bool
        filter !this.isDeleted
      }
    `);
    expect(errors).toEqual([]);
    const cap = firstCapability(model);
    expect(cap.name).toBe("softDeletable");
    expect(cap.members.map((m) => m.$type)).toEqual(["Property", "FilterDecl"]);
  });

  it("parses a fields + stamp capability with comma-separated fields (auditable)", async () => {
    const { model, errors } = await parse(`
      capability auditable {
        createdAt: datetime, updatedAt: datetime
        stamp onCreate { createdAt := now() }
        stamp onUpdate { updatedAt := now() }
      }
    `);
    expect(errors).toEqual([]);
    const cap = firstCapability(model);
    expect(cap.name).toBe("auditable");
    expect(cap.members.map((m) => m.$type)).toEqual([
      "Property",
      "Property",
      "StampDecl",
      "StampDecl",
    ]);
  });

  it("parses an empty-bodied capability", async () => {
    const { model, errors } = await parse(`capability marker { }`);
    expect(errors).toEqual([]);
    expect(firstCapability(model).members).toEqual([]);
  });

  it("coexists at the top level alongside a context (inert — no lowering yet)", async () => {
    const { model, errors } = await parse(`
      capability softDeletable {
        isDeleted: bool
        filter !this.isDeleted
      }
      context Sales {
        aggregate Order { subject: string }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstCapability(model).name).toBe("softDeletable");
    expect(model.members.some((m) => m.$type === "BoundedContext")).toBe(true);
  });
});
