// ---------------------------------------------------------------------------
// Java backend — tenancy filter AND-ed into a REIFIED `criterion` retrieval
// (DEBT-01 residual closer).
//
// A retrieval whose `where:` is exactly a criterion reference reads via
// `JpaSpecificationExecutor.findAll(spec)`, which bypasses the scoped
// findAll/findById @Query overrides.  So a principal (tenancy) filter is AND-ed
// in as a `tenantScope(User)` Specification factory on `<Agg>Criteria`,
// composed onto the criterion spec in the repository impl (which gains an
// injected CurrentUserAccessor).  The factory renders the principal predicate
// null-safe (no actor → null → fail-closed).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/tenancy-reified.ddd", "utf8");
const ROOT = "api1/src/main/java/com/loom/api1";

describe("java generator — tenancy on a reified criterion retrieval", () => {
  it("emits a null-safe tenantScope(User) Specification factory on the Criteria class", async () => {
    const files = await generateSystemFiles(SRC);
    const criteria = [...files.keys()].find((k) => k.endsWith("AccountCriteria.java"))!;
    const content = files.get(criteria)!;
    expect(content).toContain("import com.loom.api1.auth.User;");
    expect(content).toContain("public static Specification<Account> tenantScope(User currentUser)");
    expect(content).toContain(
      'cb.equal(root.<String>get("tenantId"), (currentUser == null ? null : currentUser.tenantId()))',
    );
  });

  it("injects CurrentUserAccessor and ANDs tenantScope into the reified findAll", async () => {
    const files = await generateSystemFiles(SRC);
    const impl = files.get(`${ROOT}/features/accounts/AccountRepositoryImpl.java`)!;
    expect(impl).toContain("import com.loom.api1.auth.CurrentUserAccessor;");
    expect(impl).toContain("private final CurrentUserAccessor currentUserAccessor;");
    expect(impl).toContain(
      "public AccountRepositoryImpl(AccountJpaRepository jpa, CurrentUserAccessor currentUserAccessor)",
    );
    // Both reified overloads compose the tenant scope onto the criterion spec.
    expect(impl).toContain(
      'jpa.findAll(AccountCriteria.HighBalance(min).and(AccountCriteria.tenantScope(currentUserAccessor.user())), Sort.by(Sort.Order.desc("balance")))',
    );
    expect(impl).toContain(
      "AccountCriteria.HighBalance(min).and(AccountCriteria.tenantScope(currentUserAccessor.user())), new OffsetLimitPageRequest(",
    );
  });

  it("leaves a non-tenancy reified retrieval untouched (no tenantScope, no accessor)", async () => {
    // The existing retrieval.ddd fixture has no principal filter — its Criteria
    // class + repo impl must stay free of the tenancy plumbing.
    const noTenancy = readFileSync("test/e2e/fixtures/java-build/retrieval.ddd", "utf8");
    const files = await generateSystemFiles(noTenancy);
    const criteria = [...files.keys()].find((k) => k.endsWith("CustomerCriteria.java"))!;
    expect(files.get(criteria)!).not.toContain("tenantScope");
    const impl = [...files.keys()].find((k) => k.endsWith("CustomerRepositoryImpl.java"))!;
    expect(files.get(impl)!).not.toContain("CurrentUserAccessor");
  });
});
