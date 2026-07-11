// Phase B — top-level function lowering pins.  A call to a top-level
// (ambient) function INLINES its expression body at the call site (params
// substituted by the lowered arguments), wrapped in a paren for precedence.
// There is NO `call` node and NO emitted function — that is why the feature
// needs zero backend work.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allAggregates, type ExprIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function derivedExpr(top: string, member: string, name: string): Promise<ExprIR> {
  const src = `
    ${top}
    context C {
      aggregate Order {
        quantity: int
        customerName: string
        ${member}
      }
      repository Orders for Order { }
    }
  `;
  const { model } = await parseString(src, { validate: false });
  const agg = allAggregates(lowerModel(model)).find((a) => a.name === "Order")!;
  return agg.derived.find((d) => d.name === name)!.expr;
}

function kinds(e: ExprIR, out: string[] = []): string[] {
  out.push(e.kind);
  for (const v of Object.values(e as Record<string, unknown>)) {
    if (v && typeof v === "object" && "kind" in v) kinds(v as ExprIR, out);
  }
  return out;
}

describe("Phase B — top-level function inlining", () => {
  it("inlines the body (paren-wrapped) with args substituted — no call node", async () => {
    const expr = await derivedExpr(
      `function taxed(amount: int, pct: int): int = amount + amount * pct / 100`,
      `derived gross: int = taxed(quantity, 20)`,
      "gross",
    );
    const ks = kinds(expr);
    // The inlined body is spliced in — no `call` to `taxed` survives.
    expect(ks).not.toContain("call");
    // Wrapped in a paren for precedence, over a binary (`amount + …`).
    expect(expr.kind).toBe("paren");
    expect(ks).toContain("binary");
    // The `amount` param resolves to the caller's `this.quantity` (a this-prop
    // ref) and `pct` to the literal 20 — no dangling param ref remains.
    expect(ks).toContain("ref");
  });

  it("a body of a single ref inlines to that ref (still paren-wrapped)", async () => {
    const expr = await derivedExpr(
      `function identity(n: int): int = n`,
      `derived q2: int = identity(quantity)`,
      "q2",
    );
    expect(expr.kind).toBe("paren");
    expect(kinds(expr)).not.toContain("call");
  });
});
