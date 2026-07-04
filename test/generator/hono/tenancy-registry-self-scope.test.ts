// ---------------------------------------------------------------------------
// Node/Hono backend — derived tenancy registry self-scope filter (multi-
// tenancy Phase 1b, capstone decision 4).
//
// Under `tenancy by user.tenantId of Organization`, enrichment appends
// `this.id == currentUser.tenantId` to the registry's contextFilters; the
// Drizzle backend renders it through the SAME principal capability-filter
// path `tenantOwned` uses — `eq(schema.organizations.id,
// requireCurrentUser().tenantId)` AND-ed into every root read.  The string
// claim binds against the uuid column at the accessor site (pg casts the
// text parameter).  Filters never gate creates, so the claim-less signup
// bootstrap (`POST /organizations`) stays open.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "node",
);
const SELF_SCOPE = "eq(schema.organizations.id, requireCurrentUser().tenantId)";

describe("hono generator — derived registry self-scope filter", () => {
  it("ANDs the self-scope into every registry root read (findAll / findById)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/db/repositories/organization-repository.ts")!;
    expect(repo).toContain(`.where(${SELF_SCOPE})`); // findAll
    expect(repo).toContain(`and(eq(schema.organizations.id, id), ${SELF_SCOPE})`); // findById
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
