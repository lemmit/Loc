import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ViewIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, viewUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { camelId, opView } from "../../ir/util/openapi-ids.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { dtoParam, projectEntityExpr, projectToResponse, wireType } from "./dto-mapping.js";
import { collectCsExprUsings, renderCsExpr } from "./render-expr.js";
import { esCorrIdClass, esEventDbSet } from "./workflow-eventsourced-emit.js";
import { workflowStateClass, workflowStateDbSet } from "./workflow-state-emit.js";

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
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string; sourcemap?: SourceMapRecorder },
): void {
  if (ctx.views.length === 0) return;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const wfByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));
  const sourcemap = options?.sourcemap;
  for (const view of ctx.views) {
    const construct = `${ctx.name}.${view.name}`;
    // Workflow-sourced view (workflow-instance-views.md): a Mediator query
    // whose handler reads the saga-state DbSet with the filter, returning the
    // workflow's `<Wf>InstanceResponse` (emitted by emitWorkflowInstanceReads).
    if (view.source.kind === "workflow") {
      const wf = wfByName.get(view.source.name);
      if (!wf?.instanceWireShape) continue; // validator already errored
      const queryPath = `Application/Views/${upperFirst(view.name)}Query.cs`;
      const queryContent = renderWorkflowViewQuery(view, wf, ns);
      out.set(queryPath, queryContent);
      sourcemap?.file(queryPath, queryContent, view.origin, construct);
      const handlerPath = `Application/Views/${upperFirst(view.name)}Handler.cs`;
      const handlerContent = renderWorkflowViewHandler(view, wf, ctx, ns);
      out.set(handlerPath, handlerContent);
      sourcemap?.file(handlerPath, handlerContent, view.origin, construct);
      continue;
    }
    const agg = aggsByName.get(view.source.name);
    if (!agg) continue; // validator already errored
    if (view.output) {
      const rowPath = `Application/Views/${upperFirst(view.name)}Row.cs`;
      const rowContent = renderRowRecord(view, ctx, ns);
      out.set(rowPath, rowContent);
      sourcemap?.file(rowPath, rowContent, view.origin, construct);
    }
    const queryPath = `Application/Views/${upperFirst(view.name)}Query.cs`;
    const queryContent = renderQuery(view, agg, ns);
    out.set(queryPath, queryContent);
    sourcemap?.file(queryPath, queryContent, view.origin, construct);
    const handlerPath = `Application/Views/${upperFirst(view.name)}Handler.cs`;
    const handlerContent = renderHandler(view, agg, ctx, ns);
    out.set(handlerPath, handlerContent);
    sourcemap?.file(handlerPath, handlerContent, view.origin, construct);
  }
  out.set(`Api/${ctx.name}ViewsController.cs`, renderController(ctx, ns, options?.routePrefix));
}

/** The view's response row type — `<Agg>Response` for the shorthand
 *  form, `<View>Row` for the full form. */
function responseRecordName(view: ViewIR, agg: AggregateIR): string {
  return view.output ? `${upperFirst(view.name)}Row` : `${agg.name}Response`;
}

function renderRowRecord(view: ViewIR, ctx: EnrichedBoundedContextIR, ns: string): string {
  const fields = view
    .output!.fields.map((f) => dtoParam(wireType(f.type, ctx, "response"), upperFirst(f.name)))
    .join(", ");
  return `// Auto-generated.
using System.ComponentModel.DataAnnotations;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Views;

public sealed record ${upperFirst(view.name)}Row(${fields});
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

public sealed record ${upperFirst(view.name)}Query() : IQuery<IReadOnlyList<${responseRecord}>>;
`;
}

