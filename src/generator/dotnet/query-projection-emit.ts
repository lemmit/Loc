import type {
  BoundedContextIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  ProjectionAggregateIR,
  ProjectionIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isQueryTimeProjection } from "../../ir/types/loom-ir.js";
import {
  type AggregateSelect,
  aggregateCoercion,
  GROUP_KEY_TRANSFORM_INTRINSIC,
  groupedAggregates,
  groupKeyOf,
  wholeTableAggregates,
} from "../../ir/util/projection-aggregate.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { MONEY_WIRE_SCALE } from "../money-scale.js";
import { dtoParam, projectEntityArgs, projectToResponse, wireType } from "./dto-mapping.js";
import { projectionRowDbSet } from "./projection-state-emit.js";
import {
  CS_INTRINSIC_QUERY_RENDERERS,
  CS_INTRINSIC_RENDERERS,
  collectCsExprUsings,
  renderCsExpr,
} from "./render-expr.js";
import { workflowStateDbSet } from "./workflow-state-emit.js";

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
  // A whole-table aggregation yields ONE row, so the query returns the row
  // itself — not a list of one.  A GROUPED aggregation (`group by`, M-T4.2)
  // yields one row PER GROUP — `wholeTableAggregates` refuses it, so it takes
  // the list branch with the per-row shapes.
  const result = wholeTableAggregates(proj)
    ? `${upperFirst(proj.name)}Row`
    : `IReadOnlyList<${upperFirst(proj.name)}Row>`;
  return `// Auto-generated.
using Mediator;
namespace ${ns}.Application.Projections;

public sealed record ${upperFirst(proj.name)}QpQuery() : IQuery<${result}>;
`;
}

interface JoinMap {
  mapVar: string;
  /** The source-row key expression (`d.CustomerId`) the join keys on. */
  keyExpr: string;
}

