// ---------------------------------------------------------------------------
// Python backend — derived tenancy registry self-scope filter (multi-tenancy
// Phase 1b, capstone decision 4).
//
// The registry's derived `this.id == currentUser.tenantId` rides the same
// ambient-accessor conjunction path as `tenantOwned`'s filter, AND-ed into
// every root read.  The id column is `Uuid` and the claim a `string`, so the
// claim is bound through `User.guid_claim` (M-T3.7(c)): `as_uuid=False` is a
// RESULT-side setting, so a raw claim still reaches SQLAlchemy's bind
// processor (`uuid.UUID(value)`) and a malformed one raised `ValueError` — a
// 500 for an ordinary bad token.  Parsed to None it renders `IS NULL`, which
// no NOT NULL primary key matches: the same empty read a foreign claim gives.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "python",
);
const SELF_SCOPE = 'OrganizationRow.id == require_current_user().guid_claim("tenant_id")';

describe("python generator — derived registry self-scope filter", () => {
  it("ANDs the self-scope into every registry root read", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/app/db/repositories/organization_repository.py")!;
    expect(repo).toContain("from app.auth.user import require_current_user");
    expect(repo).toContain(`.where(${SELF_SCOPE})`); // all()
    expect(repo).toContain(`and_(OrganizationRow.id == id, ${SELF_SCOPE})`); // find_by_id
  });

  it("never binds the raw claim to the Uuid column — a malformed one reads empty (M-T3.7(c))", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/app/db/repositories/organization_repository.py")!;
    // The raw claim never reaches a comparison; only the parsed form does.
    // Reverting the fix restores `require_current_user().tenant_id` here.
    expect(repo).not.toContain("require_current_user().tenant_id");
    // The coercion itself: absent OR unparseable -> None, never a raise.
    const user = files.get("d/app/auth/user.py")!;
    expect(user).toContain("def guid_claim(self, name: str) -> str | None:");
    expect(user).toContain("return str(uuid.UUID(str(raw)))");
    expect(user).toContain("except ValueError:");
  });

  it("does NOT thread the claim into the registry's create path (bootstrap stays open)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/app/db/repositories/organization_repository.py")!;
    const saveStart = repo.indexOf("async def save(");
    const saveBody = repo.slice(saveStart, repo.indexOf("async def ", saveStart + 1));
    expect(saveBody).not.toContain("require_current_user");
  });
});
