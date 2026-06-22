import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Per-operation audit runtime — Java / Spring counterpart of the Hono
// `audit_records` table + the .NET `AuditRecord` / `IAuditWriter` pair.
// Emitted only when a served context declares at least one `audited`
// operation (gated on the op, never on a backend allowlist).
//
//   - `AuditRecord` (infrastructure.persistence) — the append-only JPA row.
//   - `AuditRecordRepository` (infrastructure.persistence) — the Spring Data
//     port the application service persists the record through INSIDE its own
//     @Transactional method, so the audit row commits in the SAME transaction
//     as the aggregate's state change (atomic — both commit or roll back
//     together, mirroring the Hono transactional route + the .NET IAuditWriter
//     unit-of-work staging).
//
// The per-operation capture (before/after wire snapshots either side of the
// mutation + the AuditRecord persist) is emitted by service.ts; this module
// owns the shared entity + its repository.  The DDL ships as one extra late
// Flyway migration (`emit/migrations.ts`, `emitJavaAuditMigration`) — audit is
// NOT part of the platform-neutral MigrationsIR.
// ---------------------------------------------------------------------------

/** The `audited` public operations on an aggregate — the per-op audit scope
 *  (lifecycle create/destroy audit is grammar-blocked and out of scope). */
export function auditedOpsOf(agg: EnrichedAggregateIR): OperationIR[] {
  return agg.operations.filter((o) => o.audited && o.visibility === "public");
}

/** True iff this aggregate has any `audited` public operation — gates the
 *  per-service audit instrumentation. */
export function aggHasAuditedOp(agg: EnrichedAggregateIR): boolean {
  return agg.operations.some((o) => o.audited && o.visibility === "public");
}

/** True iff any aggregate in the given contexts has an `audited` public
 *  operation — gates the shared runtime files + the audit_records DDL. */
export function contextsHaveAudit(contexts: EnrichedBoundedContextIR[]): boolean {
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      if (aggHasAuditedOp(agg)) return true;
    }
  }
  return false;
}

/** The append-only audit entity (infrastructure.persistence.AuditRecord).
 *  Mirrors the Hono `audit_records` Drizzle table / the .NET AuditRecord
 *  column-for-column: snake_case columns, jsonb on the actor / before / after
 *  blobs, indexes on (target_type, target_id) + (correlation_id). */
export function renderAuditRecordEntity(basePkg: string): string {
  return lines(
    `package ${basePkg}.infrastructure.persistence;`,
    ``,
    `import java.time.OffsetDateTime;`,
    ``,
    `import org.hibernate.annotations.JdbcTypeCode;`,
    `import org.hibernate.type.SqlTypes;`,
    ``,
    `import jakarta.persistence.*;`,
    ``,
    `/** One row per successful audited operation, written in the same`,
    ` *  transaction as the operation's aggregate save (atomic).  before/after`,
    ` *  are the wire-DTO snapshots either side of the mutation; the record is`,
    ` *  append-only and never exposed on the operation response. */`,
    `@Entity`,
    `@Table(name = "audit_records", indexes = {`,
    `    @Index(name = "audit_records_target_idx", columnList = "target_type, target_id"),`,
    `    @Index(name = "audit_records_correlation_idx", columnList = "correlation_id")`,
    `})`,
    `public class AuditRecord {`,
    `    @Id`,
    `    @Column(name = "audit_id")`,
    `    private String auditId;`,
    `    @Column(name = "operation_id")`,
    `    private String operationId;`,
    `    @Column(name = "action")`,
    `    private String action;`,
    `    @Column(name = "target_type")`,
    `    private String targetType;`,
    `    @Column(name = "target_id")`,
    `    private String targetId;`,
    `    @JdbcTypeCode(SqlTypes.JSON)`,
    `    @Column(name = "actor")`,
    `    private Object actor;`,
    `    @JdbcTypeCode(SqlTypes.JSON)`,
    `    @Column(name = "before")`,
    `    private Object before;`,
    `    @JdbcTypeCode(SqlTypes.JSON)`,
    `    @Column(name = "after")`,
    `    private Object after;`,
    `    @Column(name = "at")`,
    `    private OffsetDateTime at;`,
    `    @Column(name = "status")`,
    `    private String status;`,
    `    @Column(name = "correlation_id")`,
    `    private String correlationId;`,
    `    @Column(name = "scope_id")`,
    `    private String scopeId;`,
    `    @Column(name = "parent_id")`,
    `    private String parentId;`,
    ``,
    `    protected AuditRecord() {`,
    `    }`,
    ``,
    `    public AuditRecord(String auditId, String operationId, String action, String targetType,`,
    `            String targetId, Object actor, Object before, Object after, OffsetDateTime at,`,
    `            String status, String correlationId, String scopeId, String parentId) {`,
    `        this.auditId = auditId;`,
    `        this.operationId = operationId;`,
    `        this.action = action;`,
    `        this.targetType = targetType;`,
    `        this.targetId = targetId;`,
    `        this.actor = actor;`,
    `        this.before = before;`,
    `        this.after = after;`,
    `        this.at = at;`,
    `        this.status = status;`,
    `        this.correlationId = correlationId;`,
    `        this.scopeId = scopeId;`,
    `        this.parentId = parentId;`,
    `    }`,
    ``,
    `    public String auditId() {`,
    `        return auditId;`,
    `    }`,
    `}`,
    ``,
  );
}

