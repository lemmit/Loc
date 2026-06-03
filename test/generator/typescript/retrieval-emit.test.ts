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

// PR4 — the retrieval `loadPlan` is a no-op on Hono/Drizzle, same as EF.
// `eagerContainsOf` bulk-loads every owned containment and the hydrate
// folds them all into the returned aggregate, so `whole(T)` is satisfied
// and an explicit `loads:` can't narrow them out: owned containments are
// part of the aggregate's wireShape, and the cross-backend parity
// invariant forbids dropping a part on one backend. Guards against a
// future contributor "honouring" loads with a spurious narrowing branch.
const LOADS_SRC = `
  context Sales {
    aggregate Order {
      status: string
      contains lines: Line[]
      contains notes: Note[]
      entity Line { sku: string }
      entity Note { text: string }
    }
    repository Orders for Order { }
    criterion Open(s: string) of Order = status == s
    retrieval Recent(s: string) of Order { where: Open(s) }
    retrieval Slim(s: string) of Order { where: Open(s) loads: [this.lines] }
  }
`;

/** Body of one `async run<Name>(…)` method, bounded by the next class
 *  member (`async `, the `toWire` helper, or the class close). */
function runBody(repo: string, name: string): string {
  const start = repo.indexOf(`async ${name}(`);
  expect(start, `${name} method not found`).toBeGreaterThanOrEqual(0);
  const rest = repo.slice(start + 1);
  const endRel = rest.search(/\n {2}(?:async |toWire\()|\n\}/);
  return rest.slice(0, endRel === -1 ? rest.length : endRel);
}

describe("typescript generator — retrieval loadPlan (whole/explicit parity)", () => {
  it("explicit `loads` does not narrow — both retrievals bulk-load every owned containment", async () => {
    const { model, errors } = await parseString(LOADS_SRC);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/order-repository.ts")!;
    // `Slim` declares `loads: [this.lines]` but still loads `notes` too —
    // owned containments are always materialised (no narrowing).
    const slim = runBody(repo, "runSlim");
    expect(slim).toContain("schema.lines");
    expect(slim).toContain("schema.notes");
    // …and the body is structurally identical to the default-whole one.
    expect(runBody(repo, "runSlim").replaceAll("runSlim", "RUN")).toBe(
      runBody(repo, "runRecent").replaceAll("runRecent", "RUN"),
    );
  });
});
