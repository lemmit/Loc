// ---------------------------------------------------------------------------
// Java / Spring backend — per-operation `audited` (audit-and-logging.md).  Port
// of the node / .NET runtime: an audited public operation appends a
// who/what/when + before/after wire-DTO snapshot row into the append-only
// audit_records table, persisted INSIDE the service's @Transactional method
// (the same transaction as the aggregate save).  Lifecycle create/destroy audit
// is grammar-blocked and out of scope — only per-op `audited`.
//
// Boot-verified via LOOM_JAVA_BUILD against
// test/e2e/fixtures/java-build/audited-operation.ddd.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/audited-operation.ddd", "utf8");
const ROOT = "api/src/main/java/com/loom/api";
const MIG = "api/src/main/resources/db/migration/V29991231235959.8__Audit.sql";

const files = await generateSystemFiles(SRC);
const get = (p: string): string => {
  const f = files.get(p);
  if (f === undefined) throw new Error(`missing emitted file: ${p}`);
  return f;
};

describe("java generator — audit SDK", () => {
  it("emits the AuditRecord JPA entity + jsonb columns + indexes", () => {
    const rec = get(`${ROOT}/infrastructure/persistence/AuditRecord.java`);
    expect(rec).toContain('@Table(name = "audit_records"');
    expect(rec).toContain(
      '@Index(name = "audit_records_target_idx", columnList = "target_type, target_id")',
    );
    expect(rec).toContain(
      '@Index(name = "audit_records_correlation_idx", columnList = "correlation_id")',
    );
    expect(rec).toContain("@JdbcTypeCode(SqlTypes.JSON)");
    expect(rec).toContain('@Column(name = "actor")');
    expect(rec).toContain('@Column(name = "before")');
    expect(rec).toContain('@Column(name = "after")');
    expect(rec).toContain('@Column(name = "operation_id")');
    expect(rec).toContain('@Column(name = "status")');
  });

  it("emits the AuditRecordRepository Spring Data port", () => {
    expect(get(`${ROOT}/infrastructure/persistence/AuditRecordRepository.java`)).toContain(
      "public interface AuditRecordRepository extends JpaRepository<AuditRecord, String>",
    );
  });
});

describe("java generator — audited operation instrumentation", () => {
  const svc = get(`${ROOT}/features/orders/OrderService.java`);

  it("injects the AuditRecordRepository into the @Transactional service", () => {
    expect(svc).toContain("@Transactional");
    expect(svc).toContain("private final AuditRecordRepository auditRecords;");
    expect(svc).toContain("AuditRecordRepository auditRecords");
    expect(svc).toContain("this.auditRecords = auditRecords;");
  });

  it("captures before BEFORE the mutation and after post-save", () => {
    expect(svc).toContain("var __before = OrderResponse.from(aggregate);");
    expect(svc).toContain("aggregate.cancel();");
    expect(svc).toContain("repository.save(aggregate);");
    expect(svc).toContain("var __after = OrderResponse.from(aggregate);");
    // before precedes the op call; after follows the save.
    expect(svc).toMatch(
      /var __before = OrderResponse\.from\(aggregate\);\s*\n\s*aggregate\.cancel\(\);/,
    );
    expect(svc).toMatch(
      /repository\.save\(aggregate\);\s*\n\s*var __after = OrderResponse\.from\(aggregate\);/,
    );
  });

  it("persists the AuditRecord who/what/when + before/after in the save transaction", () => {
    expect(svc).toContain("auditRecords.save(new AuditRecord(");
    expect(svc).toContain('"cancelOrder",'); // operationId = <op><Agg>
    expect(svc).toContain('"cancel",'); // action
    expect(svc).toContain('"Order",'); // targetType
    expect(svc).toContain("id.value().toString(),"); // targetId
    expect(svc).toContain("__before,");
    expect(svc).toContain("__after,");
    expect(svc).toContain("OffsetDateTime.now(),");
    expect(svc).toContain('"ok",'); // status
    expect(svc).toContain("RequestContext.correlationId(),");
    expect(svc).toContain("RequestContext.scopeId(),");
    expect(svc).toContain("RequestContext.parentId()));");
  });

  it("announces audit_recorded (debug) on the catalog channel after the save", () => {
    expect(svc).toContain(
      'CatalogLog.event("audit_recorded", "debug", "action", "cancel", "target", "Order", "actor", RequestContext.actorId());',
    );
  });

  it("instruments every audited op (cancel + reopen)", () => {
    expect(svc).toContain('"reopenOrder",');
    expect(svc).toContain('"reopen",');
    // The non-audited crudish `update` op is NOT instrumented.
    const updateBody = svc.slice(svc.indexOf("public void update("));
    expect(updateBody).not.toContain("auditRecords.save(");
  });

  it("stamps the actor as null on a deployable without auth", () => {
    // audited-operation.ddd has no `auth: required`, so there's no principal.
    expect(svc).toMatch(/id\.value\(\)\.toString\(\),\s*\n\s*null,/);
  });
});

describe("java generator — audit migration DDL", () => {
  const sql = get(MIG);

  it("creates audit_records with the who/what/when + before/after columns", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS audit_records (");
    expect(sql).toContain("  actor jsonb,");
    expect(sql).toContain("  before jsonb NOT NULL,");
    expect(sql).toContain("  after jsonb NOT NULL,");
    expect(sql).toContain("  status text NOT NULL,");
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS audit_records_target_idx ON audit_records (target_type, target_id);",
    );
  });
});

// Regression: the audit-record actor reads `currentUserAccessor.user()` on an
// authed system even when no operation otherwise uses the current user, so the
// accessor must be injected for audit-on-authed (the `needsUserAccessor` gate)
// — otherwise the service references an uninjected field and javac fails.
describe("java generator — audit actor accessor injection (authed, no op-user use)", () => {
  const AUTHED = `
system AuthedAudit {
  user { id: guid  email: string }
  subdomain Core {
    context Ordering {
      aggregate Order {
        status: string
        operation cancel() audited { status := "cancelled" }
      }
      repository Orders for Order { }
    }
  }
  api OrderingApi from Core
  storage primary { type: postgres }
  resource orderingState { for: Ordering, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [Ordering]
    dataSources: [orderingState]
    serves: OrderingApi
    auth: required
    port: 8081
  }
}`;

  it("injects CurrentUserAccessor and reads the principal for the audit actor", async () => {
    const out = await generateSystemFiles(AUTHED);
    const svc = out.get(`${ROOT}/features/orders/OrderService.java`);
    if (svc === undefined) throw new Error("missing OrderService.java");
    // The accessor is injected (field + ctor param) and the audit actor reads it.
    expect(svc).toContain("private final CurrentUserAccessor currentUserAccessor;");
    expect(svc).toContain("CurrentUserAccessor currentUserAccessor");
    expect(svc).toContain("this.currentUserAccessor = currentUserAccessor;");
    expect(svc).toMatch(/id\.value\(\)\.toString\(\),\s*\n\s*currentUserAccessor\.user\(\),/);
  });
});
