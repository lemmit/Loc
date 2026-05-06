import type {
  AggregateIR,
  ParamIR,
  RepositoryIR,
} from "../../../ir/loom-ir.js";
import { pascal, plural } from "../../../util/naming.js";
import { lines } from "../../../util/code-builder.js";
import { renderCsType } from "../render-expr.js";

// Repository interface (Domain layer) + EF-backed implementation
// (Infrastructure layer).  Both surfaces own a `GetByIdAsync` /
// `SaveAsync` plus one method per DSL `find`.

export function renderRepositoryInterface(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
): string {
  const finds = repo?.finds ?? [];
  const findLines = finds.map(
    (f) =>
      `    System.Threading.Tasks.Task<${renderCsType(f.returnType)}> ${pascal(f.name)}(${renderParamsWithCt(f.params)});`,
  );
  return (
    lines(
      "// Auto-generated.",
      `using ${ns}.Domain.Ids;`,
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
): string {
  const finds = repo?.finds ?? [];
  const setName = plural(pascal(agg.name));
  const findMethodLines = finds.flatMap((f) => {
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    const projection = body?.projectionClause ?? ".ToListAsync(ct)";
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${pascal(f.name)}(${renderParamsWithCt(f.params)})`,
      "    {",
      `        return await _db.${setName}${filter}${projection};`,
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
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence;`,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly AppDbContext _db;",
      "    private readonly IDomainEventDispatcher _events;",
      "",
      `    public ${agg.name}Repository(AppDbContext db, IDomainEventDispatcher events)`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      "    }",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken ct = default)`,
      "    {",
      `        return await _db.${setName}.FirstOrDefaultAsync(x => x.Id == id, ct);`,
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
      "        await _db.SaveChangesAsync(ct);",
      "        foreach (var ev in aggregate.PullEvents())",
      "        {",
      "            await _events.DispatchAsync(ev, ct);",
      "        }",
      "    }",
      ...findMethodLines,
      "}",
    ) + "\n"
  );
}

function renderParamsWithCt(params: ParamIR[]): string {
  const head = params
    .map((p) => `${renderCsType(p.type)} ${p.name}`)
    .join(", ");
  return head.length > 0
    ? `${head}, System.Threading.CancellationToken ct = default`
    : "System.Threading.CancellationToken ct = default";
}
