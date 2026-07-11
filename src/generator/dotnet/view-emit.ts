import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
  TypeIR,
  ViewIR,
  WireField,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, viewUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { camelId, opView } from "../../ir/util/openapi-ids.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { dtoParam, projectEntityExpr, projectToResponse, wireType } from "./dto-mapping.js";
import { projectionRowDbSet } from "./projection-state-emit.js";
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
    // Projection-sourced view (projection.md v1.1): a Mediator query whose
    // handler reads the `<Proj>Row` EF DbSet directly (no repository) with the
    // view filter, then — full form — bulk-loads the foreign aggregates an
    // `X id` follow bind references and projects each row through the binds
    // (the shared aggregate full-form tail, over projection rows).  Shorthand
    // form returns the projection's `<Proj>Response` wire shape.
    if (view.source.kind === "projection") {
      const proj = ctx.projections.find((p) => p.name === view.source.name);
      if (!proj) continue; // validator already errored
      if (view.output) {
        const rowPath = `Application/Views/${upperFirst(view.name)}Row.cs`;
        const rowContent = renderRowRecord(view, ctx, ns);
        out.set(rowPath, rowContent);
        sourcemap?.file(rowPath, rowContent, view.origin, construct);
      }
      const queryPath = `Application/Views/${upperFirst(view.name)}Query.cs`;
      const queryContent = renderProjectionViewQuery(view, proj, ns);
      out.set(queryPath, queryContent);
      sourcemap?.file(queryPath, queryContent, view.origin, construct);
      const handlerPath = `Application/Views/${upperFirst(view.name)}Handler.cs`;
      const handlerContent = renderProjectionViewHandler(view, proj, ctx, ns);
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
  const where = view.filter
    ? renderCsExpr(view.filter, { thisName: "r", efQuery: true })
    : undefined;
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

// ---------------------------------------------------------------------------
// Projection-sourced views (projection.md v1.1) — a Mediator query whose
// handler reads the `<Proj>Row` read-model DbSet directly (no repository) with
// the view filter pushed to a SQL `WHERE`, then:
//   - **full form** — bulk-loads every foreign aggregate an `X id` follow bind
//     references (`FindManyByIdsAsync`, the aggregate full-form tail) and
//     projects each row through the binds, returning `<View>Row`;
//   - **shorthand** — projects each row through the projection's wire shape,
//     returning the same `<Proj>Response` the v1 projection read controller
//     emits.
//
// The one wrinkle versus the aggregate arm: every NON-KEY projection column is
// nullable (partial upsert), so a bind referencing one — a bare column ref or
// the leaf of an `X id` follow — is normalized back to its non-null domain type
// (`.Value` for a value type / `!` for a reference type) before `projectToResponse`
// runs, and the follow bulk-load filters nulls out of its id source.  The
// correlation key column is NOT NULL, so it needs neither.
// ---------------------------------------------------------------------------

/** The projection view's response record — `<View>Row` (full form) or the
 *  projection's `<Proj>Response` wire record (shorthand). */
function projectionResponseRecordName(view: ViewIR, proj: ProjectionIR): string {
  return view.output ? `${upperFirst(view.name)}Row` : `${upperFirst(proj.name)}Response`;
}

function renderProjectionViewQuery(view: ViewIR, proj: ProjectionIR, ns: string): string {
  const responseRecord = projectionResponseRecordName(view, proj);
  // Shorthand reuses the projection's `<Proj>Response` (Application.Workflows);
  // full form's `<View>Row` is sibling in Application.Views.
  const usingResponse = view.output ? "" : `using ${ns}.Application.Workflows;\n`;
  return `// Auto-generated.
using System.Collections.Generic;
using Mediator;
${usingResponse}namespace ${ns}.Application.Views;

public sealed record ${upperFirst(view.name)}Query() : IQuery<IReadOnlyList<${responseRecord}>>;
`;
}

function renderProjectionViewHandler(
  view: ViewIR,
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const queryName = `${upperFirst(view.name)}Query`;
  const handlerName = `${upperFirst(view.name)}Handler`;
  const responseRecord = projectionResponseRecordName(view, proj);
  const dbSet = projectionRowDbSet(proj);
  const auxiliaries = view.output?.auxiliaries ?? [];
  const usings = new Set<string>();
  for (const f of view.output?.fields ?? []) {
    const bind = view.output?.binds.find((b) => b.name === f.name);
    if (bind) collectCsExprUsings(bind.expr, usings);
  }
  if (view.filter) collectCsExprUsings(view.filter, usings);
  if (view.requires) collectCsExprUsings(view.requires, usings);
  // Authorization gate — same shape as the workflow / aggregate arms; the
  // accessor is injected only when a gate references currentUser.
  const gateUsesUser = !!view.requires && exprUsesCurrentUser(view.requires);
  // Ctor: AppDbContext always, one foreign repository per follow-referenced
  // aggregate (deduped), plus the current-user accessor for a user gate.
  const fields: string[] = [`    private readonly AppDbContext _db;`];
  const ctorParams: string[] = [`AppDbContext db`];
  const ctorAssigns: string[] = [`_db = db`];
  const seenAggs = new Set<string>();
  for (const aux of auxiliaries) {
    if (seenAggs.has(aux.aggName)) continue;
    seenAggs.add(aux.aggName);
    const fieldName = `_${lowerFirst(aux.aggName)}Repo`;
    fields.push(`    private readonly I${aux.aggName}Repository ${fieldName};`);
    ctorParams.push(`I${aux.aggName}Repository ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  if (gateUsesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${ctorParams[0]}) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;
  // Authorization gate lines, emitted before the query runs.
  const gateLines: string[] = [];
  if (view.requires) {
    if (gateUsesUser) gateLines.push(`        var currentUser = _currentUser.User;`);
    gateLines.push(
      `        if (!(${renderCsExpr(view.requires)})) throw new ForbiddenException(${JSON.stringify(
        `Forbidden: view ${view.name}`,
      )});`,
    );
  }
  // SQL-pushed row read over the read-model DbSet (`this.<col>` → `r.<Col>`).
  const where = view.filter
    ? renderCsExpr(view.filter, { thisName: "r", efQuery: true })
    : undefined;
  const readLine = `        var rows = await _db.${dbSet}.AsNoTracking()${
    where ? `.Where(r => ${where})` : ""
  }.ToListAsync(cancellationToken);`;
  // Full-form bind-projection tail (bulk-load + follow rewrite over the rows),
  // else the shorthand projection wire shape.
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  const auxLines: string[] = [];
  for (const aux of auxiliaries) {
    const repoField = `_${lowerFirst(aux.aggName)}Repo`;
    const mapVar = aux.mapVar;
    const idsExpr = projIdsSourceForAux(aux, proj, pathToMap);
    auxLines.push(
      `        var ${mapVar} = (await ${repoField}.FindManyByIdsAsync(${idsExpr}, cancellationToken)).ToDictionary(__a => __a.Id);`,
    );
    pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
  }
  const projection = view.output
    ? projectProjectionFullForm(view, proj, ctx, pathToMap)
    : projectProjectionShorthand(proj, ctx);
  // Imports.  Full form pulls each follow aggregate's Domain namespace (for
  // `IXRepository`); shorthand pulls Application.Workflows (for `<Proj>Response`).
  const auxUsings = [
    ...new Set(auxiliaries.map((a) => `using ${ns}.Domain.${plural(a.aggName)};`)),
  ].join("\n");
  const usingResponse = view.output ? "" : `using ${ns}.Application.Workflows;\n`;
  const authUsing = gateUsesUser ? `using ${ns}.Auth;\n` : "";
  const commonUsing = view.requires ? `using ${ns}.Domain.Common;\n` : "";
  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Microsoft.EntityFrameworkCore;
using Mediator;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${auxUsings ? auxUsings + "\n" : ""}${authUsing}${commonUsing}${usingResponse}using ${ns}.Infrastructure.Persistence;
using ${ns}.Infrastructure.Persistence.Projections;

namespace ${ns}.Application.Views;

public sealed class ${handlerName} : IQueryHandler<${queryName}, IReadOnlyList<${responseRecord}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<IReadOnlyList<${responseRecord}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gateLines.length > 0 ? gateLines.join("\n") + "\n" : ""}${readLine}
${auxLines.join("\n")}${auxLines.length > 0 ? "\n" : ""}        return rows.Select(d => ${projection}).ToList();
    }
}
`;
}

/** Full-form projection: one `<View>Row` per row, each bind rendered with the
 *  `X id` follow rewrites + nullable-column normalization. */
function projectProjectionFullForm(
  view: ViewIR,
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  const args = view.output!.fields.map((f) => {
    const bind = view.output!.binds.find((b) => b.name === f.name)!;
    const rendered = renderProjectionBind(bind.expr, proj, pathToMap);
    return projectToResponse(rendered, f.type, ctx);
  });
  return `new ${upperFirst(view.name)}Row(${args.join(", ")})`;
}

/** Shorthand projection: the projection's `<Proj>Response`, projected from the
 *  row's wire shape exactly like the v1 projection read controller (non-key
 *  columns nullable). */
function projectProjectionShorthand(proj: ProjectionIR, ctx: EnrichedBoundedContextIR): string {
  const args = (proj.wireShape ?? [])
    .map((f) => projectToResponse(`d.${upperFirst(f.name)}`, projWireFieldType(f), ctx))
    .join(", ");
  return `new ${upperFirst(proj.name)}Response(${args})`;
}

/** Every non-key projection column is nullable → wrap its wire field as optional
 *  (mirrors projection-emit's `wireFieldType`) so `projectToResponse` unwraps it
 *  the same way the projection read controller does. */
function projWireFieldType(f: WireField): TypeIR {
  if (f.source === "id" || f.type.kind === "optional") return f.type;
  return { kind: "optional", inner: f.type };
}

/** True when a projection column's domain type lowers to a C# value type (its
 *  nullable form is `Nullable<T>`, unwrapped with `.Value`); reference types
 *  (`string`, value objects) unwrap with the null-forgiving `!`. */
function projColIsValueType(t: TypeIR): boolean {
  const leaf = t.kind === "optional" ? t.inner : t;
  switch (leaf.kind) {
    case "id":
    case "enum":
      return true;
    case "primitive":
      return leaf.name !== "string";
    default:
      return false;
  }
}

/** A bare projection-column ref, normalized to its NON-null domain type: the
 *  correlation key is already non-null; a non-key column is `T?`, unwrapped with
 *  `.Value` (value type) / `!` (reference type).  Undefined when `name` is not a
 *  projection state field. */
function normalizeProjColRef(name: string, proj: ProjectionIR): string | undefined {
  const field = proj.stateFields.find((f) => f.name === name);
  if (!field) return undefined;
  const prop = `d.${upperFirst(name)}`;
  if (name === proj.correlationField) return prop; // NOT NULL key
  // `d.<Col>` is `Nullable<T>` / `T?`; the partial upsert always populated it,
  // but the compiler can't see that — unwrap through the null-forgiving `!`
  // (`!.Value` for a value type, so `.Value` doesn't trip CS8629; a bare `!`
  // for a reference type).
  return projColIsValueType(field.type) ? `${prop}!.Value` : `${prop}!`;
}

/** Bind renderer for a projection full-form view — the `X id` follow rewrite
 *  (dictionary lookups) with the nullable-column normalization at every
 *  projection-row leaf.  Non-follow refs to a column normalize the same way;
 *  everything else delegates to `renderCsExpr` with `thisName: "d"`. */
function renderProjectionBind(
  expr: ExprIR,
  proj: ProjectionIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPathCs(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderProjIdReceiver(expr.receiver, proj, pathToMap);
        return `${map.mapVar}[${inner}].${upperFirst(expr.member)}`;
      }
    }
  }
  if (expr.kind === "ref") {
    const norm = normalizeProjColRef(expr.name, proj);
    if (norm) return norm;
  }
  return renderCsExpr(expr, { thisName: "d" });
}

/** Render an Id-typed receiver rooted in a projection column ref (leaf,
 *  nullable-normalized) or a chain of dictionary follows (each intermediate hop
 *  keyed into its map). */
function renderProjIdReceiver(
  expr: ExprIR,
  proj: ProjectionIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "ref") {
    return normalizeProjColRef(expr.name, proj) ?? `d.${upperFirst(expr.name)}`;
  }
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPathCs(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderProjIdReceiver(expr.receiver, proj, pathToMap);
        return `${map.mapVar}[${inner}].${upperFirst(expr.member)}`;
      }
    }
  }
  return renderCsExpr(expr, { thisName: "d" });
}

