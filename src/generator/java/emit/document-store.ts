import type { EnrichedAggregateIR, ExprIR, RepositoryIR } from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesPrincipalContextFilter,
  exprUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake } from "../../../util/naming.js";
import { bypassDrops, type FilterBypass } from "../capability-filter.js";
import { collectJavaExprImports, renderJavaExpr, renderJavaType } from "../render-expr.js";
import type { JavaRepoCtx } from "./repository.js";
import {
  declaredFinds,
  inMemoryPagedSortLines,
  inMemoryRetrievalLines,
  isPagedFind,
  unionFindAsOptionalTwin,
} from "./repository.js";

// ---------------------------------------------------------------------------
// Document-shaped persistence (`shape(document)`, D-DOCUMENT-AXIS) — the
// whole aggregate (contained parts inline, cross-aggregate refs as id
// values) lives in ONE jsonb column: the shared MigrationsIR emits
// `(id, data jsonb, version int)` and this JdbcTemplate repository
// round-trips the entity class directly through a field-visibility
// Jackson mapper — package-private fields serialize as-is (no snapshot
// DTOs; the entity's package-private no-arg constructor instantiates),
// `transient` fields (`_domainEvents`) are excluded via
// PROPAGATE_TRANSIENT_MARKER, and the same mapper writes and reads so
// the storage dialect is consistent.  Saves upsert with a version
// bump; finds rehydrate every document and filter in memory (the .NET
// document-repository shape) — per-projection queries are the
// relational shape's job.
// ---------------------------------------------------------------------------

