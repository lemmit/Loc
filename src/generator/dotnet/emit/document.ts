import type {
  AggregateIR,
  EnrichedAggregateIR,
  EntityPartIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { directParentName } from "../../../ir/util/containment-parent.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { csValueTypeForId, renderCsType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Document-shaped (`shape(document)`) persistence emission for .NET.
//
// A document aggregate's whole read model lives in ONE JSONB column
// instead of a normalised table-per-entity tree.  This module emits
// the three pieces that path needs:
//
//   1. `<Agg>Document`            — the EF persistence record (POCO):
//                                    `(Id, Data jsonb, Version)`.
//   2. `<Agg>DocumentConfiguration` — its IEntityTypeConfiguration<T>.
//   3. `<Agg>Snapshot` + `<Part>Snapshot` records — plain STJ-friendly
//      DTOs the repository (de)serialises into/out of the `Data`
//      column.  They mirror the entity's own C# property types exactly:
//      ID record-structs and value-object records round-trip natively
//      through their constructors under System.Text.Json, so no
//      type translation is needed.  The matching `ToSnapshot()` /
//      `FromSnapshot(...)` mapping methods are emitted ON the entity
//      class (see emit/entity.ts) so they can reach private setters and
//      the `_<containment>` backing lists.
//
// Contained parts fold INTO the document (nested snapshots); cross-
// aggregate references (`X id` / `X id[]`) ride along as ID values in
// the JSON — no join table, no part table.  This is the per-projection
// payoff of `shape(document)` (D-DOCUMENT-AXIS).
// ---------------------------------------------------------------------------

/** Initializer suffix for a snapshot record's `init` property, chosen
 *  so the type satisfies nullable-reference analysis under
 *  `/warnaserror` without forcing the caller to populate it.  Value
 *  types (ID record-structs, enums, numeric / bool / datetime / guid,
 *  `JsonElement`) and nullable references need nothing; non-nullable
 *  reference types do. */
function snapshotInit(t: TypeIR): string {
  switch (t.kind) {
    case "array":
      return " = new();";
    case "primitive":
      return t.name === "string" ? " = default!;" : "";
    case "valueobject":
      return " = default!;";
    case "optional":
      // Nullable reference / value — defaults to null, no warning.
      return "";
    default:
      // id / enum / entity-id — value types under the .NET emit.
      return "";
  }
}

/** The persistence record (POCO) backing one document aggregate.
 *  `Data` holds the serialised aggregate; `Version` is an EF
 *  concurrency token bumped on every save. */
export function renderDocumentPoco(agg: EnrichedAggregateIR, ns: string): string {
  const idType = csValueTypeForId(agg.idValueType);
  const idInit = idType === "string" ? " = default!;" : "";
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      `namespace ${ns}.Infrastructure.Persistence.Documents;`,
      "",
      "/// <summary>Document-shaped persistence record — the whole aggregate",
      `/// read model serialised into one JSONB column (shape(document)).</summary>`,
      `public sealed class ${agg.name}Document`,
      "{",
      `    public ${idType} Id { get; set; }${idInit}`,
      `    public string Data { get; set; } = "{}";`,
      "    public int Version { get; set; }",
      "}",
    ) + "\n"
  );
}

/** EF Core configuration for a document aggregate's persistence
 *  record: jsonb `Data` column + concurrency-token `Version`.  Honours
 *  the same dataSource `schema` / `tablePrefix` knobs the normalised
 *  configuration does. */
export function renderDocumentConfiguration(
  agg: EnrichedAggregateIR,
  ns: string,
  options: { schema?: string; tablePrefix?: string } = {},
): string {
  const baseTable = snake(plural(agg.name));
  const tableName = options.tablePrefix ? `${options.tablePrefix}${baseTable}` : baseTable;
  const tableArgs = options.schema ? `"${tableName}", "${options.schema}"` : `"${tableName}"`;
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      `using ${ns}.Infrastructure.Persistence.Documents;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      `public sealed class ${agg.name}DocumentConfiguration : IEntityTypeConfiguration<${agg.name}Document>`,
      "{",
      `    public void Configure(EntityTypeBuilder<${agg.name}Document> builder)`,
      "    {",
      `        builder.ToTable(${tableArgs});`,
      "        builder.HasKey(x => x.Id);",
      // Map each property to the migration's snake_case column — EF's default
      // is the PascalCase CLR name (`Id`/`Data`/`Version`), which does NOT
      // match the `id`/`data`/`version` DDL → `column c.Id does not exist` on
      // every read/insert.  The key is a plain `Guid` (minted app-side), so no
      // value converter is needed, only the column name + ValueGeneratedNever.
      `        builder.Property(x => x.Id).HasColumnName("id").ValueGeneratedNever();`,
      `        builder.Property(x => x.Data).HasColumnName("data").HasColumnType("jsonb");`,
      `        builder.Property(x => x.Version).HasColumnName("version").IsConcurrencyToken();`,
      "    }",
      "}",
    ) + "\n"
  );
}

/** One snapshot record per entity in the tree (root + each contained
 *  part).  Mirrors the entity's `Id` / `ParentId` / fields / contains
 *  with the SAME C# types the entity exposes, so the `ToSnapshot()` /
 *  `FromSnapshot(...)` methods are plain field copies. */
export function renderSnapshots(agg: EnrichedAggregateIR, ns: string): string {
  const records = [
    snapshotRecord(agg, true, agg.name),
    // A nested part's `ParentId` is branded by its DIRECT parent's id class (a
    // sibling part for a part-in-part), not the aggregate root's — otherwise the
    // snapshot record's `ParentId` type diverges from the entity's own
    // `State.ParentId` / `e.ParentId` (typed by `directParentName` in
    // emit/entity.ts) and the `ToSnapshot()` / `FromSnapshot(...)` field copies
    // fail to compile.  Root-level parts resolve to the root, so single-level
    // output is byte-identical.
    ...agg.parts.map((p) => snapshotRecord(p, false, directParentName(agg, p.name, agg.name))),
  ];
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Collections.Generic;",
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Domain.${plural(agg.name)};`,
      "",
      ...records.flatMap((r, i) => (i === 0 ? r : ["", ...r])),
    ) + "\n"
  );
}

function snapshotRecord(
  entity: AggregateIR | EntityPartIR,
  isRoot: boolean,
  /** The DIRECT parent entity's name — a sibling part for a nested (part-in-part)
   *  part, else the aggregate root.  Brands the part's `ParentId` id class so it
   *  matches the entity's own `State.ParentId`.  Unused for the root record. */
  parentName: string,
): string[] {
  const props: string[] = [];
  props.push(`    public ${entity.name}Id Id { get; init; }`);
  if (!isRoot) props.push(`    public ${parentName}Id ParentId { get; init; }`);
  for (const f of entity.fields) {
    props.push(
      `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; init; }${snapshotInit(f.type)}`,
    );
  }
  for (const c of entity.contains) {
    if (c.collection) {
      props.push(
        `    public List<${c.partName}Snapshot> ${upperFirst(c.name)} { get; init; } = new();`,
      );
    } else {
      props.push(
        `    public ${c.partName}Snapshot ${upperFirst(c.name)} { get; init; } = default!;`,
      );
    }
  }
  return [`public sealed record ${entity.name}Snapshot`, "{", ...props, "}"];
}
