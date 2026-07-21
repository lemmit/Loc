// ---------------------------------------------------------------------------
// Java backend — principal (tenancy) capability filter (DEBT-01 java slice).
//
// `filter this.tenantId == currentUser.tenantId` can't ride the static
// @SQLRestriction (no runtime principal), so it AND-s a Spring Data SpEL
// clause resolving the ambient request principal through the generated
// CurrentUserAccessor bean — `:#{@currentUserAccessor.user()?.tenantId()}`,
// the JPA analogue of node's `requireCurrentUser()` — into every read:
//   - the JPA-derived findAll/findById (re-declared as scoped @Query overrides,
//     so a guessed cross-tenant id can't leak),
//   - each custom find,
//   - each custom find.
// The null-safe `?.` keeps it fail-closed.  The non-principal @SQLRestriction
// path is unaffected; the entity carries no principal @SQLRestriction.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/tenancy-filter.ddd", "utf8");
const ROOT = "api1/src/main/java/com/loom/api1";
const SPEL = ":#{@currentUserAccessor.user()?.tenantId()}";

async function repo(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  return files.get(`${ROOT}/features/accounts/AccountJpaRepository.java`)!;
}

describe("java generator — principal (tenancy) capability filter", () => {
  it("overrides findAll with a scoped @Query carrying the SpEL principal", async () => {
    expect(await repo()).toContain(
      `@Query("select e from Account e where (e.tenantId = ${SPEL})")\n    List<Account> findAll();`,
    );
  });

  it("overrides findById so a guessed cross-tenant id can't leak", async () => {
    expect(await repo()).toContain(
      `@Query("select e from Account e where e.id = :id and (e.tenantId = ${SPEL})")\n    Optional<Account> findById(@Param("id") AccountId id);`,
    );
  });

  it("ANDs the principal into a custom find's own where", async () => {
    expect(await repo()).toContain(`where (e.balance >= :min) and (e.tenantId = ${SPEL})`);
  });

  it("does NOT put the principal filter on the entity @SQLRestriction", async () => {
    const files = await generateSystemFiles(SRC);
    const entity = files.get(`${ROOT}/features/accounts/Account.java`)!;
    expect(entity).not.toContain("@SQLRestriction");
    expect(entity).not.toContain("currentUser");
  });

  it("emits the CurrentUserAccessor bean the SpEL resolves through", async () => {
    const files = await generateSystemFiles(SRC);
    const accessor = files.get(`${ROOT}/auth/CurrentUserAccessor.java`)!;
    expect(accessor).toContain("@Component");
    expect(accessor).toContain("public User user()");
    const user = files.get(`${ROOT}/auth/User.java`)!;
    expect(user).toContain("record User(UUID id, String tenantId)");
  });
});
