import type { EnrichedAggregateIR, RepositoryIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import {
  collectJavaExprImports,
  javaValueTypeForId,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";
import type { JavaRepoCtx } from "./repository.js";
import {
  declaredFinds,
  inMemoryRetrievalLines,
  isPagedFind,
  unionFindAsOptionalTwin,
} from "./repository.js";

// ---------------------------------------------------------------------------
// Event-sourced persistence (`persistedAs(eventLog)`, appliers A2) — the
// java counterpart of the Hono / .NET event store.  No state table and
// no Spring Data interface: the repository impl reads/appends the
// shared `<agg>_events` stream table (stream_id, version, type, data
// jsonb, occurred_at — emitted by the shared MigrationsIR) through
// JdbcTemplate, folds streams via the entity's `_fromEvents` (appliers),
// and serialises events with Jackson (records round-trip natively; the
// same mapper writes and reads, so the storage dialect is consistent).
// Finds fold every stream and filter in memory (the .NET `_LoadAllAsync`
// shape) — the event log is the source of truth, not a query target.
// ---------------------------------------------------------------------------

export function renderJavaEventSourcedRepositoryImpl(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: JavaRepoCtx,
  idClass: string,
  schema: string | undefined,
): string {
  const table = schema ? `${schema}.${snake(agg.name)}_events` : `${snake(agg.name)}_events`;
  const idJava = javaValueTypeForId(agg.idValueType);
  const parseId =
    idJava === "UUID"
      ? "UUID.fromString(sid)"
      : idJava === "int"
        ? "Integer.parseInt(sid)"
        : idJava === "long"
          ? "Long.parseLong(sid)"
          : "sid";
  // The event types this stream can contain — the events the appliers fold.
  const eventNames = [...new Set((agg.appliers ?? []).map((a) => a.event))];
  const finds = declaredFinds(repo).map((f) => unionFindAsOptionalTwin(f, agg.name));

  // Expression imports the in-memory find / retrieval predicates need
  // (notably `java.util.Objects` for `==`, `java.util.Comparator` for a
  // sorted retrieval).  The retrieval helper appends its own below.
  const exprImports = new Set<string>();
  for (const f of finds) if (f.filter) collectJavaExprImports(f.filter, exprImports);

  // find_executed (debug) per declared find — `rows` is an integer count
  // (paged → total, list → size, single → 0/1).  Mirrors the relational repo +
  // .NET/Hono event-store emission.
  const findExecutedLog = (name: string, rowsExpr: string): string =>
    `        CatalogLog.event("find_executed", "debug", "aggregate", "${agg.name}", "find", "${name}", "rows", ${rowsExpr});`;
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
  // Retrievals can't query the event log, so each `run<Name>` folds every
  // stream via findAll() then evaluates its `where` + `sort` in memory
  // (the .NET `_LoadAllAsync` shape).  The helper adds its predicate
  // imports (and Comparator for sorted retrievals) to `exprImports`.
  const retrievalLines = inMemoryRetrievalLines(agg, ctx.retrievals ?? [], exprImports);

  const methodLines = [...findLines, ...retrievalLines];
  while (methodLines.length > 0 && methodLines[methodLines.length - 1] === "") methodLines.pop();

  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    `import java.util.ArrayList;`,
    exprImports.has("java.util.Comparator") ? `import java.util.Comparator;` : null,
    `import java.util.LinkedHashMap;`,
    `import java.util.List;`,
    exprImports.has("java.util.Objects") ? `import java.util.Objects;` : null,
    `import java.util.Optional;`,
    idJava === "UUID" ? `import java.util.UUID;` : null,
    ``,
    `import com.fasterxml.jackson.databind.ObjectMapper;`,
    `import org.springframework.jdbc.core.JdbcTemplate;`,
    `import org.springframework.stereotype.Repository;`,
    ``,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    ctx.domainPkg !== ctx.infraPkg ? `import ${ctx.domainPkg}.${agg.name}Repository;` : null,
    `import ${ctx.basePkg}.domain.common.AggregateNotFoundException;`,
    finds.some(isPagedFind) ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
    // DomainEvent rides the events wildcard (it lives in domain.events).
    `import ${ctx.basePkg}.domain.events.*;`,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.config.CatalogLog;`,
    ``,
    `/** Event-sourced repository — appends to ${table}, folds on load`,
    ` *  via ${agg.name}._fromEvents (the appliers). */`,
    `@Repository`,
    `public class ${agg.name}RepositoryImpl implements ${agg.name}Repository {`,
    `    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();`,
    ``,
    `    private final JdbcTemplate jdbc;`,
    ``,
    `    public ${agg.name}RepositoryImpl(JdbcTemplate jdbc) {`,
    `        this.jdbc = jdbc;`,
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} save(${agg.name} aggregate) {`,
    `        var pending = aggregate.pullEvents();`,
    `        if (!pending.isEmpty()) {`,
    `            var sid = String.valueOf(aggregate.id().value());`,
    `            Integer max = jdbc.queryForObject(`,
    `                "select max(version) from ${table} where stream_id = ?", Integer.class, sid);`,
    `            int version = max == null ? 0 : max;`,
    `            for (var ev : pending) {`,
    `                version++;`,
    `                try {`,
    `                    jdbc.update(`,
    `                        "insert into ${table} (stream_id, version, type, data) values (?, ?, ?, ?::jsonb)",`,
    `                        sid, version, ev.getClass().getSimpleName(), JSON.writeValueAsString(ev));`,
    // The (stream_id, version) PK IS the event stream's optimistic-concurrency
    // control: a competing append that read the same max(version) inserts the
    // same version and loses with a Postgres 23505, which JdbcTemplate maps to
    // DuplicateKeyException.  Rethrow the SAME exception the `versioned` service
    // raises so the ApiExceptionAdvice 409 arm maps it to Conflict.
    `                } catch (org.springframework.dao.DuplicateKeyException e) {`,
    `                    throw new org.springframework.orm.ObjectOptimisticLockingFailureException(`,
    `                        ${agg.name}.class, aggregate.id().value());`,
    `                } catch (com.fasterxml.jackson.core.JsonProcessingException e) {`,
    `                    throw new IllegalStateException("event serialization failed", e);`,
    `                }`,
    `                CatalogLog.event("event_dispatched", "info", "event_type", ev.getClass().getSimpleName(), "aggregate", "${agg.name}");`,
    `            }`,
    `        }`,
    // repository_save (debug) — after the stream append; (aggregate, id) prefix
    // mirrors the relational repo + .NET/Hono emission (children omitted).
    `        CatalogLog.event("repository_save", "debug", "aggregate", "${agg.name}", "id", String.valueOf(aggregate.id().value()));`,
    `        return aggregate;`,
    `    }`,
    ``,
    `    @Override`,
    `    public Optional<${agg.name}> findById(${idClass} id) {`,
    `        var events = loadStream(String.valueOf(id.value()));`,
    `        return events.isEmpty() ? Optional.empty() : Optional.of(${agg.name}._fromEvents(id, events));`,
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
    `        var rows = jdbc.queryForList(`,
    `            "select stream_id, type, data from ${table} order by stream_id, version");`,
    `        var byStream = new LinkedHashMap<String, List<DomainEvent>>();`,
    `        for (var row : rows) {`,
    `            byStream.computeIfAbsent((String) row.get("stream_id"), k -> new ArrayList<>())`,
    `                .add(rowToEvent((String) row.get("type"), String.valueOf(row.get("data"))));`,
    `        }`,
    `        var out = new ArrayList<${agg.name}>();`,
    `        for (var entry : byStream.entrySet()) {`,
    `            var sid = entry.getKey();`,
    `            out.add(${agg.name}._fromEvents(new ${idClass}(${parseId}), entry.getValue()));`,
    `        }`,
    `        return out;`,
    `    }`,
    ``,
    `    @Override`,
    `    public void delete(${agg.name} aggregate) {`,
    `        jdbc.update("delete from ${table} where stream_id = ?", String.valueOf(aggregate.id().value()));`,
    `    }`,
    ``,
    `    private List<DomainEvent> loadStream(String sid) {`,
    `        var rows = jdbc.queryForList(`,
    `            "select type, data from ${table} where stream_id = ? order by version", sid);`,
    `        var out = new ArrayList<DomainEvent>();`,
    `        for (var row : rows) {`,
    `            out.add(rowToEvent((String) row.get("type"), String.valueOf(row.get("data"))));`,
    `        }`,
    `        return out;`,
    `    }`,
    ``,
    `    private static DomainEvent rowToEvent(String type, String data) {`,
    `        try {`,
    `            return switch (type) {`,
    ...eventNames.map((e) => `                case "${e}" -> JSON.readValue(data, ${e}.class);`),
    `                default -> throw new IllegalStateException("unknown event type: " + type);`,
    `            };`,
    `        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {`,
    `            throw new IllegalStateException("event deserialization failed", e);`,
    `        }`,
    `    }`,
    methodLines.length > 0 ? `` : null,
    ...methodLines,
    `}`,
    ``,
  );
}
