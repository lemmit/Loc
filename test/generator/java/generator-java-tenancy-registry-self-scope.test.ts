// ---------------------------------------------------------------------------
// Java backend — derived tenancy registry self-scope filter (multi-tenancy
// Phase 1b, capstone decision 4).
//
// The registry's derived `this.id == currentUser.tenantId` rides the same
// per-query SpEL-principal JPQL path as `tenantOwned`'s filter.  The entity
// key is an `@EmbeddedId` record (`OrganizationId(UUID value)`), so the
// comparison navigates into its component (`e.id.value`) and the SpEL side
// binds the claim AS the id's value type: a `string` claim against a guid id
// converts via `T(java.util.UUID).fromString(...)`, null-guarded so a missing
// principal binds `= NULL` (fail-closed, no rows); a same-typed guid claim
// binds directly through the plain `?.` accessor.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "java",
);
const ROOT = "d/src/main/java/com/loom/d";
const SPEL_CONVERTED =
  ":#{@currentUserAccessor.user() == null || @currentUserAccessor.user().tenantId() == null ? null : T(java.util.UUID).fromString(@currentUserAccessor.user().tenantId())}";

async function orgRepo(src: string = SRC): Promise<string> {
  const files = await generateSystemFiles(src);
  return files.get(`${ROOT}/features/organizations/OrganizationJpaRepository.java`)!;
}

describe("java generator — derived registry self-scope filter", () => {
  it("overrides findAll with the id.value-vs-converted-claim scoped @Query", async () => {
    expect(await orgRepo()).toContain(
      `@Query("select e from Organization e where (e.id.value = ${SPEL_CONVERTED})")\n    List<Organization> findAll();`,
    );
  });

  it("overrides findById so a guessed foreign org id can't leak", async () => {
    expect(await orgRepo()).toContain(
      `@Query("select e from Organization e where e.id = :id and (e.id.value = ${SPEL_CONVERTED})")\n    Optional<Organization> findById(@Param("id") OrganizationId id);`,
    );
  });

  it("binds a same-typed guid claim directly (no UUID.fromString)", async () => {
    const repo = await orgRepo(SRC.replace("tenantId: string", "tenantId: guid"));
    expect(repo).toContain("e.id.value = :#{@currentUserAccessor.user()?.tenantId()}");
    expect(repo).not.toContain("fromString");
  });

  it("keeps the registry entity free of @SQLRestriction and claim reads", async () => {
    const files = await generateSystemFiles(SRC);
    const entity = files.get(`${ROOT}/features/organizations/Organization.java`)!;
    expect(entity).not.toContain("@SQLRestriction");
    expect(entity).not.toContain("currentUser");
    expect(entity).not.toContain("tenantId");
  });
});
