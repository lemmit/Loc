// Generator coverage for `retrieval` (PR3): a context retrieval targeting
// an aggregate emits a `run<Name>` repository method — `where` → Drizzle
// predicate, `sort` → `.orderBy(asc/desc(col))`, call-site `page` →
// `.limit()/.offset()`, returning the hydrated aggregate array.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer { active: bool  region: string  name: string }
    repository Customers for Customer { }
    criterion ActiveCustomer of Customer = active == true
    criterion InRegion(rgn: string) of Customer = region == rgn

    retrieval ActiveInRegion(region: string) of Customer {
      where: ActiveCustomer && InRegion(region)
      sort:  [name asc]
    }
  }
`;

describe("typescript generator — retrieval", () => {
  it("emits a runActiveInRegion method with where + sort + paging", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/customer-repository.ts")!;

    // Method signature: retrieval params + optional page arg, returns array.
    expect(repo).toMatch(
      /async runActiveInRegion\(region: string, page\?: \{ offset\?: number; limit\?: number \}\): Promise<Customer\[\]>/,
    );
    // where → the composed criteria, same Drizzle shape as a find filter.
    expect(repo).toMatch(
      /\.where\(and\(eq\(schema\.customers\.active, true\), eq\(schema\.customers\.region, region\)\)\)/,
    );
    // sort → orderBy(asc(col)).
    expect(repo).toMatch(/\.orderBy\(asc\(schema\.customers\.name\)\)/);
    // page → conditional limit/offset.
    expect(repo).toMatch(/if \(page\?\.limit !== undefined\) query = query\.limit\(page\.limit\);/);
    expect(repo).toMatch(
      /if \(page\?\.offset !== undefined\) query = query\.offset\(page\.offset\);/,
    );
    // asc pulled into the drizzle-orm import.
    expect(repo).toMatch(/import \{[^}]*\basc\b[^}]*\} from "drizzle-orm";/);
  });

  it("emits no run method for an aggregate with no retrieval", async () => {
    const { model } = await parseString(`
      context Sales {
        aggregate Order { total: decimal }
        repository Orders for Order { }
      }
    `);
    const repo = generateHono(model).get("db/repositories/order-repository.ts")!;
    expect(repo).not.toMatch(/async run/);
  });

  it("emits a paging-only run for a where-only retrieval (no orderBy)", async () => {
    const { model, errors } = await parseString(`
      context Sales {
        aggregate Customer { active: bool }
        repository Customers for Customer { }
        criterion ActiveCustomer of Customer = active == true
        retrieval AllActive of Customer = ActiveCustomer
      }
    `);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/customer-repository.ts")!;
    expect(repo).toMatch(/async runAllActive\(page\?: /);
    expect(repo).not.toMatch(/runAllActive[\s\S]*\.orderBy\(/);
  });
});