function renderHandler(proj: ProjectionIR, ctx: EnrichedBoundedContextIR, ns: string): string {
  // A workflow-sourced projection (`from <Workflow>`) reads the workflow's
  // persisted saga-state DbSet (workflows have no aggregate repository), applies
  // the `where` filter, and projects instance fields via `select`.  Validation
  // guarantees a non-event-sourced observable workflow with no `join`/`ignoring`.
  // GROUPED AGGREGATION (`group by`, M-T4.2) takes precedence over every other
  // shape — a grouped projection mixes per-row key selects with aggregates, so
  // letting it fall through would hand the per-row arm an unresolved aggregate.
  if (groupedAggregates(proj)) {
    return renderGroupedHandler(proj, ctx, ns);
  }
  // WHOLE-TABLE AGGREGATION (M-T1.3 Phase 0) takes precedence over every other
  // shape: it queries the table directly through the DbContext, never through a
  // repository, because the point of the shape is to materialise no rows.
  if (wholeTableAggregates(proj)) {
    return renderAggregateHandler(proj, ctx, ns);
  }
  if (proj.query!.sourceKind === "workflow") {
    return renderWorkflowHandler(proj, ctx, ns);
  }
  // A projection-sourced projection (`from <OtherProjection>`) reads the SOURCE
  // folded projection's persisted `<Proj>Row` read-model DbSet (a materialized
  // projection has no aggregate repository), applies the `where` filter EF-side,
  // and projects the source row fields via `select`.  Validation guarantees a
  // materialized source with no `join`/`ignoring`.
  if (proj.query!.sourceKind === "projection") {
    return renderProjectionSourceHandler(proj, ctx, ns);
  }
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
  // Shorthand form (`projection X { from <Agg> [as a] where … }`, no declared
  // fields / no `select`): the row shape is enriched to the source aggregate's
  // full wire shape, so project each domain row exactly like the aggregate's
  // own `<Agg>Response(...)` — reusing `projectEntityArgs` (wireShape-order
  // positional args off `d`) instead of the per-select map.
  const isShorthand = (proj.query!.selects?.length ?? 0) === 0;
  const sourceAgg = ctx.aggregates.find((a) => a.name === source);
  let projection: string;
  if (isShorthand && sourceAgg) {
    projection = `new ${rowName}(${projectEntityArgs("d", sourceAgg, ctx)})`;
  } else {
    const selectByField = new Map((proj.query!.selects ?? []).map((s) => [s.field, s] as const));
    const args = (proj.wireShape ?? []).map((f) => {
      const sel = selectByField.get(f.name);
      if (!sel) return "default!";
      return projectToResponse(renderSelect(sel.expr, aliasMap), f.type, ctx);
    });
    projection = `new ${rowName}(${args.join(", ")})`;
  }

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

/** Render the handler for a WHOLE-TABLE AGGREGATION (M-T1.3 Phase 0).
 *
 *  ONE SQL query, no rows materialised — the shape exists precisely to avoid
 *  the naive read (a `SELECT *` over the whole table with every row rehydrated
 *  into a domain object to produce one integer, the scaling failure M-T2.6
 *  removed from `findAll`).  `GroupBy(_ => 1)` is the EF Core idiom for a
 *  whole-table aggregate in a SINGLE round trip: separate `CountAsync` /
 *  `SumAsync` calls would each be their own query over the same table.
 *
 *  Over an EMPTY table the grouped query yields no row at all, so the result is
 *  null and every field falls back to its zero — `count` of no rows is 0, and a
 *  SQL `SUM` of no rows is NULL, which a non-optional declared field means as
 *  zero. */
function renderAggregateHandler(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const aggregates = wholeTableAggregates(proj)!;
  const rowName = `${upperFirst(proj.name)}Row`;
  const queryName = `${upperFirst(proj.name)}QpQuery`;
  const handlerName = `${upperFirst(proj.name)}QpHandler`;
  const source = proj.query!.source!;
  const dbSet = plural(upperFirst(source));

  const usings = new Set<string>();
  const filter = proj.query!.filter;
  const where = filter ? renderCsExpr(filter, { thisName: "o", efQuery: true }) : undefined;
  if (filter) collectCsExprUsings(filter, usings);

  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }

  const fields: string[] = [`    private readonly AppDbContext _db;`];
  const ctorParams: string[] = [`AppDbContext db`];
  const ctorAssigns: string[] = [`_db = db`];
  if (requires && gateUsesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(AppDbContext db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }

  // The anonymous projection the grouped query selects; each member is named
  // after its wire field so the row construction below reads plainly.
  const members = aggregates
    .map((s) => `${upperFirst(s.field)} = ${csAggregate(s.aggregate)}`)
    .join(", ");
  const args = aggregates.map((s) => csCoerce(s, `agg`, ctx)).join(", ");
  const anyMoney = aggregates.some((s) => aggregateCoercion(s).asString);
  if (anyMoney) usings.add("System.Globalization");

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Microsoft.EntityFrameworkCore;
using Mediator;
using ${ns}.Domain.${plural(source)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Application.Projections;

public sealed class ${handlerName} : IQueryHandler<${queryName}, ${rowName}>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<${rowName}> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}        var agg = await _db.${dbSet}.AsNoTracking()${where ? `.Where(o => ${where})` : ""}
            .GroupBy(_ => 1)
            .Select(g => new { ${members} })
            .FirstOrDefaultAsync(cancellationToken);
        return new ${rowName}(${args});
    }
}
`;
}

/** Render the handler for a GROUPED aggregation (`group by`, M-T4.2).
 *
 *  ONE SQL query, one row per distinct grouping-key combination — `SELECT
 *  <keys>, <aggs> … GROUP BY <keys> ORDER BY <keys>`, all computed server-side.
 *  The ORDER BY over the grouping columns is REQUIRED: without it the group
 *  order is engine-chosen, and the cross-backend wire differential would flake
 *  on row order rather than values.
 *
 *  The EF chain groups on an anonymous key of the entity's own properties (so
 *  the whole thing stays translatable), projects keys + aggregates into one
 *  anonymous row, orders by the keys, and materialises — then maps each raw
 *  group to the declared `<P>Row` in memory: key columns through the same
 *  wire projection the per-row arm uses (`projectToResponse` — enum stays the
 *  enum type, money formats InvariantCulture, an id unwraps to its Guid), and
 *  aggregates through the singleton arm's `csCoerce` (its null-fallbacks are
 *  vacuous here — an existing group always has a value — but keeping one
 *  coercion path keeps the two arms from drifting). */
function renderGroupedHandler(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const grouped = groupedAggregates(proj)!;
  const rowName = `${upperFirst(proj.name)}Row`;
  const queryName = `${upperFirst(proj.name)}QpQuery`;
  const handlerName = `${upperFirst(proj.name)}QpHandler`;
  const source = proj.query!.source!;
  const dbSet = plural(upperFirst(source));

  // The distinct grouping columns as entity property names, in `group by`
  // order — the GroupBy key, the ORDER BY chain, and (via `g.Key`) the
  // projected key members all derive from exactly these.  Validation pins
  // every entry to a bare source column before emit.
  //
  // Each entry carries the anonymous-type MEMBER name and the DECLARATION that
  // produces it.  A bare column declares as `o.Status`, letting C# infer the
  // member name `Status` — byte-identical to the pre-transform emission.  A
  // COMPUTED key (M-T4.2 date bucket) has no inferable name, so it declares
  // explicitly (`PlacedAtStartOfDay = o.PlacedAt.Date`) and the member name
  // encodes the transform: the same column grouped raw and grouped-by-day are
  // different groups, so they must not collapse onto one member.
  const groupCol = (e: ExprIR): { member: string; decl: string } => {
    const key = groupKeyOf(e);
    if (!key) {
      throw new Error(
        `internal: projection ${proj.name}: a group-by column must be a bare source column`,
      );
    }
    const prop = upperFirst(key.column);
    if (key.transform === undefined) return { member: prop, decl: `o.${prop}` };
    const render =
      CS_INTRINSIC_QUERY_RENDERERS[GROUP_KEY_TRANSFORM_INTRINSIC[key.transform]] ??
      CS_INTRINSIC_RENDERERS[GROUP_KEY_TRANSFORM_INTRINSIC[key.transform]];
    if (!render) {
      throw new Error(`internal: no C# rendering for grouping-key transform '${key.transform}'`);
    }
    const member = `${prop}${upperFirst(key.transform)}`;
    return { member, decl: `${member} = ${render(`o.${prop}`, [])}` };
  };
  const cols: Array<{ member: string; decl: string }> = [];
  for (const e of grouped.groupBy) {
    const gc = groupCol(e);
    if (!cols.some((c) => c.member === gc.member)) cols.push(gc);
  }

  const usings = new Set<string>();
  const filter = proj.query!.filter;
  const where = filter ? renderCsExpr(filter, { thisName: "o", efQuery: true }) : undefined;
  if (filter) collectCsExprUsings(filter, usings);

  // Authorization gate (default-deny) — same shape as the singleton arm.
  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }

  const fields: string[] = [`    private readonly AppDbContext _db;`];
  const ctorParams: string[] = [`AppDbContext db`];
  const ctorAssigns: string[] = [`_db = db`];
  if (requires && gateUsesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(AppDbContext db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }

  // The anonymous projection: every grouping column (whether selected or not,
  // so the ORDER BY below can reach it), then one member per aggregate select
  // named after its wire field.
  const members = [
    ...cols.map((c) => `g.Key.${c.member}`),
    ...grouped.aggregates.map((s) => `${upperFirst(s.field)} = ${csAggregate(s.aggregate)}`),
  ].join(", ");
  const orderBy = cols
    .map((c, i) => `.${i === 0 ? "OrderBy" : "ThenBy"}(x => x.${c.member})`)
    .join("");

  // Map each raw group to the declared row, in wire-shape order.
  const keyByField = new Map(grouped.keys.map((k) => [k.field, k] as const));
  const aggByField = new Map(grouped.aggregates.map((a) => [a.field, a] as const));
  const args = (proj.wireShape ?? []).map((f) => {
    const key = keyByField.get(f.name);
    if (key) {
      // Reads the SAME anonymous member the GroupBy declared — so a computed
      // key's select and its grouping can't drift apart.
      return projectToResponse(`x.${groupCol(key.expr).member}`, key.type, ctx);
    }
    const agg = aggByField.get(f.name);
    if (agg) return csCoerce(agg, "x", ctx);
    return "default!";
  });
  const anyMoney = grouped.aggregates.some((s) => aggregateCoercion(s).asString);
  if (anyMoney) usings.add("System.Globalization");

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Microsoft.EntityFrameworkCore;
using Mediator;
using ${ns}.Domain.${plural(source)};
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Application.Projections;

public sealed class ${handlerName} : IQueryHandler<${queryName}, IReadOnlyList<${rowName}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<IReadOnlyList<${rowName}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}        var groups = await _db.${dbSet}.AsNoTracking()${where ? `.Where(o => ${where})` : ""}
            .GroupBy(o => new { ${cols.map((c) => c.decl).join(", ")} })
            .Select(g => new { ${members} })
            ${orderBy}
            .ToListAsync(cancellationToken);
        return groups.Select(x => new ${rowName}(${args.join(", ")})).ToList();
    }
}
`;
}

/** The LINQ aggregate call for one `select`, inside the grouped projection.
 *  `count` counts ROWS (no column); the rest take the aggregated column, which
 *  is source-row-rooted so it names the entity's property. */
function csAggregate(agg: ProjectionAggregateIR): string {
  if (agg.op === "count" || !agg.arg) return "g.Count()";
  const arg = agg.arg;
  if (arg.kind !== "member") {
    throw new Error(
      "internal: a whole-table aggregation argument must be a source column reference",
    );
  }
  const col = `o.${upperFirst(arg.member)}`;
  // LINQ spells the extremes `Max`/`Min` and the rest `Sum`/`Average`.
  const fn = agg.op === "avg" ? "Average" : upperFirst(agg.op);
  return `g.${fn}(o => ${col})`;
}

/** Coerce one aggregate result to the row's declared wire type, null-safe over
 *  an empty table.  `money` rides the .NET wire as a STRING (see the aggregate
 *  Response records), so a decimal sum is formatted with InvariantCulture — a
 *  locale's comma-vs-dot would otherwise change the wire value. */
function csCoerce(s: AggregateSelect, aggVar: string, ctx: EnrichedBoundedContextIR): string {
  const c = aggregateCoercion(s);
  const read = `${aggVar}?.${upperFirst(s.field)}`;
  if (c.isCount) return `${read} ?? 0`;
  // money pins the FIXED wire scale (RS-12) instead of echoing the aggregate's
  // own: `Sum`/`Max`/`Min` come back at the scale the rows were STORED at, so a
  // `money("10.00")` write read back through a projection shipped `"40.00"`
  // where `projectToResponse` sends `"40.0000"` for the same declared field
  // (#2549).  `"F4"` also carries the empty-table `0m` default to `"0.0000"`.
  if (c.isMoney) {
    const scaled = `ToString("F${MONEY_WIRE_SCALE}", CultureInfo.InvariantCulture)`;
    return c.optional
      ? `${read} is null ? null : ${read}!.Value.${scaled}`
      : `(${read} ?? 0m).${scaled}`;
  }
  if (c.asString) {
    return c.optional
      ? `${read} is null ? null : ${read}!.Value.ToString(CultureInfo.InvariantCulture)`
      : `(${read} ?? 0m).ToString(CultureInfo.InvariantCulture)`;
  }
  // LINQ picks the aggregate's OWN result type, which need not be the row's:
  // `Average` over an `int` column returns `double`, and a row field declared
  // `decimal` then fails to compile (`CS1503: cannot convert from 'double' to
  // 'decimal'`).  Cast to the DECLARED wire type — the row is the contract.
  const target = wireType(s.type, ctx, "response");
  return c.optional ? `(${target})${read}` : `(${target})(${read} ?? 0)`;
}

