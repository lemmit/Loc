import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
} from "../../../ir/types/loom-ir.js";
import { aggHasAuditedTarget } from "../../../ir/util/audit-capability.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Per-operation audit runtime — Python / FastAPI counterpart of the Hono
// `audit_records` table + the .NET `AuditRecord` / `IAuditWriter` pair + the
// Java `AuditRecord` JPA row.  Emitted only when a served context declares at
// least one `audited` operation (gated on the op, never on a backend
// allowlist).
//
//   - `AuditRecordRow` (SQLAlchemy model) — the append-only history table.
//     The route persists the record through the aggregate repository's
//     `record_audit(...)` helper INSIDE the request's own session, so the
//     audit row commits in the SAME transaction as the aggregate's state
//     change (atomic — both commit or roll back together, mirroring the Hono
//     transactional route + the .NET IAuditWriter unit-of-work staging + the
//     Java service insert).
//
// The per-operation capture (before/after wire snapshots either side of the
// mutation + the record persist) is emitted by routes-builder.ts +
// repository-builder.ts; this module owns the shared model.  It lands in
// `app/db/audit.py`.  The DDL ships as one LATE hand-emitted migration
// (`emit/migrations.ts`, `emitPythonAuditMigration`) — audit is NOT part of
// the shared MigrationsIR.
// ---------------------------------------------------------------------------

/** The `audited` public operations on an aggregate — the per-op audit scope. */
export function auditedOpsOf(agg: EnrichedAggregateIR): OperationIR[] {
  return agg.operations.filter((o) => o.audited && o.visibility === "public");
}

/** True iff this aggregate has any `audited` public operation — gates the
 *  per-route operation audit instrumentation + the repository `record_audit`
 *  helper. */
export function aggHasAuditedOp(agg: EnrichedAggregateIR): boolean {
  return agg.operations.some((o) => o.audited && o.visibility === "public");
}

/** True iff any aggregate in the given contexts carries an `audited` command
 *  action — operation, lifecycle create, OR destroy (the SHARED predicate).
 *  Gates the shared runtime file + the audit_records DDL so a
 *  lifecycle-only-audited aggregate still gets the table. */
export function contextsHaveAudit(contexts: EnrichedBoundedContextIR[]): boolean {
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      if (aggHasAuditedTarget(agg)) return true;
    }
  }
  return false;
}

/** `app/db/audit.py` — the append-only audit SQLAlchemy model.  Mirrors the
 *  Hono `audit_records` Drizzle table / the .NET / Java AuditRecord
 *  column-for-column: snake_case columns, jsonb on the actor / before / after
 *  blobs, indexes on (target_type, target_id) + (correlation_id). */
function renderPyAudit(): string {
  return lines(
    `"""Per-operation audit runtime — the append-only history model.`,
    ``,
    `Emitted only when a served context declares an \`audited\` operation.  One`,
    `row per successful audited operation, persisted in the SAME session as the`,
    `aggregate save (atomic).  before/after are the wire-DTO snapshots either`,
    `side of the mutation; the record is append-only and never exposed on the`,
    `operation response."""`,
    ``,
    `from datetime import datetime`,
    ``,
    `from sqlalchemy import DateTime, Index, Text`,
    `from sqlalchemy.dialects.postgresql import JSONB`,
    `from sqlalchemy.orm import Mapped, mapped_column`,
    ``,
    `from app.db.schema import Base`,
    ``,
    ``,
    `class AuditRecordRow(Base):`,
    `    __tablename__ = "audit_records"`,
    `    __table_args__ = (`,
    `        Index("audit_records_target_idx", "target_type", "target_id"),`,
    `        Index("audit_records_correlation_idx", "correlation_id"),`,
    `    )`,
    ``,
    `    audit_id: Mapped[str] = mapped_column(Text, primary_key=True)`,
    `    operation_id: Mapped[str] = mapped_column(Text)`,
    `    action: Mapped[str] = mapped_column(Text)`,
    `    target_type: Mapped[str] = mapped_column(Text)`,
    `    target_id: Mapped[str] = mapped_column(Text)`,
    `    actor: Mapped[object | None] = mapped_column(JSONB)`,
    `    before: Mapped[object] = mapped_column(JSONB)`,
    `    after: Mapped[object] = mapped_column(JSONB)`,
    `    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))`,
    `    status: Mapped[str] = mapped_column(Text)`,
    `    correlation_id: Mapped[str | None] = mapped_column(Text)`,
    `    scope_id: Mapped[str | None] = mapped_column(Text)`,
    `    parent_id: Mapped[str | None] = mapped_column(Text)`,
    ``,
  );
}

/** Emit the audit SDK model when any audited op exists.  No-op otherwise
 *  (keeps non-audit projects byte-identical). */
export function emitPyAudit(contexts: EnrichedBoundedContextIR[], out: Map<string, string>): void {
  if (!contextsHaveAudit(contexts)) return;
  out.set("app/db/audit.py", renderPyAudit());
}
