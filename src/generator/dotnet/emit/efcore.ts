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
import { isTphBase, ownFieldsOf } from "../../../ir/util/inheritance.js";
import { isValueCollectionType, valueCollectionsFor } from "../../../ir/util/value-collections.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { projectionRowClass, projectionRowDbSet } from "../projection-state-emit.js";
import { renderCsExpr } from "../render-expr.js";
import {
  esEventDbSet,
  esEventRecordClass,
  eventSourcedWorkflows as esWorkflows,
} from "../workflow-eventsourced-emit.js";
import {
  correlationWorkflows,
  workflowStateClass,
  workflowStateDbSet,
} from "../workflow-state-emit.js";
import { joinDbSetName, joinEntityName } from "./join-entities.js";

// AppDbContext + per-aggregate IEntityTypeConfiguration<T>.  The
// configuration walks each aggregate's fields/contains and emits the
// matching `HasConversion` / `OwnsOne` / `OwnsMany` calls.  Reference
// collections (`Id<T>[]` aggregate fields, populated by enrichment as
// `agg.associations`) get their own per-join-table entity + DbSet +
// IEntityTypeConfiguration; the aggregate config additionally calls
// `builder.Ignore(...)` on each reference-collection property so EF doesn't
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
  /** Names of embedded-shaped (`shape(embedded)`) aggregates.  Each is a
   *  queryable root row whose reference-collections fold into a JSONB
   *  column on the row (mapped by `<Agg>Configuration` via a value-
   *  converter), NOT a join table — so its associations are dropped from
   *  the join-entity DbSet/configuration set here.  Empty ⇒ byte-identical. */
  embeddedAggs: ReadonlySet<string> = new Set(),
  /** Transactional outbox (dispatch-delivery-semantics.md): when the
   *  context carries any durable channel (`retention: log | work`), the
   *  AppDbContext maps the shared `__loom_outbox` table (OutboxMessage
   *  entity + configuration).  False ⇒ byte-identical. */
  hasOutbox = false,
  /** Provenance (provenance.md): when the context declares any `provenanced`
   *  field, AppDbContext maps the append-only `provenance_records` history
   *  table (ProvenanceRecord entity + configuration).  False ⇒ byte-identical. */
  hasProvenance = false,
  /** Per-operation audit (audit-and-logging.md): when the context declares any
   *  `audited` operation, AppDbContext maps the append-only `audit_records`
   *  table (AuditRecord entity + configuration).  False ⇒ byte-identical. */
  hasAudit = false,
): string {
  const isDoc = (name: string) => documentAggs.has(name);
  const isEs = (name: string) => eventSourcedAggs.has(name);
  const isEmbedded = (name: string) => embeddedAggs.has(name);
  // Abstract bases split by layout.  A TPC (`ownTable`) base owns no table —
  // it is excluded from the EF model via `modelBuilder.Ignore<Base>()` so each
  // concrete maps standalone (its own table carrying the inherited base columns
  // flattened).  A TPH (`sharedTable`) base, by contrast, IS mapped: it owns the
  // single shared table + `kind` discriminator (configured in its
  // `<Base>Configuration`, via `HasDiscriminator`), so it gets a `DbSet<Base>`
  // (for the polymorphic `find all <Base>` reader) and is NOT ignored.  Its
  // concrete subtypes keep their own `DbSet<Concrete>` (EF auto-filters by
  // discriminator) + an own-fields-only configuration.
  const entityAggs = ctx.aggregates.filter((a) => !a.isAbstract);
  const tphBases = ctx.aggregates.filter((a) => a.isAbstract && isTphBase(a, ctx.aggregates));
  const tpcBases = ctx.aggregates.filter((a) => a.isAbstract && !isTphBase(a, ctx.aggregates));
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
  // The TPH base's polymorphic DbSet — `find all <Base>` queries it and EF
  // returns every concrete in the shared table.
  const tphBaseDbSets = tphBases.map(
    (a) => `    public DbSet<${a.name}> ${plural(upperFirst(a.name))} => Set<${a.name}>();`,
  );
  const ignoreBases = tpcBases.map((a) => `        modelBuilder.Ignore<${a.name}>();`);
  const applyConfigs = entityAggs.map((a) =>
    isEs(a.name)
      ? `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}EventRecordConfiguration());`
      : isDoc(a.name)
        ? `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}DocumentConfiguration());`
        : `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}Configuration());`,
  );
  // The TPH base's configuration owns the shared table + `HasDiscriminator`;
  // apply it FIRST so EF sees the discriminator mapping before the derived
  // concrete configurations refine their own columns.
  const tphBaseConfigs = tphBases.map(
    (a) => `        modelBuilder.ApplyConfiguration(new Configurations.${a.name}Configuration());`,
  );
  // Join-entity DbSets + their ApplyConfiguration entries.  Each
  // reference-collection field on an aggregate produces one join
  // entity (the join table lives outside any single aggregate's
  // configuration so it can serve queries against either side).
  // Document aggregates fold their reference collections into the JSON
  // document — no join table, so drop their associations here.
  const joinAssocs = contextAssociations(ctx).filter(
    (a) => !isDoc(a.ownerAgg) && !isEs(a.ownerAgg) && !isEmbedded(a.ownerAgg),
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
  // Persisted workflow-correlation state (channels.md / workflow-and-applier.md
  // A2-S2): one DbSet + configuration per correlation-bearing workflow, keyed
  // by its correlation field.  Empty (byte-identical) when the context declares
  // no saga.  Requires `using <ns>.Infrastructure.Persistence.Workflows;` for
  // the state POCO type.
  const corrWfs = correlationWorkflows(ctx.workflows);
  const wfStateUsings =
    corrWfs.length > 0 ? [`using ${ns}.Infrastructure.Persistence.Workflows;`] : [];
  const wfStateDbSets = corrWfs.map(
    (wf) =>
      `    public DbSet<${workflowStateClass(wf)}> ${workflowStateDbSet(wf)} => Set<${workflowStateClass(wf)}>();`,
  );
  const wfStateApplyConfigs = corrWfs.map(
    (wf) =>
      `        modelBuilder.ApplyConfiguration(new Configurations.${workflowStateClass(wf)}Configuration());`,
  );
  // Projection read models (projection.md): one DbSet + configuration per
  // projection, keyed by its correlation column, non-key columns nullable.
  // Empty (byte-identical) when the context declares no projection.  The
  // `<Proj>Row` POCO lives in the Persistence.Projections namespace.
  const projRows = ctx.projections ?? [];
  const projRowUsings =
    projRows.length > 0 ? [`using ${ns}.Infrastructure.Persistence.Projections;`] : [];
  const projRowDbSets = projRows.map(
    (p) =>
      `    public DbSet<${projectionRowClass(p)}> ${projectionRowDbSet(p)} => Set<${projectionRowClass(p)}>();`,
  );
  const projRowApplyConfigs = projRows.map(
    (p) =>
      `        modelBuilder.ApplyConfiguration(new Configurations.${projectionRowClass(p)}Configuration());`,
  );
  // Event-sourced workflows (workflow-and-applier.md A2-S5b): each persists as
  // an append-only `<wf>_events` stream — a `DbSet<<Wf>EventRecord>` + its
  // configuration, the saga analogue of the aggregate event store (its
  // `<Wf>EventRecord` POCO shares the Persistence.Events namespace, so the
  // `anyEs` aggregate using already covers it; add it when no ES aggregate did).
  const esWfs = esWorkflows(ctx.workflows);
  const esWfUsings =
    esWfs.length > 0 && !anyEs ? [`using ${ns}.Infrastructure.Persistence.Events;`] : [];
  const wfEventDbSets = esWfs.map(
    (wf) =>
      `    public DbSet<${esEventRecordClass(wf)}> ${esEventDbSet(wf)} => Set<${esEventRecordClass(wf)}>();`,
  );
  const wfEventApplyConfigs = esWfs.map(
    (wf) =>
      `        modelBuilder.ApplyConfiguration(new Configurations.${esEventRecordClass(wf)}Configuration());`,
  );
  const outboxDbSets = hasOutbox
    ? ["    public DbSet<OutboxMessage> LoomOutbox => Set<OutboxMessage>();"]
    : [];
  const outboxApplyConfigs = hasOutbox
    ? ["        modelBuilder.ApplyConfiguration(new OutboxMessageConfiguration());"]
    : [];
  // Provenance history + per-operation audit sinks — append-only tables, one
  // shared per database, mapped when the served contexts use the feature.
  const provenanceDbSets = hasProvenance
    ? ["    public DbSet<ProvenanceRecord> ProvenanceRecords => Set<ProvenanceRecord>();"]
    : [];
  const provenanceApplyConfigs = hasProvenance
    ? [
        "        modelBuilder.ApplyConfiguration(new Configurations.ProvenanceRecordConfiguration());",
      ]
    : [];
  const auditDbSets = hasAudit
    ? ["    public DbSet<AuditRecord> AuditRecords => Set<AuditRecord>();"]
    : [];
  const auditApplyConfigs = hasAudit
    ? ["        modelBuilder.ApplyConfiguration(new Configurations.AuditRecordConfiguration());"]
    : [];
  // Principal-referencing query filters (tenancy) are installed HERE, on the
  // DbContext, not in the stateless per-entity configurations.  An EF query
  // filter that references the STATIC ambient (`RequestContext.Current`) is
  // evaluated once at model build and baked into the cached per-query-shape
  // plan — it does not track the per-request principal, so it fails to isolate
  // (confirmed at runtime).  Referencing the injected scoped
  // `ICurrentUserAccessor` instance field (`_currentUser`) instead makes EF
  // parameterize it and RE-EVALUATE per query execution against this
  // request-scoped context — the standard EF Core multi-tenancy pattern.
  // Principal-free filters (softDelete) stay in the per-entity config.
  // A self-scope registry filter compares the strongly-typed key `x.Id` to the
  // principal claim lifted into `new <Agg>Id(Guid.Parse(claim))`.  EF CANNOT
  // translate a value-converted-key comparison whose right side still holds the
  // `new <Agg>Id(...)` CONSTRUCTOR (it parameterizes only the inner claim access
  // — `new <Agg>Id(@ef_filter__p)` — then fails: "could not be translated",
  // confirmed at runtime).  So the constructed id is HOISTED to a private
  // context member (`this.<member>`), which EF funcletizes whole into a single
  // `<Agg>Id?` query parameter — exactly the shape `GetByIdAsync`'s `x.Id == id`
  // translates.  The member `TryParse`s the claim and yields `null` for a
  // non-guid / claim-less principal, so the filter fails CLOSED (id = NULL → no
  // rows) instead of throwing `FormatException`.
  const principalFilterMembers: string[] = [];
  const principalFilterLines = entityAggs
    .filter((a) => !isDoc(a.name) && !isEs(a.name))
    .flatMap((a) => {
      const names = queryFilterNames(a);
      return (a.contextFilters ?? [])
        .map((predicate, i) => [predicate, i] as const)
        .filter(([predicate]) => exprRefsCurrentUser(predicate))
        .map(([predicate, i]) => {
          let body = renderCsExpr(predicate, {
            thisName: "x",
            currentUserExpr: "_currentUser.User",
            efQuery: true,
          });
          // Hoist a `new <Agg>Id(...)` self-scope construction out of the filter
          // expression (EF can't translate the constructor in-tree).
          const guidCtor = new RegExp(`new ${a.name}Id\\(Guid\\.Parse\\((.+?)\\)\\)`);
          const directCtor = new RegExp(`new ${a.name}Id\\(((?:(?!Guid\\.Parse).)+?)\\)`);
          const guidMatch = body.match(guidCtor);
          const directMatch = guidMatch ? null : body.match(directCtor);
          if (guidMatch || directMatch) {
            const member = `__SelfScopeId_${a.name}_${i}`;
            if (guidMatch) {
              principalFilterMembers.push(
                `    private ${a.name}Id? ${member} => Guid.TryParse(${guidMatch[1]}, out var __g) ? new ${a.name}Id(__g) : (${a.name}Id?)null;`,
              );
              body = body.replace(guidCtor, member);
            } else if (directMatch) {
              principalFilterMembers.push(
                `    private ${a.name}Id? ${member} => new ${a.name}Id(${directMatch[1]});`,
              );
              body = body.replace(directCtor, member);
            }
          }
          return `        modelBuilder.Entity<${a.name}>().HasQueryFilter(${JSON.stringify(names[i])}, x => ${body});`;
        });
    });
  const anyPrincipalFilter = principalFilterLines.length > 0;
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      ...aggUsings,
      ...joinUsings,
      ...wfStateUsings,
      ...projRowUsings,
      ...esWfUsings,
      // The scoped principal accessor the per-request tenancy query filters read,
      // plus the id namespace (a registry self-scope filter constructs an `<Agg>Id`).
      anyPrincipalFilter ? `using ${ns}.Auth;` : null,
      anyPrincipalFilter ? `using ${ns}.Domain.Ids;` : null,
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AppDbContext : DbContext",
      "{",
      // Tenancy query filters resolve the current principal through this
      // injected scoped accessor so EF re-evaluates them per request (see
      // OnModelCreating).  AddDbContext resolves the ctor arg from the app
      // service provider; the context is not pooled, so scoped injection is safe.
      ...(anyPrincipalFilter
        ? [
            "    private readonly ICurrentUserAccessor _currentUser;",
            "",
            "    public AppDbContext(DbContextOptions<AppDbContext> options, ICurrentUserAccessor currentUser) : base(options)",
            "    {",
            "        _currentUser = currentUser;",
            "    }",
          ]
        : ["    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }"]),
      "",
      // Hoisted self-scope registry ids (see principalFilterLines) — private
      // funcletizable members the query filters compare `x.Id` against.
      ...(principalFilterMembers.length > 0 ? [...principalFilterMembers, ""] : []),
      ...dbSets,
      ...tphBaseDbSets,
      ...joinDbSets,
      ...wfStateDbSets,
      ...projRowDbSets,
      ...wfEventDbSets,
      ...outboxDbSets,
      ...provenanceDbSets,
      ...auditDbSets,
      "    protected override void OnModelCreating(ModelBuilder modelBuilder)",
      "    {",
      ...ignoreBases,
      ...tphBaseConfigs,
      ...applyConfigs,
      ...joinApplyConfigs,
      ...wfStateApplyConfigs,
      ...projRowApplyConfigs,
      ...wfEventApplyConfigs,
      ...outboxApplyConfigs,
      ...provenanceApplyConfigs,
      ...auditApplyConfigs,
      // Per-request tenancy filters (after the entities are configured).
      ...principalFilterLines,
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
   *  `builder.ToTable("orders", "tenant_a")`; `tablePrefix` prepends the
   *  snake-case plural ("tenant_a_orders").  Absent today on systems
   *  that don't declare any dataSource bindings — output stays
   *  byte-identical when both fields are undefined. */
  options: {
    schema?: string;
    tablePrefix?: string;
    embedded?: boolean;
    /** TPH (aggregate-inheritance.md, `sharedTable`).  `base`: this aggregate
     *  is the abstract base owning the shared table — emit `ToTable` + `HasKey`
     *  + a `HasDiscriminator<string>("kind")` over `concretes` (value = each
     *  concrete's name, matching the Hono/Drizzle wire).  `concrete`: this is a
     *  subtype sharing the base's table — configure only its OWN columns
     *  (`ownFieldsOf`); `ToTable`/`HasKey`/`Id` are inherited from the base
     *  config, so EF maps the own columns as the shared table's nullable
     *  columns and auto-filters reads by the discriminator. */
    tph?:
      | { role: "base"; concretes: readonly AggregateIR[] }
      | { role: "concrete"; base: AggregateIR };
  } = {},
): string {
  const tph = options.tph;
  const isTphConcreteCfg = tph?.role === "concrete";
  const voLookup: VoLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  // A TPH concrete configures only its OWN columns (the base columns belong to
  // the base config); a base / standalone aggregate configures all its fields.
  const cfgFields = tph?.role === "concrete" ? ownFieldsOf(agg, tph.base) : agg.fields;
  // Reference-collection (`X id[]`) fields are persisted out-of-band — a join
  // table on the relational/TPH path, a JSONB column on the embedded path
  // (see `refCollectionLines` below).  Either way they must NOT flow through
  // the scalar `fieldConfigLines` (whose primitive-collection arm would pin a
  // stray `.Property(x => x.Tags).HasColumnName("tags")` that the join path
  // immediately `.Ignore`s and the embedded path replaces).
  const isRefCollectionField = (f: FieldIR): boolean =>
    f.type.kind === "array" && f.type.element.kind === "id";
  // Optimistic concurrency (`versioned`): the synthetic `version` token field
  // is configured as EF's native concurrency token, so every UPDATE/DELETE
  // guards on the loaded value (`... WHERE id = @id AND version = @orig`) and a
  // stale write raises DbUpdateConcurrencyException → 409.  Gated on
  // `aggregateIsVersioned` — a non-versioned aggregate is byte-identical.
  const versioned = aggregateIsVersioned(agg);
  const fieldConfigs = cfgFields
    .filter((f) => !isRefCollectionField(f))
    .flatMap((f) =>
      fieldConfigLines(
        f,
        "        ",
        "builder",
        voLookup,
        false,
        agg.name,
        versioned && f.name === "version",
      ),
    );
  // Table + key + id-conversion live on the table-owning config: a standalone
  // aggregate or a TPH base.  A TPH concrete inherits all three from the base.
  const tableKeyLines = isTphConcreteCfg
    ? []
    : [
        // dataSource-driven table mapping.  `tablePrefix` lands first (it
        // shifts the local table name); `schema` is the second arg when set.
        // Both default to undefined → byte-identical single-arg `ToTable`.
        `        builder.ToTable(${renderTableArgs(plural(agg.name), options)});`,
        "        builder.HasKey(x => x.Id);",
        `        builder.Property(x => x.Id).HasConversion(v => v.Value, v => new ${agg.name}Id(v)).HasColumnName("id");`,
      ];
  // The TPH base maps the hierarchy: a `kind` discriminator column whose value
  // for each concrete is that concrete's name (the cross-backend contract —
  // see Hono's `emitTphTable` / `discriminatorValue`).
  const discriminatorLines =
    tph?.role === "base"
      ? [
          `        builder.HasDiscriminator<string>("kind")`,
          ...tph.concretes.map(
            (c, i) =>
              `            .HasValue<${c.name}>(${JSON.stringify(c.name)})${i === tph.concretes.length - 1 ? ";" : ""}`,
          ),
        ]
      : [];
  // Containment / join-collection / index / filter config attach to the
  // table-owning, non-inheritance configs.  TPH hierarchies are flat in v1
  // (`contains` on a TPH concrete is gated `loom.tph-contains-unsupported`),
  // so a TPH base/concrete configures scalar columns + the discriminator only.
  const containmentLines = tph
    ? []
    : agg.contains.flatMap((c) => containmentConfigLines(c, agg, options));
  // Reference-collection (`X id[]`) fields persist out-of-band.  Two shapes:
  //
  //   • relational / TPH (default): a separate join entity owns the link, so
  //     the public `List<TargetId>` accessor is `.Ignore`d (else EF Core's
  //     primitive-collection support would pin it as a JSON column AND the
  //     repository's join-sync would double-write).
  //
  //   • embedded (`shape(embedded)`): the migration folds the collection into
  //     a single `<field> JSONB` column on the root row (no join table — the
  //     node backend stores it identically), so we map `List<TargetId>` to
  //     that column via a value-converter that (de)serialises a bare JSON
  //     array of the underlying id values (`["<uuid>", ...]`), matching the
  //     cross-backend wire.  A `ValueComparer` is required for EF to track
  //     the mutable collection.
  const refCollectionLines = tph
    ? []
    : agg.associations.flatMap((a) =>
        options.embedded
          ? embeddedRefCollectionLines(a)
          : [`        builder.Ignore(x => x.${upperFirst(a.fieldName)});`],
      );
  // HasIndex for every root column referenced by a repository find — same set
  // the Drizzle schema indexes; without them `find byEmail` scans sequentially.
  const indexLines = tph
    ? []
    : [...indexedColumnsFor(agg, ctx)].map(
        (col) => `        builder.HasIndex(x => x.${pascalCol(col, agg)});`,
      );
  // Context filters: one NAMED `builder.HasQueryFilter("<Name>", ...)` per
  // propagated predicate (EF Core 10 named query filters — efcore10.md).
  // Pre-EF-10 only ONE filter per entity was allowed; a second
  // `HasQueryFilter(...)` silently OVERWROTE the first, so an aggregate
  // carrying two capability filters (e.g. `softDelete` + a tenancy `filter`)
  // would lose one at runtime.  Naming each filter makes them additive again —
  // every predicate applies — and lets a query selectively bypass a single one
  // via `IgnoreQueryFilters(["<Name>"])` instead of dropping them all.
  const filterNames = queryFilterNames(agg);
  // A capability `filter this.x == currentUser.x` (tenancy) references the
  // principal.  An EF query filter is a STATIC lambda built once in
  // `OnModelCreating`, so it cannot close over a request-scoped `currentUser`
  // local the way an operation body can — resolve it through the same ambient
  // accessor the read side uses (`AMBIENT_CURRENT_USER`), so the whole backend
  // resolves `currentUser` one way (shared with the reified retrieval spec).
  // Principal-referencing capability filters (tenancy `filter this.x ==
  // currentUser.x`) are NOT emitted here.  An EF query filter defined in a
  // stateless IEntityTypeConfiguration cannot reach a per-request principal:
  // referencing the STATIC ambient (`RequestContext.Current`) makes EF evaluate
  // it ONCE at model build and bake it into the cached per-query-shape plan — a
  // stale filter that fails to isolate (confirmed at runtime: a cross-tenant
  // read leak AND empty results for the owner).  Those filters move to
  // `AppDbContext.OnModelCreating` (see `renderDbContext`), where they reference
  // the injected scoped `ICurrentUserAccessor` so EF re-evaluates per request.
  // Only genuinely-static, principal-free filters (e.g. softDelete
  // `!isDeleted`) stay here.
  const filterLines = tph
    ? []
    : (agg.contextFilters ?? [])
        .map((predicate, i) => [predicate, i] as const)
        .filter(([predicate]) => !exprRefsCurrentUser(predicate))
        .map(
          ([predicate, i]) =>
            `        builder.HasQueryFilter(${JSON.stringify(filterNames[i])}, x => ${renderCsExpr(predicate, { thisName: "x", efQuery: true })});`,
        );
  // The config class no longer references the principal (those filters moved to
  // AppDbContext), so it never needs the ambient `RequestContext` import.
  const filterRefsCurrentUser = false;
  // Co-located provenance (provenance.md): each `provenanced` field's
  // `<Field>Provenance` lineage maps to a `<field>_provenance` jsonb column via
  // a System.Text.Json value-converter (ProvJson.Options → the same Web-default
  // shape the history flush serialises).  The CLR property is nullable, so EF
  // stores null verbatim and only runs the converter for a non-null lineage;
  // the `!` on Deserialize keeps the converter warning-clean under /warnaserror.
  const provFields = tph ? [] : agg.fields.filter((f) => f.provenanced);
  const provColumnLines = provFields.map(
    (f) =>
      `        builder.Property(x => x.${upperFirst(f.name)}Provenance).HasColumnName("${snake(f.name)}_provenance").HasColumnType("jsonb")` +
      ".HasConversion(" +
      "v => System.Text.Json.JsonSerializer.Serialize(v, ProvJson.Options), " +
      "v => System.Text.Json.JsonSerializer.Deserialize<ProvLineage>(v, ProvJson.Options)!);",
  );
  // The abstract TPH base carries no `_domainEvents` list (only concrete roots
  // do), so it has nothing to ignore; every other config ignores it.
  const domainEventsIgnore =
    tph?.role === "base" ? [] : ["        builder.Ignore(x => x.DomainEvents);"];
  // The base config references each concrete type in its `HasValue<C>` chain,
  // so it imports every concrete's namespace.
  const concreteUsings =
    tph?.role === "base"
      ? tph.concretes
          .filter((c) => c.name !== agg.name)
          .map((c) => `using ${ns}.Domain.${plural(c.name)};`)
      : [];
  return (
    lines(
      "// Auto-generated.",
      // The embedded ref-collection value-converter uses LINQ (`Select`/
      // `SequenceEqual`/`Aggregate`) over the `List<TargetId>` ⇄ JSON mapping.
      options.embedded && agg.associations.length > 0 ? "using System.Linq;" : null,
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      ...concreteUsings,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      // Provenance lineage type + its shared JSON options for the co-located
      // `<field>_provenance` value-converter.
      provColumnLines.length > 0 || filterRefsCurrentUser ? `using ${ns}.Domain.Common;` : null,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      `public sealed class ${agg.name}Configuration : IEntityTypeConfiguration<${agg.name}>`,
      "{",
      `    public void Configure(EntityTypeBuilder<${agg.name}> builder)`,
      "    {",
      ...tableKeyLines,
      ...fieldConfigs,
      ...provColumnLines,
      ...discriminatorLines,
      ...containmentLines,
      ...refCollectionLines,
      ...indexLines,
      ...filterLines,
      ...domainEventsIgnore,
      "    }",
      "}",
    ) + "\n"
  );
}

/** The underlying CLR type a strongly-typed id wraps, by its value kind —
 *  the type the JSON array of id values (de)serialises as. */
function idValueClrType(vt: AssociationIR["valueType"]): string {
  switch (vt) {
    case "int":
      return "int";
    case "long":
      return "long";
    case "string":
      return "string";
    default:
      return "Guid";
  }
}

/** EF mapping for an EMBEDDED aggregate's reference-collection (`X id[]`):
 *  a `<field> JSONB` column on the root row whose value-converter
 *  (de)serialises `List<TargetId>` ⇄ a bare JSON array of the underlying id
 *  values (`["<uuid>", ...]`), matching the migration's `<field> JSONB` and
 *  the node backend's identical storage.  A `ValueComparer` lets EF track the
 *  mutable list (required for value-converted reference-type collections). */
function embeddedRefCollectionLines(a: AssociationIR): string[] {
  const prop = upperFirst(a.fieldName);
  const idClass = `${a.targetAgg}Id`;
  const inner = idValueClrType(a.valueType);
  const listOfId = `System.Collections.Generic.List<${idClass}>`;
  const listOfInner = `System.Collections.Generic.List<${inner}>`;
  return [
    `        builder.Property(x => x.${prop})`,
    `            .HasColumnName("${snake(a.fieldName)}")`,
    `            .HasColumnType("jsonb")`,
    `            .HasConversion(`,
    `                v => System.Text.Json.JsonSerializer.Serialize(v.Select(__e => __e.Value).ToList(), (System.Text.Json.JsonSerializerOptions?)null),`,
    `                v => System.Text.Json.JsonSerializer.Deserialize<${listOfInner}>(v, (System.Text.Json.JsonSerializerOptions?)null)!.Select(__v => new ${idClass}(__v)).ToList(),`,
    `                new Microsoft.EntityFrameworkCore.ChangeTracking.ValueComparer<${listOfId}>(`,
    `                    (__a, __b) => __a!.SequenceEqual(__b!),`,
    `                    v => v.Aggregate(0, (__acc, __e) => System.HashCode.Combine(__acc, __e.GetHashCode())),`,
    `                    v => v.ToList()));`,
  ];
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

/** The FINAL, disambiguated EF named-query-filter names for an aggregate,
 *  index-aligned with `agg.contextFilters`.  This is the single source of truth
 *  for filter identity: the `OnModelCreating` config emits
 *  `HasQueryFilter("<name>", …)` from it, and the read emitters resolve an
 *  `ignoring <Cap>` clause to the same names via `agg.contextFilterOrigins`
 *  (named-filter-bypass.md §11).  Disambiguation (the rare two-filters-one-name
 *  case) MUST stay in lockstep between the config and the reads, so it lives
 *  here once. */
export function queryFilterNames(agg: AggregateIR): string[] {
  const seen = new Set<string>();
  return (agg.contextFilters ?? []).map((predicate, i) => {
    let name = queryFilterName(predicate, agg.contextFilterRefs?.[i], i);
    if (seen.has(name)) {
      let n = 2;
      while (seen.has(`${name}${n}`)) n++;
      name = `${name}${n}`;
    }
    seen.add(name);
    return name;
  });
}

/** The EF named-filter names an `ignoring` clause bypasses on this aggregate
 *  (named-filter-bypass.md §11).  `bypassAll` → every filter; otherwise the
 *  names whose contributing capability (`agg.contextFilterOrigins[i]`) is in
 *  `bypassCaps`.  Returns [] when nothing matches (a `*` on a filterless
 *  aggregate, or only stamps-only caps named — both already validated). */
export function bypassedFilterNames(
  agg: AggregateIR,
  bypass: { bypassAll?: boolean; bypassCaps?: string[] },
): string[] {
  const names = queryFilterNames(agg);
  if (bypass.bypassAll) return names;
  const caps = new Set(bypass.bypassCaps ?? []);
  if (caps.size === 0) return [];
  const origins = agg.contextFilterOrigins ?? [];
  return names.filter((_, i) => {
    const origin = origins[i];
    return origin != null && caps.has(origin);
  });
}

/** Stable, human-readable name for an EF Core 10 named query filter.
 *  Prefers the criterion's own name when the filter reifies a named
 *  `criterion` (`activeOnly` → `ActiveOnlyFilter`); otherwise derives it
 *  from the single column the predicate touches (`!this.isDeleted` →
 *  `IsDeletedFilter`), falling back to a positional `Filter<n>` when the
 *  predicate spans zero or several columns. */
function queryFilterName(
  predicate: ExprIR,
  ref: { name: string } | undefined,
  index: number,
): string {
  if (ref) return `${upperFirst(ref.name)}Filter`;
  const cols = new Set<string>();
  collectColumnRefs(predicate, cols);
  if (cols.size === 1) {
    const [col] = [...cols];
    return `${upperFirst(col!)}Filter`;
  }
  return `Filter${index + 1}`;
}

/** Does a query-filter predicate reference the `currentUser` principal?
 *  Tenancy filters (`filter this.x == currentUser.x`) do; structural filters
 *  (`softDelete`) don't.  Drives the conditional `Domain.Common` using for the
 *  ambient accessor.  Walks only the expr shapes a capability filter can take. */
function exprRefsCurrentUser(e: ExprIR): boolean {
  switch (e.kind) {
    case "ref":
      return e.refKind === "current-user" || e.name === "currentUser";
    case "member":
      return exprRefsCurrentUser(e.receiver);
    case "binary":
      return exprRefsCurrentUser(e.left) || exprRefsCurrentUser(e.right);
    case "paren":
      return exprRefsCurrentUser(e.inner);
    case "unary":
      return exprRefsCurrentUser(e.operand);
    case "method-call":
      return exprRefsCurrentUser(e.receiver) || e.args.some(exprRefsCurrentUser);
    case "call":
      return e.args.some(exprRefsCurrentUser);
    case "ternary":
      return (
        exprRefsCurrentUser(e.cond) ||
        exprRefsCurrentUser(e.then) ||
        exprRefsCurrentUser(e.otherwise)
      );
    default:
      return false;
  }
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
  /** Mark this (plain-scalar) property as EF's native concurrency token —
   *  set only for the `versioned` capability's synthetic `version` field. */
  concurrencyToken = false,
): string[] {
  // Value-object array (`charges: Money[]`): an owned collection mapped to
  // the id-less child table — the migration's `order_charges` (owner FK +
  // `ordinal` + flattened VO columns).  EF maps `List<Money>` into that
  // table rather than inventing a convention-named one.
  if (voLookup && ownerName && !embedded && isValueCollectionType(f.type)) {
    return ownedVoArrayLines(f, ownerName, voLookup, indent, builder);
  }
  // Column name = the migration's snake_case (`created_at`, `external_id`).
  // EF's default is the PascalCase CLR property name, which does NOT match
  // the migration DDL → 42703 on every INSERT/SELECT.  Suppressed in the
  // embedded (`ToJson`) shape, where members are JSON keys, not columns.
  const col = snake(f.name);
  const colName = embedded ? "" : `.HasColumnName("${col}")`;
  // A nullable strongly-typed id / enum (`supersededBy: Self id?`) is an
  // `optional` wrapping the id/enum — peel it so the value converter is still
  // emitted.  Without a converter EF can't map `EngineerId?` (throws at model
  // build: "could not be mapped because the database provider does not support
  // this type").
  const isOptional = f.type.kind === "optional";
  const leaf = f.type.kind === "optional" ? f.type.inner : f.type;
  if (leaf.kind === "id") {
    const idType = `${leaf.targetName}Id`;
    // The id is a `readonly record struct`, so `Id?` is `Nullable<Id>` and the
    // plain inline lambdas bind `v` as the nullable type — `v.Value`/`new Id(v)`
    // then don't type-check.  The optional form maps `Id?` ⇆ `Provider?`
    // explicitly, guarding on `HasValue` (an expression-tree lambda can't use
    // the `?.` null-propagating operator — CS8072).
    const provider = idValueClrType(leaf.valueType);
    const conv = isOptional
      ? `.HasConversion(v => v.HasValue ? v.Value.Value : (${provider}?)null, v => v.HasValue ? (${idType}?)new ${idType}(v.Value) : (${idType}?)null)`
      : `.HasConversion(v => v.Value, v => new ${idType}(v))`;
    return [`${indent}${builder}.Property(x => x.${upperFirst(f.name)})${conv}${colName};`];
  }
  if (leaf.kind === "enum") {
    return [
      `${indent}${builder}.Property(x => x.${upperFirst(f.name)}).HasConversion<string>()${colName};`,
    ];
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
  // Plain scalar (string / int / bool / datetime / decimal / primitive
  // collection): EF needs an explicit column-name mapping to the migration's
  // snake_case, otherwise it defaults to the PascalCase property name.  In the
  // embedded shape the field is a JSON key, so emit nothing (the default).
  if (embedded) return [];
  const tokenSuffix = concurrencyToken ? ".IsConcurrencyToken()" : "";
  return [
    `${indent}${builder}.Property(x => x.${upperFirst(f.name)}).HasColumnName("${col}")${tokenSuffix};`,
  ];
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
    // embedded=true: members are JSON keys inside the ToJson document, not
    // table columns, so HasColumnName must not be emitted here.
    const partFieldLines = partFields.flatMap((f) =>
      fieldConfigLines(f, "            ", "o", undefined, true),
    );
    if (!c.collection) {
      return [
        `        builder.OwnsOne<${c.partName}>(x => x.${upperFirst(c.name)}, o => {`,
        `            o.ToJson("${jsonCol}");`,
        ...partFieldLines,
        "        });",
      ];
    }
    return [
      `        builder.Ignore(x => x.${upperFirst(c.name)});`,
      `        builder.OwnsMany<${c.partName}>("_${c.name}", o => {`,
      `            o.ToJson("${jsonCol}");`,
      ...partFieldLines,
      "        });",
    ];
  }
  if (!c.collection) {
    return [`        builder.OwnsOne<${c.partName}>(x => x.${upperFirst(c.name)});`];
  }
  const partFieldLines = partFields.flatMap((f) => fieldConfigLines(f, "            ", "o"));
  return [
    "        // Ignore the public read-accessor and tell EF to map the",
    "        // private backing field instead.",
    `        builder.Ignore(x => x.${upperFirst(c.name)});`,
    `        builder.OwnsMany<${c.partName}>("_${c.name}", o => {`,
    // Containment part tables inherit the aggregate's dataSource
    // schema + prefix — both halves of the parent / part live in
    // the same physical store.
    `            o.ToTable(${renderTableArgs(plural(c.partName), options)});`,
    '            o.WithOwner().HasForeignKey("ParentId");',
    // The owner FK column is the migration's `<owner>_id` (tableForPart in
    // migrations-builder), not EF's default `ParentId` — map the shadow
    // property's column so the child INSERT/SELECT lines up with the DDL.
    `            o.Property("ParentId").HasColumnName("${snake(agg.name)}_id");`,
    "            o.HasKey(x => x.Id);",
    `            o.Property(x => x.Id).HasConversion(v => v.Value, v => new ${c.partName}Id(v)).HasColumnName("id");`,
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
