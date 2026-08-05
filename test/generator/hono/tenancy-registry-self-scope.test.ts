// ---------------------------------------------------------------------------
// Node/Hono backend — derived tenancy registry self-scope filter (multi-
// tenancy Phase 1b, capstone decision 4).
//
// Under `tenancy by user.tenantId of Organization`, enrichment appends
// `this.id == currentUser.tenantId` to the registry's contextFilters; the
// Drizzle backend renders it through the SAME principal capability-filter
// path `tenantOwned` uses, AND-ed into every root read.  The claim is a
// `string` and the column a `uuid`, so it is bound through a well-formedness
// GUARD (M-T3.7(c)): a malformed claim would otherwise reach the driver as raw
// text and make Postgres reject the statement (`invalid input syntax for type
// uuid`) — a 500 for an ordinary bad token.  Filters never gate creates, so
// the claim-less signup bootstrap (`POST /organizations`) stays open.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "node",
);
const CLAIM = "requireCurrentUser().tenantId";
const BARE_EQ = `eq(schema.organizations.id, ${CLAIM})`;
const NO_MATCH = "and(isNull(schema.organizations.id), isNotNull(schema.organizations.id))";
const GUARD = `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(${CLAIM})`;
const SELF_SCOPE = `(${GUARD} ? ${BARE_EQ} : ${NO_MATCH})`;

/** Occurrences of `needle` in `hay`. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("hono generator — derived registry self-scope filter", () => {
  it("ANDs the self-scope into every registry root read (findAll / findById)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/db/repositories/organization-repository.ts")!;
    expect(repo).toContain(`.where(${SELF_SCOPE})`); // findAll
    expect(repo).toContain(`and(eq(schema.organizations.id, id), ${SELF_SCOPE})`); // findById
  });

  it("never binds the raw claim to the uuid column — a malformed one reads empty (M-T3.7(c))", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/db/repositories/organization-repository.ts")!;
    // Every comparison of the registry id to the claim sits INSIDE the
    // well-formedness ternary.  Equal counts is the load-bearing assertion:
    // drop the guard and the bare `eq` survives while the guarded form does
    // not, so this goes red (mutation-proven) rather than merely losing an
    // extra `toContain`.
    expect(count(repo, BARE_EQ)).toBeGreaterThan(0);
    expect(count(repo, SELF_SCOPE)).toBe(count(repo, BARE_EQ));
    // …and the malformed branch is the same always-false term `deny` uses, so
    // the read is EMPTY rather than an error.
    expect(repo).toContain(NO_MATCH);
  });

  it("does NOT thread the claim into the registry's create path (bootstrap stays open)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/db/repositories/organization-repository.ts")!;
    // The save/insert path carries no principal read — no stamp, no filter.
    const saveStart = repo.indexOf("async save(");
    const saveBody = repo.slice(saveStart, repo.indexOf("async ", saveStart + 1));
    expect(saveBody).not.toContain("requireCurrentUser");
    // The create route builds the aggregate from the request body alone —
    // no claim read anywhere in the registry's HTTP surface.
    const routes = files.get("d/http/organization.routes.ts")!;
    expect(routes).toContain("Organization.create({ name: body.name })");
    expect(routes).not.toContain("tenantId");
  });
});