export function renderJavaDocumentRepositoryImpl(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: JavaRepoCtx,
  idClass: string,
  schema: string | undefined,
): string {
  const bare = plural(snake(agg.name));
  const table = schema ? `${schema}.${bare}` : bare;
  const finds = declaredFinds(repo).map((f) => unionFindAsOptionalTwin(f, agg.name));

  // A document aggregate's every field lives in the `data` jsonb column, so a
  // (non-principal) capability `filter` is applied in-app over the rehydrated
  // aggregate (the read already deserialises every row).  findById + findAll
  // apply the ALWAYS-ON subset (non-promoted caps + bare filters); since every
  // custom find reads through findAll(), that gates them too.
  //
  // §11.6 selective bypass: a PROMOTED capability (some read `ignoring`s it)
  // leaves the always-on subset and is re-applied PER-FIND — conjoined into each
  // find's stream `.filter`, omitted on the finds that bypass it.  `promotedCaps`
  // is threaded by the orchestrator (capability-filter.ts).
  const promotedCaps = ctx.promotedCaps ?? new Set<string>();
  const origins = agg.contextFilterOrigins ?? [];
  // The (predicate, origin) entries, split by whether the predicate reads the
  // request principal (`currentUser`).  Non-principal filters are applied in-app
  // over the rehydrated aggregate as before; PRINCIPAL filters (DEBT-02 Slice B,
  // e.g. `filter this.tenantId == currentUser.tenantId`) are also applied in-app
  // here — a document aggregate can't push them to SQL/JPQL (the relational path
  // does via a SpEL @Query) — but they need the `currentUser` local bound from
  // the injected accessor and a fail-closed null guard (see `principalPred`).
  const capEntries: { pred: ExprIR; origin: string | undefined }[] = (agg.contextFilters ?? [])
    .map((pred, i) => ({ pred, origin: origins[i] }))
    .filter((e) => !exprUsesCurrentUser(e.pred));
  // Principal (tenancy) filters: always-on (never promoted/bypassable — the
  // relational path AND-s them into every root read unconditionally), rendered
  // with `accessorProps` so `currentUser.tenantId` → `currentUser.tenantId()`.
  const principalPreds: ExprIR[] = (agg.contextFilters ?? []).filter(exprUsesCurrentUser);
  const hasPrincipal = aggregateUsesPrincipalContextFilter(agg);
  const renderPred = (p: ExprIR, varName: string): string =>
    `(${renderJavaExpr(p, { thisName: varName, agg, accessorProps: true })})`;
  // The principal conjunct over `varName`, guarded fail-closed: a null
  // `currentUser` (unauthenticated scope) short-circuits to NO rows rather than
  // NPE-ing on `currentUser.tenantId()`.  This is the in-app analogue of the
  // relational path's null-safe SpEL (`@currentUserAccessor.user()?.tenantId()`),
  // which a null principal makes match nothing.  Null when no principal filter.
  const principalPred = (varName: string): string | null => {
    if (principalPreds.length === 0) return null;
    const preds = principalPreds.map((p) => renderPred(p, varName));
    return `currentUser != null && ${preds.join(" && ")}`;
  };
  // Always-on predicates: bare filters (undefined origin) + non-promoted caps
  // + the fail-closed principal conjunct.
  const alwaysOn = (varName: string): string | null => {
    const preds = capEntries
      .filter((e) => e.origin == null || !promotedCaps.has(e.origin))
      .map((e) => renderPred(e.pred, varName));
    const principal = principalPred(varName);
    if (principal) preds.push(principal);
    return preds.length > 0 ? preds.join(" && ") : null;
  };
  // Promoted predicates a read does NOT bypass — conjoined into the find stream.
  const promotedFilterClause = (bypass: FilterBypass | undefined, varName: string): string => {
    const preds = capEntries
      .filter(
        (e) => e.origin != null && promotedCaps.has(e.origin) && !bypassDrops(e.origin, bypass),
      )
      .map((e) => renderPred(e.pred, varName));
    return preds.length > 0 ? `.filter(${varName} -> ${preds.join(" && ")})` : "";
  };
  const capRec = alwaysOn("rec");
  const capX = alwaysOn("x");

  // Expression imports the in-app find / capability predicates need — notably
  // `java.util.Objects` for a string/ref `==` (renders to `Objects.equals`).
  // (The pre-existing emit hardcoded a fixed import list and omitted this, so a
  // document aggregate with a string-equality find failed to compile.)
  const exprImports = new Set<string>();
  for (const f of finds) if (f.filter) collectJavaExprImports(f.filter, exprImports);
  for (const p of agg.contextFilters ?? []) collectJavaExprImports(p, exprImports);

  // Retrievals (`retrieval` bundles) can't query the jsonb document, so each
  // `run<Name>` rehydrates every row and evaluates its `where` + `sort` in
  // memory (the .NET document-repository shape).  `collectJavaExprImports`
  // runs inside the helper, so its predicate imports land in `exprImports`.
  const retrievalLines = inMemoryRetrievalLines(
    agg,
    ctx.retrievals ?? [],
    exprImports,
    (retrievalName, varName) =>
      promotedFilterClause(ctx.bypassByRetrieval?.get(retrievalName), varName),
  );

  // find_executed (debug) per declared find — the `rows` field is an integer
  // count (paged → total, list → size, single → 0/1).  Mirrors the relational
  // repo + .NET/Hono document emission.
  const findExecutedLog = (name: string, rowsExpr: string): string =>
    `        CatalogLog.event("find_executed", "debug", "aggregate", "${agg.name}", "find", "${name}", "rows", ${rowsExpr});`;
  const findLines = finds.flatMap((f) => {
    const params = f.params.map((p) => `${renderJavaType(p.type)} ${p.name}`);
    const ownFilter = f.filter
      ? `.filter(x -> ${renderJavaExpr(f.filter, { thisName: "x", agg, accessorProps: true })})`
      : "";
    // Re-apply the promoted caps this find doesn't `ignoring`, over the same `x`.
    const filter =
      ownFilter + promotedFilterClause({ bypassAll: f.bypassAll, bypassCaps: f.bypassCaps }, "x");
    if (isPagedFind(f)) {
      const sig = [...params, "int page", "int pageSize", "String sort", "String dir"].join(", ");
      return [
        `    @Override`,
        `    public Paged<${agg.name}> ${f.name}(${sig}) {`,
        `        var all = findAll().stream()${filter}.toList();`,
        ...inMemoryPagedSortLines(agg),
        `        var items = all.stream().sorted(__cmp).skip((long) (page - 1) * pageSize).limit(pageSize).toList();`,
        findExecutedLog(f.name, "all.size()"),
        `        return new Paged<>(items, page, pageSize, all.size(), (all.size() + pageSize - 1) / pageSize);`,
        `    }`,
        ``,
      ];
    }
    if (f.returnType.kind !== "array") {
      return [
        `    @Override`,
        `    public ${agg.name} ${f.name}(${params.join(", ")}) {`,
        `        var result = findAll().stream()${filter}.findFirst().orElse(null);`,
        findExecutedLog(f.name, "result == null ? 0 : 1"),
        `        return result;`,
        `    }`,
        ``,
      ];
    }
    return [
      `    @Override`,
      `    public List<${agg.name}> ${f.name}(${params.join(", ")}) {`,
      `        var result = findAll().stream()${filter}.toList();`,
      findExecutedLog(f.name, "result.size()"),
      `        return result;`,
      `    }`,
      ``,
    ];
  });
  const methodLines = [...findLines, ...retrievalLines];
  while (methodLines.length > 0 && methodLines[methodLines.length - 1] === "") methodLines.pop();

  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    `import java.util.ArrayList;`,
    exprImports.has("java.util.Comparator") ? `import java.util.Comparator;` : null,
    `import java.util.List;`,
    exprImports.has("java.util.Objects") ? `import java.util.Objects;` : null,
    `import java.util.Optional;`,
    ``,
    `import com.fasterxml.jackson.annotation.JsonAutoDetect;`,
    `import com.fasterxml.jackson.annotation.PropertyAccessor;`,
    `import tools.jackson.databind.MapperFeature;`,
    `import tools.jackson.databind.ObjectMapper;`,
    `import tools.jackson.databind.json.JsonMapper;`,
    `import org.springframework.jdbc.core.JdbcTemplate;`,
    `import org.springframework.stereotype.Repository;`,
    ``,
    `import ${ctx.basePkg}.config.CatalogLog;`,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    ctx.domainPkg !== ctx.infraPkg ? `import ${ctx.domainPkg}.${agg.name}Repository;` : null,
    `import ${ctx.basePkg}.domain.common.AggregateNotFoundException;`,
    finds.some(isPagedFind) ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
    hasPrincipal ? `import ${ctx.basePkg}.auth.CurrentUserAccessor;` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    ``,
    `/** Document repository — the whole aggregate round-trips one jsonb`,
    ` *  column in ${table} via a field-visibility Jackson mapper. */`,
    `@Repository`,
    `public class ${agg.name}RepositoryImpl implements ${agg.name}Repository {`,
    `    /** Field-visibility mapper: the entity's package-private fields`,
    ` *  round-trip directly (record-style accessors are not getters);`,
    ` *  transient fields (_domainEvents) stay out of the document. */`,
    `    private static final ObjectMapper JSON = JsonMapper.builder()`,
    `        .findAndAddModules()`,
    `        .configure(MapperFeature.PROPAGATE_TRANSIENT_MARKER, true)`,
    `        .changeDefaultVisibility(vc -> vc`,
    `            .withVisibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)`,
    `            .withVisibility(PropertyAccessor.GETTER, JsonAutoDetect.Visibility.NONE)`,
    `            .withVisibility(PropertyAccessor.IS_GETTER, JsonAutoDetect.Visibility.NONE)`,
    `            .withVisibility(PropertyAccessor.CREATOR, JsonAutoDetect.Visibility.ANY))`,
    `        .build();`,
    ``,
    `    private final JdbcTemplate jdbc;`,
    // DEBT-02 Slice B: a principal (tenancy) capability filter is applied in-app
    // over the rehydrated document, so the impl needs the request principal —
    // inject the same CurrentUserAccessor bean the relational path uses.  Only
    // wired when the aggregate carries such a filter (non-principal document
    // aggregates stay byte-identical: no field, no ctor param, no import).
    hasPrincipal ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
    ``,
    hasPrincipal
      ? `    public ${agg.name}RepositoryImpl(JdbcTemplate jdbc, CurrentUserAccessor currentUserAccessor) {`
      : `    public ${agg.name}RepositoryImpl(JdbcTemplate jdbc) {`,
    `        this.jdbc = jdbc;`,
    hasPrincipal ? `        this.currentUserAccessor = currentUserAccessor;` : null,
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} save(${agg.name} aggregate) {`,
    `        try {`,
    `            jdbc.update(`,
    `                "insert into ${table} (id, data, version) values (?, ?::jsonb, 1) "`,
    `                    + "on conflict (id) do update set data = excluded.data, version = ${bare}.version + 1",`,
    `                aggregate.id().value(), JSON.writeValueAsString(aggregate));`,
    `        } catch (tools.jackson.core.JacksonException e) {`,
    `            throw new IllegalStateException("document serialization failed", e);`,
    `        }`,
    // repository_save (debug) — after the upsert; (aggregate, id) prefix mirrors
    // the relational repo + .NET/Hono emission (children omitted).
    `        CatalogLog.event("repository_save", "debug", "aggregate", "${agg.name}", "id", String.valueOf(aggregate.id().value()));`,
    `        return aggregate;`,
    `    }`,
    ``,
    `    @Override`,
    `    public Optional<${agg.name}> findById(${idClass} id) {`,
    `        var rows = jdbc.query("select data from ${table} where id = ?", (rs, i) -> rs.getString(1), id.value());`,
    ...(capRec
      ? [
          `        if (rows.isEmpty()) return Optional.empty();`,
          hasPrincipal ? `        var currentUser = currentUserAccessor.user();` : null,
          `        var rec = fromJson(rows.get(0));`,
          `        return (${capRec}) ? Optional.of(rec) : Optional.empty();`,
        ].filter((l): l is string => l != null)
      : [`        return rows.isEmpty() ? Optional.empty() : Optional.of(fromJson(rows.get(0)));`]),
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} getById(${idClass} id) {`,
    `        var found = findById(id);`,
    // aggregate_loaded (debug) — `found` is a bool so a downstream filter can
    // grep failed loads by (event="aggregate_loaded", found=false).
    `        CatalogLog.event("aggregate_loaded", "debug", "aggregate", "${agg.name}", "id", String.valueOf(id.value()), "found", found.isPresent());`,
    `        return found.orElseThrow(() ->`,
    `            new AggregateNotFoundException("${agg.name} " + id + " not found"));`,
    `    }`,
    ``,
    `    @Override`,
    `    public List<${agg.name}> findAll() {`,
    `        var rows = jdbc.query("select data from ${table} order by id", (rs, i) -> rs.getString(1));`,
    `        var out = new ArrayList<${agg.name}>();`,
    ...(capX
      ? [
          hasPrincipal ? `        var currentUser = currentUserAccessor.user();` : null,
          `        for (var data : rows) {`,
          `            var x = fromJson(data);`,
          `            if (${capX}) out.add(x);`,
          `        }`,
        ].filter((l): l is string => l != null)
      : [`        for (var data : rows) out.add(fromJson(data));`]),
    `        return out;`,
    `    }`,
    ``,
    `    @Override`,
    `    public void delete(${agg.name} aggregate) {`,
    `        jdbc.update("delete from ${table} where id = ?", aggregate.id().value());`,
    `    }`,
    ``,
    `    private static ${agg.name} fromJson(String data) {`,
    `        try {`,
    `            return JSON.readValue(data, ${agg.name}.class);`,
    `        } catch (tools.jackson.core.JacksonException e) {`,
    `            throw new IllegalStateException("document deserialization failed", e);`,
    `        }`,
    `    }`,
    methodLines.length > 0 ? `` : null,
    ...methodLines,
    `}`,
    ``,
  );
}
