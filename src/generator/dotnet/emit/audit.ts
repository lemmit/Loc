import type { EnrichedAggregateIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Per-operation audit runtime — .NET counterpart of the Hono `audit_records`
// table + the audited-route who/what/when + before/after snapshot.  Emitted
// only when a context declares at least one `audited` operation.
//
//   - `AuditRecord` (Infrastructure/Persistence) — the append-only EF row.
//   - `IAuditWriter` (Application/Common) + `AuditWriter`
//     (Infrastructure/Persistence) — stages a record onto the request-scoped
//     AppDbContext WITHOUT calling SaveChanges, so the audited command
//     handler's `_repo.SaveAsync` flushes the audit row in the SAME
//     transaction as the aggregate's state change (atomic — both commit or
//     roll back together, mirroring the Hono transactional route).
// ---------------------------------------------------------------------------

/** The `audited` operations on an aggregate (operations + creates + destroys),
 *  matching the validator's gate set (`validateAuditedOperationSupport`). */
export function auditedOpsOf(agg: EnrichedAggregateIR): OperationIR[] {
  return [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])].filter(
    (o) => o.audited,
  );
}

/** True iff this aggregate has any `audited` public operation — gates the
 *  per-handler audit instrumentation. */
export function aggHasAuditedOp(agg: EnrichedAggregateIR): boolean {
  return agg.operations.some((o) => o.audited && o.visibility === "public");
}

/** The append-only audit POCO (Infrastructure/Persistence/AuditRecord.cs).
 *  Mirrors the Hono `audit_records` Drizzle table column-for-column. */
export function renderAuditRecord(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "/// <summary>One row per successful audited operation, written in the same",
      "/// transaction as the operation's aggregate save (atomic).  before/after are",
      "/// the wire-DTO snapshots either side of the mutation; the record is",
      "/// append-only and never exposed on the operation response.</summary>",
      "public sealed class AuditRecord",
      "{",
      "    public string AuditId { get; set; } = default!;",
      "    public string OperationId { get; set; } = default!;",
      "    public string Action { get; set; } = default!;",
      "    public string TargetType { get; set; } = default!;",
      "    public string TargetId { get; set; } = default!;",
      "    public string? Actor { get; set; }",
      "    public string Before { get; set; } = default!;",
      "    public string After { get; set; } = default!;",
      "    public DateTime At { get; set; }",
      "    public string Status { get; set; } = default!;",
      "    public string? CorrelationId { get; set; }",
      "    public string? ScopeId { get; set; }",
      "}",
    ) + "\n"
  );
}

/** EF configuration for the audit table — snake_case columns, jsonb on the
 *  blob columns, a (target_type, target_id) index matching the Hono schema. */
export function renderAuditRecordConfiguration(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      "public sealed class AuditRecordConfiguration : IEntityTypeConfiguration<AuditRecord>",
      "{",
      "    public void Configure(EntityTypeBuilder<AuditRecord> builder)",
      "    {",
      '        builder.ToTable("audit_records");',
      "        builder.HasKey(x => x.AuditId);",
      '        builder.Property(x => x.AuditId).HasColumnName("audit_id");',
      '        builder.Property(x => x.OperationId).HasColumnName("operation_id");',
      '        builder.Property(x => x.Action).HasColumnName("action");',
      '        builder.Property(x => x.TargetType).HasColumnName("target_type");',
      '        builder.Property(x => x.TargetId).HasColumnName("target_id");',
      '        builder.Property(x => x.Actor).HasColumnName("actor").HasColumnType("jsonb");',
      '        builder.Property(x => x.Before).HasColumnName("before").HasColumnType("jsonb");',
      '        builder.Property(x => x.After).HasColumnName("after").HasColumnType("jsonb");',
      '        builder.Property(x => x.At).HasColumnName("at");',
      '        builder.Property(x => x.Status).HasColumnName("status");',
      '        builder.Property(x => x.CorrelationId).HasColumnName("correlation_id");',
      '        builder.Property(x => x.ScopeId).HasColumnName("scope_id");',
      "        builder.HasIndex(x => new { x.TargetType, x.TargetId });",
      "        builder.HasIndex(x => x.CorrelationId);",
      "    }",
      "}",
    ) + "\n"
  );
}

/** The audit writer — `IAuditWriter` (Application/Common, so handlers depend
 *  on it without reaching into Infrastructure) + `AuditWriter`
 *  (Infrastructure/Persistence, holding the scoped AppDbContext).  `Stage`
 *  only `Add`s the row; the handler's `_repo.SaveAsync` commits it alongside
 *  the aggregate, so the audit trail is atomic with the state change. */
export function renderAuditWriterInterface(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      `using ${ns}.Infrastructure.Persistence;`,
      "",
      `namespace ${ns}.Application.Common;`,
      "",
      "/// <summary>Stages an audit record onto the request-scoped unit of work.",
      "/// The record is flushed by the command handler's repository save, so it",
      "/// commits in the same transaction as the aggregate's state change.</summary>",
      "public interface IAuditWriter",
      "{",
      "    void Stage(AuditRecord record);",
      "}",
    ) + "\n"
  );
}

export function renderAuditWriter(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      `using ${ns}.Application.Common;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AuditWriter : IAuditWriter",
      "{",
      "    private readonly AppDbContext _db;",
      "",
      "    public AuditWriter(AppDbContext db)",
      "    {",
      "        _db = db;",
      "    }",
      "",
      "    // Add only — no SaveChanges.  The command handler's _repo.SaveAsync runs",
      "    // SaveChangesAsync on the same scoped AppDbContext, flushing this row in",
      "    // the aggregate's transaction.",
      "    public void Stage(AuditRecord record) => _db.AuditRecords.Add(record);",
      "}",
    ) + "\n"
  );
}
