import type { EnrichedAggregateIR, ExprIR, RepositoryIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake } from "../../../util/naming.js";
import { bypassDrops, type FilterBypass } from "../capability-filter.js";
import { collectJavaExprImports, renderJavaExpr, renderJavaType } from "../render-expr.js";
import type { JavaRepoCtx } from "./repository.js";
import {
  declaredFinds,
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
  // The (predicate, origin) entries, principal-filters excluded (gated off java).
  const capEntries: { pred: ExprIR; origin: string | undefined }[] = (agg.contextFilters ?? [])
    .map((pred, i) => ({ pred, origin: origins[i] }))
    .filter((e) => !exprUsesCurrentUser(e.pred));
  const renderPred = (p: ExprIR, varName: string): string =>
    `(${renderJavaExpr(p, { thisName: varName, agg, accessorProps: true })})`;
  // Always-on predicates: bare filters (undefined origin) + non-promoted caps.
  const alwaysOn = (varName: string): string | null => {
    const preds = capEntries
      .filter((e) => e.origin == null || !promotedCaps.has(e.origin))
      .map((e) => renderPred(e.pred, varName));
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

  const findLines = finds.flatMap((f) => {
    const params = f.params.map((p) => `${renderJavaType(p.type)} ${p.name}`);
    const ownFilter = f.filter
      ? `.filter(x -> ${renderJavaExpr(f.filter, { thisName: "x", agg, accessorProps: true })})`
      : "";
    // Re-apply the promoted caps this find doesn't `ignoring`, over the same `x`.
    const filter =
      ownFilter + promotedFilterClause({ bypassAll: f.bypassAll, bypassCaps: f.bypassCaps }, "x");
    if (isPagedFind(f)) {
      const sig = [...params, "int page", "int pageSize"].join(", ");
      return [
        `    @Override`,
        `    public Paged<${agg.name}> ${f.name}(${sig}) {`,
        `        var all = findAll().stream()${filter}.toList();`,
        `        var items = all.stream().skip((long) (page - 1) * pageSize).limit(pageSize).toList();`,
        `        return new Paged<>(items, page, pageSize, all.size(), (all.size() + pageSize - 1) / pageSize);`,
        `    }`,
        ``,
      ];
    }
    if (f.returnType.kind !== "array") {
      return [
        `    @Override`,
        `    public ${agg.name} ${f.name}(${params.join(", ")}) {`,
        `        return findAll().stream()${filter}.findFirst().orElse(null);`,
        `    }`,
        ``,
      ];
    }
    return [
      `    @Override`,
      `    public List<${agg.name}> ${f.name}(${params.join(", ")}) {`,
      `        return findAll().stream()${filter}.toList();`,
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
    `import com.fasterxml.jackson.databind.MapperFeature;`,
    `import com.fasterxml.jackson.databind.ObjectMapper;`,
    `import com.fasterxml.jackson.databind.json.JsonMapper;`,
    `import org.springframework.jdbc.core.JdbcTemplate;`,
    `import org.springframework.stereotype.Repository;`,
    ``,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    ctx.domainPkg !== ctx.infraPkg ? `import ${ctx.domainPkg}.${agg.name}Repository;` : null,
    `import ${ctx.basePkg}.domain.common.AggregateNotFoundException;`,
    finds.some(isPagedFind) ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
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
    `        .visibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)`,
    `        .visibility(PropertyAccessor.GETTER, JsonAutoDetect.Visibility.NONE)`,
    `        .visibility(PropertyAccessor.IS_GETTER, JsonAutoDetect.Visibility.NONE)`,
    `        .visibility(PropertyAccessor.CREATOR, JsonAutoDetect.Visibility.ANY)`,
    `        .build();`,
    ``,
    `    private final JdbcTemplate jdbc;`,
    ``,
    `    public ${agg.name}RepositoryImpl(JdbcTemplate jdbc) {`,
    `        this.jdbc = jdbc;`,
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} save(${agg.name} aggregate) {`,
    `        try {`,
    `            jdbc.update(`,
    `                "insert into ${table} (id, data, version) values (?, ?::jsonb, 1) "`,
    `                    + "on conflict (id) do update set data = excluded.data, version = ${bare}.version + 1",`,
    `                aggregate.id().value(), JSON.writeValueAsString(aggregate));`,
    `        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {`,
    `            throw new IllegalStateException("document serialization failed", e);`,
    `        }`,
    `        return aggregate;`,
    `    }`,
    ``,
    `    @Override`,
    `    public Optional<${agg.name}> findById(${idClass} id) {`,
    `        var rows = jdbc.query("select data from ${table} where id = ?", (rs, i) -> rs.getString(1), id.value());`,
    ...(capRec
      ? [
          `        if (rows.isEmpty()) return Optional.empty();`,
          `        var rec = fromJson(rows.get(0));`,
          `        return (${capRec}) ? Optional.of(rec) : Optional.empty();`,
        ]
      : [`        return rows.isEmpty() ? Optional.empty() : Optional.of(fromJson(rows.get(0)));`]),
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} getById(${idClass} id) {`,
    `        return findById(id).orElseThrow(() ->`,
    `            new AggregateNotFoundException("${agg.name} " + id + " not found"));`,
    `    }`,
    ``,
    `    @Override`,
    `    public List<${agg.name}> findAll() {`,
    `        var rows = jdbc.query("select data from ${table} order by id", (rs, i) -> rs.getString(1));`,
    `        var out = new ArrayList<${agg.name}>();`,
    ...(capX
      ? [
          `        for (var data : rows) {`,
          `            var x = fromJson(data);`,
          `            if (${capX}) out.add(x);`,
          `        }`,
        ]
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
    `        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {`,
    `            throw new IllegalStateException("document deserialization failed", e);`,
    `        }`,
    `    }`,
    methodLines.length > 0 ? `` : null,
    ...methodLines,
    `}`,
    ``,
  );
}
