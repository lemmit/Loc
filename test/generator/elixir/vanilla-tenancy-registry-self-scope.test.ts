// ---------------------------------------------------------------------------
// Elixir (plain Ecto/Phoenix) backend — derived tenancy registry self-scope
// filter (multi-tenancy Phase 1b, capstone decision 4).
//
// The registry's derived `this.id == currentUser.tenantId` rides the same
// pinned-principal Ecto path as `tenantOwned`'s filter:
// `record.id == ^(current_user && current_user.tenant_id)` AND-ed into every
// root read.  Ecto casts the pinned string claim against the binary_id
// column; a `nil` principal binds `= NULL` (fail-closed — no rows).  The
// insert path takes bare attrs — no principal, so the claim-less signup
// bootstrap stays open.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "elixir",
);
const PINNED = "record.id == ^(current_user && current_user.tenant_id)";

describe("elixir vanilla generator — derived registry self-scope filter", () => {
  it("ANDs the pinned self-scope into every registry root read", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/lib/d/accounts/organization_repository.ex")!;
    expect(repo).toContain(`where: ${PINNED})`); // list
    expect(repo).toContain(`where: record.id == ^id and (${PINNED})`); // find_by_id
  });

  it("does NOT thread the claim into the registry's insert path (bootstrap stays open)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/lib/d/accounts/organization_repository.ex")!;
    const insertBody = repo.slice(repo.indexOf("def insert("), repo.indexOf("def update("));
    expect(insertBody).not.toContain("current_user");
    const changeset = files.get("d/lib/d/accounts/organization_changeset.ex")!;
    expect(changeset).not.toContain("tenant_id");
  });
});
