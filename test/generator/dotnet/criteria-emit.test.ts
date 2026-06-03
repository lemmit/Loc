// Reified-criteria Slices 1a + 2a (.NET): each `criterion` over an aggregate
// candidate emits a Domain-layer `Criterion<T>` specification carrying the
// in-memory `IsSatisfiedBy` (evaluate) face — and, for criteria in the
// queryable subset, a `ToExpression()` (query) face. Additive — not yet
// wired into invariants/preconditions (still inline) or find/view (still
// inline). Ambient (`of bool`) and `currentUser`-referencing criteria are
// skipped (their principal binding belongs in the not-yet-emitted factory),
// so the emitted set compiles.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer {
      active: bool
      region: string
      name: string
    }
    repository Customers for Customer { }
    criterion ActiveCustomer of Customer = active
    criterion InRegion(rgn: string) of Customer = region == rgn
    criterion Matchy of Customer = name.matches("x")
    criterion Mine(owner: string) of Customer = currentUser.name == owner
    criterion IsManager of bool = currentUser.role == "manager"
  }
`;

async function files() {
  return generateDotnet(await parseValid(SRC));
}

describe(".NET generator — reified criteria (Slice 1: evaluate face)", () => {
  it("emits the shared Criterion<T> base into Domain/Common", async () => {
    const base = (await files()).get("Domain/Common/Criterion.cs")!;
    expect(base).toBeDefined();
    expect(base).toMatch(/public abstract class Criterion<T>/);
    expect(base).toMatch(/public abstract bool IsSatisfiedBy\(T candidate\);/);
  });

  it("emits a parameterless criterion as a Criterion<Agg> with IsSatisfiedBy", async () => {
    const c = (await files()).get("Domain/Criteria/ActiveCustomerCriterion.cs")!;
    expect(c).toBeDefined();
    expect(c).toMatch(/public sealed class ActiveCustomerCriterion : Criterion<Customer>/);
    // No constructor for a parameterless criterion; body renders `this` as the candidate.
    expect(c).not.toMatch(/public ActiveCustomerCriterion\(/);
    expect(c).toMatch(
      /public override bool IsSatisfiedBy\(Customer __candidate\) => __candidate\.Active;/,
    );
  });

  it("emits a parameterized criterion with a binding ctor; params → fields", async () => {
    const c = (await files()).get("Domain/Criteria/InRegionCriterion.cs")!;
    expect(c).toBeDefined();
    expect(c).toMatch(/private readonly string rgn;/);
    expect(c).toMatch(/public InRegionCriterion\(string rgn\)/);
    expect(c).toMatch(/this\.rgn = rgn;/);
    // candidate field → `__candidate.Region`; parameter → bare `rgn` (the field).
    expect(c).toMatch(
      /public override bool IsSatisfiedBy\(Customer __candidate\) => __candidate\.Region == rgn;/,
    );
  });

  it("skips currentUser-referencing and ambient (of bool) criteria", async () => {
    const out = await files();
    // entity candidate but reads currentUser → deferred to the factory slice
    expect(out.has("Domain/Criteria/MineCriterion.cs")).toBe(false);
    // `of bool` ambient predicate → no candidate type
    expect(out.has("Domain/Criteria/IsManagerCriterion.cs")).toBe(false);
  });

  it("(Slice 2a) a queryable criterion also carries the ToExpression query face", async () => {
    const c = (await files()).get("Domain/Criteria/InRegionCriterion.cs")!;
    expect(c).toMatch(/using System\.Linq\.Expressions;/);
    expect(c).toMatch(
      /public Expression<Func<Customer, bool>> ToExpression\(\) => __candidate => __candidate\.Region == rgn;/,
    );
  });

  it("(Slice 2a) a non-queryable criterion gets evaluate-face only (no ToExpression) + its using", async () => {
    const c = (await files()).get("Domain/Criteria/MatchyCriterion.cs")!;
    expect(c).toBeDefined();
    // Evaluate face renders `matches` → Regex.IsMatch and pulls in its using
    // (the gap Slice 1a's hardcoded using-set would have missed).
    expect(c).toMatch(/using System\.Text\.RegularExpressions;/);
    expect(c).toMatch(
      /IsSatisfiedBy\(Customer __candidate\) => Regex\.IsMatch\(__candidate\.Name, "x"\);/,
    );
    // Not in the queryable subset → no query face, no Expressions using.
    expect(c).not.toMatch(/ToExpression/);
    expect(c).not.toMatch(/using System\.Linq\.Expressions;/);
  });
});
