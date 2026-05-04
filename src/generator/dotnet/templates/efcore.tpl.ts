import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  FieldIR,
} from "../../../ir/loom-ir.js";
import { pascal, plural, snake } from "../../../util/naming.js";
import { lines } from "../../../util/code-builder.js";

// AppDbContext + per-aggregate IEntityTypeConfiguration<T>.  The
// configuration walks each aggregate's fields/contains and emits the
// matching `HasConversion` / `OwnsOne` / `OwnsMany` calls.

export function renderDbContext(ctx: BoundedContextIR, ns: string): string {
  const aggUsings = ctx.aggregates.map(
    (a) => `using ${ns}.Domain.${plural(a.name)};`,
  );
  const dbSets = ctx.aggregates.map(
    (a) => `    public DbSet<${a.name}> ${plural(pascal(a.name))} => Set<${a.name}>();`,
  );
  const applyConfigs = ctx.aggregates.map(
    (a) =>
      `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}Configuration());`,
  );
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      ...aggUsings,
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AppDbContext : DbContext",
      "{",
      "    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }",
      "",
      ...dbSets,
      "    protected override void OnModelCreating(ModelBuilder modelBuilder)",
      "    {",
      ...applyConfigs,
      "    }",
      "}",
    ) + "\n"
  );
}

export function renderConfiguration(agg: AggregateIR, ns: string): string {
  const fieldConfigs = agg.fields.flatMap((f) => fieldConfigLines(f, "        ", "b"));
  const containmentLines = agg.contains.flatMap((c) =>
    containmentConfigLines(c, agg),
  );
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      `public sealed class ${agg.name}Configuration : IEntityTypeConfiguration<${agg.name}>`,
      "{",
      `    public void Configure(EntityTypeBuilder<${agg.name}> b)`,
      "    {",
      `        b.ToTable("${snake(plural(agg.name))}");`,
      "        b.HasKey(x => x.Id);",
      `        b.Property(x => x.Id).HasConversion(v => v.Value, v => new ${agg.name}Id(v));`,
      ...fieldConfigs,
      ...containmentLines,
      "        b.Ignore(x => x.DomainEvents);",
      "    }",
      "}",
    ) + "\n"
  );
}

function fieldConfigLines(
  f: FieldIR,
  indent: string,
  builder: string,
): string[] {
  if (f.type.kind === "id") {
    return [
      `${indent}${builder}.Property(x => x.${pascal(f.name)}).HasConversion(v => v.Value, v => new ${f.type.targetName}Id(v));`,
    ];
  }
  if (f.type.kind === "enum") {
    return [
      `${indent}${builder}.Property(x => x.${pascal(f.name)}).HasConversion<string>();`,
    ];
  }
  if (f.type.kind === "valueobject") {
    return [`${indent}${builder}.OwnsOne<${f.type.name}>(x => x.${pascal(f.name)});`];
  }
  return [];
}

function containmentConfigLines(
  c: ContainmentIR,
  agg: AggregateIR,
): string[] {
  if (!c.collection) {
    return [`        b.OwnsOne<${c.partName}>(x => x.${pascal(c.name)});`];
  }
  const part = agg.parts.find((p) => p.name === c.partName);
  const partFields = part?.fields ?? [];
  const partFieldLines = partFields.flatMap((f) =>
    fieldConfigLines(f, "            ", "o"),
  );
  return [
    "        // Ignore the public read-accessor and tell EF to map the",
    "        // private backing field instead.",
    `        b.Ignore(x => x.${pascal(c.name)});`,
    `        b.OwnsMany<${c.partName}>("_${c.name}", o => {`,
    `            o.ToTable("${snake(plural(c.partName))}");`,
    '            o.WithOwner().HasForeignKey("ParentId");',
    "            o.HasKey(x => x.Id);",
    `            o.Property(x => x.Id).HasConversion(v => v.Value, v => new ${c.partName}Id(v));`,
    ...partFieldLines,
    "        });",
  ];
}
