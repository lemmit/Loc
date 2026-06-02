// Lowering coverage for `retrieval` (the named query bundle): the IR
// record on the context, the default-whole load plan, explicit loads /
// sort lowering, and the `where` predicate lowering through the same
// criterion-composing path as a `find … where`.

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
  context Sales {
    aggregate Customer { active: bool  region: string  name: string }
    repository Customers for Customer { }

    criterion ActiveCustomer of Customer = active
    criterion InRegion(rgn: string) of Customer = region == rgn

    retrieval AllActive of Customer = ActiveCustomer

    retrieval ActiveInRegion(region: string) of Customer {
      where: ActiveCustomer && InRegion(region)
      sort:  [name asc]
      loads: [this.region]
    }
  }
`;

async function salesCtx() {
  const loom = await buildLoomModel(SRC);
  return allContexts(loom).find((c) => c.name === "Sales")!;
}

describe("lowering — retrieval", () => {
  it("records retrievals on the bounded-context IR with target + params", async () => {
    const ctx = await salesCtx();
    expect(ctx.retrievals.map((r) => r.name)).toEqual(["AllActive", "ActiveInRegion"]);

    const all = ctx.retrievals.find((r) => r.name === "AllActive")!;
    expect(all.targetType).toEqual({ kind: "entity", name: "Customer" });
    expect(all.params).toEqual([]);

    const air = ctx.retrievals.find((r) => r.name === "ActiveInRegion")!;
    expect(air.params.map((p) => p.name)).toEqual(["region"]);
  });

  it("defaults to a whole load plan and empty sort when slots omitted", async () => {
    const ctx = await salesCtx();
    const all = ctx.retrievals.find((r) => r.name === "AllActive")!;
    expect(all.loadPlan).toEqual({ kind: "whole" });
    expect(all.sort).toEqual([]);
  });

  it("lowers explicit sort + loads to structural segments", async () => {
    const ctx = await salesCtx();
    const air = ctx.retrievals.find((r) => r.name === "ActiveInRegion")!;

    expect(air.sort).toEqual([{ path: [{ name: "name", collection: false }], direction: "asc" }]);
    expect(air.loadPlan).toEqual({
      kind: "explicit",
      paths: [[{ name: "region", collection: false }]],
    });
  });

  it("lowers the `where` predicate composing criteria (same shape as the inline form)", async () => {
    const ctx = await salesCtx();
    const air = ctx.retrievals.find((r) => r.name === "ActiveInRegion")!;
    // `ActiveCustomer && InRegion(region)` composes via a binary `&&`.
    expect(air.where.kind).toBe("binary");
    if (air.where.kind === "binary") expect(air.where.op).toBe("&&");
  });
});