/** Render the handler for a workflow-sourced query-time projection.  Reads the
 *  saga-state DbSet (`_db.<Wf>State DbSet`) through the injected `AppDbContext`
 *  — NOT an aggregate repository — applies the `where` filter EF-side, and
 *  projects each state row through the `select` expressions into `<Proj>Row`.
 *  The non-event-sourced + EF path only (validation defers ES). */
function renderWorkflowHandler(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const rowName = `${upperFirst(proj.name)}Row`;
  const queryName = `${upperFirst(proj.name)}QpQuery`;
  const handlerName = `${upperFirst(proj.name)}QpHandler`;
  const source = proj.query!.source!;
  const wf = ctx.workflows.find((w) => w.name === source);
  if (!wf) {
    throw new Error(
      `Query-time projection ${proj.name}: workflow source '${source}' not found in context ${ctx.name}`,
    );
  }
  const dbSet = workflowStateDbSet(wf);

  const usings = new Set<string>();
  const filter = proj.query!.filter;
  const where = filter ? renderCsExpr(filter, { thisName: "r", efQuery: true }) : undefined;
  if (filter) collectCsExprUsings(filter, usings);
  for (const s of proj.query!.selects ?? []) collectCsExprUsings(s.expr, usings);

  // Authorization gate (default-deny) — same shape as the aggregate handler.
  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }

  // Project each state row through the `select` expressions, keyed by wire field.
  // A source-alias read (`f.orderId`) lowers to a member off the current row, so
  // renderCsExpr with `thisName: "r"` yields `r.OrderId`.
  const selectByField = new Map((proj.query!.selects ?? []).map((s) => [s.field, s] as const));
  const args = (proj.wireShape ?? []).map((f) => {
    const sel = selectByField.get(f.name);
    if (!sel) return "default!";
    return projectToResponse(renderCsExpr(sel.expr, { thisName: "r" }), f.type, ctx);
  });
  const projection = `new ${rowName}(${args.join(", ")})`;

  // Ctor injects AppDbContext (not an aggregate repo), plus the request principal
  // when a `currentUser` gate is present.
  const fields: string[] = [`    private readonly AppDbContext _db;`];
  const ctorParams: string[] = [`AppDbContext db`];
  const ctorAssigns: string[] = [`_db = db`];
  if (requires && gateUsesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(AppDbContext db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Microsoft.EntityFrameworkCore;
using Mediator;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Application.Projections;

public sealed class ${handlerName} : IQueryHandler<${queryName}, IReadOnlyList<${rowName}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<IReadOnlyList<${rowName}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}        var rows = await _db.${dbSet}.AsNoTracking()${where ? `.Where(r => ${where})` : ""}.ToListAsync(cancellationToken);
        return rows.Select(r => ${projection}).ToList();
    }
}
`;
}

/** Render the handler for a projection-sourced query-time projection.  Reads the
 *  SOURCE folded projection's persisted read-model DbSet (`_db.<Proj>Row DbSet`)
 *  through the injected `AppDbContext` — NOT an aggregate repository — applies
 *  the `where` filter EF-side, and projects each source row through the `select`
 *  expressions into `<Proj>Row`.  Structural twin of `renderWorkflowHandler`,
 *  keyed on a folded projection's read-model row instead of a saga-state row.
 *
 *  The one shape difference: a folded projection's NON-KEY columns are nullable
 *  (a partial upsert), so a `select` reading a non-key source field into a
 *  non-optional target field is unwrapped (`.Value` for a value type, `!` for a
 *  reference type) before the wire projection — the `where` filter already
 *  excludes NULLs (`NULL > 100` is unknown → dropped).  The key column stays
 *  non-nullable. */
function renderProjectionSourceHandler(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const rowName = `${upperFirst(proj.name)}Row`;
  const queryName = `${upperFirst(proj.name)}QpQuery`;
  const handlerName = `${upperFirst(proj.name)}QpHandler`;
  const source = proj.query!.source!;
  const src = ctx.projections.find((p) => p.name === source);
  if (!src) {
    throw new Error(
      `Query-time projection ${proj.name}: projection source '${source}' not found in context ${ctx.name}`,
    );
  }
  const dbSet = projectionRowDbSet(src);

  const usings = new Set<string>();
  const filter = proj.query!.filter;
  const where = filter ? renderCsExpr(filter, { thisName: "r", efQuery: true }) : undefined;
  if (filter) collectCsExprUsings(filter, usings);
  for (const s of proj.query!.selects ?? []) collectCsExprUsings(s.expr, usings);

  // Authorization gate (default-deny) — same shape as the aggregate/workflow handler.
  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }

  // Project each source row through the `select` expressions, keyed by wire field.
  // A source-row read (`t.total`) lowers to a member off the current row, so
  // renderCsExpr with `thisName: "r"` yields `r.Total`.
  const selectByField = new Map((proj.query!.selects ?? []).map((s) => [s.field, s] as const));
  const args = (proj.wireShape ?? []).map((f) => {
    const sel = selectByField.get(f.name);
    if (!sel) return "default!";
    return projectSourceRowArg(sel.expr, f.type, src, ctx);
  });
  const projection = `new ${rowName}(${args.join(", ")})`;

  // Ctor injects AppDbContext (not an aggregate repo), plus the request principal
  // when a `currentUser` gate is present.
  const fields: string[] = [`    private readonly AppDbContext _db;`];
  const ctorParams: string[] = [`AppDbContext db`];
  const ctorAssigns: string[] = [`_db = db`];
  if (requires && gateUsesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(AppDbContext db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
using Microsoft.EntityFrameworkCore;
using Mediator;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Application.Projections;

public sealed class ${handlerName} : IQueryHandler<${queryName}, IReadOnlyList<${rowName}>>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<IReadOnlyList<${rowName}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}        var rows = await _db.${dbSet}.AsNoTracking()${where ? `.Where(r => ${where})` : ""}.ToListAsync(cancellationToken);
        return rows.Select(r => ${projection}).ToList();
    }
}
`;
}

