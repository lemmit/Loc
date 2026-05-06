import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ViewIR,
} from "../../ir/loom-ir.js";
import { camel, pascal, plural, snake } from "../../util/naming.js";
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
  // Slice 3: auxiliaries — sourceField → mapVarName (`customerId` →
  // `customerById`) — drives DI of foreign repos + bulk loads at
  // handler entry, and rewrites `Id<X>` follow refs in the
  // projection.
  const auxiliaries = view.output?.auxiliaries ?? [];
  const auxMaps = new Map(
    auxiliaries.map(
      (aux) => [aux.sourceField, `${camel(aux.aggName)}ById`] as const,
    ),
  );
  // Repo fields + ctor injection.
  const fields: string[] = [
    `    private readonly I${agg.name}Repository _repo;`,
  ];
  const ctorParams: string[] = [`I${agg.name}Repository repo`];
  const ctorAssigns: string[] = [`_repo = repo`];
  for (const aux of auxiliaries) {
    const fieldName = `_${camel(aux.aggName)}Repo`;
    fields.push(`    private readonly I${aux.aggName}Repository ${fieldName};`);
    ctorParams.push(`I${aux.aggName}Repository ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${ctorParams[0]}) => _repo = repo;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join("; ")};\n    }`;
  // Bulk-load lines — one per auxiliary.
  const auxLines: string[] = [];
  for (const aux of auxiliaries) {
    const repoField = `_${camel(aux.aggName)}Repo`;
    const mapVar = auxMaps.get(aux.sourceField)!;
    auxLines.push(
      `        var ${mapVar} = (await ${repoField}.FindManyByIdsAsync(domain.Select(d => d.${pascal(aux.sourceField)}).ToList(), ct)).ToDictionary(__a => __a.Id);`,
    );
  }
  const projection = view.output
    ? projectFullForm(view, ctx, auxMaps)
    : projectEntityExpr("d", agg, ctx);
  // Imports.  Shorthand needs the aggregate's Responses namespace;
  // full form needs only the local Views namespace (its row record
  // is sibling).  Auxiliaries pull in each foreign aggregate's
  // Domain namespace so `IXRepository` resolves.
  const usingResponse = view.output
    ? ""
    : `using ${ns}.Application.${plural(agg.name)}.Responses;\n`;
  const auxUsings = [
    ...new Set(auxiliaries.map((a) => `using ${ns}.Domain.${plural(a.aggName)};`)),
  ].join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${ns}.Domain.${plural(agg.name)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${auxUsings ? auxUsings + "\n" : ""}${usingResponse}
namespace ${ns}.Application.Views;

public sealed class ${handlerName} : IQueryHandler<${queryName}, System.Collections.Generic.IReadOnlyList<${responseRecord}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<System.Collections.Generic.IReadOnlyList<${responseRecord}>> Handle(${queryName} q, CancellationToken ct)
    {
        var domain = await _repo.${pascal(view.name)}(ct);
${auxLines.join("\n")}${auxLines.length > 0 ? "\n" : ""}        return domain.Select(d => ${projection}).ToList();
    }
}
`;
}

/** Render a full-form view's per-row projection.  Each bind
 *  renders rooted at `d` (the row variable), with `Id<X>` follow
 *  refs rewritten to dictionary lookups when the view declared
 *  any auxiliaries.  Then the rendered expression runs through
 *  `projectToResponse` for wire-shape conversion (Id → Guid via
 *  `.Value`, enum → string via `.ToString()`, etc.). */
function projectFullForm(
  view: ViewIR,
  ctx: BoundedContextIR,
  auxMaps: Map<string, string>,
): string {
  const args = view.output!.fields.map((f) => {
    const bind = view.output!.binds.find((b) => b.name === f.name)!;
    const rendered = renderBindWithFollowsCs(bind.expr, "d", auxMaps);
    return projectToResponse(rendered, f.type, ctx);
  });
  return `new ${pascal(view.name)}Row(${args.join(", ")})`;
}

/** C# analogue of the Hono renderBindWithFollows.  Single-hop
 *  `Id<X>` follow rewrites: a `member` access whose receiver is a
 *  `ref` of `kind: "id"` becomes `<auxMap>[<thisName>.<sourceField>].<member>`.
 *  All other expression shapes delegate to the standard renderCsExpr
 *  with the same `thisName`. */
function renderBindWithFollowsCs(
  expr: ExprIR,
  thisName: string,
  auxMaps: Map<string, string>,
): string {
  if (
    expr.kind === "member" &&
    expr.receiver.kind === "ref" &&
    expr.receiver.type?.kind === "id"
  ) {
    const sourceField = expr.receiver.name;
    const mapVar = auxMaps.get(sourceField);
    if (mapVar) {
      return `${mapVar}[${thisName}.${pascal(sourceField)}].${pascal(expr.member)}`;
    }
  }
  return renderCsExpr(expr, { thisName });
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

