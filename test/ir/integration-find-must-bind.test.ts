import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// loom.integration-find-must-bind (test-placement.md, Phase 3a): a repository
// read inside `expect(...)` in a context integration test must be let-bound —
// the node renderer awaits reads at statement level, so an inline find has no
// `await` site. A let-bound find is fine.
// ---------------------------------------------------------------------------

async function codesFor(src: string): Promise<string[]> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper<Model>(services.Ddd)(src, { validation: true });
  const diags = validateLoomModel(enrichLoomModel(lowerModel(doc.parseResult.value)));
  return diags.map((d) => d.code);
}

const wrap = (body: string): string => `
  system S { subdomain M { context C {
    aggregate Order { code: string }
    repository Orders for Order { }
    test "t" { ${body} }
  } } }
`;

describe("IR: loom.integration-find-must-bind", () => {
  it("errors on an inline repository find inside expect(...)", async () => {
    const codes = await codesFor(
      wrap(`let o = Order.create({ code: "x" })  expect(Order.findById(o.id).code).toBe("x")`),
    );
    expect(codes).toContain("loom.integration-find-must-bind");
  });

  it("accepts a let-bound find asserted over its binding", async () => {
    const codes = await codesFor(
      wrap(
        `let o = Order.create({ code: "x" })  let f = Order.findById(o.id)  expect(f.code).toBe("x")`,
      ),
    );
    expect(codes).not.toContain("loom.integration-find-must-bind");
  });
});
