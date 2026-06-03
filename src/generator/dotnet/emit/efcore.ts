import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  ContainmentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
} from "../../../ir/types/loom-ir.js";
import { isValueCollectionType, valueCollectionsFor } from "../../../ir/util/value-collections.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";
import { joinDbSetName, joinEntityName } from "./join-entities.js";

// AppDbContext + per-aggregate IEntityTypeConfiguration<T>.  The
// configuration walks each aggregate's fields/contains and emits the
// matching `HasConversion` / `OwnsOne` / `OwnsMany` calls.  Reference
// collections (`Id<T>[]` aggregate fields, populated by enrichment as
// `agg.associations`) get their own per-join-table entity + DbSet +
// IEntityTypeConfiguration; the aggregate config additionally calls
// `b.Ignore(...)` on each reference-collection property so EF doesn't
// try to map the `List<TargetId>` to a column on the root.

/** Every association declared across an entire context's aggregates,
 *  in stable order (matches Drizzle schema emission). */
function contextAssociations(ctx: EnrichedBoundedContextIR): AssociationIR[] {
  return ctx.aggregates.flatMap((a) => a.associations);
}

export function renderDbContext(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  /** Names of document-shaped (`shape(document)`) aggregates in this
   *  context.  Each contributes a `DbSet<<Agg>Document>` + the document
   *  configuration instead of the normalised entity DbSet/config, and
   *  its reference-collection join tables are skipped (they fold into
   *  the JSON document).  Empty / omitted ⇒ byte-identical with the
   *  all-normalised output. */
  documentAggs: ReadonlySet<string> = new Set(),
  /** Names of event-sourced (`persistedAs(eventLog)`) aggregates.  Each
   *  contributes a `DbSet<<Agg>EventRecord>` + the event-record
   *  configuration (the append-only `<agg>_events` stream) instead of the
   *  normalised entity DbSet/config; its reference-collection join tables
   *  are skipped (state lives in the stream).  Empty ⇒ byte-identical. */
  eventSourcedAggs: ReadonlySet<string> = new Set(),
): string {
  const isDoc = (name: string) => documentAggs.has(name);
  const isEs = (name: string) => eventSourcedAggs.has(name);
  // Abstract TPC (`ownTable`) bases own no table — they are excluded from the
  // EF model via `modelBuilder.Ignore<Base>()` so each concrete maps standalone
  // (its own table carrying the inherited base columns flattened), instead of
  // EF folding the hierarchy into TPH/TPC mapping.  They contribute no DbSet
  // and no configuration; the concretes do.
  const entityAggs = ctx.aggregates.filter((a) => !a.isAbstract);
  const abstractBases = ctx.aggregates.filter((a) => a.isAbstract);
  const anyDoc = entityAggs.some((a) => isDoc(a.name));
  const anyEs = entityAggs.some((a) => isEs(a.name));
  const aggUsings = ctx.aggregates.map((a) => `using ${ns}.Domain.${plural(a.name)};`);
  if (anyDoc) aggUsings.push(`using ${ns}.Infrastructure.Persistence.Documents;`);
  if (anyEs) aggUsings.push(`using ${ns}.Infrastructure.Persistence.Events;`);
  const dbSets = entityAggs.map((a) =>
    isEs(a.name)
      ? `    public DbSet<${a.name}EventRecord> ${a.name}Events => Set<${a.name}EventRecord>();`
      : isDoc(a.name)
        ? `    public DbSet<${a.name}Document> ${plural(upperFirst(a.name))} => Set<${a.name}Document>();`
        : `    public DbSet<${a.name}> ${plural(upperFirst(a.name))} => Set<${a.name}>();`,
  );
  const ignoreBases = abstractBases.map((a) => `        modelBuilder.Ignore<${a.name}>();`);
  const applyConfigs = entityAggs.map((a) =>
    isEs(a.name)
      ? `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}EventRecordConfiguration());`
      : isDoc(a.name)
        ? `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}DocumentConfiguration());`
        : `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}Configuration());`,
  );
  // Join-entity DbSets + their ApplyConfiguration entries.  Each
  // reference-collection field on an aggregate produces one join
  // entity (the join table lives outside any single aggregate's
  // configuration so it can serve queries against either side).
  // Document aggregates fold their reference collections into the JSON
  // document — no join table, so drop their associations here.
  const joinAssocs = contextAssociations(ctx).filter(
    (a) => !isDoc(a.ownerAgg) && !isEs(a.ownerAgg),
  );
  const joinUsings =
    joinAssocs.length > 0 ? [`using ${ns}.Infrastructure.Persistence.JoinTables;`] : [];
  const joinDbSets = joinAssocs.map((a) => {
    const cls = joinEntityName(a);
    return `    public DbSet<${cls}> ${joinDbSetName(a)} => Set<${cls}>();`;
  });
  const joinApplyConfigs = joinAssocs.map(
    (a) =>
      `        modelBuilder.ApplyConfiguration(new Configurations.${joinEntityName(a)}Configuration());`,
  );
  // Capability filter installation is per-EntityConfiguration —
  // see `renderConfiguration` below, which emits one
  // `b.HasQueryFilter(...)` per `agg.contextFilters` entry.  No
  // DbContext-level loop, no marker interfaces, no per-capability
  // helper class.  Pre-Phase-3-refactor shape; the grouping
  // infrastructure was removed when stdlib macros were split into
  // level-correct trios (capability behaviour declared at context;
  // state declared at aggregate).
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      ...aggUsings,
      ...joinUsings,
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AppDbContext : DbContext",
      "{",
      "    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }",
      "",
      ...dbSets,
      ...joinDbSets,
      "    protected override void OnModelCreating(ModelBuilder modelBuilder)",
      "    {",
      ...ignoreBases,
      ...applyConfigs,
      ...joinApplyConfigs,
      "    }",
      "}",
    ) + "\n"
  );
}

