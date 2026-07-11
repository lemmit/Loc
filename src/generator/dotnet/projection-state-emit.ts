import type { ProjectionIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { csIdValueClrType } from "./dto-mapping.js";
import { renderCsType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Persisted projection read-model row (.NET / EF Core) — the projection.md
// read half, mirroring the saga-state persistence (`workflow-state-emit.ts`)
// with the command side removed.  A `<Proj>Row` POCO EF-mapped to the
// Flyway-owned read-model table `plural(snake(name))` (DDL derived platform-
// neutrally by `projectionTableShape` in the migrations builder): the
// correlation field is the key, the remaining state fields are columns.
//
// The one shape difference from a saga row: every NON-KEY column is nullable (a
// fold upserts only the fields an event carries, so a row is partial until every
// contributing event arrives).  So each non-key field renders as if
// `optional: true` — a nullable CLR type + no `= default!` seed — matching the
// nullable columns `projectionTableShape` emits.  The DbSet + ApplyConfiguration
// wiring lives in `renderDbContext` (emit/efcore.ts); the fold + read routes in
// `projection-emit.ts`.
// ---------------------------------------------------------------------------

/** The read-model row POCO class name (`OrderBookRow`). */
export function projectionRowClass(proj: ProjectionIR): string {
  return `${upperFirst(proj.name)}Row`;
}

/** The read-model row table name — matches `projectionTableShape`. */
export function projectionRowTable(proj: ProjectionIR): string {
  return plural(snake(proj.name));
}

/** The DbSet property name (`OrderBooks`) the fold + read controller go through. */
export function projectionRowDbSet(proj: ProjectionIR): string {
  return plural(upperFirst(proj.name));
}

/** The nullable CLR type for a non-key column (`OrderStatus?` / `CustomerId?` /
 *  `string?`) — every non-key projection column is nullable (partial upsert). */
function nullableCsType(t: import("../../ir/types/loom-ir.js").TypeIR): string {
  const rendered = renderCsType(t);
  return t.kind === "optional" ? rendered : `${rendered}?`;
}

/** Emit the read-model row POCO + its EF configuration for every projection.
 *  No-op when none — byte-identical for projects without a projection. */
export function emitProjectionRowPersistence(
  projections: readonly ProjectionIR[],
  ns: string,
  out: Map<string, string>,
  /** The projection's owning-context schema for the `ToTable` (projection →
   *  context map-back); undefined → unqualified, byte-identical. */
  resolveProjectionSchema: (proj: ProjectionIR) => string | undefined = () => undefined,
): void {
  for (const proj of projections) {
    out.set(
      `Infrastructure/Persistence/Projections/${projectionRowClass(proj)}.cs`,
      renderProjectionRowEntity(proj, ns),
    );
    out.set(
      `Infrastructure/Persistence/Configurations/${projectionRowClass(proj)}Configuration.cs`,
      renderProjectionRowConfiguration(proj, ns, resolveProjectionSchema(proj)),
    );
  }
}

/** The read-model row POCO: the correlation field (`= default!`) plus every
 *  non-key state field as a NULLABLE public auto-property (the fold writes
 *  `state.<Prop>` via the `thisName: "state"` seam). */
export function renderProjectionRowEntity(proj: ProjectionIR, ns: string): string {
  const corr = proj.correlationField;
  const corrField = proj.stateFields.find((f) => f.name === corr);
  const props: string[] = [];
  // The correlation field is the key (NOT NULL) → non-nullable CLR + `= default!`.
  if (corrField) {
    props.push(
      `    public ${renderCsType(corrField.type)} ${upperFirst(corr)} { get; set; } = default!;`,
    );
  }
  // Every non-key column is nullable → a nullable CLR property (no `= default!`,
  // so no CS8618 for a reference type and NULLs read back cleanly).
  for (const f of proj.stateFields) {
    if (f.name === corr) continue;
    props.push(`    public ${nullableCsType(f.type)} ${upperFirst(f.name)} { get; set; }`);
  }
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Projections;`,
      "",
      `public sealed class ${projectionRowClass(proj)}`,
      "{",
      ...props,
      "}",
    ) + "\n"
  );
}

/** The read-model row's EF configuration — `ToTable` / `HasKey(correlation)` /
 *  per-field `HasConversion` (id / enum), mirroring the saga-state config. */
export function renderProjectionRowConfiguration(
  proj: ProjectionIR,
  ns: string,
  schema?: string,
): string {
  const corr = proj.correlationField;
  const cls = projectionRowClass(proj);
  const toTableArgs = schema
    ? `"${projectionRowTable(proj)}", "${schema}"`
    : `"${projectionRowTable(proj)}"`;
  const fieldConfigs = proj.stateFields.flatMap((f) => {
    const isKey = f.name === corr;
    const leaf = f.type.kind === "optional" ? f.type.inner : f.type;
    if (leaf.kind === "id") {
      const idType = `${leaf.targetName}Id`;
      // The key is NOT NULL → the plain converter; a non-key id column is
      // nullable → the `HasValue`-guarded `Id? ⇆ Provider?` form (an
      // expression-tree lambda can't use `?.`, mirroring the aggregate config).
      const provider = csIdValueClrType(leaf.valueType);
      const conv = isKey
        ? `.HasConversion(v => v.Value, v => new ${idType}(v))`
        : `.HasConversion(v => v.HasValue ? v.Value.Value : (${provider}?)null, v => v.HasValue ? (${idType}?)new ${idType}(v.Value) : (${idType}?)null)`;
      return [`        builder.Property(x => x.${upperFirst(f.name)})${conv};`];
    }
    if (leaf.kind === "enum") {
      // `HasConversion<string>()` maps both a non-null enum and a nullable enum.
      return [`        builder.Property(x => x.${upperFirst(f.name)}).HasConversion<string>();`];
    }
    return [];
  });
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence.Projections;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      `public sealed class ${cls}Configuration : IEntityTypeConfiguration<${cls}>`,
      "{",
      `    public void Configure(EntityTypeBuilder<${cls}> builder)`,
      "    {",
      `        builder.ToTable(${toTableArgs});`,
      `        builder.HasKey(x => x.${upperFirst(corr)});`,
      ...fieldConfigs,
      "    }",
      "}",
    ) + "\n"
  );
}