/** Spring Data port for the audit table — the application service persists
 *  the record through `save` inside its own @Transactional method, so the
 *  audit row commits with the aggregate's state change. */
export function renderAuditRecordRepository(basePkg: string): string {
  return lines(
    `package ${basePkg}.infrastructure.persistence;`,
    ``,
    `import org.springframework.data.jpa.repository.JpaRepository;`,
    ``,
    `/** The append-only audit history port.  The application service persists`,
    ` *  the record through this inside its own @Transactional method, so the`,
    ` *  audit row commits in the same transaction as the aggregate save. */`,
    `public interface AuditRecordRepository extends JpaRepository<AuditRecord, String> {`,
    `}`,
    ``,
  );
}

// A Flyway version far above any module migration so this DDL sorts last
// (parity with the provenance migration's `29991231235959`).  `.8` keeps it
// distinct from the `.9` provenance migration in Flyway's `V<v>.<n>__` scheme.
const AUDIT_MIGRATION_VERSION = "29991231235959";

/** Emit the late Flyway migration creating `audit_records` when any context
 *  has an `audited` public operation.  No-op otherwise (keeps non-audit
 *  projects byte-identical). */
export function emitJavaAuditMigration(
  contexts: EnrichedBoundedContextIR[],
  out: Map<string, string>,
): void {
  if (!contextsHaveAudit(contexts)) return;
  const sql = lines(
    `-- Auto-generated by Loom — per-operation audit DDL (audit-and-logging.md).`,
    `-- Late migration: sorts after every module migration.  Feature-local —`,
    `-- not part of MigrationsIR; the Postgres DDL is byte-shared with the other`,
    `-- backends.`,
    ``,
    `CREATE TABLE IF NOT EXISTS audit_records (`,
    `  audit_id text PRIMARY KEY,`,
    `  operation_id text NOT NULL,`,
    `  action text NOT NULL,`,
    `  target_type text NOT NULL,`,
    `  target_id text NOT NULL,`,
    `  actor jsonb,`,
    `  before jsonb NOT NULL,`,
    `  after jsonb NOT NULL,`,
    `  at timestamptz NOT NULL,`,
    `  status text NOT NULL,`,
    `  correlation_id text,`,
    `  scope_id text,`,
    `  parent_id text`,
    `);`,
    ``,
    `CREATE INDEX IF NOT EXISTS audit_records_target_idx ON audit_records (target_type, target_id);`,
    `CREATE INDEX IF NOT EXISTS audit_records_correlation_idx ON audit_records (correlation_id);`,
    ``,
  );
  out.set(`src/main/resources/db/migration/V${AUDIT_MIGRATION_VERSION}.8__Audit.sql`, sql);
}
