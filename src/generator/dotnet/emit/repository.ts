import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  ParamIR,
  RepositoryIR,
  RetrievalIR,
} from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { sortableFields } from "../../../ir/util/sortable-fields.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall } from "../../_obs/render-dotnet.js";
import { unionFindAsOptionalTwin } from "../find-emit.js";
import {
  AMBIENT_CURRENT_USER,
  csValueTypeForId,
  renderCsExpr,
  renderCsType,
} from "../render-expr.js";
import { queryFilterNames } from "./efcore.js";
import { eventDbSetName, eventRecordClass } from "./event-store.js";
import { joinDbSetName, joinEntityName, joinFkPropName } from "./join-entities.js";

// Repository interface (Domain layer) + EF-backed implementation
// (Infrastructure layer).  Both surfaces own a `GetByIdAsync` /
// `SaveAsync` plus one method per DSL `find`.  A find whose `where`
// references `currentUser` gets a trailing
// `User currentUser` parameter that the closure-captured filter
// expression reads from.

export function renderRepositoryInterface(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  retrievals: RetrievalIR[] = [],
  /** The strongly-typed id class this aggregate's key uses.  Defaults to the
   *  aggregate's own `<Agg>Id`; a TPH (`sharedTable`) concrete passes its base's
   *  `<Base>Id` (the shared single-table key it inherits). */
  idClass: string = `${agg.name}Id`,
): string {
  // Union-returning finds (P4c) reach the Domain repository as their optional
  // twin (single-row select returning `Agg?`); the Application query handler
  // owns the union mapping, so the Domain layer never names the Response-side
  // union type.  See `unionFindAsOptionalTwin` in find-emit.ts.
  const finds = (repo?.finds ?? []).map((f) => unionFindAsOptionalTwin(f, agg.name));
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  const anyFindIsPaged = finds.some((f) => pagedReturn(f.returnType));
  const findLines = finds.map((f) => {
    const usesUser = findUsesCurrentUser(f);
    const pageExtra = pagedReturn(f.returnType)
      ? ["int page", "int pageSize", "string sort", "string dir"]
      : [];
    return `    Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser, pageExtra)});`;
  });
  // `Run<Name>Async(args, page?, cancellationToken)` per context retrieval (retrieval.md).
  const retrievalLines = retrievals.map(
    (r) =>
      `    Task<IReadOnlyList<${agg.name}>> Run${upperFirst(r.name)}Async(${renderRetrievalParamsWithCt(r.params)});`,
  );
  return (
    lines(
      "// Auto-generated.",
      `using ${ns}.Domain.Ids;`,
      // An enum-typed find/retrieval param (`ByStatus(status: Status)`) names a
      // `Domain.Enums` type in the interface signature; the concrete repository
      // already imports it unconditionally, so mirror that here.
      `using ${ns}.Domain.Enums;`,
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      // `Domain.Common` carries `Paged<T>` (paged finds) AND `FilterBypass`
      // (the `ignoring`-clause bypass param on every `Run<Name>Async`).
      anyFindIsPaged || retrievals.length > 0 ? `using ${ns}.Domain.Common;` : null,
      "",
      `namespace ${ns}.Domain.${plural(agg.name)};`,
      "",
      `public interface I${agg.name}Repository`,
      "{",
      `    Task<${agg.name}?> GetByIdAsync(${idClass} id, CancellationToken cancellationToken = default);`,
      // Command-load path (authorization Phase 3 P3.1): a write-scope-narrowed
      // GetById the mutation handlers load through.  Only when the aggregate's
      // write scope is narrower than its read scope.
      ...(agg.writeScopeFilter
        ? [
            `    Task<${agg.name}?> GetByIdForWriteAsync(${idClass} id, CancellationToken cancellationToken = default);`,
          ]
        : []),
      `    Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${idClass}> ids, CancellationToken cancellationToken = default);`,
      `    Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default);`,
      // Hard delete — only when the aggregate has a canonical `destroy`
      // (declared or via `crudish`); keeps plain repos unchanged.
      ...(agg.canonicalDestroy
        ? [
            `    Task DeleteAsync(${agg.name} aggregate, CancellationToken cancellationToken = default);`,
          ]
        : []),
      ...findLines,
      ...retrievalLines,
      "}",
    ) + "\n"
  );
}

