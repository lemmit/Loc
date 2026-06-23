// ---------------------------------------------------------------------------
// Java backend — lifecycle stamps (`stamp onCreate`/`onUpdate`, the
// audit / softDelete capability stamps).  On Java these are PERSIST-TIME via
// idiomatic Spring Data JPA auditing (capability-stamp-dedup-simulation.md §5):
// each stamped field carries a @CreatedDate/@LastModifiedDate (now()) or
// @CreatedBy/@LastModifiedBy (currentUser) annotation, the entity composes
// @EntityListeners(AuditingEntityListener.class) + implements the pure
// `Auditable` marker, and a once-per-app `JpaAuditingConfig` wires
// @EnableJpaAuditing + an AuditorAware<UUID> over the request-scoped
// principal.  There is NO service-called `_stampOn*` method — the listener
// fills the columns at flush.  Principal-referencing (`currentUser`) stamps on
// a deployable WITHOUT auth and stamps on event-sourced aggregates stay
// fail-fast gated (loom.java-stamp-unsupported).  Boot-verified end-to-end
// against Postgres via test/e2e/fixtures/java-build/stamps.ddd.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/stamps.ddd", "utf8");
const ROOT = "api1/src/main/java/com/loom/api1";

describe("java generator — lifecycle stamps (persist-time JPA auditing)", () => {
  it("annotates the stamp fields + composes the auditing listener, no _stampOn* method", async () => {
    const entity = (await generateSystemFiles(SRC)).get(`${ROOT}/features/orders/Order.java`)!;
    // now()-valued stamps → @CreatedDate / @LastModifiedDate.
    expect(entity).toContain("    @CreatedDate");
    expect(entity).toContain('    @Column(name = "created_at", updatable = false)');
    expect(entity).toContain("    @LastModifiedDate");
    expect(entity).toContain('    @Column(name = "updated_at")');
    // Listener composed + pure marker implemented.
    expect(entity).toContain("@EntityListeners(AuditingEntityListener.class)");
    expect(entity).toContain("public class Order implements Auditable {");
    expect(entity).toContain(
      "import org.springframework.data.jpa.domain.support.AuditingEntityListener;",
    );
    // The old operation-time stamp method is gone.
    expect(entity).not.toContain("_stampOnCreate");
    expect(entity).not.toContain("_stampOnUpdate");
  });

  it("the service no longer calls a stamp method before save", async () => {
    const svc = (await generateSystemFiles(SRC)).get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).not.toContain("_stampOnCreate");
    expect(svc).not.toContain("_stampOnUpdate");
    // create still flows straight to repository.save (the listener stamps at flush).
    expect(svc).toMatch(/Order\.create\([^)]*\);\s*\n\s*repository\.save\(aggregate\);/);
  });

  it("emits the once-per-app Auditable marker + JpaAuditingConfig", async () => {
    const files = await generateSystemFiles(SRC);
    const marker = files.get(`${ROOT}/domain/common/Auditable.java`)!;
    expect(marker).toContain("public interface Auditable {");
    const config = files.get(`${ROOT}/config/JpaAuditingConfig.java`)!;
    // stamps.ddd has no principal stamp / no auth → @EnableJpaAuditing only,
    // no AuditorAware bean (so @CreatedDate/@LastModifiedDate still fire).
    expect(config).toContain("@EnableJpaAuditing");
    expect(config).not.toContain("AuditorAware");
  });

  it("a currentUser stamp on an auth deployable wires the AuditorAware over the principal id", async () => {
    const principal = readFileSync("test/e2e/fixtures/java-build/stamps-principal.ddd", "utf8");
    const files = await generateSystemFiles(principal);
    const entity = files.get("api1/src/main/java/com/loom/api1/features/orders/Order.java")!;
    // currentUser-valued create stamp → @CreatedBy.
    expect(entity).toContain("    @CreatedBy");
    expect(entity).toContain('    @Column(name = "created_by", updatable = false)');
    expect(entity).toContain("import org.springframework.data.annotation.CreatedBy;");
    expect(entity).not.toContain("_stampOnCreate");
    // The auditor provider resolves @CreatedBy through the request-scoped principal.
    const config = files.get("api1/src/main/java/com/loom/api1/config/JpaAuditingConfig.java")!;
    expect(config).toContain('@EnableJpaAuditing(auditorAwareRef = "auditorProvider")');
    expect(config).toContain(
      "public AuditorAware<UUID> auditorProvider(CurrentUserAccessor accessor)",
    );
    expect(config).toContain("Optional.ofNullable(accessor.user()).map(u -> u.id())");
    // The service no longer threads currentUser for stamping.
    const svc = files.get("api1/src/main/java/com/loom/api1/features/orders/OrderService.java")!;
    expect(svc).not.toContain("aggregate._stampOnCreate");
  });

  it("gates a currentUser stamp on a deployable WITHOUT auth fail-fast", async () => {
    // stamps.ddd's deployable has no `auth: required` — a currentUser
    // stamp there has no request-scoped principal to stamp from.
    const principal = SRC.replace(
      "stamp onCreate { createdAt := now() }",
      "stamp onCreate { createdAt := now()  createdBy := currentUser }",
    )
      .replace("createdAt: datetime", "createdAt: datetime\n        createdBy: guid")
      .replace("system ST {", "system ST {\n  user { id: guid  name: string }");
    const loom = await buildLoomModel(principal);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.java-stamp-unsupported");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("no auth");
  });
});
