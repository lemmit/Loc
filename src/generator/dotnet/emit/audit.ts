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

// NOTE: there is deliberately no `auditedOpsOf` / `aggHasAuditedOp` helper
// here or in the Java / Python siblings.  The real gates are `cqrs-emit.ts` /
// `cqrs/commands.ts` reading `op.audited` inline; a parallel helper nothing
// calls drifts from them (one such copy folded lifecycle actions in and
// skipped the visibility filter) and reads as a shared seam it is not.
/** The append-only audit POCO (Infrastructure/Persistence/AuditRecord.cs).
 *  Mirrors the Hono `audit_records` Drizzle table column-for-column. */
export function renderAuditRecord(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Text.Json.Nodes;",
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
      // Nullable, matching `migrations-builder`: a `create` has no BEFORE
      // state and a `destroy` has no AFTER state.  A non-nullable reference
      // type is REQUIRED by EF convention, so a non-nullable property here made
      // EF build a NOT NULL column that the writer's own null contradicts.
      //
      // `JsonNode?`, not `string?`: the COLUMN is `jsonb` on every backend (one
      // shared definition — `auditTableShape` in `src/system/migrations-builder.ts`),
      // and every other backend binds it as an OBJECT (Python `Mapped[object |
      // None]`, Elixir `:map`, Java `Object`).  A serialized `string` binding
      // made .NET the odd one out: every reader of a snapshot had to parse
      // before it could index into it.  `JsonNode` indexes directly
      // (`node["Field"]`) and — unlike `JsonDocument` — is not `IDisposable`, so
      // holding one on a POCO does not drag CA1001 in under `/warnaserror`.
      "    public JsonNode? Before { get; set; }",
      "    public JsonNode? After { get; set; }",
      "    public DateTime At { get; set; }",
      "    public string Status { get; set; } = default!;",
      "    public string? CorrelationId { get; set; }",
      "    public string? ScopeId { get; set; }",
      "    public string? ParentId { get; set; }",
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
      '        builder.Property(x => x.ParentId).HasColumnName("parent_id");',
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
export function renderAuditWriterInterface(ns: string, usingDapper = false): string {
  return (
    lines(
      "// Auto-generated.",
      `using ${ns}.Infrastructure.Persistence;`,
      usingDapper ? "using System.Collections.Generic;" : null,
      "",
      `namespace ${ns}.Application.Common;`,
      "",
      "/// <summary>Stages an audit record onto the request-scoped unit of work.",
      "/// The record is flushed by the command handler's repository save, so it",
      "/// commits in the same transaction as the aggregate's state change.</summary>",
      "public interface IAuditWriter",
      "{",
      "    void Stage(AuditRecord record);",
      // Dapper has no unit of work to stage onto, so the buffer is explicit and
      // the repository drains it inside its own transaction.  EF's sibling needs
      // no such member — AppDbContext IS the buffer.
      usingDapper ? "" : null,
      usingDapper
        ? "    /// <summary>Take and clear the staged records.  Called by the repository"
        : null,
      usingDapper
        ? "    /// inside its open transaction, so audit rows commit with the state change.</summary>"
        : null,
      usingDapper ? "    IReadOnlyList<AuditRecord> Drain();" : null,
      "}",
    ) + "\n"
  );
}

/** The Dapper `AuditWriter` — a request-scoped buffer.
 *
 *  The EF sibling stages onto `AppDbContext` and lets `SaveChangesAsync` flush
 *  it; with Dapper there is no unit of work, so records accumulate here and the
 *  repository's `SaveAsync` drains them onto its already-open transaction (the
 *  same seam the provenance flush uses).  Atomicity is therefore identical:
 *  audit rows and the aggregate write commit or roll back together. */
export function renderDapperAuditWriter(ns: string): string {
  return (
    lines(
      "// Auto-generated.  Dapper audit staging (persistence: dapper).",
      "using System.Collections.Generic;",
      `using ${ns}.Application.Common;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AuditWriter : IAuditWriter",
      "{",
      "    private readonly List<AuditRecord> _staged = new();",
      "",
      "    public void Stage(AuditRecord record) => _staged.Add(record);",
      "",
      "    public IReadOnlyList<AuditRecord> Drain()",
      "    {",
      "        var drained = _staged.ToArray();",
      "        _staged.Clear();",
      "        return drained;",
      "    }",
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