export function renderRepositoryImpl(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  findBodies: Array<{
    name: string;
    ignoreClause: string;
    filterClause: string;
    projectionClause: string;
  }>,
  options?: {
    /** Extra namespaces find-filter expressions reach into (e.g.
     *  `System.Text.RegularExpressions` when a filter uses
     *  `.matches(...)`).  Spliced into the file's using block. */
    extraUsings?: readonly string[];
    /** True when --trace is in effect — brackets the EF
     *  SaveChangesAsync with tx_begin / tx_commit / tx_rollback. */
    emitTrace?: boolean;
    /** Context retrievals targeting this aggregate + their LINQ body
     *  fragments — emit a `Run<Name>Async` method each. */
    retrievals?: RetrievalIR[];
    retrievalBodies?: Array<{ name: string; whereClause: string; orderByClause: string }>;
    /** Strongly-typed id class for this aggregate's key (default `<Agg>Id`); a
     *  TPH concrete passes its base's `<Base>Id` (the shared inherited key). */
    idClass?: string;
    /** True when this is a `shape(embedded)` aggregate: its reference
     *  collections (`X id[]`) fold into a JSONB column on the root row
     *  (mapped by `<Agg>Configuration` via a value-converter), NOT a join
     *  table — so EF round-trips the `List<TargetId>` property automatically
     *  and the repository emits NO join-table load/save sync (nor the
     *  `JoinTables` using). */
    embedded?: boolean;
  },
): string {
  const emitTrace = !!options?.emitTrace;
  const idClass = options?.idClass ?? `${agg.name}Id`;
  // Union-returning finds (P4c) reach the Domain repository as their optional
  // twin (single-row select returning `Agg?`); the Application query handler
  // owns the union mapping, so the Domain layer never names the Response-side
  // union type.  See `unionFindAsOptionalTwin` in find-emit.ts.
  const finds = (repo?.finds ?? []).map((f) => unionFindAsOptionalTwin(f, agg.name));
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  const setName = plural(upperFirst(agg.name));
  // Embedded aggregates persist their reference collections as a JSONB column
  // on the root (EF maps the `List<TargetId>` property directly), so there are
  // no join tables to load/save — drop the associations for join-sync purposes.
  const associations = options?.embedded ? [] : agg.associations;
  // Reference-collection (`Id<T>[]`) load + save lines.  Each
  // association is a separate `_db.<JoinDbSet>` whose rows are
  // explicitly queried/inserted/deleted by the repository — we don't
  // model the join as an EF navigation, so the patterns mirror the
  // TS/Hono Drizzle implementation line-for-line (see
  // src/generator/typescript/repository-builder.ts).
  const loadByIdLines = buildLoadByIdLines(associations);
  const loadManyByIdsLines = buildLoadManyByIdsLines(agg.name, setName, associations);
  const saveDiffSyncLines = buildSaveDiffSyncLines(associations);
  // Optimistic concurrency (`versioned`): on an UPDATE (the entity is tracked,
  // not freshly added), guard the write on the loaded version — overridden by
  // the client's `If-Match` expected version when supplied (ambient
  // RequestContext, populated by RequestContextMiddleware) — and bump it.  EF's
  // native concurrency token (efcore.ts `IsConcurrencyToken()`) turns that into
  // `UPDATE ... SET version = @next WHERE id = @id AND version = @expected`; a
  // zero-row result raises DbUpdateConcurrencyException, which the
  // DomainExceptionFilter maps to 409.  Not applied to INSERTs (a new row keeps
  // its seeded version).  Empty (byte-identical) for a non-versioned aggregate.
  const versionGuardLines = aggregateIsVersioned(agg)
    ? [
        "        if (entry.State != EntityState.Added && entry.State != EntityState.Detached)",
        "        {",
        "            var __version = entry.Property(x => x.Version);",
        "            var __expected = RequestContext.Current?.ExpectedVersion;",
        "            if (__expected.HasValue) __version.OriginalValue = __expected.Value;",
        "            __version.CurrentValue = __version.OriginalValue + 1;",
        "        }",
      ]
    : [];
  // Provenance flush (provenance.md): drain the per-write lineage buffer and
  // stage one provenance_records row per write.  Added to the same scoped
  // AppDbContext as the aggregate change, BEFORE SaveChangesAsync, so the
  // history commits atomically with the state (the .NET mirror of the Hono
  // transactional `drainProv()` insert).  Empty (byte-identical) when the
  // aggregate has no `provenanced` fields.
  const provFlushLines = agg.fields.some((f) => f.provenanced)
    ? [
        "        var __prov = aggregate.DrainProv();",
        "        foreach (var __lin in __prov)",
        "        {",
        "            _db.ProvenanceRecords.Add(new ProvenanceRecord",
        "            {",
        "                TraceId = Guid.NewGuid().ToString(),",
        "                SnapshotId = __lin.SnapshotId,",
        "                TargetType = __lin.Target.Type,",
        "                Field = __lin.Target.Field,",
        "                Inputs = System.Text.Json.JsonSerializer.Serialize(__lin.Inputs, ProvJson.Options),",
        "                ComputedValue = System.Text.Json.JsonSerializer.Serialize(__lin.ComputedValue, ProvJson.Options),",
        "                At = DateTime.UtcNow,",
        "                CorrelationId = RequestContext.Current?.CorrelationId,",
        "                ScopeId = RequestContext.Current?.ScopeId,",
        "                ActorId = RequestContext.Current?.ActorId,",
        "                ParentId = RequestContext.Current?.ParentId,",
        "            });",
        "        }",
        "        if (__prov.Count > 0)",
        "        {",
        `            ${renderDotnetLogCall("provenanceRecorded", [
          { name: "aggregate", valueExpr: JSON.stringify(agg.name) },
          { name: "count", valueExpr: "__prov.Count" },
        ])}`,
        "        }",
      ]
    : [];
  // Per-find catalog log: `find_executed` (debug) at every method's
  // return.  Mirrors the Hono repo emission so cross-backend log
  // consumers see the same event identity + field set.  Array finds
  // use `result.Count` (IReadOnlyList) or the projection's terminal
  // method's return — we bind to `result` either way.
  const findMethodLines = finds.flatMap((f) => {
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    // `.IgnoreQueryFilters(…)` for an `ignoring` clause (named-filter-bypass.md
    // §11) — installed on the IQueryable BEFORE `.Where(...)`, so the bypassed
    // capability filter(s) never compose into this read.
    const ignore = body?.ignoreClause ?? "";
    const projection = body?.projectionClause ?? ".ToListAsync(cancellationToken)";
    const usesUser = findUsesCurrentUser(f);
    // Paged (P3b): a count query + a `Skip`/`Take` page query (the find's
    // `where` threaded into both), returning the domain `Paged<Agg>`
    // envelope (1-based).  The query handler maps items to response DTOs.
    if (pagedReturn(f.returnType)) {
      // Server-side sort (M-T2.6): map each whitelisted wire key to its CLR
      // (PascalCase) property and order via `EF.Property<object>` (translates to
      // `ORDER BY` server-side).  An unknown key falls through to `Id` (the
      // stable default order); the query record's binding can't inject SQL.
      const sortArms = sortableFields(agg)
        .filter((wf) => wf !== "id")
        .map((wf) => `"${wf}" => "${upperFirst(wf)}"`)
        .join(", ");
      const orderExpr = (asc: boolean): string =>
        `_db.${setName}${ignore}${filter}.${asc ? "OrderBy" : "OrderByDescending"}(e => EF.Property<object>(e, sortColumn))`;
      return [
        `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser, ["int page", "int pageSize", "string sort", "string dir"])})`,
        "    {",
        "        var offset = (page - 1) * pageSize;",
        `        var sortColumn = sort switch { ${sortArms}${sortArms ? ", " : ""}_ => "Id" };`,
        `        var total = await _db.${setName}${ignore}${filter}.CountAsync(cancellationToken);`,
        "        var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;",
        `        var ordered = dir == "desc" ? ${orderExpr(false)} : ${orderExpr(true)};`,
        `        var items = await ordered.Skip(offset).Take(pageSize).ToListAsync(cancellationToken);`,
        `        ${renderDotnetLogCall("findExecuted", [
          { name: "aggregate", valueExpr: `"${agg.name}"` },
          { name: "find", valueExpr: `"${f.name}"` },
          { name: "rows", valueExpr: "items.Count" },
        ])}`,
        `        return new Paged<${agg.name}>(items, page, pageSize, total, totalPages);`,
        "    }",
      ];
    }
    // rows expression depends on the cardinality of the find — the
    // catalog field is just "rows" (an integer count), so map both
    // arrays + singles to a number.
    const isArray = f.returnType.kind === "array";
    const rowsExpr = isArray ? "result.Count" : "result == null ? 0 : 1";
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser)})`,
      "    {",
      `        var result = await _db.${setName}${ignore}${filter}${projection};`,
      `        ${renderDotnetLogCall("findExecuted", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "find", valueExpr: `"${f.name}"` },
        { name: "rows", valueExpr: rowsExpr },
      ])}`,
      "        return result;",
      "    }",
    ];
  });
  // `Run<Name>Async` per context retrieval: where + sort baked in; page
  // applied from the call-site argument.
  //
  // The retrieval's `loadPlan` is a deliberate no-op on EF Core: owned
  // containments map to `OwnsOne`/`OwnsMany` (see efcore.ts), and EF Core
  // *always* materialises owned types with their owner — there is no
  // `.Include` step to gate, and an owned navigation can't be projected
  // away. So `whole(T)` is satisfied for free (every part rides along) and
  // an explicit `loads:` neither widens nor narrows the query. Contrast
  // Phoenix, where relational containments are separate `has_many`s that
  // start `%NotLoaded{}` and the plan drives `prepare build(load:)`. The
  // regression guard in retrieval-emit.test.ts pins that whole and an
  // explicit-`loads` retrieval emit the identical query body here.
  const retrievals = options?.retrievals ?? [];
  // Adapter-side translation of a domain `FilterBypass` (capability names) to
  // this aggregate's EF Core named query filters (audit S7 — the EF filter
  // names never appear on the domain PORT; the adapter owns the mapping).  One
  // `(capability, filterName)` pair per named filter that has a capability
  // origin (a base filter with no origin can only be dropped via `bypass.All`).
  const filterNames = queryFilterNames(agg);
  const filterOrigins = agg.contextFilterOrigins ?? [];
  const bypassPairs = filterNames
    .map((filter, i) => ({ cap: filterOrigins[i], filter }))
    .filter((p): p is { cap: string; filter: string } => p.cap != null);
  const bypassBody = [
    "        if (bypass.All) __q = __q.IgnoreQueryFilters();",
    ...(bypassPairs.length > 0
      ? [
          "        else if (bypass.Capabilities is { Count: > 0 })",
          "        {",
          `            var __ignore = new (string Capability, string Filter)[] { ${bypassPairs
            .map((p) => `(${JSON.stringify(p.cap)}, ${JSON.stringify(p.filter)})`)
            .join(", ")} }`,
          "                .Where(m => bypass.Capabilities.Contains(m.Capability)).Select(m => m.Filter).ToArray();",
          "            if (__ignore.Length > 0) __q = __q.IgnoreQueryFilters(__ignore);",
          "        }",
        ]
      : []),
  ];
  const retrievalMethodLines = retrievals.flatMap((r) => {
    // The retrieval is a reified Ardalis Specification (where + sort, emitted
    // by spec-emit.ts); the method applies it and layers call-site paging.
    const specArgs = r.params.map((p) => p.name).join(", ");
    return [
      `    public async Task<IReadOnlyList<${agg.name}>> Run${upperFirst(r.name)}Async(${renderRetrievalParamsWithCt(r.params)})`,
      "    {",
      // Apply an inline read's `ignoring` clause (named-filter-bypass.md §11)
      // to the base IQueryable BEFORE the spec composes its WHERE/ORDER.  The
      // domain `bypass` (capability names) is translated to EF filter names
      // adapter-side, above.
      `        var __q = _db.${setName}.AsQueryable();`,
      ...bypassBody,
      `        var result = await __q.WithSpecification(new ${upperFirst(r.name)}Spec(${specArgs})).ApplyPaging(page).ToListAsync(cancellationToken);`,
      `        ${renderDotnetLogCall("findExecuted", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "find", valueExpr: `"Run${upperFirst(r.name)}"` },
        { name: "rows", valueExpr: "result.Count" },
      ])}`,
      "        return result;",
      "    }",
    ];
  });
  const extraUsings = (options?.extraUsings ?? []).map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System.Linq;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      ...extraUsings,
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.Extensions.Logging;",
      // `.WithSpecification(...)` for `Run<Name>Async` retrieval methods.
      retrievals.length > 0 ? "using Ardalis.Specification.EntityFrameworkCore;" : null,
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence;`,
      associations.length > 0 ? `using ${ns}.Infrastructure.Persistence.JoinTables;` : null,
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly AppDbContext _db;",
      "    private readonly IDomainEventDispatcher _events;",
      // Per-class ILogger injection — same idiom Phase 8 .NET v1 used
      // for the controllers + DomainExceptionFilter, so the entire
      // generated codebase keeps one logging pattern.
      `    private readonly ILogger<${agg.name}Repository> _log;`,
      "",
      `    public ${agg.name}Repository(AppDbContext db, IDomainEventDispatcher events, ILogger<${agg.name}Repository> log)`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      "        _log = log;",
      "    }",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${idClass} id, CancellationToken cancellationToken = default)`,
      "    {",
      `        var found = await _db.${setName}.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);`,
      // aggregate_loaded (debug) — mirrors the Hono repo emission;
      // `found` is a bool so a downstream filter can grep failed loads
      // by (event="aggregate_loaded", Found=false).
      `        ${renderDotnetLogCall("aggregateLoaded", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "id.Value" },
        { name: "found", valueExpr: "found != null" },
      ])}`,
      ...loadByIdLines,
      "        return found;",
      "    }",
      "",
      // Command-load path (authorization Phase 3 P3.1): a write-scope existence
      // pre-guard (EF applies the read query-filter automatically; the extra
      // predicate narrows to the write scope, which is always ⊆ the read scope),
      // then the ordinary hydrating `GetByIdAsync`.  A row the caller may READ
      // but not WRITE (out of write scope) reads as missing → 404 (no existence
      // leak).  Principal via the ambient accessor (re-read per call, so no
      // stale-plan pitfall of a static EF query filter).  Emitted only when the
      // aggregate carries a `writeScopeFilter`.
      ...(agg.writeScopeFilter
        ? [
            `    public async Task<${agg.name}?> GetByIdForWriteAsync(${idClass} id, CancellationToken cancellationToken = default)`,
            "    {",
            `        var inScope = await _db.${setName}.AnyAsync(x => x.Id == id && (${renderCsExpr(
              agg.writeScopeFilter,
              { thisName: "x", currentUserExpr: AMBIENT_CURRENT_USER, agg },
            )}), cancellationToken);`,
            "        if (!inScope) return null;",
            "        return await GetByIdAsync(id, cancellationToken);",
            "    }",
            "",
          ]
        : []),
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${idClass}> ids, CancellationToken cancellationToken = default)`,
      "    {",
      "        if (ids.Count == 0) return Array.Empty<" + agg.name + ">();",
      ...loadManyByIdsLines,
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      "        var entry = _db.Entry(aggregate);",
      "        if (entry.State == EntityState.Detached)",
      "        {",
      `            _db.${setName}.Add(aggregate);`,
      "        }",
      ...versionGuardLines,
      ...saveDiffSyncLines,
      ...provFlushLines,
      // tx_* (trace) — emitted ONLY under --trace.  EF's SaveChangesAsync
      // runs an implicit transaction; the trio (begin/commit/rollback)
      // brackets it so an operator can correlate a failed save with
      // the catch-throw at the seam.  Trace-off keeps the original
      // one-liner shape.
      ...(emitTrace
        ? [
            `        ${renderDotnetLogCall("txBegin", [
              { name: "aggregate", valueExpr: `"${agg.name}"` },
              { name: "id", valueExpr: "aggregate.Id.Value" },
            ])}`,
            "        try",
            "        {",
            "            await _db.SaveChangesAsync(cancellationToken);",
            `            ${renderDotnetLogCall("txCommit", [
              { name: "aggregate", valueExpr: `"${agg.name}"` },
              { name: "id", valueExpr: "aggregate.Id.Value" },
            ])}`,
            // repository_save (debug) AFTER tx_commit so the line fires
            // only when the underlying save actually committed.
            `            ${renderDotnetLogCall("repositorySave", [
              { name: "aggregate", valueExpr: `"${agg.name}"` },
              { name: "id", valueExpr: "aggregate.Id.Value" },
            ])}`,
            "        }",
            "        catch (Exception __txErr)",
            "        {",
            `            ${renderDotnetLogCall("txRollback", [
              { name: "aggregate", valueExpr: `"${agg.name}"` },
              { name: "id", valueExpr: "aggregate.Id.Value" },
              { name: "error", valueExpr: "__txErr.Message" },
            ])}`,
            "            throw;",
            "        }",
          ]
        : [
            "        await _db.SaveChangesAsync(cancellationToken);",
            // repository_save (debug) after SaveChangesAsync — the EF
            // transaction has committed at this point.  Field set mirrors
            // the Hono emission's (aggregate, id) prefix.
            `        ${renderDotnetLogCall("repositorySave", [
              { name: "aggregate", valueExpr: `"${agg.name}"` },
              { name: "id", valueExpr: "aggregate.Id.Value" },
            ])}`,
          ]),
      "        foreach (var ev in aggregate.PullEvents())",
      "        {",
      // event_dispatched (info) per drained event.  `ev.GetType().Name`
      // gives the concrete DomainEvent subclass name — same identity
      // the Hono dispatcher emits via (event as object).constructor.name.
      `            ${renderDotnetLogCall("eventDispatched", [
        { name: "event_type", valueExpr: "ev.GetType().Name" },
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "aggregate.Id.Value" },
      ])}`,
      "            await _events.DispatchAsync(ev, cancellationToken);",
      "        }",
      "    }",
      // Hard delete — gated on a canonical `destroy`.  `Remove` + Save;
      // containment children and join-table rows drop via the schema's
      // ON DELETE CASCADE FKs (mirrors the Hono Drizzle delete).
      ...(agg.canonicalDestroy
        ? [
            "",
            `    public async Task DeleteAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
            "    {",
            `        _db.${setName}.Remove(aggregate);`,
            "        await _db.SaveChangesAsync(cancellationToken);",
            "    }",
          ]
        : []),
      ...findMethodLines,
      ...retrievalMethodLines,
      "}",
    ) + "\n"
  );
}

/** Inline per-association load inside `GetByIdAsync`, executed after
 * the root row materialises but before `return found`.  Skipped when
 * the aggregate has no reference collections (the `if` block stays
 * empty, no lines emitted). */
function buildLoadByIdLines(associations: AssociationIR[]): string[] {
  if (associations.length === 0) return [];
  const out: string[] = [];
  out.push("        if (found != null)");
  out.push("        {");
  for (const a of associations) {
    const dbSet = joinDbSetName(a);
    const owner = joinFkPropName(a.ownerFk);
    const target = joinFkPropName(a.targetFk);
    const prop = upperFirst(a.fieldName);
    out.push(`            found.${prop} = await _db.${dbSet}`);
    out.push(`                .Where(j => j.${owner} == id)`);
    out.push(`                .OrderBy(j => j.${target})`);
    out.push(`                .Select(j => j.${target})`);
    out.push(`                .ToListAsync(cancellationToken);`);
  }
  out.push("        }");
  return out;
}

/** `FindManyByIdsAsync` body — when no associations, falls back to the
 * single-line `return await ...` shape.  When associations exist,
 * loads roots into a list, bulk-loads each join table grouped by
 * owner, and hydrates each root's reference collections. */
function buildLoadManyByIdsLines(
  aggName: string,
  setName: string,
  associations: AssociationIR[],
): string[] {
  if (associations.length === 0) {
    return [
      `        return await _db.${setName}.Where(x => ids.Contains(x.Id)).ToListAsync(cancellationToken);`,
    ];
  }
  const out: string[] = [];
  out.push(
    `        var roots = await _db.${setName}.Where(x => ids.Contains(x.Id)).ToListAsync(cancellationToken);`,
  );
  out.push("        if (roots.Count == 0) return roots;");
  for (const a of associations) {
    const cap = upperFirst(a.fieldName);
    const dbSet = joinDbSetName(a);
    const owner = joinFkPropName(a.ownerFk);
    const target = joinFkPropName(a.targetFk);
    const ownerType = `${a.ownerAgg}Id`;
    const targetType = `${a.targetAgg}Id`;
    out.push(`        var __${a.fieldName}Rows = await _db.${dbSet}`);
    out.push(`            .Where(j => ids.Contains(j.${owner}))`);
    out.push(`            .OrderBy(j => j.${owner}).ThenBy(j => j.${target})`);
    out.push(`            .Select(j => new { Owner = j.${owner}, Target = j.${target} })`);
    out.push(`            .ToListAsync(cancellationToken);`);
    out.push(`        var __${a.fieldName}ByOwner = __${a.fieldName}Rows`);
    out.push(`            .GroupBy(r => r.Owner)`);
    out.push(`            .ToDictionary(g => g.Key, g => g.Select(r => r.Target).ToList());`);
    out.push("        foreach (var __root in roots)");
    out.push("        {");
    out.push(
      `            __root.${cap} = __${a.fieldName}ByOwner.TryGetValue(__root.Id, out var __${a.fieldName}List) ? __${a.fieldName}List : new List<${targetType}>();`,
    );
    out.push("        }");
    void ownerType;
    void aggName;
  }
  out.push("        return roots;");
  return out;
}

/** Diff-sync block inside `SaveAsync`, emitted after the
 * detached-check Add and before `SaveChangesAsync`.  For every
 * reference collection on the aggregate: load existing join rows,
 * compare against the current `aggregate.<Prop>` set, delete pairs
 * that are no longer present, and insert new ones.  Set semantics —
 * the wire contract for `Id<T>[]` is a set (membership only, no order),
 * so the join row carries no payload: it's added if missing, left as-is
 * otherwise.  Mirrors the TS Drizzle save diff-sync. */
function buildSaveDiffSyncLines(associations: AssociationIR[]): string[] {
  if (associations.length === 0) return [];
  const out: string[] = [];
  for (const a of associations) {
    const cap = upperFirst(a.fieldName);
    const dbSet = joinDbSetName(a);
    const cls = joinEntityName(a);
    const owner = joinFkPropName(a.ownerFk);
    const target = joinFkPropName(a.targetFk);
    const targetType = `${a.targetAgg}Id`;
    out.push("");
    out.push(`        var __existing${cap} = await _db.${dbSet}`);
    out.push(`            .Where(x => x.${owner} == aggregate.Id).ToListAsync(cancellationToken);`);
    out.push(`        var __current${cap} = aggregate.${cap}.ToList();`);
    out.push(`        var __currentIds${cap} = new HashSet<${targetType}>(__current${cap});`);
    out.push(
      `        foreach (var __stale in __existing${cap}.Where(x => !__currentIds${cap}.Contains(x.${target})).ToList())`,
    );
    out.push("        {");
    out.push(`            _db.${dbSet}.Remove(__stale);`);
    out.push("        }");
    out.push(`        foreach (var __tid in __current${cap})`);
    out.push("        {");
    out.push(`            if (!__existing${cap}.Any(x => x.${target} == __tid))`);
    out.push("            {");
    out.push(`                _db.${dbSet}.Add(new ${cls}(aggregate.Id, __tid));`);
    out.push("            }");
    out.push("        }");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document-shaped (`shape(document)`) repository implementation.
//
// Backed by the `<Agg>Document` persistence record (one JSONB column)
// rather than the normalised entity table.  `GetById` / `FindManyByIds`
// deserialise the `Data` column into the aggregate's snapshot DTO and
// rehydrate via `<Agg>.FromSnapshot(...)`; `Save` serialises
// `aggregate.ToSnapshot()` back, bumping the concurrency `Version`.
//
// Finds evaluate client-side (load all documents → rehydrate → apply
// the LINQ-to-objects predicate) — the document column carries no
// queryable per-field shape in v1.  Reference-collection diff-sync and
// join tables don't apply: those references fold into the document.
// ---------------------------------------------------------------------------
export function renderDocumentRepositoryImpl(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  findBodies: Array<{
    name: string;
    ignoreClause: string;
    filterClause: string;
    projectionClause: string;
  }>,
  options?: { extraUsings?: readonly string[]; idClass?: string },
): string {
  const idClass = options?.idClass ?? `${agg.name}Id`;
  // Union-returning finds (P4c) reach the Domain repository as their optional
  // twin (single-row select returning `Agg?`); the Application query handler
  // owns the union mapping, so the Domain layer never names the Response-side
  // union type.  See `unionFindAsOptionalTwin` in find-emit.ts.
  const finds = (repo?.finds ?? []).map((f) => unionFindAsOptionalTwin(f, agg.name));
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  const setName = plural(upperFirst(agg.name));
  const snap = `${agg.name}Snapshot`;
  const deser = `${agg.name}.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<${snap}>(__d.Data, __json)!)`;
  const findMethodLines = finds.flatMap((f) => {
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    // De-async the EF terminal — finds run in-memory over the rehydrated
    // documents, so the async EF operators become their LINQ-to-objects
    // equivalents.
    const projection = (body?.projectionClause ?? ".ToListAsync(cancellationToken)")
      .replace(".ToListAsync(cancellationToken)", ".ToList()")
      .replace(".FirstOrDefaultAsync(cancellationToken)", ".FirstOrDefault()")
      .replace(".FirstAsync(cancellationToken)", ".First()");
    const usesUser = findUsesCurrentUser(f);
    // Paged-by-default findAll (M-T2.6): the document column carries no
    // queryable per-field shape, so the page is sliced in memory over the
    // rehydrated documents (count + Skip/Take).  Ordering falls back to the
    // stable `Id` key with `dir` — a JSONB blob can't cheaply sort by an
    // arbitrary wire column, so `sort` is accepted (route parity) but not honored.
    if (pagedReturn(f.returnType)) {
      return [
        `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser, ["int page", "int pageSize", "string sort", "string dir"])})`,
        "    {",
        "        _ = sort;",
        `        var __all = (await _db.${setName}.ToListAsync(cancellationToken)).Select(__d => ${deser})${filter}.ToList();`,
        "        var total = __all.Count;",
        "        var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;",
        `        var __ordered = dir == "desc" ? __all.OrderByDescending(x => x.Id.Value) : __all.OrderBy(x => x.Id.Value);`,
        "        var items = __ordered.Skip((page - 1) * pageSize).Take(pageSize).ToList();",
        `        ${renderDotnetLogCall("findExecuted", [
          { name: "aggregate", valueExpr: `"${agg.name}"` },
          { name: "find", valueExpr: `"${f.name}"` },
          { name: "rows", valueExpr: "items.Count" },
        ])}`,
        `        return new Paged<${agg.name}>(items, page, pageSize, total, totalPages);`,
        "    }",
      ];
    }
    const isArray = f.returnType.kind === "array";
    const rowsExpr = isArray ? "result.Count" : "result == null ? 0 : 1";
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser)})`,
      "    {",
      `        var __all = (await _db.${setName}.ToListAsync(cancellationToken)).Select(__d => ${deser});`,
      `        var result = __all${filter}${projection};`,
      `        ${renderDotnetLogCall("findExecuted", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "find", valueExpr: `"${f.name}"` },
        { name: "rows", valueExpr: rowsExpr },
      ])}`,
      "        return result;",
      "    }",
    ];
  });
  const extraUsings = (options?.extraUsings ?? []).map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Linq;",
      "using System.Collections.Generic;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      ...extraUsings,
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.Extensions.Logging;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence;`,
      `using ${ns}.Infrastructure.Persistence.Documents;`,
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly AppDbContext _db;",
      "    private readonly IDomainEventDispatcher _events;",
      `    private readonly ILogger<${agg.name}Repository> _log;`,
      "    private static readonly System.Text.Json.JsonSerializerOptions __json =",
      "        new(System.Text.Json.JsonSerializerDefaults.Web);",
      "",
      `    public ${agg.name}Repository(AppDbContext db, IDomainEventDispatcher events, ILogger<${agg.name}Repository> log)`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      "        _log = log;",
      "    }",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${idClass} id, CancellationToken cancellationToken = default)`,
      "    {",
      `        var __doc = await _db.${setName}.FirstOrDefaultAsync(x => x.Id == id.Value, cancellationToken);`,
      `        ${renderDotnetLogCall("aggregateLoaded", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "id.Value" },
        { name: "found", valueExpr: "__doc != null" },
      ])}`,
      "        if (__doc == null) return null;",
      `        return ${agg.name}.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<${snap}>(__doc.Data, __json)!);`,
      "    }",
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${idClass}> ids, CancellationToken cancellationToken = default)`,
      "    {",
      `        if (ids.Count == 0) return Array.Empty<${agg.name}>();`,
      "        var __raw = ids.Select(i => i.Value).ToList();",
      `        var __docs = await _db.${setName}.Where(x => __raw.Contains(x.Id)).ToListAsync(cancellationToken);`,
      `        return __docs.Select(__d => ${deser}).ToList();`,
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      "        var __data = System.Text.Json.JsonSerializer.Serialize(aggregate.ToSnapshot(), __json);",
      `        var __existing = await _db.${setName}.FirstOrDefaultAsync(x => x.Id == aggregate.Id.Value, cancellationToken);`,
      "        if (__existing == null)",
      "        {",
      `            _db.${setName}.Add(new ${agg.name}Document { Id = aggregate.Id.Value, Data = __data, Version = 1 });`,
      "        }",
      "        else",
      "        {",
      "            __existing.Data = __data;",
      "            __existing.Version += 1;",
      "        }",
      "        await _db.SaveChangesAsync(cancellationToken);",
      `        ${renderDotnetLogCall("repositorySave", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "aggregate.Id.Value" },
      ])}`,
      "        foreach (var ev in aggregate.PullEvents())",
      "        {",
      `            ${renderDotnetLogCall("eventDispatched", [
        { name: "event_type", valueExpr: "ev.GetType().Name" },
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "aggregate.Id.Value" },
      ])}`,
      "            await _events.DispatchAsync(ev, cancellationToken);",
      "        }",
      "    }",
      ...findMethodLines,
      "}",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Event-sourced (`persistedAs(eventLog)`) repository for the .NET/EF backend
// (appliers A2.2b).  The .NET counterpart of the Hono
// `repository-eventsourced-builder.ts`.
//
// The aggregate's truth is its `<agg>_events` stream (an EF entity
// `<Agg>EventRecord`, no state table).  `GetByIdAsync` reads the stream in
// version order and folds it via `<Agg>._FromEvents`; `SaveAsync` appends
// `PullEvents()` with gap-free versions then dispatches; finds load every
// stream, fold each, and filter in-memory (fold-from-zero MVP).  Event
// payloads round-trip through System.Text.Json (Web defaults) — the records
// are STJ-friendly (positional records over id / value-object / enum types).
// ---------------------------------------------------------------------------
export function renderEventSourcedRepositoryImpl(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  findBodies: Array<{
    name: string;
    ignoreClause: string;
    filterClause: string;
    projectionClause: string;
  }>,
  contextName: string,
  options?: { extraUsings?: readonly string[]; idClass?: string },
): string {
  const idClass = options?.idClass ?? `${agg.name}Id`;
  // Union-returning finds (P4c) reach the Domain repository as their optional
  // twin (single-row select returning `Agg?`); the Application query handler
  // owns the union mapping, so the Domain layer never names the Response-side
  // union type.  See `unionFindAsOptionalTwin` in find-emit.ts.
  const finds = (repo?.finds ?? []).map((f) => unionFindAsOptionalTwin(f, agg.name));
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  // The single per-context event log (event-log-architecture.md): the shared
  // `_db.Events` DbSet over the `EventRecord` POCO.  This aggregate's stream is
  // the subset tagged `StreamType == "<Agg>"` — every load/append/fold filters
  // on it so a sibling aggregate/workflow sharing the `<ctx>_events` table is
  // never folded through this aggregate's appliers (the correctness trap).
  const dbSet = eventDbSetName(contextName);
  const streamType = agg.name;
  // The event types this aggregate's stream can contain — the events its
  // appliers fold.  Drives the `RowToEvent` deserialiser dispatch.
  const eventNames = [...new Set((agg.appliers ?? []).map((a) => a.event))];
  const idValue = csValueTypeForId(agg.idValueType);
  const parseId =
    idValue === "Guid"
      ? "Guid.Parse(__kv.Key)"
      : idValue === "int"
        ? "int.Parse(__kv.Key)"
        : idValue === "long"
          ? "long.Parse(__kv.Key)"
          : "__kv.Key";

  const rowToEventArms = eventNames.map(
    (e) =>
      `            "${e}" => System.Text.Json.JsonSerializer.Deserialize<${e}>(__r.Data, __json)!,`,
  );
  const recordCls = eventRecordClass(contextName);

  const findMethodLines = finds.flatMap((f) => {
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    const projection = (body?.projectionClause ?? ".ToListAsync(cancellationToken)")
      .replace(".ToListAsync(cancellationToken)", ".ToList()")
      .replace(".FirstOrDefaultAsync(cancellationToken)", ".FirstOrDefault()")
      .replace(".FirstAsync(cancellationToken)", ".First()");
    const usesUser = findUsesCurrentUser(f);
    const isArray = f.returnType.kind === "array";
    const rowsExpr = isArray ? "result.Count" : "result == null ? 0 : 1";
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser)})`,
      "    {",
      "        var __all = await _LoadAllAsync(cancellationToken);",
      `        var result = __all${filter}${projection};`,
      `        ${renderDotnetLogCall("findExecuted", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "find", valueExpr: `"${f.name}"` },
        { name: "rows", valueExpr: rowsExpr },
      ])}`,
      "        return result;",
      "    }",
    ];
  });

  const extraUsings = (options?.extraUsings ?? []).map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Linq;",
      "using System.Collections.Generic;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      ...extraUsings,
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.Extensions.Logging;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Events;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence;`,
      `using ${ns}.Infrastructure.Persistence.Events;`,
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly AppDbContext _db;",
      "    private readonly IDomainEventDispatcher _events;",
      `    private readonly ILogger<${agg.name}Repository> _log;`,
      "    private static readonly System.Text.Json.JsonSerializerOptions __json =",
      "        new(System.Text.Json.JsonSerializerDefaults.Web);",
      "",
      `    public ${agg.name}Repository(AppDbContext db, IDomainEventDispatcher events, ILogger<${agg.name}Repository> log)`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      "        _log = log;",
      "    }",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${idClass} id, CancellationToken cancellationToken = default)`,
      "    {",
      "        var __sid = id.Value.ToString();",
      `        var __rows = await _db.${dbSet}.Where(e => e.StreamType == "${streamType}" && e.StreamId == __sid).OrderBy(e => e.Version).ToListAsync(cancellationToken);`,
      `        ${renderDotnetLogCall("aggregateLoaded", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "id.Value" },
        { name: "found", valueExpr: "__rows.Count > 0" },
      ])}`,
      "        if (__rows.Count == 0) return null;",
      `        return ${agg.name}._FromEvents(id, __rows.Select(RowToEvent).ToList());`,
      "    }",
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${idClass}> ids, CancellationToken cancellationToken = default)`,
      "    {",
      `        if (ids.Count == 0) return Array.Empty<${agg.name}>();`,
      `        var __out = new List<${agg.name}>();`,
      "        foreach (var __id in ids)",
      "        {",
      "            var __a = await GetByIdAsync(__id, cancellationToken);",
      "            if (__a != null) __out.Add(__a);",
      "        }",
      "        return __out;",
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      "        var __pending = aggregate.PullEvents();",
      "        if (__pending.Count > 0)",
      "        {",
      "            var __sid = aggregate.Id.Value.ToString();",
      `            var __version = await _db.${dbSet}.Where(e => e.StreamType == "${streamType}" && e.StreamId == __sid).Select(e => (int?)e.Version).MaxAsync(cancellationToken) ?? 0;`,
      "            foreach (var __ev in __pending)",
      "            {",
      "                __version++;",
      `                _db.${dbSet}.Add(new ${recordCls}`,
      "                {",
      `                    StreamType = "${streamType}",`,
      "                    StreamId = __sid,",
      "                    Version = __version,",
      "                    Type = __ev.GetType().Name,",
      "                    Data = System.Text.Json.JsonSerializer.Serialize((object)__ev, __json),",
      "                    OccurredAt = DateTime.UtcNow,",
      "                });",
      "            }",
      // The (stream_id, version) PK IS the event stream's optimistic-concurrency
      // control: a competing append that read the same Max(Version) inserts the
      // same version and loses with a Postgres 23505.  EF surfaces it as a
      // DbUpdateException with a PostgresException inner; translate it to the EF
      // concurrency exception the DomainExceptionFilter maps to 409 (parity with
      // the `versioned` guarded write's stale-write rejection).
      "            try",
      "            {",
      "                await _db.SaveChangesAsync(cancellationToken);",
      "            }",
      "            catch (Microsoft.EntityFrameworkCore.DbUpdateException __ex)",
      '                when (__ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })',
      "            {",
      '                throw new Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException("The resource was modified by another request; reload and retry.", __ex);',
      "            }",
      "        }",
      `        ${renderDotnetLogCall("repositorySave", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "aggregate.Id.Value" },
      ])}`,
      "        foreach (var ev in __pending)",
      "        {",
      `            ${renderDotnetLogCall("eventDispatched", [
        { name: "event_type", valueExpr: "ev.GetType().Name" },
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "aggregate.Id.Value" },
      ])}`,
      "            await _events.DispatchAsync(ev, cancellationToken);",
      "        }",
      "    }",
      "",
      // Load every stream, fold each — the in-memory source for finds.
      `    private async Task<List<${agg.name}>> _LoadAllAsync(CancellationToken cancellationToken)`,
      "    {",
      `        var __rows = await _db.${dbSet}.Where(e => e.StreamType == "${streamType}").OrderBy(e => e.StreamId).ThenBy(e => e.Version).ToListAsync(cancellationToken);`,
      "        var __byStream = new Dictionary<string, List<IDomainEvent>>();",
      "        foreach (var __r in __rows)",
      "        {",
      "            if (!__byStream.TryGetValue(__r.StreamId, out var __list))",
      "            {",
      "                __list = new List<IDomainEvent>();",
      "                __byStream[__r.StreamId] = __list;",
      "            }",
      "            __list.Add(RowToEvent(__r));",
      "        }",
      `        return __byStream.Select(__kv => ${agg.name}._FromEvents(new ${idClass}(${parseId}), __kv.Value)).ToList();`,
      "    }",
      "",
      `    private static IDomainEvent RowToEvent(${recordCls} __r)`,
      "    {",
      "        return __r.Type switch",
      "        {",
      ...rowToEventArms,
      '            _ => throw new InvalidOperationException($"Unknown event type: {__r.Type}"),',
      "        };",
      "    }",
      ...findMethodLines,
      "}",
    ) + "\n"
  );
}

function renderParamsWithCt(
  params: ParamIR[],
  usesUser: boolean = false,
  extra: string[] = [],
): string {
  const head = [
    ...params.map((p) => `${renderCsType(p.type)} ${p.name}`),
    ...extra,
    usesUser ? "User currentUser" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return head.length > 0
    ? `${head}, CancellationToken cancellationToken = default`
    : "CancellationToken cancellationToken = default";
}

/** Retrieval params + an optional call-site `page` argument
 *  (`(int? offset, int? limit)? page`) + CancellationToken.  `page` is
 *  never part of the retrieval declaration (retrieval.md) — it rides on
 *  the run method. */
export function renderRetrievalParamsWithCt(params: ParamIR[]): string {
  const head = [
    ...params.map((p) => `${renderCsType(p.type)} ${p.name}`),
    "(int? offset, int? limit)? page = null",
  ].join(", ");
  // The `bypass` param carries an inline read's `ignoring` clause
  // (named-filter-bypass.md §11) from the call site to the shared retrieval
  // method — in DOMAIN terms (`FilterBypass`, capability names), NOT EF
  // `IgnoreQueryFilters` vocabulary, so the repository PORT stays ORM-neutral
  // (audit S7); the adapter translates it.  `cancellationToken` MUST stay last
  // (CA1068, an error under `/warnaserror`), so `bypass` sits before it; call
  // sites pass `cancellationToken` NAMED (it follows the optional `page`).
  return `${head}, FilterBypass bypass = default, CancellationToken cancellationToken = default`;
}
