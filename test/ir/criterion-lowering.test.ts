// Lowering coverage for `criterion`: the IR record on the context, and
// the inline-equivalence contract — a criterion reference in a `where`
// clause lowers to *exactly* the same ExprIR as the equivalent inline
// predicate, with parameters substituted and `&&` composing for free.

import { describe, expect, it } from "vitest";
import { allContexts, type ExprIR } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
  context Sales {
    aggregate Customer { active: bool  region: string }
    repository Customers for Customer {
      find activeInline(): Customer[] where active
      find activeViaCriterion(): Customer[] where ActiveCustomer
      find inRegionInline(r: string): Customer[] where region == r
      find inRegionViaCriterion(r: string): Customer[] where InRegion(r)
      find eligibleViaCriterion(r: string): Customer[] where ActiveCustomer && InRegion(r)
      find eligibleInline(r: string): Customer[] where active && region == r
    }
    criterion ActiveCustomer of Customer = active
    criterion InRegion(rgn: string) of Customer = region == rgn
  }
`;

async function finds() {
  const loom = await buildLoomModel(SRC);
  const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
  const repo = ctx.repositories.find((r) => r.aggregateName === "Customer")!;
  const byName = (n: string) => repo.finds.find((f) => f.name === n)!;
  return { ctx, byName };
}

describe("lowering — criterion", () => {
  it("records criteria on the bounded-context IR", async () => {
    const loom = await buildLoomModel(SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
    expect(ctx.criteria.map((c) => c.name).sort()).toEqual(["ActiveCustomer", "InRegion"]);
    const active = ctx.criteria.find((c) => c.name === "ActiveCustomer")!;
    expect(active.targetType).toEqual({ kind: "entity", name: "Customer" });
    expect(active.body).toMatchObject({ kind: "ref", refKind: "this-prop", name: "active" });
  });

  it("inlines a parameterless criterion identically to the inline predicate", async () => {
    const { byName } = await finds();
    expect(byName("activeViaCriterion").filter).toEqual(byName("activeInline").filter);
  });

  it("substitutes parameters when inlining a parameterised criterion", async () => {
    const { byName } = await finds();
    expect(byName("inRegionViaCriterion").filter).toEqual(byName("inRegionInline").filter);
  });

  it("composes criteria via `&&` into the same shape as the inline composition", async () => {
    const { byName } = await finds();
    expect(byName("eligibleViaCriterion").filter).toEqual(byName("eligibleInline").filter);
  });

  it("produces a queryable binary tree (no unresolved refs) for the composed criterion", async () => {
    const { byName } = await finds();
    const filter = byName("eligibleViaCriterion").filter as ExprIR;
    expect(filter.kind).toBe("binary");
    const refKinds: string[] = [];
    const walk = (e: ExprIR): void => {
      if (e.kind === "ref") refKinds.push(e.refKind);
      else if (e.kind === "binary") {
        walk(e.left);
        walk(e.right);
      }
    };
    walk(filter);
    expect(refKinds).not.toContain("unknown");
  });
});
