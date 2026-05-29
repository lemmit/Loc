// Generator coverage for `criterion`: a criterion inlined into a
// repository `find ... where` flows through the existing where→Drizzle
// path, producing the same query the equivalent inline filter does — no
// per-backend query-engine change is needed.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer { active: bool  region: string }
    repository Customers for Customer {
      find inRegionInline(r: string): Customer[] where active == true && region == r
      find inRegionViaCriterion(r: string): Customer[] where ActiveCustomer && InRegion(r)
    }
    criterion ActiveCustomer of Customer = active == true
    criterion InRegion(rgn: string) of Customer = region == rgn
  }
`;

describe("typescript generator — criterion", () => {
  it("lowers a criterion-driven find to the same Drizzle where as the inline find", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const repo = files.get("db/repositories/customer-repository.ts")!;
    const expected =
      /\.where\(and\(eq\(schema\.customers\.active, true\), eq\(schema\.customers\.region, r\)\)\)/;
    // Both the inline find and the criterion-driven find emit it.
    expect(repo.match(new RegExp(expected, "g"))?.length ?? 0).toBeGreaterThanOrEqual(2);
    // No unresolved-name fallout reached the emitter.
    expect(repo).not.toMatch(/TODO: translate where-clause[\s\S]*inRegionViaCriterion/);
  });
});
