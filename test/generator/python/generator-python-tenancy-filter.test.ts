// ---------------------------------------------------------------------------
// Python backend — principal (tenancy) capability filter (DEBT-02 python slice).
//
// `filter this.tenantId == currentUser.tenantId` can't ride a static WHERE
// (no compile-time principal), so it AND-s `require_current_user().tenant_id`
// — the ambient `ContextVar[User | None]` accessor, the SQLAlchemy analogue of
// node's `requireCurrentUser()` weave / EF Core's `HasQueryFilter` — into every
// root read in the generated repository:
//   - the auto find_by_id / all / find_many_by_ids,
//   - each custom find (its own `where` conjoined via `and_(...)`),
//   - each custom find.
// No read method gains a parameter — the accessor reads the request-scoped
// principal the auth middleware stashed.  `auth: required` emits the User
// dataclass + `current_user_var` + fail-closed `require_current_user()` the
// predicate resolves through.  The non-principal predicate path (W1a — see
// context-filter-emit.test.ts) is unaffected.  The java analogue is
// test/generator/java/generator-java-tenancy-filter.test.ts.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = readFileSync("test/e2e/fixtures/python-build/tenancy-filter.ddd", "utf8");
const REPO = "api/app/db/repositories/account_repository.py";
const PRINCIPAL = "(AccountRow.tenant_id == require_current_user().tenant_id)";

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(`source has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

async function repo(): Promise<string> {
  const r = (await build()).get(REPO);
  expect(r).toBeDefined();
  return r!;
}

describe("python generator — principal (tenancy) capability filter", () => {
  it("AND-s the principal predicate into all() (the bare root read)", async () => {
    expect(await repo()).toContain(`select(AccountRow).where(${PRINCIPAL})`);
  });

  it("AND-s the principal into find_by_id so a guessed cross-tenant id can't leak", async () => {
    expect(await repo()).toContain(
      `select(AccountRow).where(and_(AccountRow.id == id, ${PRINCIPAL}))`,
    );
  });

  it("AND-s the principal into find_many_by_ids", async () => {
    expect(await repo()).toContain(
      `select(AccountRow).where(and_(AccountRow.id.in_(list(ids)), ${PRINCIPAL}))`,
    );
  });

  it("ANDs the principal into a custom find's own where", async () => {
    expect(await repo()).toContain(
      `select(AccountRow).where(and_((AccountRow.balance >= min), ${PRINCIPAL}))`,
    );
  });

  it("imports require_current_user into the repository module", async () => {
    expect(await repo()).toContain("from app.auth.user import require_current_user");
  });

  it("emits the ContextVar carrier + fail-closed accessor in app/auth/user.py", async () => {
    const user = (await build()).get("api/app/auth/user.py")!;
    expect(user).toContain("current_user_var: ContextVar[User | None] = ContextVar(");
    expect(user).toContain("def require_current_user() -> User:");
    // Fail-closed: an unauthenticated principal-scoped read raises.
    expect(user).toContain('raise PermissionError("unauthorized")');
    // The User dataclass carries the tenant claim the predicate reads.
    expect(user).toContain("tenant_id: str");
  });
});
