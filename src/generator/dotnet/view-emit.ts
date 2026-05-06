import type {
  AggregateIR,
  BoundedContextIR,
  ViewIR,
} from "../../ir/loom-ir.js";
import { pascal, plural, snake } from "../../util/naming.js";
import { projectEntityExpr, projectToResponse, wireType } from "./dto-mapping.js";
import { renderCsExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// .NET view emission.
//
// For each `view` declared in the context, emit a Mediator query +
// handler pair under `Application/Views/`, plus a per-context
// `Api/<Context>ViewsController.cs` exposing each view at
// `GET /views/<snake_view>`.
//
// Two response shapes:
//
//   - **Shorthand** (`view X = Y where ...`): handler returns
//     `IReadOnlyList<<Agg>Response>` (the source aggregate's
//     existing wire DTO).
//   - **Full form** (`view X { fields ... bind ... }`): handler
//     returns `IReadOnlyList<<View>Row>` — a fresh wire-shape
//     record emitted alongside the query.  Bind expressions
//     project per-row using the existing C# renderer with
//     `thisName: "d"`; Id-typed binds get a `.Value` unwrap so the
//     record holds the raw Guid.
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
    if (view.output) {
      out.set(
        `Application/Views/${pascal(view.name)}Row.cs`,
        renderRowRecord(view, ctx, ns),
      );
    }
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

/** The view's response row type — `<Agg>Response` for the shorthand
 *  form, `<View>Row` for the full form. */
function responseRecordName(view: ViewIR, agg: AggregateIR): string {
  return view.output ? `${pascal(view.name)}Row` : `${agg.name}Response`;
}

function renderRowRecord(
  view: ViewIR,
  ctx: BoundedContextIR,
  ns: string,
): string {
  const fields = view.output!.fields
    .map((f) => `${wireType(f.type, ctx, "response")} ${pascal(f.name)}`)
    .join(", ");
  return `// Auto-generated.
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Views;

public sealed record ${pascal(view.name)}Row(${fields});
`;
}

function renderQuery(view: ViewIR, agg: AggregateIR, ns: string): string {
  const responseRecord = responseRecordName(view, agg);
  // Shorthand views import the aggregate's Response from its
  // Responses namespace; full-form views' Row type lives next to
  // the query in `Application.Views`.
  const usingResponse = view.output
    ? ""
    : `using ${ns}.Application.${plural(agg.name)}.Responses;\n`;
  return `// Auto-generated.
using Mediator;
${usingResponse}namespace ${ns}.Application.Views;

public sealed record ${pascal(view.name)}Query() : IQuery<System.Collections.Generic.IReadOnlyList<${responseRecord}>>;
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
  const responseRecord = responseRecordName(view, agg);
  const projection = view.output
    ? projectFullForm(view, ctx)
    : projectEntityExpr("d", agg, ctx);
  // Imports differ slightly: shorthand needs the aggregate's
  // Responses namespace; full form needs only the local Views
  // namespace (its row record is sibling).
  const usingResponse = view.output
    ? ""
    : `using ${ns}.Application.${plural(agg.name)}.Responses;\n`;
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${ns}.Domain.${plural(agg.name)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${usingResponse}
namespace ${ns}.Application.Views;

public sealed class ${handlerName} : IQueryHandler<${queryName}, System.Collections.Generic.IReadOnlyList<${responseRecord}>>
{
    private readonly I${agg.name}Repository _repo;
    public ${handlerName}(I${agg.name}Repository repo) => _repo = repo;

    public async ValueTask<System.Collections.Generic.IReadOnlyList<${responseRecord}>> Handle(${queryName} q, CancellationToken ct)
    {
        var domain = await _repo.${pascal(view.name)}(ct);
        return domain.Select(d => ${projection}).ToList();
    }
}
`;
}

/** Render a full-form view's per-row projection: `new <View>Row(arg1,
 *  arg2, ...)`.  Each arg renders the bind expression rooted at the
 *  row variable `d`, then runs through `projectToResponse` so the
 *  wire-shape conversions match the canonical aggregate response
 *  pipeline (Id → Guid via `.Value`, enum → string via `.ToString()`,
 *  datetime → ISO 8601, value-objects → nested record, decimals
 *  pass through). */
function projectFullForm(view: ViewIR, ctx: BoundedContextIR): string {
  const args = view.output!.fields.map((f) => {
    const bind = view.output!.binds.find((b) => b.name === f.name)!;
    const rendered = renderCsExpr(bind.expr, { thisName: "d" });
    return projectToResponse(rendered, f.type, ctx);
  });
  return `new ${pascal(view.name)}Row(${args.join(", ")})`;
}

function renderController(ctx: BoundedContextIR, ns: string): string {
  const className = `${ctx.name}ViewsController`;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const blocks: string[] = [];
  for (const view of ctx.views) {
    const agg = aggsByName.get(view.aggregateName);
    if (!agg) continue;
    const recordName = responseRecordName(view, agg);
    const responseType = `System.Collections.Generic.IReadOnlyList<${recordName}>`;
    blocks.push(
      `    [HttpGet("${snake(view.name)}")]\n` +
        `    public async Task<ActionResult<${responseType}>> ${pascal(view.name)}()\n` +
        `    {\n` +
        `        var result = await _mediator.Send(new ${pascal(view.name)}Query());\n` +
        `        return Ok(result);\n` +
        `    }\n`,
    );
  }
  // `using` per touched aggregate's response namespace (only when at
  // least one shorthand view references that aggregate's Response).
  const aggResponseUsings = [
    ...new Set(
      ctx.views
        .filter((v) => !v.output)
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

