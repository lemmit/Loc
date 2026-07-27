// `loom.call-arg-type` / `loom.construction-field-type` at the EXPRESSION slots
// the statement/expression walk never reaches (M-T6.18 gap #3,
// `checkPredicateSlotArgs`): repository `find … where` / `… requires`, criterion
// / policy-fn bodies, and operation `requires` / `when` gates.  Predicate-call
// ARITY is already model-wide (loom.criterion-arity / loom.policy-fn-arity); this
// is the per-argument TYPE those gates don't touch.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (members: string) => `
system Demo {
  subdomain S {
    context C {
      criterion InRegion(r: string) of Order = region == r
      policy CanApprove(cap: string): bool = cap == "admin"
      aggregate Order with crudish {
        region: string
        qty: int
        ${members}
      }
      repository Orders for Order {
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

// Variant with the extra member injected on the REPOSITORY (for find slots).
const sysRepo = (finds: string) => `
system Demo {
  subdomain S {
    context C {
      criterion InRegion(r: string) of Order = region == r
      aggregate Order with crudish {
        region: string
        qty: int
      }
      repository Orders for Order {
        ${finds}
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(members: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(members), { validate: true });
  return codesOf(diagnostics);
}
async function repoCodes(finds: string): Promise<string[]> {
  const { diagnostics } = await parseString(sysRepo(finds), { validate: true });
  return codesOf(diagnostics);
}

const TYPE = "loom.call-arg-type";

describe("predicate-slot arg types (M-T6.18 gap #3)", () => {
  // --- operation requires / when gates -------------------------------------
  it("flags a wrong-typed policy arg in an operation `requires` gate", async () => {
    expect(await codes("operation appr() requires CanApprove(5) { qty := qty }")).toContain(TYPE);
  });

  it("is CLEAN for a correctly-typed policy arg in a `requires` gate", async () => {
    expect(
      await codes('operation appr() requires CanApprove("admin") { qty := qty }'),
    ).not.toContain(TYPE);
  });

  it("flags a wrong-typed criterion arg in an operation `when` gate", async () => {
    expect(await codes("operation appr() when InRegion(5) { qty := qty }")).toContain(TYPE);
  });

  // --- criterion body (nested predicate call) ------------------------------
  it("flags a wrong-typed nested criterion arg in a criterion body", async () => {
    const { diagnostics } = await parseString(
      `
system Demo {
  subdomain S {
    context C {
      criterion InRegion(r: string) of Order = region == r
      criterion Domestic of Order = InRegion(5)
      aggregate Order with crudish { region: string }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`,
      { validate: true },
    );
    expect(codesOf(diagnostics)).toContain(TYPE);
  });

  it("is CLEAN for a correctly-typed nested criterion arg in a criterion body", async () => {
    const { diagnostics } = await parseString(
      `
system Demo {
  subdomain S {
    context C {
      criterion InRegion(r: string) of Order = region == r
      criterion Domestic of Order = InRegion("EU")
      aggregate Order with crudish { region: string }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`,
      { validate: true },
    );
    expect(codesOf(diagnostics)).not.toContain(TYPE);
  });

  // --- repository find `where` ---------------------------------------------
  it("flags a wrong-typed criterion arg in a repository `find … where`", async () => {
    expect(await repoCodes("find inR(): Order[] where InRegion(5)")).toContain(TYPE);
  });

  it("is CLEAN for a correctly-typed criterion arg in a `find … where`", async () => {
    expect(await repoCodes('find inR(): Order[] where InRegion("EU")')).not.toContain(TYPE);
  });

  // --- no double-report of arity as a type error ---------------------------
  it("does not report an arity mismatch in a gate as a type error", async () => {
    expect(
      await codes('operation appr() requires CanApprove("a", "b") { qty := qty }'),
    ).not.toContain(TYPE);
  });
});
