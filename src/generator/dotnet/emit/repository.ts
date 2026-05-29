import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  ParamIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall } from "../../_obs/render-dotnet.js";
import { renderCsType } from "../render-expr.js";
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
): string {
  const finds = repo?.finds ?? [];
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  const findLines = finds.map((f) => {
    const usesUser = findUsesCurrentUser(f);
    return `    Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser)});`;
  });
  return (
    lines(
      "// Auto-generated.",
      `using ${ns}.Domain.Ids;`,
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      "",
      `namespace ${ns}.Domain.${plural(agg.name)};`,
      "",
      `public interface I${agg.name}Repository`,
      "{",
      `    Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken ct = default);`,
      `    Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken ct = default);`,
      `    Task SaveAsync(${agg.name} aggregate, CancellationToken ct = default);`,
      ...findLines,
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
  },
): string {
  const emitTrace = !!options?.emitTrace;
  const finds = repo?.finds ?? [];
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  const setName = plural(upperFirst(agg.name));
  const associations = agg.associations;
  // Reference-collection (`Id<T>[]`) load + save lines.  Each
  // association is a separate `_db.<JoinDbSet>` whose rows are
  // explicitly queried/inserted/deleted by the repository — we don't
  // model the join as an EF navigation, so the patterns mirror the
  // TS/Hono Drizzle implementation line-for-line (see
  // src/generator/typescript/repository-builder.ts).
  const loadByIdLines = buildLoadByIdLines(associations);
  const loadManyByIdsLines = buildLoadManyByIdsLines(agg.name, setName, associations);
  const saveDiffSyncLines = buildSaveDiffSyncLines(associations);
  // Per-find catalog log: `find_executed` (debug) at every method's
  // return.  Mirrors the Hono repo emission so cross-backend log
  // consumers see the same event identity + field set.  Array finds
  // use `result.Count` (IReadOnlyList) or the projection's terminal
  // method's return — we bind to `result` either way.
  const findMethodLines = finds.flatMap((f) => {
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    const projection = body?.projectionClause ?? ".ToListAsync(ct)";
    const usesUser = findUsesCurrentUser(f);
    // rows expression depends on the cardinality of the find — the
    // catalog field is just "rows" (an integer count), so map both
    // arrays + singles to a number.
    const isArray = f.returnType.kind === "array";
    const rowsExpr = isArray ? "result.Count" : "result == null ? 0 : 1";
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser)})`,
      "    {",
      `        var result = await _db.${setName}${filter}${projection};`,
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
      "using System.Linq;",
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
      `    public async Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken ct = default)`,
      "    {",
      `        var found = await _db.${setName}.FirstOrDefaultAsync(x => x.Id == id, ct);`,
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
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken ct = default)`,
      "    {",
      "        if (ids.Count == 0) return Array.Empty<" + agg.name + ">();",
      ...loadManyByIdsLines,
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken ct = default)`,
      "    {",
      "        var entry = _db.Entry(aggregate);",
      "        if (entry.State == EntityState.Detached)",
      "        {",
      `            _db.${setName}.Add(aggregate);`,
      "        }",
      ...saveDiffSyncLines,
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
            "            await _db.SaveChangesAsync(ct);",
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
            "        await _db.SaveChangesAsync(ct);",
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
      "            await _events.DispatchAsync(ev, ct);",
      "        }",
      "    }",
      ...findMethodLines,
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
    out.push(`                .OrderBy(j => j.Ordinal)`);
    out.push(`                .Select(j => j.${target})`);
    out.push(`                .ToListAsync(ct);`);
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
    return [`        return await _db.${setName}.Where(x => ids.Contains(x.Id)).ToListAsync(ct);`];
  }
  const out: string[] = [];
  out.push(
    `        var roots = await _db.${setName}.Where(x => ids.Contains(x.Id)).ToListAsync(ct);`,
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
    out.push(`            .OrderBy(j => j.${owner}).ThenBy(j => j.Ordinal)`);
    out.push(`            .Select(j => new { Owner = j.${owner}, Target = j.${target} })`);
    out.push(`            .ToListAsync(ct);`);
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
 * the wire contract for `Id<T>[]` doesn't promise order — but we
 * still write the ordinal column from the list index for a
 * deterministic per-backend value.  Mirrors the TS Drizzle save
 * diff-sync. */
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
    out.push(`            .Where(x => x.${owner} == aggregate.Id).ToListAsync(ct);`);
    out.push(`        var __current${cap} = aggregate.${cap}.ToList();`);
    out.push(`        var __currentIds${cap} = new HashSet<${targetType}>(__current${cap});`);
    out.push(
      `        foreach (var __stale in __existing${cap}.Where(x => !__currentIds${cap}.Contains(x.${target})).ToList())`,
    );
    out.push("        {");
    out.push(`            _db.${dbSet}.Remove(__stale);`);
    out.push("        }");
    out.push(`        for (int __i = 0; __i < __current${cap}.Count; __i++)`);
    out.push("        {");
    out.push(`            var __tid = __current${cap}[__i];`);
    out.push(`            var __row = __existing${cap}.FirstOrDefault(x => x.${target} == __tid);`);
    out.push("            if (__row != null) { __row.Ordinal = __i; }");
    out.push(`            else { _db.${dbSet}.Add(new ${cls}(aggregate.Id, __tid, __i)); }`);
    out.push("        }");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document-shaped (`normalised(false)`) repository implementation.
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
  findBodies: Array<{ name: string; filterClause: string; projectionClause: string }>,
  options?: { extraUsings?: readonly string[] },
): string {
  const finds = repo?.finds ?? [];
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
    const projection = (body?.projectionClause ?? ".ToListAsync(ct)")
      .replace(".ToListAsync(ct)", ".ToList()")
      .replace(".FirstOrDefaultAsync(ct)", ".FirstOrDefault()")
      .replace(".FirstAsync(ct)", ".First()");
    const usesUser = findUsesCurrentUser(f);
    const isArray = f.returnType.kind === "array";
    const rowsExpr = isArray ? "result.Count" : "result == null ? 0 : 1";
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser)})`,
      "    {",
      `        var __all = (await _db.${setName}.ToListAsync(ct)).Select(__d => ${deser});`,
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
      `    public async Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken ct = default)`,
      "    {",
      `        var __doc = await _db.${setName}.FirstOrDefaultAsync(x => x.Id == id.Value, ct);`,
      `        ${renderDotnetLogCall("aggregateLoaded", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "id.Value" },
        { name: "found", valueExpr: "__doc != null" },
      ])}`,
      "        if (__doc == null) return null;",
      `        return ${agg.name}.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<${snap}>(__doc.Data, __json)!);`,
      "    }",
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken ct = default)`,
      "    {",
      `        if (ids.Count == 0) return Array.Empty<${agg.name}>();`,
      "        var __raw = ids.Select(i => i.Value).ToList();",
      `        var __docs = await _db.${setName}.Where(x => __raw.Contains(x.Id)).ToListAsync(ct);`,
      `        return __docs.Select(__d => ${deser}).ToList();`,
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken ct = default)`,
      "    {",
      "        var __data = System.Text.Json.JsonSerializer.Serialize(aggregate.ToSnapshot(), __json);",
      `        var __existing = await _db.${setName}.FirstOrDefaultAsync(x => x.Id == aggregate.Id.Value, ct);`,
      "        if (__existing == null)",
      "        {",
      `            _db.${setName}.Add(new ${agg.name}Document { Id = aggregate.Id.Value, Data = __data, Version = 1 });`,
      "        }",
      "        else",
      "        {",
      "            __existing.Data = __data;",
      "            __existing.Version += 1;",
      "        }",
      "        await _db.SaveChangesAsync(ct);",
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
      "            await _events.DispatchAsync(ev, ct);",
      "        }",
      "    }",
      ...findMethodLines,
      "}",
    ) + "\n"
  );
}

function renderParamsWithCt(params: ParamIR[], usesUser: boolean = false): string {
  const head = [
    ...params.map((p) => `${renderCsType(p.type)} ${p.name}`),
    usesUser ? "User currentUser" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return head.length > 0
    ? `${head}, CancellationToken ct = default`
    : "CancellationToken ct = default";
}
