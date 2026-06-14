import type { EnrichedBoundedContextIR, FieldIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Provenance runtime — .NET counterpart of the Hono `domain/provenance.ts`
// SDK + the `provenance_records` history table.  Emitted only when a context
// declares at least one `provenanced` field.
//
//   - `ProvLineage` / `ProvTarget` / `ProvInput` (Domain/Common) — the
//     immutable lineage value every write-site builds.  Same JSON shape as
//     the Hono `ProvLineage` (System.Text.Json Web defaults → camelCase
//     `{ snapshotId, target: { type, field }, inputs: [{ path, value }],
//     computedValue }`).
//   - `ProvenanceRecord` (Infrastructure/Persistence) — one append-only EF
//     row per provenanced write, flushed in the aggregate's save transaction.
//
// The per-write capture (the trace buffer + co-located `<field>_provenance`
// column) is emitted by entity.ts / render-stmt.ts / efcore.ts; this module
// owns the shared type + the history POCO/configuration.
// ---------------------------------------------------------------------------

/** A field carrying the `provenanced` modifier (root or part). */
export function provenancedFieldsOf(entity: { fields: FieldIR[] }): FieldIR[] {
  return entity.fields.filter((f) => f.provenanced);
}

/** True iff any aggregate / part in the given contexts declares a
 *  `provenanced` field — gates the shared runtime files + DbSet wiring. */
export function contextsHaveProvenance(contexts: EnrichedBoundedContextIR[]): boolean {
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      if (provenancedFieldsOf(agg).length > 0) return true;
      if (agg.parts.some((p) => provenancedFieldsOf(p).length > 0)) return true;
    }
  }
  return false;
}

/** The shared `ProvLineage` value (Domain/Common/ProvLineage.cs).  Positional
 *  records so System.Text.Json round-trips them with no surface ceremony;
 *  `ProvJson.Options` (Web defaults) is the single options instance the EF
 *  value-converter + the history flush serialise through, keeping the jsonb
 *  column shape identical to the Hono lineage. */
export function renderProvLineage(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System.Collections.Generic;",
      "using System.Text.Json;",
      "",
      `namespace ${ns}.Domain.Common;`,
      "",
      "/// <summary>Resolved aggregate type + field name a provenanced write targets.</summary>",
      "public sealed record ProvTarget(string Type, string Field);",
      "",
      "/// <summary>One leaf input feeding a provenanced write — the source-side path",
      "/// and the value it held when the write ran.  Value is opaque (boxed) so any",
      "/// scalar/value-object round-trips through System.Text.Json verbatim.</summary>",
      "public sealed record ProvInput(string Path, object? Value);",
      "",
      "/// <summary>The lineage of one provenanced write: the rule snapshot it came",
      "/// from, the field it targeted, the inputs that fed it, and the value it",
      "/// produced.  Persisted co-located on the row (current) and appended to the",
      "/// provenance_records history table (every write).</summary>",
      "public sealed record ProvLineage(",
      "    string SnapshotId,",
      "    ProvTarget Target,",
      "    IReadOnlyList<ProvInput> Inputs,",
      "    object? ComputedValue);",
      "",
      "/// <summary>The single System.Text.Json options instance (Web defaults —",
      "/// camelCase) the provenance EF value-converter + history flush serialise",
      "/// through, so the co-located column and the history row share one shape.</summary>",
      "public static class ProvJson",
      "{",
      "    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);",
      "}",
    ) + "\n"
  );
}

/** The append-only history POCO (Infrastructure/Persistence/ProvenanceRecord.cs).
 *  Mirrors the Hono `provenance_records` Drizzle table column-for-column. */
export function renderProvenanceRecord(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "/// <summary>One append-only row per provenanced write, inserted in the same",
      "/// transaction as the aggregate save (atomic).  The current lineage is also",
      "/// stored co-located on the aggregate row's `<field>_provenance` jsonb column;",
      "/// this table is the full per-write history.</summary>",
      "public sealed class ProvenanceRecord",
      "{",
      "    public string TraceId { get; set; } = default!;",
      "    public string SnapshotId { get; set; } = default!;",
      "    public string TargetType { get; set; } = default!;",
      "    public string Field { get; set; } = default!;",
      "    public string Inputs { get; set; } = default!;",
      "    public string? ComputedValue { get; set; }",
      "    public DateTime At { get; set; }",
      "    public string? CorrelationId { get; set; }",
      "    public string? ScopeId { get; set; }",
      "}",
    ) + "\n"
  );
}

/** EF configuration for the history table — snake_case columns, jsonb on the
 *  blob columns, a (target_type, field) index matching the Hono schema. */
export function renderProvenanceRecordConfiguration(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      "public sealed class ProvenanceRecordConfiguration : IEntityTypeConfiguration<ProvenanceRecord>",
      "{",
      "    public void Configure(EntityTypeBuilder<ProvenanceRecord> builder)",
      "    {",
      '        builder.ToTable("provenance_records");',
      "        builder.HasKey(x => x.TraceId);",
      '        builder.Property(x => x.TraceId).HasColumnName("trace_id");',
      '        builder.Property(x => x.SnapshotId).HasColumnName("snapshot_id");',
      '        builder.Property(x => x.TargetType).HasColumnName("target_type");',
      '        builder.Property(x => x.Field).HasColumnName("field");',
      '        builder.Property(x => x.Inputs).HasColumnName("inputs").HasColumnType("jsonb");',
      '        builder.Property(x => x.ComputedValue).HasColumnName("computed_value").HasColumnType("jsonb");',
      '        builder.Property(x => x.At).HasColumnName("at");',
      '        builder.Property(x => x.CorrelationId).HasColumnName("correlation_id");',
      '        builder.Property(x => x.ScopeId).HasColumnName("scope_id");',
      "        builder.HasIndex(x => new { x.TargetType, x.Field });",
      "        builder.HasIndex(x => x.CorrelationId);",
      "    }",
      "}",
    ) + "\n"
  );
}
