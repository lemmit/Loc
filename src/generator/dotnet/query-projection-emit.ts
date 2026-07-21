import type {
  BoundedContextIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isQueryTimeProjection } from "../../ir/types/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { dtoParam, projectToResponse, wireType } from "./dto-mapping.js";
import { collectCsExprUsings, renderCsExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// .NET query-time projection emission (read-path-architecture.md rev.13).
//
// A query-time projection (`projection X { from <Agg> [as a] where … join …
// select … }`, no `on(e)` folds) is the always-current read model of the
// query-time projection read.  It reads live: the source read rides a synthesized
// parameterless repository find (`mergeViewsAsFinds` folds query-time
// projections in), each `join <Agg> as c on <idRef>` bulk-loads the followed
// aggregate through its repository `FindManyByIdsAsync(...)` into a
// `Dictionary<XId, Agg>` keyed by `.Id` (.NET has no lazy nav for an `X id` FK,
// so the follow is an explicit dictionary load — the analogue of Hono
// `findManyByIds` / Python `find_many_by_ids` / the Elixir & Java maps), and
// each `select f = <expr>` projects one row.  A `select` reading a join alias
// (`c.name`) rewrites to `<mapVar>[<key>].Name`.
//
// One Mediator query + handler per projection under `Application/Projections/`,
// plus a per-context `Api/<Ctx>QueryProjectionsController.cs` exposing
// `GET /projections/<slug>` (sibling of the folded `<Ctx>ProjectionsController`
// at the same prefix; distinct projection names ⇒ distinct slugs ⇒ no route
// collision).  Only backends in `PROJECTION_QT_SUPPORTED` are permitted a
// query-time projection by the IR validator; dotnet joins node/python/elixir/java.
// ---------------------------------------------------------------------------

export function emitQueryProjections(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string; sourcemap?: SourceMapRecorder },
): void {
  const projections = (ctx.projections ?? []).filter(isQueryTimeProjection);
  if (projections.length === 0) return;
  const sourcemap = options?.sourcemap;
  for (const proj of projections) {
    const construct = `${ctx.name}.${proj.name}`;
    const rowPath = `Application/Projections/${upperFirst(proj.name)}Row.cs`;
    const rowContent = renderRowRecord(proj, ctx, ns);
    out.set(rowPath, rowContent);
    sourcemap?.file(rowPath, rowContent, proj.origin, construct);

    const queryPath = `Application/Projections/${upperFirst(proj.name)}QpQuery.cs`;
    const queryContent = renderQuery(proj, ns);
    out.set(queryPath, queryContent);
    sourcemap?.file(queryPath, queryContent, proj.origin, construct);

    const handlerPath = `Application/Projections/${upperFirst(proj.name)}QpHandler.cs`;
    const handlerContent = renderHandler(proj, ctx, ns);
    out.set(handlerPath, handlerContent);
    sourcemap?.file(handlerPath, handlerContent, proj.origin, construct);
  }
  out.set(
    `Api/${ctx.name}QueryProjectionsController.cs`,
    renderController(ctx, ns, options?.routePrefix),
  );
}

function renderRowRecord(proj: ProjectionIR, ctx: EnrichedBoundedContextIR, ns: string): string {
  const fields = (proj.wireShape ?? [])
    .map((f) => dtoParam(wireType(f.type, ctx, "response"), upperFirst(f.name)))
    .join(", ");
  return `// Auto-generated.
using System.ComponentModel.DataAnnotations;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Projections;

public sealed record ${upperFirst(proj.name)}Row(${fields});
`;
}

function renderQuery(proj: ProjectionIR, ns: string): string {
  return `// Auto-generated.
using Mediator;
namespace ${ns}.Application.Projections;

public sealed record ${upperFirst(proj.name)}QpQuery() : IQuery<IReadOnlyList<${upperFirst(proj.name)}Row>>;
`;
}

interface JoinMap {
  mapVar: string;
  /** The source-row key expression (`d.CustomerId`) the join keys on. */
  keyExpr: string;
}

