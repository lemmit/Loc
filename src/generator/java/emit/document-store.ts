import type { EnrichedAggregateIR, RepositoryIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake } from "../../../util/naming.js";
import { renderJavaExpr, renderJavaType } from "../render-expr.js";
import type { JavaRepoCtx } from "./repository.js";
import { declaredFinds, isPagedFind, unionFindAsOptionalTwin } from "./repository.js";

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
  if ((ctx.retrievals ?? []).length > 0) {
    throw new Error(
      `java document shape: retrievals on document aggregate '${agg.name}' are not implemented (the document column is not a query target).`,
    );
  }
  const bare = plural(snake(agg.name));
  const table = schema ? `${schema}.${bare}` : bare;
  const finds = declaredFinds(repo).map((f) => unionFindAsOptionalTwin(f, agg.name));

  // A document aggregate's every field lives in the `data` jsonb column, so a
  // (non-principal) capability `filter` is applied in-app over the rehydrated
  // aggregate (the read already deserialises every row).  Gating findById +
  // findAll covers the custom finds too — they all read through findAll().
  const capBody = (varName: string): string | null => {
    const preds = (agg.contextFilters ?? [])
      .filter((p) => !exprUsesCurrentUser(p))
      .map((p) => `(${renderJavaExpr(p, { thisName: varName, agg, accessorProps: true })})`);
    return preds.length > 0 ? preds.join(" && ") : null;
  };
  const capRec = capBody("rec");
  const capX = capBody("x");

  const findLines = finds.flatMap((f) => {
    const params = f.params.map((p) => `${renderJavaType(p.type)} ${p.name}`);
    const filter = f.filter
      ? `.filter(x -> ${renderJavaExpr(f.filter, { thisName: "x", agg, accessorProps: true })})`
      : "";
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
  while (findLines[findLines.length - 1] === "") findLines.pop();

  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    `import java.util.ArrayList;`,
    `import java.util.List;`,
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
    findLines.length > 0 ? `` : null,
    ...findLines,
    `}`,
    ``,
  );
}
