// Auto-generated-code emitter for the .NET event store (appliers A2.2b).
//
// An event-sourced aggregate (`persistedAs(eventLog)`) persists to an
// append-only `<agg>_events` table — the .NET counterpart of the Hono
// Drizzle event stream.  EF maps it through a plain persistence POCO
// (`<Agg>EventRecord`) + an `IEntityTypeConfiguration`; the repository
// (see `repository.ts:renderEventSourcedRepositoryImpl`) folds the stream
// on load and appends events on save.  No Marten — the stream lives on the
// same relational store as every other table (D-DOCUMENT-AXIS rejected a
// dedicated Marten backend).
//
// Column names are spelled snake_case explicitly so the EF entity matches
// the canonical `<agg>_events` migration (the multi-word `stream_id` /
// `occurred_at` wouldn't fold to the migration's names under EF's default
// PascalCase → Postgres case-folding; mirrors the value-object
// `HasColumnName` fix).

import type { EnrichedAggregateIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";

/** The persistence record (POCO) for one event-sourced aggregate's stream.
 *  One row per recorded event, keyed by `(StreamId, Version)`. */
export function renderEventRecordPoco(agg: EnrichedAggregateIR, ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      `namespace ${ns}.Infrastructure.Persistence.Events;`,
      "",
      "/// <summary>Append-only event-stream row backing an event-sourced",
      "/// aggregate (persistedAs(eventLog)).  One row per recorded event,",
      "/// keyed by (StreamId, Version); Data is the JSON event payload.</summary>",
      `public sealed class ${agg.name}EventRecord`,
      "{",
      "    public string StreamId { get; set; } = default!;",
      "    public int Version { get; set; }",
      "    public string Type { get; set; } = default!;",
      '    public string Data { get; set; } = "{}";',
      "    public DateTime OccurredAt { get; set; }",
      "}",
    ) + "\n"
  );
}

/** EF Core configuration for the event-stream table: composite
 *  `(stream_id, version)` key, jsonb `data`, snake_case column names
 *  matching the canonical `<agg>_events` migration. */
export function renderEventRecordConfiguration(agg: EnrichedAggregateIR, ns: string): string {
  const tableName = `${snake(agg.name)}_events`;
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      `using ${ns}.Infrastructure.Persistence.Events;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      `public sealed class ${agg.name}EventRecordConfiguration : IEntityTypeConfiguration<${agg.name}EventRecord>`,
      "{",
      `    public void Configure(EntityTypeBuilder<${agg.name}EventRecord> builder)`,
      "    {",
      `        builder.ToTable("${tableName}");`,
      "        builder.HasKey(x => new { x.StreamId, x.Version });",
      '        builder.Property(x => x.StreamId).HasColumnName("stream_id");',
      '        builder.Property(x => x.Version).HasColumnName("version");',
      '        builder.Property(x => x.Type).HasColumnName("type");',
      '        builder.Property(x => x.Data).HasColumnName("data").HasColumnType("jsonb");',
      '        builder.Property(x => x.OccurredAt).HasColumnName("occurred_at");',
      "    }",
      "}",
    ) + "\n"
  );
}
