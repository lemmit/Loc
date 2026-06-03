import type { AssociationIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Join-entity emission for `Id<T>[]` reference collections.
//
// One C# class + one IEntityTypeConfiguration<JoinEntity> per
// AssociationIR.  The class is a thin row with two strongly-typed Id
// columns + an Ordinal int.  EF tracks it as a plain entity (not a
// navigation target from either aggregate); the repository explicitly
// queries/writes it, mirroring how the TS/Hono generator persists the
// join table via Drizzle.
//
// Naming:
//   joinTable    = "trainer_party"      → class TrainerParty, DbSet TrainerParties
//   ownerFk      = "trainer_id"         → property TrainerId (type TrainerId)
//   targetFk     = "pokemon_id"         → property PokemonId (type PokemonId)
//   ordinal      = "Ordinal"            (always)
// Self-referential collections collapse to ownerFk="owner_id"/targetFk="target_id"
// in enrichment; the property names follow.
// ---------------------------------------------------------------------------

/** C# class name for the join entity — "trainer_party" → "TrainerParty". */
export function joinEntityName(assoc: AssociationIR): string {
  return pascalSnake(assoc.joinTable);
}

/** DbSet property name (pluralised) — "trainer_party" → "TrainerParties". */
export function joinDbSetName(assoc: AssociationIR): string {
  return plural(joinEntityName(assoc));
}

/** C# property name for an FK — "trainer_id" → "TrainerId". */
export function joinFkPropName(fk: string): string {
  return pascalSnake(fk);
}

/** Render the join-entity class file (placed at
 * `Infrastructure/Persistence/JoinTables/<JoinEntityName>.cs`). */
export function renderJoinEntity(assoc: AssociationIR, ns: string): string {
  const className = joinEntityName(assoc);
  const ownerProp = joinFkPropName(assoc.ownerFk);
  const targetProp = joinFkPropName(assoc.targetFk);
  const ownerType = `${assoc.ownerAgg}Id`;
  const targetType = `${assoc.targetAgg}Id`;
  return (
    lines(
      "// Auto-generated.",
      `using ${ns}.Domain.Ids;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.JoinTables;`,
      "",
      `public sealed class ${className}`,
      "{",
      `    public ${ownerType} ${ownerProp} { get; set; }`,
      `    public ${targetType} ${targetProp} { get; set; }`,
      `    public int Ordinal { get; set; }`,
      "",
      `    private ${className}() { ${ownerProp} = default!; ${targetProp} = default!; }`,
      "",
      `    public ${className}(${ownerType} ${camelize(ownerProp)}, ${targetType} ${camelize(targetProp)}, int ordinal)`,
      "    {",
      `        ${ownerProp} = ${camelize(ownerProp)};`,
      `        ${targetProp} = ${camelize(targetProp)};`,
      `        Ordinal = ordinal;`,
      "    }",
      "}",
    ) + "\n"
  );
}

/** Render the EF Core IEntityTypeConfiguration<JoinEntity> file
 * (placed at `Infrastructure/Persistence/Configurations/<JoinEntityName>Configuration.cs`). */
export function renderJoinEntityConfiguration(assoc: AssociationIR, ns: string): string {
  const className = joinEntityName(assoc);
  const ownerProp = joinFkPropName(assoc.ownerFk);
  const targetProp = joinFkPropName(assoc.targetFk);
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Infrastructure.Persistence.JoinTables;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      `public sealed class ${className}Configuration : IEntityTypeConfiguration<${className}>`,
      "{",
      `    public void Configure(EntityTypeBuilder<${className}> builder)`,
      "    {",
      `        builder.ToTable("${assoc.joinTable}");`,
      `        builder.HasKey(x => new { x.${ownerProp}, x.${targetProp} });`,
      `        builder.HasIndex(x => x.${targetProp});`,
      `        builder.Property(x => x.${ownerProp}).HasConversion(v => v.Value, v => new ${assoc.ownerAgg}Id(v));`,
      `        builder.Property(x => x.${targetProp}).HasConversion(v => v.Value, v => new ${assoc.targetAgg}Id(v));`,
      `        builder.Property(x => x.Ordinal).IsRequired();`,
      "    }",
      "}",
    ) + "\n"
  );
}

/** "trainer_party" → "TrainerParty"; "owner_id" → "OwnerId". */
function pascalSnake(s: string): string {
  return s
    .split("_")
    .map((w) => (w.length === 0 ? "" : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}

/** "TrainerId" → "trainerId" (for ctor parameter names). */
function camelize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toLowerCase() + s.slice(1);
}
