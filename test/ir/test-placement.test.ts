import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { AggregateIR, TestIR } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Hoisting a `test` out of its aggregate (`test … for <Agg>`) must re-lower
// onto the target aggregate identically to the colocated form — the whole
// pipeline downstream keys off `AggregateIR.tests`, so a hoisted test that
// lands there under the same per-aggregate env is indistinguishable from a
// nested one (test-placement.md).  The one legitimate difference is the
// provenance `origin` (source byte offsets differ by the test's file position),
// which is stripped before comparison; true byte-identity of the emitted test
// FILE — which carries no source spans — is proven in the generator suite.
// ---------------------------------------------------------------------------

/** Recursively drop `origin` provenance keys so two IRs lowered from the same
 *  logical test at different source positions compare structurally equal. */
function stripOrigin<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripOrigin) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "origin") continue;
      out[k] = stripOrigin(v);
    }
    return out as T;
  }
  return value;
}

// A FRESH services/workspace per parse: these sources all declare an `Order`
// aggregate, and a shared workspace would let one doc's `for Order` cross-ref
// resolve to another doc's `Order` node (global-scope name collision), which is
// a harness artifact, not the routing under test.
async function orderTests(src: string): Promise<TestIR[]> {
  const services = createDddServices(NodeFileSystem);
  const parse = parseHelper<Model>(services.Ddd);
  const doc = await parse(src, { validation: true });
  const model = doc.parseResult.value;
  const raw = lowerModel(model);
  const aggs: AggregateIR[] = [];
  for (const sys of raw.systems)
    for (const m of sys.subdomains) for (const c of m.contexts) aggs.push(...c.aggregates);
  const order = aggs.find((a) => a.name === "Order");
  if (!order) throw new Error("Order aggregate not lowered");
  return order.tests;
}

const BODY = `let m = Money { amount: 10.5, currency: "USD" }
              expect(m.amount).toBe(10.5)
              expect(m.currency).toBe("USD")`;

const money = `valueobject Money { amount: decimal  currency: string  invariant amount >= 0.0 }`;

const nestedSrc = `
  system S { subdomain M { context C {
    ${money}
    aggregate Order { code: string
      test "money builds" { ${BODY} }
    }
  } } }
`;

const ctxHoistedSrc = `
  system S { subdomain M { context C {
    ${money}
    aggregate Order { code: string }
    test "money builds" for Order { ${BODY} }
  } } }
`;

const rootHoistedSrc = `
  system S { subdomain M { context C {
    ${money}
    aggregate Order { code: string }
  } } }
  test "money builds" for Order { ${BODY} }
`;

describe("IR: hoisted test re-lowers byte-identically onto the target aggregate", () => {
  it("nested → Order.tests has the test", async () => {
    const tests = await orderTests(nestedSrc);
    expect(tests.map((t) => t.name)).toEqual(["money builds"]);
    expect(tests[0].statements.length).toBe(3);
  });

  it("context-hoisted → structurally identical TestIR on Order.tests", async () => {
    const nested = stripOrigin(await orderTests(nestedSrc));
    const hoisted = stripOrigin(await orderTests(ctxHoistedSrc));
    expect(hoisted).toEqual(nested);
  });

  it("root-hoisted → structurally identical TestIR on Order.tests", async () => {
    const nested = stripOrigin(await orderTests(nestedSrc));
    const hoisted = stripOrigin(await orderTests(rootHoistedSrc));
    expect(hoisted).toEqual(nested);
  });
});
