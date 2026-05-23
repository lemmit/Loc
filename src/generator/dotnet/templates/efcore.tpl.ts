import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  ExprIR,
  FieldIR,
} from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";

// AppDbContext + per-aggregate IEntityTypeConfiguration<T>.  The
// configuration walks each aggregate's fields/contains and emits the
// matching `HasConversion` / `OwnsOne` / `OwnsMany` calls.

export function renderDbContext(ctx: BoundedContextIR, ns: string): string {
  const aggUsings = ctx.aggregates.map((a) => `using ${ns}.Domain.${plural(a.name)};`);
  const dbSets = ctx.aggregates.map(
    (a) => `    public DbSet<${a.name}> ${plural(upperFirst(a.name))} => Set<${a.name}>();`,
  );
  const applyConfigs = ctx.aggregates.map(
    (a) => `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}Configuration());`,
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

export function renderConfiguration(agg: AggregateIR, ns: string, ctx: BoundedContextIR): string {
  const fieldConfigs = agg.fields.flatMap((f) => fieldConfigLines(f, "        ", "b"));
  const containmentLines = agg.contains.flatMap((c) => containmentConfigLines(c, agg));
  // Emit HasIndex for every aggregate-root column referenced by a
  // repository find — same set the Drizzle schema indexes.  Without
  // these, `find byEmail` / `byCustomer` etc. run sequential scans
  // once the table grows past a few hundred rows.
  const indexed = indexedColumnsFor(agg, ctx);
  const indexLines = [...indexed].map(
    (col) => `        b.HasIndex(x => x.${pascalCol(col, agg)});`,
  );
  // Soft-delete: when the macro flag is present, install a global
  // query filter that excludes rows where the chosen flag column
  // is true.  The macro carries the user's field name (default
  // "isDeleted"), so backends honour the project's chosen schema
  // convention.  Together with the macro-emitted ISoftDeletable
  // marker interface and the `softDelete()` / `restore()`
  // operations, this gives "soft delete" full runtime semantics
  // without any per-aggregate boilerplate.
  const softDeleteLines = agg.flags?.softDelete
    ? [
        `        b.HasQueryFilter(x => !x.${pascalCol(agg.flags.softDelete.field, agg)});`,
      ]
    : [];
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
      ...indexLines,
      ...softDeleteLines,
      "        b.Ignore(x => x.DomainEvents);",
      "    }",
      "}",
    ) + "\n"
  );
}

/** Aggregate-root columns referenced by any of this aggregate's
 * repository finds — either explicitly via `where this.<col>` or
 * implicitly via convention-based parameter-name matching. */
function indexedColumnsFor(agg: AggregateIR, ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
  if (!repo) return out;
  for (const find of repo.finds) {
    if (find.filter) {
      collectColumnRefs(find.filter, out);
    } else {
      for (const p of find.params) {
        const matched = agg.fields.find(
          (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
        );
        if (matched) out.add(matched.name);
      }
    }
  }
  return out;
}

function collectColumnRefs(e: ExprIR, out: Set<string>): void {
  switch (e.kind) {
    case "binary":
      collectColumnRefs(e.left, out);
      collectColumnRefs(e.right, out);
      return;
    case "paren":
      collectColumnRefs(e.inner, out);
      return;
    case "unary":
      collectColumnRefs(e.operand, out);
      return;
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop") {
        out.add(e.name);
      }
      return;
    case "member":
      if (e.receiver.kind === "this") {
        out.add(e.member);
      }
      return;
    default:
      return;
  }
}

/** EF Core's HasIndex takes a property selector — column names map
 * to PascalCase property names (matching the `upperFirst(...)` casing
 * applied when the property is emitted on the entity class). */
function pascalCol(name: string, _agg: AggregateIR): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function fieldConfigLines(f: FieldIR, indent: string, builder: string): string[] {
  if (f.type.kind === "id") {
    return [
      `${indent}${builder}.Property(x => x.${upperFirst(f.name)}).HasConversion(v => v.Value, v => new ${f.type.targetName}Id(v));`,
    ];
  }
  if (f.type.kind === "enum") {
    return [`${indent}${builder}.Property(x => x.${upperFirst(f.name)}).HasConversion<string>();`];
  }
  if (f.type.kind === "valueobject") {
    return [`${indent}${builder}.OwnsOne<${f.type.name}>(x => x.${upperFirst(f.name)});`];
  }
  return [];
}

function containmentConfigLines(c: ContainmentIR, agg: AggregateIR): string[] {
  if (!c.collection) {
    return [`        b.OwnsOne<${c.partName}>(x => x.${upperFirst(c.name)});`];
  }
  const part = agg.parts.find((p) => p.name === c.partName);
  const partFields = part?.fields ?? [];
  const partFieldLines = partFields.flatMap((f) => fieldConfigLines(f, "            ", "o"));
  return [
    "        // Ignore the public read-accessor and tell EF to map the",
    "        // private backing field instead.",
    `        b.Ignore(x => x.${upperFirst(c.name)});`,
    `        b.OwnsMany<${c.partName}>("_${c.name}", o => {`,
    `            o.ToTable("${snake(plural(c.partName))}");`,
    '            o.WithOwner().HasForeignKey("ParentId");',
    "            o.HasKey(x => x.Id);",
    `            o.Property(x => x.Id).HasConversion(v => v.Value, v => new ${c.partName}Id(v));`,
    ...partFieldLines,
    "        });",
  ];
}
