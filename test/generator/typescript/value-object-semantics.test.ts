// S9 · Value objects are VALUES on Hono — `equals()` + DomainError.
//
// From `docs/audits/generated-code-ddd-review-2026-07.md` §S9: the Hono VO
// class was immutable but had no `equals()` (reference identity — the one
// property a VO must not have) and its invariant violations threw a bare
// `Error`, surfacing as an unclassified 500 instead of routing through the
// DomainError → ProblemDetails taxonomy (400) like every other domain guard.
//
// What this pins:
//   1. Field-wise `equals()` — type-driven: `===` for primitives, `.equals`
//      for nested VOs and `money` (Decimal), `getTime()` for datetime,
//      null-guarded recursion for optionals.
//   2. Invariant violations throw `DomainError` (imported from ./errors).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system PS {
  subdomain D {
    context Shop {
      valueobject Coordinates {
        lat: decimal
        lon: decimal
      }
      valueobject Listing {
        title: string
        price: money
        location: Coordinates
        seenAt: datetime
        note: string?
        invariant title.length > 0
      }
      aggregate Ad with crudish {
        code: string
        listing: Listing
      }
      repository Ads for Ad { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable d { platform: node, contexts: [Shop], dataSources: [st], serves: A, port: 3000 }
}`;

describe("S9 · Hono value objects carry value semantics", () => {
  it("emits a type-driven field-wise equals()", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const vos = files.get("d/domain/value-objects.ts")!;
    expect(vos).toBeDefined();
    // Simple VO: plain === across number fields.
    expect(vos).toContain(
      "equals(other: Coordinates): boolean {\n    return this.lat === other.lat && this.lon === other.lon;",
    );
    // Composite VO: money → Decimal.equals, nested VO → recursion,
    // datetime → getTime, optional → null-guarded.
    const listingEq = vos.slice(vos.indexOf("class Listing"));
    expect(listingEq).toContain("this.title === other.title");
    expect(listingEq).toContain("this.price.equals(other.price)");
    expect(listingEq).toContain("this.location.equals(other.location)");
    expect(listingEq).toContain("this.seenAt.getTime() === other.seenAt.getTime()");
    expect(listingEq).toContain(
      "(this.note === null || other.note === null ? this.note === other.note : this.note === other.note)",
    );
  });

  it("invariant violations throw DomainError, not a bare Error", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const vos = files.get("d/domain/value-objects.ts")!;
    expect(vos).toContain('import { DomainError } from "./errors"');
    expect(vos).toContain('throw new DomainError("Invariant violated: title.length > 0")');
    expect(vos).not.toMatch(/throw new Error\(/);
  });
});