function renderHandler(
  view: ViewIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const queryName = `${upperFirst(view.name)}Query`;
  const handlerName = `${upperFirst(view.name)}Handler`;
  const responseRecord = responseRecordName(view, agg);
  // Non-implicit namespaces touched by the bind expressions this
  // handler renders (e.g. System.Text.RegularExpressions when a bind
  // calls `field.matches(...)`) — collected over the same binds
  // projectFullForm renders below, so the file imports only what its
  // own binds reach into.
  const usings = new Set<string>();
  for (const f of view.output?.fields ?? []) {
    const bind = view.output?.binds.find((b) => b.name === f.name);
    if (bind) collectCsExprUsings(bind.expr, usings);
  }
  if (view.requires) collectCsExprUsings(view.requires, usings);
  // Auxiliaries — sourceField → mapVarName (`customerId` →
  // `customerById`) — drives DI of foreign repos + bulk loads at
  // handler entry, and rewrites `X id` follow refs in the
  // projection.
  const auxiliaries = view.output?.auxiliaries ?? [];
  // When the view's filter / binds reference currentUser,
  // the handler injects ICurrentUserAccessor and threads
  // `_currentUser.User` into the repository call.
  const usesUser = viewUsesCurrentUser(view);
  // A `requires` authorization gate (D-AUTH-OIDC / default-deny) runs in the
  // handler before the query — the read-side analogue of an operation's
  // `requires`.  The gate is currentUser-only; when it references currentUser
  // (i.e. anything but the `requires true` escape) the handler needs the
  // accessor and a local `currentUser` for the rendered predicate to bind to.
  const gateUsesUser = !!view.requires && exprUsesCurrentUser(view.requires);
  const needsUser = usesUser || gateUsesUser;
  // Path → mapVar+aggName lookup, populated as we walk the
  // dependency-ordered auxiliaries.  Single-hop entries seed it;
  // multi-hop entries reference earlier prefix entries.
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  // Repo fields + ctor injection — deduped per aggregate (the same
  // aggregate may appear on multiple paths).
  const fields: string[] = [`    private readonly I${agg.name}Repository _repo;`];
  const ctorParams: string[] = [`I${agg.name}Repository repo`];
  const ctorAssigns: string[] = [`_repo = repo`];
  if (needsUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const seenAggs = new Set<string>();
  for (const aux of auxiliaries) {
    if (seenAggs.has(aux.aggName)) continue;
    seenAggs.add(aux.aggName);
    const fieldName = `_${lowerFirst(aux.aggName)}Repo`;
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
  const repoCallArgs = usesUser ? "_currentUser.User, cancellationToken" : "cancellationToken";
  // Bulk-load lines — one per auxiliary path, in dependency order.
  const auxLines: string[] = [];
  for (const aux of auxiliaries) {
    const repoField = `_${lowerFirst(aux.aggName)}Repo`;
    const mapVar = aux.mapVar;
    const idsExpr = csIdsSourceForAux(aux, pathToMap);
    auxLines.push(
      `        var ${mapVar} = (await ${repoField}.FindManyByIdsAsync(${idsExpr}, cancellationToken)).ToDictionary(__a => __a.Id);`,
    );
    pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
  }
  const projection = view.output
    ? projectFullForm(view, ctx, pathToMap)
    : projectEntityExpr("d", agg, ctx);
  // Authorization gate lines, emitted before the query runs.  A
  // currentUser-referencing gate first binds a local `currentUser` (the
  // rendered `current-user` ref); `requires true` skips it.  Mirrors
  // render-stmt's operation `requires` → ForbiddenException (→ 403 via
  // DomainExceptionFilter).
  const gateLines: string[] = [];
  if (view.requires) {
    if (gateUsesUser) gateLines.push(`        var currentUser = _currentUser.User;`);
    gateLines.push(
      `        if (!(${renderCsExpr(view.requires)})) throw new ForbiddenException(${JSON.stringify(
        `Forbidden: view ${view.name}`,
      )});`,
    );
  }
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
  const authUsing = needsUser ? `using ${ns}.Auth;\n` : "";
  // `requires` gates throw ForbiddenException, which lives in Domain.Common.
  const commonUsing = view.requires ? `using ${ns}.Domain.Common;\n` : "";
  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Mediator;
using ${ns}.Domain.${plural(agg.name)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${auxUsings ? auxUsings + "\n" : ""}${authUsing}${commonUsing}${usingResponse}
namespace ${ns}.Application.Views;

public sealed class ${handlerName} : IQueryHandler<${queryName}, IReadOnlyList<${responseRecord}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<IReadOnlyList<${responseRecord}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gateLines.length > 0 ? gateLines.join("\n") + "\n" : ""}        var domain = await _repo.${upperFirst(view.name)}(${repoCallArgs});
${auxLines.join("\n")}${auxLines.length > 0 ? "\n" : ""}        return domain.Select(d => ${projection}).ToList();
    }
}
`;
}

function projectFullForm(
  view: ViewIR,
  ctx: EnrichedBoundedContextIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  const args = view.output!.fields.map((f) => {
    const bind = view.output!.binds.find((b) => b.name === f.name)!;
    const rendered = renderBindWithFollowsCs(bind.expr, "d", pathToMap);
    return projectToResponse(rendered, f.type, ctx);
  });
  return `new ${upperFirst(view.name)}Row(${args.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Workflow-sourced views (workflow-instance-views.md) — a Mediator query whose
// handler reads the saga-state DbSet with the view filter, returning the
// workflow's `<Wf>InstanceResponse` (the read-side analogue of the .NET
// instance endpoints from #1035; the DTO is emitted by emitWorkflowInstanceReads).
// ---------------------------------------------------------------------------

function renderWorkflowViewQuery(view: ViewIR, wf: WorkflowIR, ns: string): string {
  const responseRecord = `${upperFirst(wf.name)}InstanceResponse`;
  return `// Auto-generated.
using System.Collections.Generic;
using Mediator;
using ${ns}.Application.Workflows;

namespace ${ns}.Application.Views;

public sealed record ${upperFirst(view.name)}Query() : IQuery<IReadOnlyList<${responseRecord}>>;
`;
}

function renderWorkflowViewHandler(
  view: ViewIR,
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const queryName = `${upperFirst(view.name)}Query`;
  const handlerName = `${upperFirst(view.name)}Handler`;
  const responseRecord = `${upperFirst(wf.name)}InstanceResponse`;
  const dbSet = workflowStateDbSet(wf);
  const eventSourced = !!wf.eventSourced;
  const usings = new Set<string>();
  const where = view.filter ? renderCsExpr(view.filter, { thisName: "r", efQuery: true }) : undefined;
  if (view.filter) collectCsExprUsings(view.filter, usings);
  if (view.requires) collectCsExprUsings(view.requires, usings);
  const proj = (wf.instanceWireShape ?? [])
    .map((f) => projectToResponse(`r.${upperFirst(f.name)}`, f.type, ctx))
    .join(", ");
  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  // Authorization gate — same shape as the aggregate handler.  The accessor
  // is injected only when a gate references currentUser.
  const gateUsesUser = !!view.requires && exprUsesCurrentUser(view.requires);
  const gateLines: string[] = [];
  if (view.requires) {
    if (gateUsesUser) gateLines.push(`        var currentUser = _currentUser.User;`);
    gateLines.push(
      `        if (!(${renderCsExpr(view.requires)})) throw new ForbiddenException(${JSON.stringify(
        `Forbidden: view ${view.name}`,
      )});`,
    );
  }
  const ctorFields = gateUsesUser
    ? `    private readonly AppDbContext _db;\n    private readonly ICurrentUserAccessor _currentUser;\n    public ${handlerName}(AppDbContext db, ICurrentUserAccessor currentUser)\n    {\n        _db = db;\n        _currentUser = currentUser;\n    }`
    : `    private readonly AppDbContext _db;\n    public ${handlerName}(AppDbContext db) => _db = db;`;
  const authUsing = gateUsesUser ? `using ${ns}.Auth;\n` : "";
  const commonUsing = view.requires ? `using ${ns}.Domain.Common;\n` : "";
  // The read body diverges on `wf.eventSourced`.  A state-based saga pushes the
  // view filter into the EF query over the `<Wf>State` DbSet (SQL `WHERE`).  An
  // event-sourced workflow has no state table — it group-folds the `<wf>_events`
  // stream into the same instance read model the ES instance LIST produces
  // (load all event rows, group by StreamId, fold each via `_FromEvents`), then
  // applies the SAME predicate IN-MEMORY (`.Where(r => …)` over the folded
  // state).  Both project `instanceWireShape` field-for-field, so operationIds,
  // route paths, and the response component stay identical across the two paths.
  let queryBody: string;
  if (eventSourced) {
    const eventSet = esEventDbSet(wf);
    const stateCls = workflowStateClass(wf);
    const corrId = esCorrIdClass(wf);
    queryBody =
      `        var __rows = await _db.${eventSet}.AsNoTracking().OrderBy(e => e.StreamId).ThenBy(e => e.Version).ToListAsync(cancellationToken);\n` +
      `        var rows = __rows.GroupBy(e => e.StreamId).Select(g => ${stateCls}._FromEvents(new ${corrId}(System.Guid.Parse(g.Key)), g.Select(${stateCls}.RowToEvent).ToList()))${where ? `.Where(r => ${where})` : ""};\n` +
      `        return rows.Select(r => new ${responseRecord}(${proj})).ToList();`;
  } else {
    queryBody =
      `        var rows = await _db.${dbSet}.AsNoTracking()${where ? `.Where(r => ${where})` : ""}.ToListAsync(cancellationToken);\n` +
      `        return rows.Select(r => new ${responseRecord}(${proj})).ToList();`;
  }
  return `// Auto-generated.
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Microsoft.EntityFrameworkCore;
using Mediator;
using ${ns}.Application.Workflows;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${authUsing}${commonUsing}using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Application.Views;

public sealed class ${handlerName} : IQueryHandler<${queryName}, IReadOnlyList<${responseRecord}>>
{
${ctorFields}

    public async ValueTask<IReadOnlyList<${responseRecord}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gateLines.length > 0 ? gateLines.join("\n") + "\n" : ""}${queryBody}
    }
}
`;
}

/** Render a bind expression with chained `X id` follow rewriting
 *  for .NET.  At each `member` whose receiverType is `X id`, the
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
        return `${map.mapVar}[${inner}].${upperFirst(expr.member)}`;
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
    return `${thisName}.${upperFirst(expr.name)}`;
  }
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPathCs(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderIdReceiverCs(expr.receiver, thisName, pathToMap);
        return `${map.mapVar}[${inner}].${upperFirst(expr.member)}`;
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
    return `domain.Select(d => d.${upperFirst(aux.path[0]!)}).ToList()`;
  }
  const prevPath = aux.path.slice(0, -1).join(".");
  const prev = pathToMap.get(prevPath);
  if (!prev) return `new List<object>()`;
  const finalField = aux.path[aux.path.length - 1]!;
  return `${prev.mapVar}.Values.Select(__a => __a.${upperFirst(finalField)}).ToList()`;
}

function renderController(ctx: BoundedContextIR, ns: string, routePrefix?: string): string {
  const className = `${ctx.name}ViewsController`;
  const route = `${routePrefix ?? ""}views`;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const wfByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));
  let hasWorkflowView = false;
  const blocks: string[] = [];
  for (const view of ctx.views) {
    let recordName: string;
    if (view.source.kind === "workflow") {
      const wf = wfByName.get(view.source.name);
      if (!wf?.instanceWireShape) continue;
      recordName = `${upperFirst(wf.name)}InstanceResponse`;
      hasWorkflowView = true;
    } else {
      const agg = aggsByName.get(view.source.name);
      if (!agg) continue;
      recordName = responseRecordName(view, agg);
    }
    const responseType = `IReadOnlyList<${recordName}>`;
    blocks.push(
      `    [HttpGet("${snake(view.name)}")]\n` +
        `    public async Task<ActionResult<${responseType}>> ${upperFirst(camelId(opView(view.name)))}()\n` +
        `    {\n` +
        `        var result = await _mediator.Send(new ${upperFirst(view.name)}Query());\n` +
        `        return Ok(result);\n` +
        `    }\n`,
    );
  }
  // `using` per touched aggregate's response namespace (only when at
  // least one shorthand view references that aggregate's Response).
  const aggResponseUsings = [
    ...new Set(
      ctx.views
        .filter((v) => !v.output && v.source.kind === "aggregate")
        .map((v) => aggsByName.get(v.source.name))
        .filter((a): a is AggregateIR => !!a)
        .map((a) => `using ${ns}.Application.${plural(a.name)}.Responses;`),
    ),
  ];
  // Workflow-view responses (`<Wf>InstanceResponse`) live in Application.Workflows.
  if (hasWorkflowView) aggResponseUsings.push(`using ${ns}.Application.Workflows;`);
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
