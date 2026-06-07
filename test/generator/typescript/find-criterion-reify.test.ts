// Hono reified criteria — `find` path.  A repository `find` whose `where` is
// *exactly* a named `criterion` calls the same module-level predicate function
// (`<name>Criterion`) a `retrieval` does, instead of inlining the predicate.
// A composed/anonymous `where` keeps inlining (the "if it has a name" rule), so
// behaviour — and cross-backend wire parity — is unchanged; only the code
// organisation differs.  A criterion shared by a find and a retrieval emits one
// function.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer { active: bool  region: string  name: string }
    repository Customers for Customer {
      find active(): Customer[] where ActiveCustomer
      find inRegion(r: string): Customer[] where InRegion(r)
      find activeInRegion(r: string): Customer[] where ActiveCustomer && InRegion(r)
    }
    criterion ActiveCustomer of Customer = active == true
    criterion InRegion(rgn: string) of Customer = region == rgn
    retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name asc] }
  }
`;

describe("typescript generator — reified criteria (find)", () => {
  it("a single-criterion find calls the reified predicate fn", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/customer-repository.ts")!;

    // Parameterless + parameterised single-criterion finds reify.
    expect(repo).toMatch(
      /async active\(\): Promise<Customer\[\]> \{[\s\S]*?\.where\(activeCustomerCriterion\(\)\)/,
    );
    expect(repo).toMatch(/async inRegion\(r: string\)[\s\S]*?\.where\(inRegionCriterion\(r\)\)/);

    // Composed `where` stays inline — no reified call.
    expect(repo).toMatch(
      /async activeInRegion\(r: string\)[\s\S]*?\.where\(and\(eq\(schema\.customers\.active, true\), eq\(schema\.customers\.region, r\)\)\)/,
    );
  });

  it("a criterion shared by a find and a retrieval emits exactly one fn", async () => {
    const { model } = await parseString(SRC);
    const repo = generateHono(model).get("db/repositories/customer-repository.ts")!;
    // `InRegion` is used by find `inRegion` and retrieval `ByRegion` — one fn.
    const decls = repo.match(/const inRegionCriterion = /g) ?? [];
    expect(decls.length).toBe(1);
  });
});
