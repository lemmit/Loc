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

// A zero-argument criterion declared WITH empty parens (`Cheap()`) and CALLED
// with parens (`where: Cheap()`) must inline to its queryable boolean body, the
// same as the bare form (`Cheap`).  Previously a parameterless criterion was
// eagerly inlined by `resolveNameRef` and the trailing `()` collapsed the
// already-inlined body into a spurious free `call`, which the queryable-subset
// classifier rejected ("call to '<expr>' (free)").
describe("lowering — zero-arg criterion called with parens is queryable", () => {
  const PAREN_SRC = `
    context Sales {
      aggregate Product { price: decimal  name: string }
      repository Products for Product { }

      criterion Cheap() of Product = price < 10
      criterion Named(n: string) of Product = name == n

      retrieval CheapOnes() of Product { where: Cheap() }
      retrieval CheapNamed(n: string) of Product { where: Cheap() && Named(n) }
    }
  `;

  it("inlines `where: Cheap()` to the comparison body (no free call, no validation error)", async () => {
    const loom = await buildLoomModel(PAREN_SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
    const cheap = ctx.retrievals.find((r) => r.name === "CheapOnes")!;
    // Inlined predicate `price < 10` — a queryable comparison, not a `call`.
    expect(cheap.where.kind).toBe("binary");
    if (cheap.where.kind === "binary") expect(cheap.where.op).toBe("<");
    // Composed with a parameterised criterion via `&&`.
    const named = ctx.retrievals.find((r) => r.name === "CheapNamed")!;
    expect(named.where.kind).toBe("binary");
    if (named.where.kind === "binary") expect(named.where.op).toBe("&&");
  });
});
