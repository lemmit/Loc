// Hono reified criteria: a `retrieval` whose `where` is exactly a named
// `criterion` emits a module-level predicate function (`<name>Criterion`) —
// the functional analog of .NET's `Criterion<T>` — that the generated
// `run<Name>` method calls instead of inlining the predicate.  Behaviour is
// identical to the inline form (same Drizzle `where`), so cross-backend
// conformance parity is unaffected; only the code organisation differs.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer { active: bool  region: string  name: string }
    repository Customers for Customer { }
    criterion InRegion(rgn: string) of Customer = region == rgn
    retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name asc] }
  }
`;

describe("typescript generator — reified criteria (retrieval)", () => {
  it("emits a module-level criterion fn the run method calls", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/customer-repository.ts")!;
    // The predicate is reified once, outside the class.
    expect(repo).toMatch(
      /const inRegionCriterion = \(rgn: string\) => eq\(schema\.customers\.region, rgn\);/,
    );
    // run<Name> calls it instead of inlining the `where`.
    expect(repo).toMatch(/\.where\(inRegionCriterion\(rgn\)\)/);
    // The reified call is the only `where` form for this retrieval — no inline
    // duplicate of the predicate leaked through.
    expect(repo).not.toMatch(/\.where\(eq\(schema\.customers\.region, rgn\)\)/);
  });
});
