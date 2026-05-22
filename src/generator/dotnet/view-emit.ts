import type { AggregateIR, BoundedContextIR, ExprIR, ViewIR } from "../../ir/loom-ir.js";
import { viewUsesCurrentUser } from "../../ir/loom-ir.js";
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
  options?: { routePrefix?: string },
): void {
  if (ctx.views.length === 0) return;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  for (const view of ctx.views) {
    const agg = aggsByName.get(view.aggregateName);
    if (!agg) continue; // validator already errored
    if (view.output) {
      out.set(`Application/Views/${pascal(view.name)}Row.cs`, renderRowRecord(view, ctx, ns));
    }
    out.set(`Application/Views/${pascal(view.name)}Query.cs`, renderQuery(view, agg, ns));
    out.set(`Application/Views/${pascal(view.name)}Handler.cs`, renderHandler(view, agg, ctx, ns));
  }
  out.set(`Api/${ctx.name}ViewsController.cs`, renderController(ctx, ns, options?.routePrefix));
}

/** The view's response row type — `<Agg>Response` for the shorthand
 *  form, `<View>Row` for the full form. */
function responseRecordName(view: ViewIR, agg: AggregateIR): string {
  return view.output ? `${pascal(view.name)}Row` : `${agg.name}Response`;
}

function renderRowRecord(view: ViewIR, ctx: BoundedContextIR, ns: string): string {
  const fields = view
    .output!.fields.map((f) => `${wireType(f.type, ctx, "response")} ${pascal(f.name)}`)
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

function renderHandler(view: ViewIR, agg: AggregateIR, ctx: BoundedContextIR, ns: string): string {
  const queryName = `${pascal(view.name)}Query`;
  const handlerName = `${pascal(view.name)}Handler`;
  const responseRecord = responseRecordName(view, agg);
  // Auxiliaries — sourceField → mapVarName (`customerId` →
  // `customerById`) — drives DI of foreign repos + bulk loads at
  // handler entry, and rewrites `Id<X>` follow refs in the
  // projection.
  const auxiliaries = view.output?.auxiliaries ?? [];
  // When the view's filter / binds reference currentUser,
  // the handler injects ICurrentUserAccessor and threads
  // `_currentUser.User` into the repository call.
  const usesUser = viewUsesCurrentUser(view);
  // Path → mapVar+aggName lookup, populated as we walk the
  // dependency-ordered auxiliaries.  Single-hop entries seed it;
  // multi-hop entries reference earlier prefix entries.
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  // Repo fields + ctor injection — deduped per aggregate (the same
  // aggregate may appear on multiple paths).
  const fields: string[] = [`    private readonly I${agg.name}Repository _repo;`];
  const ctorParams: string[] = [`I${agg.name}Repository repo`];
  const ctorAssigns: string[] = [`_repo = repo`];
  if (usesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const seenAggs = new Set<string>();
  for (const aux of auxiliaries) {
    if (seenAggs.has(aux.aggName)) continue;
    seenAggs.add(aux.aggName);
    const fieldName = `_${camel(aux.aggName)}Repo`;
    fields.push(`    private readonly I${aux.aggName}Repository ${fieldName};`);
    ctorParams.push(`I${aux.aggName}Repository ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${ctorParams[0]}) => _repo = repo;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;
  // Repository call args — drop the `, ct` separator when there are
  // no domain params, mirroring the find handler convention.
  const repoCallArgs = usesUser ? "_currentUser.User, ct" : "ct";
  // Bulk-load lines — one per auxiliary path, in dependency order.
  const auxLines: string[] = [];
  for (const aux of auxiliaries) {
    const repoField = `_${camel(aux.aggName)}Repo`;
    const mapVar = aux.mapVar;
    const idsExpr = csIdsSourceForAux(aux, pathToMap);
    auxLines.push(
      `        var ${mapVar} = (await ${repoField}.FindManyByIdsAsync(${idsExpr}, ct)).ToDictionary(__a => __a.Id);`,
    );
    pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
  }
  const projection = view.output
    ? projectFullForm(view, ctx, pathToMap)
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
  const authUsing = usesUser ? `using ${ns}.Auth;\n` : "";
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${ns}.Domain.${plural(agg.name)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${auxUsings ? auxUsings + "\n" : ""}${authUsing}${usingResponse}
namespace ${ns}.Application.Views;

public sealed class ${handlerName} : IQueryHandler<${queryName}, System.Collections.Generic.IReadOnlyList<${responseRecord}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<System.Collections.Generic.IReadOnlyList<${responseRecord}>> Handle(${queryName} q, CancellationToken ct)
    {
        var domain = await _repo.${pascal(view.name)}(${repoCallArgs});
${auxLines.join("\n")}${auxLines.length > 0 ? "\n" : ""}        return domain.Select(d => ${projection}).ToList();
    }
}
`;
}

function projectFullForm(
  view: ViewIR,
  ctx: BoundedContextIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  const args = view.output!.fields.map((f) => {
    const bind = view.output!.binds.find((b) => b.name === f.name)!;
    const rendered = renderBindWithFollowsCs(bind.expr, "d", pathToMap);
    return projectToResponse(rendered, f.type, ctx);
  });
  return `new ${pascal(view.name)}Row(${args.join(", ")})`;
}

/** Render a bind expression with chained `Id<X>` follow rewriting
 *  for .NET.  At each `member` whose receiverType is `Id<X>`, the
 *  access becomes `<map>[<receiverRendered>].<Member>`; receiver
 *  recursively follows the same walk for multi-hop chains.  Other
 *  shapes delegate to renderCsExpr with the same thisName. */
function renderBindWithFollowsCs(
  expr: ExprIR,
  thisName: string,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPathCs(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderIdReceiverCs(expr.receiver, thisName, pathToMap);
        return `${map.mapVar}[${inner}].${pascal(expr.member)}`;
      }
    }
  }
  return renderCsExpr(expr, { thisName });
}

function renderIdReceiverCs(
  expr: ExprIR,
  thisName: string,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "ref") {
    return `${thisName}.${pascal(expr.name)}`;
  }
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPathCs(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderIdReceiverCs(expr.receiver, thisName, pathToMap);
        return `${map.mapVar}[${inner}].${pascal(expr.member)}`;
      }
    }
  }
  return renderCsExpr(expr, { thisName });
}

function idFollowPathCs(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") return [e.name];
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = idFollowPathCs(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

/** Pick the C# id-source expression for an auxiliary's bulk load.
 *  Length-1 paths source from `domain` (the source aggregate
 *  results); length-2+ paths source from the prior map's values. */
function csIdsSourceForAux(
  aux: { path: string[]; aggName: string; mapVar: string },
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (aux.path.length === 1) {
    return `domain.Select(d => d.${pascal(aux.path[0]!)}).ToList()`;
  }
  const prevPath = aux.path.slice(0, -1).join(".");
  const prev = pathToMap.get(prevPath);
  if (!prev) return `new System.Collections.Generic.List<object>()`;
  const finalField = aux.path[aux.path.length - 1]!;
  return `${prev.mapVar}.Values.Select(__a => __a.${pascal(finalField)}).ToList()`;
}

function renderController(ctx: BoundedContextIR, ns: string, routePrefix?: string): string {
  const className = `${ctx.name}ViewsController`;
  const route = `${routePrefix ?? ""}views`;
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
[Route("${route}")]
public sealed class ${className} : ControllerBase
{
    private readonly IMediator _mediator;
    public ${className}(IMediator mediator) => _mediator = mediator;

${blocks.join("\n")}
}
`;
}