function renderHandler(proj: ProjectionIR, ctx: EnrichedBoundedContextIR, ns: string): string {
  const source = proj.query!.source!;
  const rowName = `${upperFirst(proj.name)}Row`;
  const queryName = `${upperFirst(proj.name)}QpQuery`;
  const handlerName = `${upperFirst(proj.name)}QpHandler`;
  const joins = proj.query!.joins;

  const usings = new Set<string>();
  for (const s of proj.query!.selects ?? []) collectCsExprUsings(s.expr, usings);

  // Authorization gate (default-deny) — the projection twin of a repository
  // `find … requires <gate>`: a `currentUser`-only predicate evaluated BEFORE
  // the read; failure throws `ForbiddenException` (→ 403 via the
  // DomainExceptionFilter).  Mirrors the .NET find gate (cqrs/queries.ts).
  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }

  // Repo fields + ctor — source repo, then one foreign repo per distinct join agg.
  const fields: string[] = [`    private readonly I${source}Repository _repo;`];
  const ctorParams: string[] = [`I${source}Repository repo`];
  const ctorAssigns: string[] = [`_repo = repo`];
  const seenAggs = new Set<string>();
  for (const join of joins) {
    if (seenAggs.has(join.aggregate)) continue;
    seenAggs.add(join.aggregate);
    const fieldName = `_${lowerFirst(join.aggregate)}Repo`;
    fields.push(`    private readonly I${join.aggregate}Repository ${fieldName};`);
    ctorParams.push(`I${join.aggregate}Repository ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  // A `currentUser`-referencing gate needs the request principal injected — the
  // find gate's `ICurrentUserAccessor` dependency (cqrs/queries.ts).
  if (requires && gateUsesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${ctorParams[0]}) => _repo = repo;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  // Bulk-load each join follow into a Dictionary keyed by the loaded aggregate's Id.
  const aliasMap = new Map<string, JoinMap>();
  const aggMapVar = new Map<string, string>();
  const auxLines: string[] = [];
  for (const join of joins) {
    let mapVar = aggMapVar.get(join.aggregate);
    const keyExpr = renderCsExpr(join.idRef, { thisName: "d" });
    if (!mapVar) {
      mapVar = `${lowerFirst(join.aggregate)}ById`;
      aggMapVar.set(join.aggregate, mapVar);
      const repoField = `_${lowerFirst(join.aggregate)}Repo`;
      auxLines.push(
        `        var ${mapVar} = (await ${repoField}.FindManyByIdsAsync(domain.Select(d => ${keyExpr}).ToList(), cancellationToken)).ToDictionary(__a => __a.Id);`,
      );
    }
    aliasMap.set(join.alias, { mapVar, keyExpr });
  }

  // Project each row through the `select` expressions, keyed by wire field.
  const selectByField = new Map((proj.query!.selects ?? []).map((s) => [s.field, s] as const));
  const args = (proj.wireShape ?? []).map((f) => {
    const sel = selectByField.get(f.name);
    if (!sel) return "default!";
    return projectToResponse(renderSelect(sel.expr, aliasMap), f.type, ctx);
  });
  const projection = `new ${rowName}(${args.join(", ")})`;

  // Emit the 403-before-read gate.  `var currentUser = _currentUser.User;` binds
  // the local the rendered predicate references (renderCsExpr → bare
  // `currentUser`), exactly as the find gate does.
  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }

  // The source aggregate's Domain namespace is emitted explicitly below; drop it
  // from the join usings so a self-referential join can't duplicate it (CS0105
  // under /warnaserror).
  const sourceUsing = `using ${ns}.Domain.${plural(source)};`;
  const auxUsings = [
    ...new Set(joins.map((j) => `using ${ns}.Domain.${plural(j.aggregate)};`)),
  ].filter((u) => u !== sourceUsing);
  // Each foreign aggregate's Domain namespace so `IXRepository` resolves; plural
  // via the same naming the repository interface lives under.
  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Mediator;
using ${ns}.Domain.${plural(source)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${auxUsings.length > 0 ? auxUsings.join("\n") + "\n" : ""}
namespace ${ns}.Application.Projections;

public sealed class ${handlerName} : IQueryHandler<${queryName}, IReadOnlyList<${rowName}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<IReadOnlyList<${rowName}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}        var domain = await _repo.${upperFirst(proj.name)}(cancellationToken);
${auxLines.join("\n")}${auxLines.length > 0 ? "\n" : ""}        return domain.Select(d => ${projection}).ToList();
    }
}
`;
}

/** Render a `select` expression against the source row `d` and the join alias
 *  maps.  A member read on a join alias (`c.name`) rewrites to
 *  `<mapVar>[<key>].Name` — the loaded-by-id aggregate for this row.
 *  Source-candidate reads (`o.id`, bare `lineCount`) render off `d`. */
function renderSelect(expr: ExprIR, aliasMap: Map<string, JoinMap>): string {
  if (expr.kind === "member" && expr.receiver.kind === "ref") {
    const alias = aliasMap.get(expr.receiver.name);
    if (alias) return `${alias.mapVar}[${alias.keyExpr}].${upperFirst(expr.member)}`;
  }
  return renderCsExpr(expr, { thisName: "d" });
}

function renderController(ctx: BoundedContextIR, ns: string, routePrefix?: string): string {
  const className = `${ctx.name}QueryProjectionsController`;
  const route = `${routePrefix ?? ""}projections`;
  const projections = (ctx.projections ?? []).filter(isQueryTimeProjection);
  const blocks = projections.map(
    (proj) =>
      `    [HttpGet("${snake(proj.name)}")]\n` +
      `    public async Task<ActionResult<IReadOnlyList<${upperFirst(proj.name)}Row>>> ${upperFirst(proj.name)}()\n` +
      `    {\n` +
      `        var result = await _mediator.Send(new ${upperFirst(proj.name)}QpQuery());\n` +
      `        return Ok(result);\n` +
      `    }\n`,
  );
  return `// Auto-generated.
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using ${ns}.Application.Projections;

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
