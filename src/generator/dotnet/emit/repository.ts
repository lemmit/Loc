import type { AggregateIR, ParamIR, RepositoryIR } from "../../../ir/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import {
  renderDotnetLogCall,
} from "../../_obs/render-dotnet.js";
import { renderCsType } from "../render-expr.js";

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
    return `    System.Threading.Tasks.Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParamsWithCt(f.params, usesUser)});`;
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
      `    System.Threading.Tasks.Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, System.Threading.CancellationToken ct = default);`,
      `    System.Threading.Tasks.Task<System.Collections.Generic.IReadOnlyList<${agg.name}>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<${agg.name}Id> ids, System.Threading.CancellationToken ct = default);`,
      `    System.Threading.Tasks.Task SaveAsync(${agg.name} aggregate, System.Threading.CancellationToken ct = default);`,
      ...findLines,
      "}",
    ) + "\n"
  );
}

export function renderRepositoryImpl(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  findBodies: Array<{
    name: string;
    filterClause: string;
    projectionClause: string;
  }>,
  emitTrace = false,
): string {
  const finds = repo?.finds ?? [];
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  const setName = plural(upperFirst(agg.name));
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
  return (
    lines(
      "// Auto-generated.",
      "using System.Linq;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.Extensions.Logging;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence;`,
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
      "        return found;",
      "    }",
      "",
      `    public async Task<System.Collections.Generic.IReadOnlyList<${agg.name}>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<${agg.name}Id> ids, CancellationToken ct = default)`,
      "    {",
      "        if (ids.Count == 0) return System.Array.Empty<" + agg.name + ">();",
      `        return await _db.${setName}.Where(x => ids.Contains(x.Id)).ToListAsync(ct);`,
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken ct = default)`,
      "    {",
      "        var entry = _db.Entry(aggregate);",
      "        if (entry.State == EntityState.Detached)",
      "        {",
      `            _db.${setName}.Add(aggregate);`,
      "        }",
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
            "        catch (System.Exception __txErr)",
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

function renderParamsWithCt(params: ParamIR[], usesUser: boolean = false): string {
  const head = [
    ...params.map((p) => `${renderCsType(p.type)} ${p.name}`),
    usesUser ? "User currentUser" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return head.length > 0
    ? `${head}, System.Threading.CancellationToken ct = default`
    : "System.Threading.CancellationToken ct = default";
}
