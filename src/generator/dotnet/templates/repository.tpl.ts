import type {
  AggregateIR,
  RepositoryIR,
} from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const REPOSITORY_INTERFACE_TPL = hb.compile(
  `// Auto-generated.
using {{ns}}.Domain.Ids;

namespace {{ns}}.Domain.{{plural name}};

public interface I{{name}}Repository
{
    System.Threading.Tasks.Task<{{name}}?> GetByIdAsync({{name}}Id id, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task SaveAsync({{name}} aggregate, System.Threading.CancellationToken ct = default);
{{#each finds}}    System.Threading.Tasks.Task<{{csType returnType}}> {{pascal name}}({{csParamsAndCt params}});
{{/each}}
}
`,
);

// Repository implementation:
//   - GetByIdAsync returns the *tracked* aggregate from EF.  Owned types
//     declared via `OwnsMany` are auto-included by EF Core, so we don't
//     need explicit `.Include(...)` calls.
//   - SaveAsync attaches new aggregates / lets the change tracker pick up
//     mutations on tracked ones, then dispatches drained domain events.
//   - Find queries default to convention-based equality predicates over
//     each parameter; users can hand-edit the body if they need joins.
const REPOSITORY_IMPL_TPL = hb.compile(
  `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using {{ns}}.Domain.{{plural name}};
using {{ns}}.Domain.Common;
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;
using {{ns}}.Infrastructure.Persistence;

namespace {{ns}}.Infrastructure.Repositories;

public sealed class {{name}}Repository : I{{name}}Repository
{
    private readonly AppDbContext _db;
    private readonly IDomainEventDispatcher _events;

    public {{name}}Repository(AppDbContext db, IDomainEventDispatcher events)
    {
        _db = db;
        _events = events;
    }

    public async Task<{{name}}?> GetByIdAsync({{name}}Id id, CancellationToken ct = default)
    {
        return await _db.{{plural (pascal name)}}.FirstOrDefaultAsync(x => x.Id == id, ct);
    }

    public async Task SaveAsync({{name}} aggregate, CancellationToken ct = default)
    {
        var entry = _db.Entry(aggregate);
        if (entry.State == EntityState.Detached)
        {
            _db.{{plural (pascal name)}}.Add(aggregate);
        }
        await _db.SaveChangesAsync(ct);
        foreach (var ev in aggregate.PullEvents())
        {
            await _events.DispatchAsync(ev, ct);
        }
    }
{{#each finds}}
    public async Task<{{csType returnType}}> {{pascal name}}({{csParamsAndCt params}})
    {
        return await _db.{{plural (pascal ../name)}}{{{ filterClause }}}{{{ projectionClause }}};
    }
{{/each}}
}
`,
);

export function renderRepositoryInterface(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
): string {
  return REPOSITORY_INTERFACE_TPL({ name: agg.name, finds: repo?.finds ?? [], ns });
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
  const finds = (repo?.finds ?? []).map((find) => {
    const body = findBodies.find((b) => b.name === find.name);
    return {
      ...find,
      filterClause: body?.filterClause ?? "",
      projectionClause: body?.projectionClause ?? ".ToListAsync(ct)",
    };
  });
  return REPOSITORY_IMPL_TPL({ name: agg.name, finds, ns });
}
