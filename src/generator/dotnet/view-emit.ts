import type {
  AggregateIR,
  BoundedContextIR,
  ViewIR,
} from "../../ir/loom-ir.js";
import { pascal, plural, snake } from "../../util/naming.js";
import { projectEntityExpr } from "./dto-mapping.js";

// ---------------------------------------------------------------------------
// .NET view emission.
//
// For each `view <Name> = <Aggregate> where <Filter>` in the context:
//
//   Application/Views/<View>Query.cs   — parameterless Mediator query
//   Application/Views/<View>Handler.cs — handler that calls the source
//     aggregate's repository method (already synthesised by the
//     `mergeViewsAsFinds` step in `index.ts`) and projects the
//     resulting domain entities to the canonical `<Agg>Response`.
//
// Plus one shared `Api/<Context>ViewsController.cs` that exposes
// each view at `GET /views/<snake_view>` (symmetric with the
// workflows controller from v13).
// ---------------------------------------------------------------------------

export function emitViews(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  if (ctx.views.length === 0) return;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  for (const view of ctx.views) {
    const agg = aggsByName.get(view.aggregateName);
    if (!agg) continue; // validator already errored
    out.set(
      `Application/Views/${pascal(view.name)}Query.cs`,
      renderQuery(view, agg, ns),
    );
    out.set(
      `Application/Views/${pascal(view.name)}Handler.cs`,
      renderHandler(view, agg, ctx, ns),
    );
  }
  out.set(
    `Api/${ctx.name}ViewsController.cs`,
    renderController(ctx, ns),
  );
}

function renderQuery(view: ViewIR, agg: AggregateIR, ns: string): string {
  return `// Auto-generated.
using Mediator;
using ${ns}.Application.${plural(agg.name)}.Responses;

namespace ${ns}.Application.Views;

public sealed record ${pascal(view.name)}Query() : IQuery<System.Collections.Generic.IReadOnlyList<${agg.name}Response>>;
`;
}

function renderHandler(
  view: ViewIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
  ns: string,
): string {
  const queryName = `${pascal(view.name)}Query`;
  const handlerName = `${pascal(view.name)}Handler`;
  const responseType = `${agg.name}Response`;
  const projection = projectEntityExpr("d", agg, ctx);
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${ns}.Domain.${plural(agg.name)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Application.${plural(agg.name)}.Responses;

namespace ${ns}.Application.Views;

public sealed class ${handlerName} : IQueryHandler<${queryName}, System.Collections.Generic.IReadOnlyList<${responseType}>>
{
    private readonly I${agg.name}Repository _repo;
    public ${handlerName}(I${agg.name}Repository repo) => _repo = repo;

    public async ValueTask<System.Collections.Generic.IReadOnlyList<${responseType}>> Handle(${queryName} q, CancellationToken ct)
    {
        var domain = await _repo.${pascal(view.name)}(ct);
        return domain.Select(d => ${projection}).ToList();
    }
}
`;
}

function renderController(ctx: BoundedContextIR, ns: string): string {
  const className = `${ctx.name}ViewsController`;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const blocks: string[] = [];
  for (const view of ctx.views) {
    const agg = aggsByName.get(view.aggregateName);
    if (!agg) continue;
    const responseType = `System.Collections.Generic.IReadOnlyList<${agg.name}Response>`;
    blocks.push(
      `    [HttpGet("${snake(view.name)}")]\n` +
        `    public async Task<ActionResult<${responseType}>> ${pascal(view.name)}()\n` +
        `    {\n` +
        `        var result = await _mediator.Send(new ${pascal(view.name)}Query());\n` +
        `        return Ok(result);\n` +
        `    }\n`,
    );
  }
  // `using` per touched aggregate's response namespace.
  const aggResponseUsings = [
    ...new Set(
      ctx.views
        .map((v) => aggsByName.get(v.aggregateName))
        .filter((a): a is AggregateIR => !!a)
        .map((a) => `using ${ns}.Application.${plural(a.name)}.Responses;`),
    ),
  ];
  return `// Auto-generated.
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using ${ns}.Application.Views;
${aggResponseUsings.join("\n")}

namespace ${ns}.Api;

[ApiController]
[Route("views")]
public sealed class ${className} : ControllerBase
{
    private readonly IMediator _mediator;
    public ${className}(IMediator mediator) => _mediator = mediator;

${blocks.join("\n")}
}
`;
}
