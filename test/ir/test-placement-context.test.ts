import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { BoundedContextIR } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Phase 3-core lowering (test-placement.md): a context integration test lands
// on `BoundedContextIR.tests`, lowered under the context env — whether nested in
// the context (no `for`) or hoisted with `for <Ctx>`.
// ---------------------------------------------------------------------------

async function orderingCtx(src: string): Promise<BoundedContextIR> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper<Model>(services.Ddd)(src, { validation: true });
  const raw = lowerModel(doc.parseResult.value);
  for (const sys of raw.systems)
    for (const m of sys.subdomains) for (const c of m.contexts) if (c.name === "Ordering") return c;
  throw new Error("Ordering context not lowered");
}

const nested = `
  system S { subdomain M { context Ordering {
    aggregate Order { code: string }
    aggregate Inventory { sku: string }
    test "cross-aggregate" { let o = Order.create({ code: "x" })  expect(1).toBe(1) }
  } } }
`;

const hoisted = `
  system S { subdomain M { context Ordering {
    aggregate Order { code: string }
    aggregate Inventory { sku: string }
  } } }
  test "cross-aggregate" for Ordering { let o = Order.create({ code: "x" })  expect(1).toBe(1) }
`;

describe("IR: context integration test lands on BoundedContextIR.tests", () => {
  it("nested (no `for`) → the context carries the test", async () => {
    const ctx = await orderingCtx(nested);
    expect(ctx.tests.map((t) => t.name)).toEqual(["cross-aggregate"]);
    expect(ctx.tests[0].statements.length).toBe(2);
  });

  it("hoisted `for Ordering` → routed onto the same context", async () => {
    const ctx = await orderingCtx(hoisted);
    expect(ctx.tests.map((t) => t.name)).toEqual(["cross-aggregate"]);
  });

  it("a context with no integration test has an empty tests list", async () => {
    const ctx = await orderingCtx(`
      system S { subdomain M { context Ordering {
        aggregate Order { code: string }
        aggregate Inventory { sku: string }
      } } }
    `);
    expect(ctx.tests).toEqual([]);
  });
});
