import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-02 Slice B — a PRINCIPAL-referencing (tenancy) capability filter
// (`filter this.tenantId == currentUser.tenantId`) on a `shape: document`
// aggregate (java).  The whole aggregate lives in one `data` jsonb column, so
// the filter can't be a SQL predicate — it's applied in-app over the rehydrated
// aggregate on every read.  The principal can't ride the static @SQLRestriction
// either, so the document store injects a `CurrentUserAccessor` bean, binds
// `var currentUser = currentUserAccessor.user();`, and applies the fail-closed
// `currentUser != null && (Objects.equals(x.tenantId(), currentUser.tenantId()))`
// in-app predicate.  Requires `auth: required` + a system `user {}` block.
// ---------------------------------------------------------------------------

const SRC = readFileSync("test/e2e/fixtures/java-build/document-tenancy.ddd", "utf8");
const ROOT = "api1/src/main/java/com/loom/api1";

async function repo(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  return files.get(`${ROOT}/features/accounts/AccountRepositoryImpl.java`)!;
}

describe("java document principal (tenancy) capability filter (DEBT-02 Slice B)", () => {
  it("injects the CurrentUserAccessor bean (import + field + constructor)", async () => {
    const r = await repo();
    expect(r).toContain("import com.loom.api1.auth.CurrentUserAccessor;");
    expect(r).toContain("private final CurrentUserAccessor currentUserAccessor;");
    expect(r).toContain(
      "public AccountRepositoryImpl(JdbcTemplate jdbc, CurrentUserAccessor currentUserAccessor) {",
    );
    expect(r).toContain("this.currentUserAccessor = currentUserAccessor;");
  });

  it("gates findById fail-closed by the in-app principal predicate", async () => {
    const r = await repo();
    expect(r).toContain("var currentUser = currentUserAccessor.user();");
    expect(r).toContain("var rec = fromJson(rows.get(0));");
    expect(r).toContain(
      "return (currentUser != null && (Objects.equals(rec.tenantId(), currentUser.tenantId()))) ? Optional.of(rec) : Optional.empty();",
    );
  });

  it("filters findAll fail-closed by the in-app principal predicate", async () => {
    const r = await repo();
    expect(r).toContain("var x = fromJson(data);");
    expect(r).toContain(
      "if (currentUser != null && (Objects.equals(x.tenantId(), currentUser.tenantId()))) out.add(x);",
    );
  });

  it("leaves custom finds reading through the (now scoped) findAll", async () => {
    const r = await repo();
    expect(r).toContain("findAll().stream().filter(x -> x.balance() >= min).toList();");
  });

  it("emits the CurrentUserAccessor / User the accessor resolves through", async () => {
    const files = await generateSystemFiles(SRC);
    const accessor = files.get(`${ROOT}/auth/CurrentUserAccessor.java`)!;
    expect(accessor).toContain("@Component");
    expect(accessor).toContain("public User user()");
    const user = files.get(`${ROOT}/auth/User.java`)!;
    expect(user).toContain("record User(UUID id, String tenantId)");
  });
});
