import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — per-operation `audited` (audit-and-logging.md), the port
// of the node / .NET / Java runtime.  An `audited` public operation emits:
//   - app/db/audit.py — the AuditRecordRow SQLAlchemy history model (jsonb
//     actor/before/after, indexes on (target_type, target_id) +
//     (correlation_id)).
//   - the repository: a `record_audit(...)` helper that stages the row in the
//     request session (same txn as the save), stamped from RequestContext.
//   - the route handler: before/after wire snapshots either side of the
//     mutation + the record_audit call; the record is never on the response.
//   - the feature-local 29991231 audit migration.
//
// Boot-verified via LOOM_PYTHON_BUILD against
// test/e2e/fixtures/python-build/audited-operation.ddd.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/audited-operation.ddd"),
  "utf8",
);

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python per-operation audit runtime", () => {
  it("emits the AuditRecordRow history model in app/db/audit.py", async () => {
    const f = (await build()).get("api/app/db/audit.py")!;
    expect(f).toContain("class AuditRecordRow(Base):");
    expect(f).toContain('__tablename__ = "audit_records"');
    expect(f).toContain('Index("audit_records_target_idx", "target_type", "target_id")');
    expect(f).toContain('Index("audit_records_correlation_idx", "correlation_id")');
    expect(f).toContain("audit_id: Mapped[str] = mapped_column(Text, primary_key=True)");
    expect(f).toContain("actor: Mapped[object | None] = mapped_column(JSONB)");
    expect(f).toContain("before: Mapped[object] = mapped_column(JSONB)");
    expect(f).toContain("after: Mapped[object] = mapped_column(JSONB)");
  });

  it("emits the record_audit repository helper staged in the request session", async () => {
    const f = (await build()).get("api/app/db/repositories/order_repository.py")!;
    expect(f).toContain("from app.db.audit import AuditRecordRow");
    expect(f).toContain("from app.obs.log import correlation_id, log, parent_id, scope_id");
    expect(f).toContain("async def record_audit(");
    expect(f).toContain("self._session.add(");
    expect(f).toContain("AuditRecordRow(");
    expect(f).toContain("audit_id=uuid4().hex,");
    expect(f).toContain("at=datetime.now(UTC),");
    expect(f).toContain("correlation_id=correlation_id(),");
    expect(f).toContain("scope_id=scope_id(),");
    expect(f).toContain("parent_id=parent_id(),");
    expect(f).toContain("await self._session.flush()");
    // audit_recorded (debug) announced after the staged add
    expect(f).toContain(
      'log("debug", "audit_recorded", action=action, target=target_type, actor=actor)',
    );
  });

  it("captures before/after around the mutation and records it in the route", async () => {
    const f = (await build()).get("api/app/http/order_routes.py")!;
    // cancel() is a void op → before BEFORE the call, after AFTER save.
    const beforeAt = f.indexOf("__before = repo.to_wire(found)");
    const callAt = f.indexOf("found.cancel(", beforeAt);
    // Versioning is default-on (M-T3.4): the guarded save carries expected_version.
    const saveAt = f.indexOf("await repo.save(found, expected_version=_expected)", callAt);
    const afterAt = f.indexOf("__after = repo.to_wire(found)", saveAt);
    const recordAt = f.indexOf("await repo.record_audit(", afterAt);
    expect(beforeAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(beforeAt);
    expect(saveAt).toBeGreaterThan(callAt);
    expect(afterAt).toBeGreaterThan(saveAt);
    expect(recordAt).toBeGreaterThan(afterAt);
    expect(f).toContain('operation_id="cancelOrder",');
    expect(f).toContain('action="cancel",');
    expect(f).toContain('target_type="Order",');
    expect(f).toContain("target_id=str(id),");
    expect(f).toContain("before=__before,");
    expect(f).toContain("after=__after,");
  });

  it("never returns the audit record on the operation response", async () => {
    const f = (await build()).get("api/app/http/order_routes.py")!;
    // The void audited op still returns the 204 Response, not the record.
    expect(f).toContain("return Response(status_code=204)");
    expect(f).not.toContain("return __after");
  });

  // The DDL moved to the shared MigrationsIR (`auditTableShape`), so it is
  // rendered by the ordinary module-migration emitter rather than a per-backend
  // late migration.  `before`/`after` are NULLABLE by design: a create has no
  // before and a destroy no after, and a NOT NULL there rolled the whole action
  // transaction back.
  it("creates audit_records through the shared migration emitter", async () => {
    const files = await build();
    const mig = [...files.entries()].find(
      ([p, c]) => p.endsWith(".sql") && c.includes("audit_records"),
    );
    expect(mig, "audit_records DDL must be emitted somewhere").toBeDefined();
    const sql = mig![1];
    expect(sql).toMatch(/audit_records_target_idx/);
    expect(sql).not.toMatch(/before[^,\n]*NOT NULL/i);
    expect(sql).not.toMatch(/after[^,\n]*NOT NULL/i);
  });
});