/** Project one `select` expression off a source projection row `r` into the
 *  target wire field.  A direct read of a NON-KEY source field reads a nullable
 *  read-model column (`int?` / `string?` / `XId?`), so when the target field is
 *  non-optional it is unwrapped to the non-null underlying before
 *  `projectToResponse` (which then applies its own id/enum/datetime wire logic).
 *  The key column and an optional target need no unwrap. */
function projectSourceRowArg(
  expr: ExprIR,
  targetType: TypeIR,
  src: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const raw = renderCsExpr(expr, { thisName: "r" });
  const field = simpleSourceField(expr, src);
  const isKey = !!field && field.name === src.correlationField;
  if (field && !isKey && targetType.kind !== "optional") {
    const unwrapped = csLeafIsValueType(field.type) ? `${raw}.Value` : `${raw}!`;
    return projectToResponse(unwrapped, targetType, ctx);
  }
  return projectToResponse(raw, targetType, ctx);
}

/** The source projection field a `select` expression reads directly, or
 *  undefined when the expression is not a bare source-row field read.  Both
 *  lowered forms of a candidate field access are matched: a `this-prop` ref and
 *  a member off `this`. */
function simpleSourceField(expr: ExprIR, src: ProjectionIR): FieldIR | undefined {
  let name: string | undefined;
  if (expr.kind === "ref" && expr.refKind === "this-prop") name = expr.name;
  else if (expr.kind === "member" && expr.receiver.kind === "this") name = expr.member;
  if (!name) return undefined;
  return src.stateFields.find((f) => f.name === name);
}

/** True when a domain `TypeIR` lowers to a C# value type — its nullable
 *  read-model column (`T?`) is `Nullable<T>` and unwraps with `.Value`.  A
 *  `string`/`File` leaf and any value-object / array / entity is a reference
 *  type (unwraps with the null-forgiving `!`). */
function csLeafIsValueType(t: TypeIR): boolean {
  const leaf = t.kind === "optional" ? t.inner : t;
  switch (leaf.kind) {
    case "id":
    case "enum":
      return true;
    case "primitive":
      return leaf.name !== "string" && leaf.name !== "File";
    default:
      return false;
  }
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
      `    public async Task<ActionResult<${
        wholeTableAggregates(proj)
          ? `${upperFirst(proj.name)}Row`
          : `IReadOnlyList<${upperFirst(proj.name)}Row>`
      }>> ${upperFirst(proj.name)}()\n` +
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
