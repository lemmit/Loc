// .NET / EF backend — audited LIFECYCLE actions (`create(...) audited` /
// `destroy audited`), the port of the Hono lifecycle-audit route.  Reuses the
// per-operation audit sink (IAuditWriter staging → AppDbContext, flushed in the
// command handler's save transaction), adapting the before/after pair to the
// lifecycle asymmetry:
//   - create → Before = "null" (JSON null literal), After = wire(created),
//     keyed by the generated id; STAGED before _repo.SaveAsync.
//   - destroy → Before = wire(loaded), After = "null"; STAGED before
//     _repo.DeleteAsync (the single SaveChangesAsync flushes both atomically).
// The before/after columns are NOT NULL jsonb; the "null" literal satisfies them.

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
  deployable api { platform: dotnet, contexts: [Invoicing], dataSources: [invoicingState], port: 4000 }
}
`;

const ROOT = "api/Application/Invoices/Commands";

const files = await generateSystemFiles(SRC);
const get = (p: string): string => {
  const f = files.get(p);
  if (f === undefined) throw new Error(`missing emitted file: ${p}`);
  return f;
};

describe("dotnet generator — audited lifecycle actions", () => {
  it("emits the audit_records table when ONLY lifecycle actions are audited", () => {
    // `pay()` is NOT audited — only create/destroy are — yet the shared
    // predicate still turns on the audit table + writer.
    expect(get("api/Infrastructure/Persistence/AuditRecord.cs")).toContain(
      "public sealed class AuditRecord",
    );
    expect(get("api/Application/Common/IAuditWriter.cs")).toContain(
      "public interface IAuditWriter",
    );
  });

  it("audits the create with Before:null and After=wire(created) staged in the save tx", () => {
    const h = get(`${ROOT}/CreateInvoiceHandler.cs`);
    expect(h).toContain("private readonly IAuditWriter _audit;");
    expect(h).toContain("_audit.Stage(new AuditRecord");
    expect(h).toContain('OperationId = "createInvoice",');
    expect(h).toContain('Action = "create",');
    expect(h).toContain('TargetType = "Invoice",');
    expect(h).toContain("TargetId = aggregate.Id.Value.ToString(),");
    expect(h).toContain('Before = "null",');
    expect(h).toContain("After = System.Text.Json.JsonSerializer.Serialize(new InvoiceResponse(");
    expect(h).toContain("CorrelationId = RequestContext.Current?.CorrelationId,");
    // Staged BEFORE the save, so the single SaveAsync flushes both atomically.
    const stageIdx = h.indexOf("_audit.Stage(new AuditRecord");
    const saveIdx = h.indexOf("await _repo.SaveAsync(aggregate, cancellationToken);");
    expect(stageIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(stageIdx);
  });

  it("audits the destroy with Before=wire(loaded) and After:null before the delete", () => {
    const h = get(`${ROOT}/DestroyInvoiceHandler.cs`);
    expect(h).toContain("_audit.Stage(new AuditRecord");
    expect(h).toContain('OperationId = "destroyInvoice",');
    expect(h).toContain('Action = "destroy",');
    expect(h).toContain("Before = System.Text.Json.JsonSerializer.Serialize(new InvoiceResponse(");
    expect(h).toContain('After = "null",');
    // The audit row is staged BEFORE the hard delete.
    const stageIdx = h.indexOf("_audit.Stage(new AuditRecord");
    const deleteIdx = h.indexOf("await _repo.DeleteAsync(aggregate, cancellationToken);");
    expect(stageIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(stageIdx);
  });
});
