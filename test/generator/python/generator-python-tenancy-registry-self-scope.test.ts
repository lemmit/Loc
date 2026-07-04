// ---------------------------------------------------------------------------
// Python backend — derived tenancy registry self-scope filter (multi-tenancy
// Phase 1b, capstone decision 4).
//
// The registry's derived `this.id == currentUser.tenantId` rides the same
// ambient-accessor conjunction path as `tenantOwned`'s filter:
// `OrganizationRow.id == require_current_user().tenant_id` AND-ed into every
// root read.  The id column is `Uuid(as_uuid=False)` (mapped as `str`), so
// the string claim binds directly — no conversion needed.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "python",
);
const SELF_SCOPE = "(OrganizationRow.id == require_current_user().tenant_id)";

describe("python generator — derived registry self-scope filter", () => {
  it("ANDs the self-scope into every registry root read", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/app/db/repositories/organization_repository.py")!;
    expect(repo).toContain("from app.auth.user import require_current_user");
    expect(repo).toContain(`.where(${SELF_SCOPE})`); // all()
    expect(repo).toContain(`and_(OrganizationRow.id == id, ${SELF_SCOPE})`); // find_by_id
  });

  it("does NOT thread the claim into the registry's create path (bootstrap stays open)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/app/db/repositories/organization_repository.py")!;
    const saveStart = repo.indexOf("async def save(");
    const saveBody = repo.slice(saveStart, repo.indexOf("async def ", saveStart + 1));
    expect(saveBody).not.toContain("require_current_user");
  });
});
