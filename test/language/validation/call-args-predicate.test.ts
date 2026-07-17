// `loom.call-arg-type` for CRITERION / POLICY-FUNCTION calls (M-T6.18 gap #3) —
// a criterion/policy call in an env-bearing position (a body precondition /
// requires) gets its args type-checked.  Their ARITY is already owned by
// `checkCriteria` (loom.criterion-arity) / `checkPolicyFns`, so this adds the
// TYPE check only — no double arity report.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (ops: string) => `
system Demo {
  subdomain S {
    context C {
      criterion InRegion(r: string) of Order = region == r
      policy CanApprove(cap: string): bool = cap == "admin"
      aggregate Order with crudish {
        region: string
        qty: int
        ${ops}
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(ops: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(ops), { validate: true });
  return codesOf(diagnostics);
}

const TYPE = "loom.call-arg-type";

describe("criterion / policy-fn arg types (M-T6.18 gap #3)", () => {
  it("flags a wrong-typed criterion argument", async () => {
    expect(await codes("operation bad() { precondition InRegion(5) }")).toContain(TYPE);
  });

  it("is CLEAN for a correctly-typed criterion argument", async () => {
    expect(await codes('operation ok() { precondition InRegion("EU") }')).not.toContain(TYPE);
  });

  it("flags a wrong-typed policy-function argument", async () => {
    expect(await codes("operation bad() { precondition CanApprove(5) }")).toContain(TYPE);
  });

  it("is CLEAN for a correctly-typed policy-function argument", async () => {
    expect(await codes('operation ok() { precondition CanApprove("admin") }')).not.toContain(TYPE);
  });

  it("does not double-report a criterion arity mismatch as a type error", async () => {
    // wrong count → loom.criterion-arity (its own gate), NOT loom.call-arg-type.
    expect(await codes('operation bad() { precondition InRegion("a", "b") }')).not.toContain(TYPE);
  });
});