export function renderConfiguration(
  agg: EnrichedAggregateIR,
  ns: string,
  ctx: BoundedContextIR,
  /** Per-aggregate dataSource config — `schema` flows into a two-arg
   *  `b.ToTable("orders", "tenant_a")`; `tablePrefix` prepends the
   *  snake-case plural ("tenant_a_orders").  Absent today on systems
   *  that don't declare any dataSource bindings — output stays
   *  byte-identical when both fields are undefined. */
  options: { schema?: string; tablePrefix?: string; embedded?: boolean } = {},
): string {
  const voLookup: VoLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  const fieldConfigs = agg.fields.flatMap((f) =>
    fieldConfigLines(f, "        ", "b", voLookup, false, agg.name),
  );
  const containmentLines = agg.contains.flatMap((c) => containmentConfigLines(c, agg, options));
  // Reference-collection (`Id<T>[]`) fields are persisted via a
  // separate join entity (see `join-entities.ts`), so the public
  // `List<TargetId>` accessor on the root must be unmapped — without
  // `b.Ignore(...)` EF Core 8's primitive-collection support pins it
  // as a JSON column on the root row, defeating the relational join.
  const refCollectionIgnores = agg.associations.map(
    (a) => `        b.Ignore(x => x.${upperFirst(a.fieldName)});`,
  );
  // Emit HasIndex for every aggregate-root column referenced by a
  // repository find — same set the Drizzle schema indexes.  Without
  // these, `find byEmail` / `byCustomer` etc. run sequential scans
  // once the table grows past a few hundred rows.
  const indexed = indexedColumnsFor(agg, ctx);
  const indexLines = [...indexed].map(
    (col) => `        b.HasIndex(x => x.${pascalCol(col, agg)});`,
  );
  // Context filters install per-EntityConfiguration: one
  // `b.HasQueryFilter(...)` per propagated predicate.  EF Core's
  // HasQueryFilter is per-entity-type by design — the
  // DbContext-level grouping mechanism Phase 3 introduced was a
  // workaround for a misplaced abstraction.  After splitting stdlib
  // macros into level-correct trios (capability at context, state
  // at aggregate), every filter just lands here regardless of
  // whether the aggregate names a capability via `implements`.
  const filterLines = (agg.contextFilters ?? []).map(
    (predicate) => `        b.HasQueryFilter(x => ${renderCsExpr(predicate, { thisName: "x" })});`,
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
      // dataSource-driven table mapping.  `tablePrefix` lands first
      // (it shifts the local table name); `schema` is the second arg
      // when set so EF Core places the entity in the right Postgres
      // schema.  Both default to undefined → byte-identical with the
      // existing single-arg ToTable on systems without dataSource
      // declarations.
      `        b.ToTable(${renderTableArgs(plural(agg.name), options)});`,
      "        b.HasKey(x => x.Id);",
      `        b.Property(x => x.Id).HasConversion(v => v.Value, v => new ${agg.name}Id(v));`,
      ...fieldConfigs,
      ...containmentLines,
      ...refCollectionIgnores,
      ...indexLines,
      ...filterLines,
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

type VoLookup = ReadonlyMap<string, readonly FieldIR[]>;

function fieldConfigLines(
  f: FieldIR,
  indent: string,
  builder: string,
  voLookup?: VoLookup,
  embedded = false,
  ownerName?: string,
): string[] {
  // Value-object array (`charges: Money[]`): an owned collection mapped to
  // the id-less child table — the migration's `order_charges` (owner FK +
  // `ordinal` + flattened VO columns).  EF maps `List<Money>` into that
  // table rather than inventing a convention-named one.
  if (voLookup && ownerName && !embedded && isValueCollectionType(f.type)) {
    return ownedVoArrayLines(f, ownerName, voLookup, indent, builder);
  }
  if (f.type.kind === "id") {
    return [
      `${indent}${builder}.Property(x => x.${upperFirst(f.name)}).HasConversion(v => v.Value, v => new ${f.type.targetName}Id(v));`,
    ];
  }
  if (f.type.kind === "enum") {
    return [`${indent}${builder}.Property(x => x.${upperFirst(f.name)}).HasConversion<string>();`];
  }
  if (f.type.kind === "valueobject") {
    // Relational root: the value object flattens into the owner table's
    // columns (the migration emits `price_amount`, `price_currency`), so the
    // owned type's columns must be named to match — EF's default
    // (`Price_Amount`) would not line up with the migration.  In the
    // embedded shape the VO rides inside a JSONB blob, so no column names.
    if (voLookup && !embedded) {
      return ownedVoLines(
        f.type.name,
        upperFirst(f.name),
        snake(f.name),
        voLookup,
        indent,
        builder,
      );
    }
    return [`${indent}${builder}.OwnsOne<${f.type.name}>(x => x.${upperFirst(f.name)});`];
  }
  return [];
}

/** Configure an owned value object so its (recursively-flattened) columns
 *  are named to the migration's snake convention (`<prefix>_<field>`),
 *  keeping EF's runtime schema in step with the canonical migration. */
function ownedVoLines(
  voName: string,
  nav: string,
  prefix: string,
  voLookup: VoLookup,
  indent: string,
  builder: string,
): string[] {
  const fields = voLookup.get(voName) ?? [];
  const inner = indent + "    ";
  const body = fields.flatMap((vf) => {
    const col = `${prefix}_${snake(vf.name)}`;
    const base = vf.type.kind === "optional" ? vf.type.inner : vf.type;
    if (base.kind === "valueobject") {
      return ownedVoLines(base.name, upperFirst(vf.name), col, voLookup, inner, "o");
    }
    const sel = `o.Property(x => x.${upperFirst(vf.name)})`;
    if (base.kind === "id") {
      return [
        `${inner}${sel}.HasConversion(v => v.Value, v => new ${base.targetName}Id(v)).HasColumnName("${col}");`,
      ];
    }
    if (base.kind === "enum") {
      return [`${inner}${sel}.HasConversion<string>().HasColumnName("${col}");`];
    }
    return [`${inner}${sel}.HasColumnName("${col}");`];
  });
  return [`${indent}${builder}.OwnsOne<${voName}>(x => x.${nav}, o => {`, ...body, `${indent}});`];
}

/** Map a value-object array field to its id-less child table as an EF owned
 *  collection: FK to the owner, a shadow `ordinal` key column, and the value
 *  object's columns named bare (matching the migration's `order_charges`). */
function ownedVoArrayLines(
  f: FieldIR,
  ownerName: string,
  voLookup: VoLookup,
  indent: string,
  builder: string,
): string[] {
  const vc = valueCollectionsFor({ name: ownerName, fields: [f] })[0];
  if (!vc) return [];
  const inner = indent + "    ";
  const props = (voLookup.get(vc.voName) ?? []).flatMap((vf) => {
    const col = snake(vf.name);
    const base = vf.type.kind === "optional" ? vf.type.inner : vf.type;
    if (base.kind === "valueobject") {
      return ownedVoLines(base.name, upperFirst(vf.name), col, voLookup, inner, "o");
    }
    const sel = `o.Property(x => x.${upperFirst(vf.name)})`;
    if (base.kind === "id") {
      return [
        `${inner}${sel}.HasConversion(v => v.Value, v => new ${base.targetName}Id(v)).HasColumnName("${col}");`,
      ];
    }
    if (base.kind === "enum") {
      return [`${inner}${sel}.HasConversion<string>().HasColumnName("${col}");`];
    }
    return [`${inner}${sel}.HasColumnName("${col}");`];
  });
  return [
    `${indent}${builder}.OwnsMany<${vc.voName}>(x => x.${upperFirst(f.name)}, o => {`,
    `${inner}o.ToTable("${vc.childTable}");`,
    `${inner}o.WithOwner().HasForeignKey("${vc.parentFk}");`,
    `${inner}o.Property<int>("ordinal");`,
    `${inner}o.HasKey("${vc.parentFk}", "ordinal");`,
    ...props,
    `${indent}});`,
  ];
}

function containmentConfigLines(
  c: ContainmentIR,
  agg: AggregateIR,
  options: { schema?: string; tablePrefix?: string; embedded?: boolean } = {},
): string[] {
  const part = agg.parts.find((p) => p.name === c.partName);
  const partFields = part?.fields ?? [];
  // Embedded (`shape(embedded)`) fold: the containment serialises into a
  // single JSONB column on the root via EF owned-types `.ToJson(...)` —
  // no child table.  The nested owned entities need no key/FK/table;
  // `HasConversion` on their id/enum/VO fields still applies inside JSON.
  if (options.embedded) {
    const jsonCol = snake(c.name);
    const partFieldLines = partFields.flatMap((f) => fieldConfigLines(f, "            ", "o"));
    if (!c.collection) {
      return [
        `        b.OwnsOne<${c.partName}>(x => x.${upperFirst(c.name)}, o => {`,
        `            o.ToJson("${jsonCol}");`,
        ...partFieldLines,
        "        });",
      ];
    }
    return [
      `        b.Ignore(x => x.${upperFirst(c.name)});`,
      `        b.OwnsMany<${c.partName}>("_${c.name}", o => {`,
      `            o.ToJson("${jsonCol}");`,
      ...partFieldLines,
      "        });",
    ];
  }
  if (!c.collection) {
    return [`        b.OwnsOne<${c.partName}>(x => x.${upperFirst(c.name)});`];
  }
  const partFieldLines = partFields.flatMap((f) => fieldConfigLines(f, "            ", "o"));
  return [
    "        // Ignore the public read-accessor and tell EF to map the",
    "        // private backing field instead.",
    `        b.Ignore(x => x.${upperFirst(c.name)});`,
    `        b.OwnsMany<${c.partName}>("_${c.name}", o => {`,
    // Containment part tables inherit the aggregate's dataSource
    // schema + prefix — both halves of the parent / part live in
    // the same physical store.
    `            o.ToTable(${renderTableArgs(plural(c.partName), options)});`,
    '            o.WithOwner().HasForeignKey("ParentId");',
    "            o.HasKey(x => x.Id);",
    `            o.Property(x => x.Id).HasConversion(v => v.Value, v => new ${c.partName}Id(v));`,
    ...partFieldLines,
    "        });",
  ];
}

/** Compose the argument list for an EF Core `.ToTable(...)` call.
 *  Pure — does not touch the IR; takes the local table name (caller
 *  already plural-cased it) and the optional `schema` / `tablePrefix`
 *  from a resolved dataSource binding.  Output forms:
 *
 *    no options       → `"orders"`
 *    schema only      → `"orders", "tenant_a"`
 *    tablePrefix only → `"tenant_a_orders"`
 *    both             → `"tenant_a_orders", "shared"`
 *
 *  Byte-identical with the legacy single-arg ToTable when no
 *  options are supplied. */
function renderTableArgs(
  pluralName: string,
  options: { schema?: string; tablePrefix?: string },
): string {
  const baseTable = snake(pluralName);
  const tableName = options.tablePrefix ? `${options.tablePrefix}${baseTable}` : baseTable;
  if (options.schema) {
    return `"${tableName}", "${options.schema}"`;
  }
  return `"${tableName}"`;
}
