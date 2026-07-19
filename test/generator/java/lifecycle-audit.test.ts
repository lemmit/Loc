// Java / Spring backend — audited LIFECYCLE actions (`create(...) audited` /
// `destroy audited`), the port of the Hono lifecycle-audit route.  Reuses the
// per-operation audit sink (AuditRecordRepository persisted in the service's own
// @Transactional method), adapting the before/after pair to the lifecycle
// asymmetry:
//   - create → before = NullNode (the JSON `null` token, satisfying the NOT NULL
//     jsonb column), after = wire(created), keyed by the generated id; persisted
//     after repository.save.
//   - destroy → before = wire(loaded), after = NullNode; persisted BEFORE
//     repository.delete (same @Transactional method → atomic).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Billing {
  subdomain Core {
    context Invoicing {
      aggregate Invoice {
        total: money
        create(total: money) audited { total := total }
        destroy audited { }
        operation pay() { }
      }
      repository Invoices for Invoice { }
    }
  }
  storage pg { type: postgres }
  resource invoicingState { for: Invoicing, kind: state, use: pg }
  deployable api { platform: java, contexts: [Invoicing], dataSources: [invoicingState], port: 4000 }
}
`;

const ROOT = "api/src/main/java/com/loom/api";
const files = await generateSystemFiles(SRC);
const get = (p: string): string => {
  const f = files.get(p);
  if (f === undefined) throw new Error(`missing emitted file: ${p}`);
  return f;
};
const svc = get(`${ROOT}/features/invoices/InvoiceService.java`);

describe("java generator — audited lifecycle actions", () => {
  it("emits the audit_records table + repository when ONLY lifecycle actions are audited", () => {
    // `pay()` is NOT audited — only create/destroy are — yet the shared
    // predicate still turns on the AuditRecord entity + migration.
    expect(get(`${ROOT}/infrastructure/persistence/AuditRecord.java`)).toContain(
      '@Table(name = "audit_records"',
    );
    expect(get("api/src/main/resources/db/migration/V29991231235959.8__Audit.sql")).toContain(
      "CREATE TABLE IF NOT EXISTS audit_records (",
    );
  });

  it("injects the AuditRecordRepository + the NullNode import", () => {
    expect(svc).toContain("private final AuditRecordRepository auditRecords;");
    expect(svc).toContain("import tools.jackson.databind.node.NullNode;");
  });

  it("audits the create with before=NullNode and after=wire(created) after the save", () => {
    expect(svc).toContain("repository.save(aggregate);");
    expect(svc).toContain("var __after = InvoiceResponse.from(aggregate);");
    expect(svc).toContain("auditRecords.save(new AuditRecord(");
    expect(svc).toContain('"createInvoice",');
    expect(svc).toContain('"create",');
    expect(svc).toContain("aggregate.id().value().toString(),");
    // create asymmetry: before = NullNode, after = __after.
    expect(svc).toMatch(/NullNode\.getInstance\(\),\s*\n\s*__after,/);
  });

  it("audits the destroy with before=wire(loaded) and after=NullNode before the delete", () => {
    expect(svc).toContain("var __before = InvoiceResponse.from(aggregate);");
    expect(svc).toContain('"destroyInvoice",');
    expect(svc).toContain('"destroy",');
    // destroy asymmetry: before = __before, after = NullNode.
    expect(svc).toMatch(/__before,\s*\n\s*NullNode\.getInstance\(\),/);
    // The audit row is persisted BEFORE the hard delete.
    const auditIdx = svc.indexOf('"destroyInvoice",');
    const deleteIdx = svc.indexOf("repository.delete(aggregate);");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(auditIdx);
  });
});