/** Pick the C# id-source for a projection follow's bulk load.  Length-1 paths
 *  source from the projection rows (`d.<Col>`) — a non-key id column is nullable,
 *  so nulls are filtered and the value unwrapped before `FindManyByIdsAsync`;
 *  length-2+ paths source from the prior map's aggregate values (non-null). */
function projIdsSourceForAux(
  aux: { path: string[]; aggName: string; mapVar: string },
  proj: ProjectionIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (aux.path.length === 1) {
    const col = aux.path[0]!;
    const prop = `d.${upperFirst(col)}`;
    if (col === proj.correlationField) {
      return `rows.Select(d => ${prop}).ToList()`;
    }
    // Non-key id column is `Nullable<XId>`; drop null rows and unwrap through
    // the null-forgiving `!` so `.Value` doesn't trip CS8629 (the compiler
    // doesn't carry the `HasValue` guard across the `Select` lambda).
    return `rows.Where(d => ${prop}.HasValue).Select(d => ${prop}!.Value).ToList()`;
  }
  const prevPath = aux.path.slice(0, -1).join(".");
  const prev = pathToMap.get(prevPath);
  if (!prev) return `new List<object>()`;
  const finalField = aux.path[aux.path.length - 1]!;
  return `${prev.mapVar}.Values.Select(__a => __a.${upperFirst(finalField)}).ToList()`;
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
  const projByName = new Map(ctx.projections.map((p) => [p.name, p] as const));
  let hasWorkflowView = false;
  // A shorthand projection view returns the projection's `<Proj>Response`
  // (Application.Workflows); a full-form one returns `<View>Row` (Application.Views).
  let hasShorthandProjectionView = false;
  const blocks: string[] = [];
  for (const view of ctx.views) {
    let recordName: string;
    if (view.source.kind === "workflow") {
      const wf = wfByName.get(view.source.name);
      if (!wf?.instanceWireShape) continue;
      recordName = `${upperFirst(wf.name)}InstanceResponse`;
      hasWorkflowView = true;
    } else if (view.source.kind === "projection") {
      const proj = projByName.get(view.source.name);
      if (!proj) continue;
      recordName = projectionResponseRecordName(view, proj);
      if (!view.output) hasShorthandProjectionView = true;
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
  // Workflow-view responses (`<Wf>InstanceResponse`) and shorthand
  // projection-view responses (`<Proj>Response`) both live in Application.Workflows.
  if (hasWorkflowView || hasShorthandProjectionView) {
    aggResponseUsings.push(`using ${ns}.Application.Workflows;`);
  }
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
