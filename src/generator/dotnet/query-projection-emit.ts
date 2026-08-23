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
  type GroupKeySelect,
  groupedAggregates,
  groupKeyOf,
  wholeTableAggregates,
} from "../../ir/util/projection-aggregate.js";
import { queryProjectionArm } from "../../ir/util/query-projection-arm.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { PG_INTRINSIC_SQL } from "../_expr/pg-intrinsics.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { MONEY_WIRE_SCALE } from "../money-scale.js";
import { dtoParam, projectEntityArgs, projectToResponse, wireType } from "./dto-mapping.js";
import {
  collectFilterPrincipalRefs,
  type DapperColumn,
  dapperAggregateTable,
  fieldColumn,
  principalFields,
  sqlIdent,
  whereToSql,
} from "./emit/dapper.js";
import { dapperProjectionColumns, dapperWorkflowStateColumns } from "./emit/dapper-workflow.js";
import {
  projectionRowClass,
  projectionRowDbSet,
  projectionRowTable,
} from "./projection-state-emit.js";
import {
  CS_INTRINSIC_QUERY_RENDERERS,
  CS_INTRINSIC_RENDERERS,
  collectCsExprUsings,
  renderCsExpr,
} from "./render-expr.js";
import {
  workflowStateClass,
  workflowStateDbSet,
  workflowStateTable,
} from "./workflow-state-emit.js";

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
  options?: { routePrefix?: string; sourcemap?: SourceMapRecorder; usingDapper?: boolean },
): void {
  const projections = (ctx.projections ?? []).filter(isQueryTimeProjection);
  if (projections.length === 0) return;
  const sourcemap = options?.sourcemap;
  const usingDapper = options?.usingDapper ?? false;
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
    const handlerContent = renderHandler(proj, ctx, ns, usingDapper);
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

function renderHandler(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  usingDapper: boolean,
): string {
  // The arm classification is SHARED with the Dapper capability gate
  // (`src/ir/util/query-projection-arm.ts`): the validator decides which
  // projections it may refuse from the same reading that decides which handler
  // is emitted, so a gate narrowed for one arm cannot silently apply to
  // another.  The ordering it encodes:
  //   - GROUPED (`group by`, M-T4.2) first — a grouped projection mixes per-row
  //     key selects with aggregates, so falling through would hand the per-row
  //     arm an unresolved aggregate;
  //   - then the WHOLE-TABLE aggregation (M-T1.3 Phase 0), which queries the
  //     table directly rather than through a repository, because the point of
  //     the shape is to materialise no rows;
  //   - then the workflow / folded-projection sources, which have no aggregate
  //     repository to read through (validation guarantees a non-event-sourced
  //     observable workflow / a materialized source, with no `join`/`ignoring`);
  //   - else the per-row arm below, which rides the aggregate's repository.
  switch (queryProjectionArm(proj)) {
    case "grouped":
      return renderGroupedHandler(proj, ctx, ns, usingDapper);
    case "singleton":
      return renderAggregateHandler(proj, ctx, ns, usingDapper);
    case "workflow":
      return renderWorkflowHandler(proj, ctx, ns, usingDapper);
    case "projection":
      return renderProjectionSourceHandler(proj, ctx, ns, usingDapper);
    default:
      break;
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

// ---------------------------------------------------------------------------
// The raw-Npgsql arms (`persistence: dapper`) — M-T6.25.
//
// Four of the five emission shapes read a TABLE rather than a repository, and
// those four were EF-LINQ over the concrete `AppDbContext`: under
// `persistence: dapper` neither the type nor the EF namespace exists, so the
// generated project did not compile and the IR validator refused the whole
// feature (`loom.dapper-unsupported`) rather than emit it.
//
// The port follows the FOLDED read controller's precedent exactly
// (`projection-emit.ts` → `renderProjectionsController`'s `usingDapper`
// branch): inject `NpgsqlDataSource`, open a connection, `QueryAsync<TDbRow>`
// a raw SELECT into a private row class whose properties are the snake column
// names, and map to the same values the EF path produced — so `csCoerce` /
// `projectToResponse` / the `<P>Row` construction are shared verbatim and the
// two adapters cannot drift on the wire shape.
//
// The predicate is lowered by `whereToSql`, the ONE predicate→SQL lowering
// this adapter has (finds, retrievals and capability filters all go through
// it).  Writing a second one here is how two dialects start disagreeing.
// ---------------------------------------------------------------------------

/** The persistence `using`s a direct-table handler needs. */
function qpPersistenceUsings(usingDapper: boolean): string {
  return usingDapper ? "using Dapper;\nusing Npgsql;" : "using Microsoft.EntityFrameworkCore;";
}

/** The `currentUser.<claim>` bindings a Dapper-rendered `where` needs.
 *
 *  `whereToSql` lowers `currentUser.<claim>` to the named parameter
 *  `@__cu_<claim>` and leaves BINDING it to the caller — the repository binds
 *  it from the ambient principal on every SELECT.  A handler that emitted the
 *  parameter without binding it would fail at RUNTIME ("parameter not
 *  supplied"), which is strictly worse than the EF path's failure for the same
 *  predicate (an unbound `currentUser` identifier, a C# compile error), so the
 *  binding is emitted here rather than gated away. */
function dapperFilterSeam(
  usingDapper: boolean,
  filter: ExprIR | undefined,
  ns: string,
  usings: Set<string>,
  /** Source-aggregate capability filters spliced into the same SELECT (the
   *  aggregation arms) — their principal claims bind through the same object. */
  capabilityFilters: readonly ExprIR[] = [],
): { needsPrincipal: boolean; paramArg: string } {
  const preds = [...(filter ? [filter] : []), ...capabilityFilters];
  if (!usingDapper || preds.length === 0) return { needsPrincipal: false, paramArg: "" };
  const refs = collectFilterPrincipalRefs(preds);
  if (refs.length === 0) return { needsPrincipal: false, paramArg: "" };
  usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  return {
    needsPrincipal: true,
    paramArg: `, new { ${principalFields(refs, "currentUser").join(", ")} }`,
  };
}

/** The source aggregate's capability filters (`tenantOwned`, `softDeletable`,
 *  any `filter <expr>`) that apply to an AGGREGATION read of `proj`, honouring
 *  its `ignoring <Cap>` / `ignoring *` clause.
 *
 *  An aggregation reads the source TABLE directly rather than through the
 *  repository, so on Dapper — which has no EF `HasQueryFilter` — nothing else
 *  applies them: the read counted rows every repository read of the same table
 *  excludes (cross-tenant with `tenantOwned`, a wrong number with
 *  `softDeletable`).  The EF arm inherits the model-level query filter and needs
 *  none of this.  A raw-table source (workflow saga state / folded `<Proj>Row`)
 *  has no source aggregate and so contributes nothing. */
function aggregationCapabilityFilters(proj: ProjectionIR, ctx: EnrichedBoundedContextIR): ExprIR[] {
  const agg = ctx.aggregates.find((a) => a.name === proj.query?.source);
  if (!agg) return [];
  const q = proj.query!;
  const bypassAll = q.bypassAll ?? false;
  const bypassCaps = q.bypassCaps ?? [];
  const origins = agg.contextFilterOrigins ?? [];
  // Only a CAPABILITY-contributed filter is bypassable; a bare/hand-written
  // one (`undefined` origin) always applies.
  return (agg.contextFilters ?? []).filter((_, i) => {
    const origin = origins[i];
    if (origin === undefined) return true;
    return !(bypassAll || bypassCaps.includes(origin));
  });
}

/** The Dapper `WHERE` body for an aggregation: the projection's own filter
 *  AND the applicable capability filters, each already parenthesised by
 *  `whereToSql`.  `undefined` ⇒ no `WHERE` at all. */
function dapperAggregationWhere(
  proj: ProjectionIR,
  capabilityFilters: readonly ExprIR[],
): string | undefined {
  const filter = proj.query!.filter;
  const parts = [...(filter ? [filter] : []), ...capabilityFilters].map((p) => {
    try {
      return whereToSql(p);
    } catch {
      throw new Error(
        `dapper: a filter on query-time projection '${proj.name}' is outside the Dapper SQL ` +
          `subset; use 'persistence: efcore' or simplify the predicate.`,
      );
    }
  });
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

/** True when this aggregate's DECLARED wire field crosses as a float64.
 *  #2563/RS-24: a `decimal` RESPONSE field is a JSON number, so .NET types it
 *  `double` (`wireType`).  `count` is an `int` and money/guid go out as
 *  formatted strings, so neither is affected. */
function aggregateLandsOnDouble(s: AggregateSelect, ctx: EnrichedBoundedContextIR): boolean {
  const c = aggregateCoercion(s);
  if (c.isCount || c.asString) return false;
  const target = wireType(s.type, ctx, "response");
  return target === "double" || target === "double?";
}

/** The Postgres aggregate call for one `select` — the raw-SQL twin of
 *  `csAggregate`.  `count` counts ROWS (no column) and casts to `int` so it
 *  lands on the same CLR type EF's `g.Count()` produces.
 *
 *  Every other operator casts to the SQL type whose Npgsql mapping IS the row
 *  DTO's CLR type, so nothing is converted in C#:
 *
 *    - a field that crosses as `double` (a declared `decimal`, #2563) casts to
 *      `double precision`;
 *    - everything else (money / guid → formatted string, `int`) casts to
 *      `numeric` and lands on `decimal`.
 *
 *  The `double precision` arm is load-bearing, not tidiness.  `numeric` maps to
 *  `System.Decimal`, and the `(double)` coercion that follows is a
 *  decimal→double conversion, which .NET rounds to **15 significant digits**:
 *  `avg` of 7/3 shipped `2.333333333333333` where every other backend ships the
 *  true nearest double `2.3333333333333335`, failing the wire-golden
 *  differential on the dapper leg alone (EF was green because its provider
 *  materialises `Average` as a real `double`).  Casting in SQL hands Npgsql a
 *  `float8` directly, and Postgres' own numeric→float8 conversion is correctly
 *  rounded — the same path node takes (numeric result → JS number).
 *
 *  Note the aggregate itself still computes in `numeric` (`avg`/`sum` over an
 *  `integer` or `numeric` column return `numeric`); only the RESULT is
 *  converted.  Casting the argument instead would move the accumulation into
 *  binary floating point and diverge from the other backends for real. */
function sqlAggregate(s: AggregateSelect, ctx: EnrichedBoundedContextIR): string {
  const agg = s.aggregate;
  if (agg.op === "count" || !agg.arg) return "count(*)::int";
  const arg = agg.arg;
  if (arg.kind !== "member") {
    throw new Error(
      "internal: a whole-table aggregation argument must be a source column reference",
    );
  }
  const cast = aggregateLandsOnDouble(s, ctx) ? "double precision" : "numeric";
  return `${agg.op}(${sqlIdent(snake(arg.member))})::${cast}`;
}

/** The CLR type the aggregate's aliased column lands on — the Npgsql mapping of
 *  the cast `sqlAggregate` emitted, so the two must move together. `count` is
 *  never NULL (0 rows counts 0); every other aggregate is NULL over no rows,
 *  which `csCoerce` turns into the declared field's zero (or keeps as null for
 *  an optional field). */
function sqlAggregateRowCs(s: AggregateSelect, ctx: EnrichedBoundedContextIR): string {
  const agg = s.aggregate;
  if (agg.op === "count" || !agg.arg) return "int";
  return aggregateLandsOnDouble(s, ctx) ? "double?" : "decimal?";
}

/** One grouping key as raw Postgres SQL — the column, or the catalogued
 *  transform applied to it.  The SAME snippet table `whereToSql` uses for a
 *  `where`-position intrinsic (`PG_INTRINSIC_SQL`), so the SELECT, GROUP BY and
 *  ORDER BY renderings are byte-identical to each other and to a predicate that
 *  names the same bucket. */
function sqlGroupKeyExpr(e: ExprIR, projName: string): string {
  const key = groupKeyOf(e);
  if (!key) {
    throw new Error(
      `internal: projection ${projName}: a group-by column must be a bare source column`,
    );
  }
  const col = sqlIdent(snake(key.column));
  if (key.transform === undefined) return col;
  const snippet = PG_INTRINSIC_SQL[GROUP_KEY_TRANSFORM_INTRINSIC[key.transform]];
  if (!snippet) {
    throw new Error(
      `internal: no Postgres rendering for grouping-key transform '${key.transform}'`,
    );
  }
  return snippet(col, []);
}

/** The row-DTO / SELECT-alias name for one grouping key.  Encodes the
 *  transform exactly as the EF anonymous member does (`placedAtStartOfDay`), so
 *  the same column grouped raw and grouped-by-day stay distinct members. */
function sqlGroupKeyAlias(e: ExprIR, projName: string): string {
  const key = groupKeyOf(e);
  if (!key) {
    throw new Error(
      `internal: projection ${projName}: a group-by column must be a bare source column`,
    );
  }
  return key.transform === undefined ? key.column : `${key.column}${upperFirst(key.transform)}`;
}

/** A private `<Name>` row class over the given Dapper columns — the raw-SELECT
 *  DTO, snake-named so Dapper's column→property match is exact.  The same
 *  shape the folded read controller and every Dapper repository emit. */
function dapperRowClass(name: string, cols: readonly DapperColumn[]): string {
  const props = cols
    .map(
      (c) => `        public ${c.rowCs} ${c.col} { get; set; }${c.nullable ? "" : " = default!;"}`,
    )
    .join("\n");
  return `    private sealed class ${name}\n    {\n${props}\n    }`;
}

/** A `Map` from the raw row DTO to the POCO the EF path materialises, so the
 *  projection expressions downstream are byte-identical across adapters.  Each
 *  column's `hydrate` already reads `r.<col>`, which is why the parameter is
 *  named `r`. */
function dapperRowMap(
  fnName: string,
  rowCls: string,
  pocoFqn: string,
  cols: readonly DapperColumn[],
): string {
  const inits = cols.map((c) => `        ${c.stateProp} = ${c.hydrate},`).join("\n");
  return `    private static ${pocoFqn} ${fnName}(${rowCls} r) => new()\n    {\n${inits}\n    };`;
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
  usingDapper: boolean,
): string {
  const aggregates = wholeTableAggregates(proj)!;
  const rowName = `${upperFirst(proj.name)}Row`;
  const queryName = `${upperFirst(proj.name)}QpQuery`;
  const handlerName = `${upperFirst(proj.name)}QpHandler`;
  const source = proj.query!.source!;
  const dbSet = plural(upperFirst(source));

  const usings = new Set<string>();
  const filter = proj.query!.filter;
  // EF hands the SAME C# predicate to its own translator; Dapper writes the
  // SQL itself, through the one predicate→SQL lowering this adapter already
  // has (`whereToSql`, shared with every Dapper find / retrieval / capability
  // filter).  A second lowering here would be a second dialect to keep true.
  const caps = usingDapper ? aggregationCapabilityFilters(proj, ctx) : [];
  const where = usingDapper
    ? dapperAggregationWhere(proj, caps)
    : filter
      ? renderCsExpr(filter, { thisName: "o", efQuery: true })
      : undefined;
  if (filter && !usingDapper) collectCsExprUsings(filter, usings);

  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }
  const seam = dapperFilterSeam(usingDapper, filter, ns, usings, caps);

  const dbType = usingDapper ? "NpgsqlDataSource" : "AppDbContext";
  const fields: string[] = [`    private readonly ${dbType} _db;`];
  const ctorParams: string[] = [`${dbType} db`];
  const ctorAssigns: string[] = [`_db = db`];
  if (requires && gateUsesUser) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  } else if (seam.needsPrincipal) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${dbType} db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }
  if (seam.needsPrincipal && !gateUsesUser)
    gate += `        var currentUser = _currentUser.User;\n`;

  const anyMoney = aggregates.some((s) => aggregateCoercion(s).asString);
  if (anyMoney) usings.add("System.Globalization");

  let members: string;
  let body: string;
  if (usingDapper) {
    // ONE `SELECT count(*), sum(…) …` with no GROUP BY, so Postgres always
    // returns exactly one row (count 0 / NULL sums over an empty table) —
    // `QuerySingleAsync`, not `…OrDefault`.  Each aggregate is aliased to its
    // wire field's snake name, which is also the row property name, so Dapper's
    // column→property match is exact.
    const cols = aggregates.map((s) => `${sqlAggregate(s, ctx)} AS ${sqlIdent(snake(s.field))}`);
    members = aggregates
      .map((s) => `        public ${sqlAggregateRowCs(s, ctx)} ${snake(s.field)} { get; set; }`)
      .join("\n");
    const sql = `SELECT ${cols.join(", ")} FROM ${sqlIdent(dapperAggregateTable(source))}${
      where ? ` WHERE ${where}` : ""
    }`;
    const args = aggregates.map((s) => csCoerce(s, `agg`, ctx, snake(s.field))).join(", ");
    body =
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);\n` +
      `        var agg = await conn.QuerySingleAsync<AggRow>(new CommandDefinition("${sql}"${seam.paramArg}, cancellationToken: cancellationToken));\n` +
      `        return new ${rowName}(${args});\n`;
  } else {
    // The anonymous projection the grouped query selects; each member is named
    // after its wire field so the row construction below reads plainly.
    const anon = aggregates
      .map((s) => `${upperFirst(s.field)} = ${csAggregate(s.aggregate)}`)
      .join(", ");
    const args = aggregates.map((s) => csCoerce(s, `agg`, ctx)).join(", ");
    members = "";
    body =
      `        var agg = await _db.${dbSet}.AsNoTracking()${where ? `.Where(o => ${where})` : ""}\n` +
      `            .GroupBy(_ => 1)\n` +
      `            .Select(g => new { ${anon} })\n` +
      `            .FirstOrDefaultAsync(cancellationToken);\n` +
      `        return new ${rowName}(${args});\n`;
  }
  const rowDecl = usingDapper
    ? `    private sealed class AggRow\n    {\n${members}\n    }\n\n`
    : "";

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
${qpPersistenceUsings(usingDapper)}
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

${rowDecl}    public async ValueTask<${rowName}> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}${body}    }
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
  usingDapper: boolean,
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
  // Same capability-filter splice as the singleton arm — see
  // `aggregationCapabilityFilters`.
  const caps = usingDapper ? aggregationCapabilityFilters(proj, ctx) : [];
  const where = usingDapper
    ? dapperAggregationWhere(proj, caps)
    : filter
      ? renderCsExpr(filter, { thisName: "o", efQuery: true })
      : undefined;
  if (filter && !usingDapper) collectCsExprUsings(filter, usings);

  // Authorization gate (default-deny) — same shape as the singleton arm.
  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }
  const seam = dapperFilterSeam(usingDapper, filter, ns, usings, caps);

  const dbType = usingDapper ? "NpgsqlDataSource" : "AppDbContext";
  const fields: string[] = [`    private readonly ${dbType} _db;`];
  const ctorParams: string[] = [`${dbType} db`];
  const ctorAssigns: string[] = [`_db = db`];
  if ((requires && gateUsesUser) || seam.needsPrincipal) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${dbType} db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }
  if (seam.needsPrincipal && !gateUsesUser)
    gate += `        var currentUser = _currentUser.User;\n`;

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
  // The Dapper row DTO's column per SELECTED key — `fieldColumn` off the key's
  // DECLARED type, named for the SQL alias, so its `rowCs`/`hydrate` are the
  // same pair every Dapper reader uses (a `text` enum column parses back to the
  // enum, an id column re-wraps into `<Target>Id`) and `projectToResponse` then
  // sees exactly what EF's `x.Status` handed it.
  const keyDbCol = (k: GroupKeySelect): DapperColumn =>
    fieldColumn({ name: sqlGroupKeyAlias(k.expr, proj.name), type: k.type, optional: false });
  const args = (proj.wireShape ?? []).map((f) => {
    const key = keyByField.get(f.name);
    if (key) {
      // Reads the SAME member the GROUP BY declared — so a computed key's
      // select and its grouping can't drift apart.
      return projectToResponse(
        usingDapper ? keyDbCol(key).hydrate : `x.${groupCol(key.expr).member}`,
        key.type,
        ctx,
      );
    }
    const agg = aggByField.get(f.name);
    if (agg)
      return csCoerce(
        agg,
        usingDapper ? "r" : "x",
        ctx,
        usingDapper ? snake(agg.field) : undefined,
      );
    return "default!";
  });
  const anyMoney = grouped.aggregates.some((s) => aggregateCoercion(s).asString);
  if (anyMoney) usings.add("System.Globalization");

  // The raw-SQL grouped query: SELECT the keys that are projected plus every
  // aggregate, GROUP BY / ORDER BY the grouping EXPRESSIONS themselves (not the
  // aliases — a grouping column may be grouped without being selected, and
  // Postgres matches a grouped select against the GROUP BY expression
  // syntactically, which is what makes the computed `date_trunc` bucket agree
  // in all three clause positions).
  const groupExprs = [...new Set(grouped.groupBy.map((e) => sqlGroupKeyExpr(e, proj.name)))];
  const selectSql = [
    ...grouped.keys.map((k) => {
      const alias = sqlIdent(snake(sqlGroupKeyAlias(k.expr, proj.name)));
      const expr = sqlGroupKeyExpr(k.expr, proj.name);
      return expr === alias ? alias : `${expr} AS ${alias}`;
    }),
    ...grouped.aggregates.map((s) => `${sqlAggregate(s, ctx)} AS ${sqlIdent(snake(s.field))}`),
  ].join(", ");
  const groupSql =
    `SELECT ${selectSql} FROM ${sqlIdent(dapperAggregateTable(source))}` +
    `${where ? ` WHERE ${where}` : ""}` +
    ` GROUP BY ${groupExprs.join(", ")} ORDER BY ${groupExprs.join(", ")}`;
  const groupRowDecl = usingDapper
    ? `${dapperRowClass("GroupRow", [
        ...grouped.keys.map(keyDbCol),
        ...grouped.aggregates.map((s) => ({
          col: snake(s.field),
          sql: "",
          nullable: true,
          rowCs: sqlAggregateRowCs(s, ctx),
          cast: "",
          save: "",
          stateProp: "",
          hydrate: "",
        })),
      ])}\n\n`
    : "";
  const groupBody = usingDapper
    ? `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);\n` +
      `        var groups = await conn.QueryAsync<GroupRow>(new CommandDefinition("${groupSql}"${seam.paramArg}, cancellationToken: cancellationToken));\n` +
      `        return groups.Select(r => new ${rowName}(${args.join(", ")})).ToList();\n`
    : `        var groups = await _db.${dbSet}.AsNoTracking()${where ? `.Where(o => ${where})` : ""}\n` +
      `            .GroupBy(o => new { ${cols.map((c) => c.decl).join(", ")} })\n` +
      `            .Select(g => new { ${members} })\n` +
      `            ${orderBy}\n` +
      `            .ToListAsync(cancellationToken);\n` +
      `        return groups.Select(x => new ${rowName}(${args.join(", ")})).ToList();\n`;

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
${qpPersistenceUsings(usingDapper)}
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

${groupRowDecl}    public async ValueTask<IReadOnlyList<${rowName}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}${groupBody}    }
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
function csCoerce(
  s: AggregateSelect,
  aggVar: string,
  ctx: EnrichedBoundedContextIR,
  /** The member the aggregate landed on.  EF names its anonymous-type member
   *  after the wire field (`Orders`); the Dapper row DTO is snake-named after
   *  the SQL alias (`orders`).  Same coercion either way. */
  member: string = upperFirst(s.field),
): string {
  const c = aggregateCoercion(s);
  const read = `${aggVar}?.${member}`;
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
  usingDapper: boolean,
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
  const where = filter
    ? usingDapper
      ? whereToSql(filter)
      : renderCsExpr(filter, { thisName: "r", efQuery: true })
    : undefined;
  if (filter && !usingDapper) collectCsExprUsings(filter, usings);
  for (const s of proj.query!.selects ?? []) collectCsExprUsings(s.expr, usings);

  // Authorization gate (default-deny) — same shape as the aggregate handler.
  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }
  const seam = dapperFilterSeam(usingDapper, filter, ns, usings);

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

  // Ctor injects the persistence handle (not an aggregate repo), plus the
  // request principal when a `currentUser` gate is present.
  const dbType = usingDapper ? "NpgsqlDataSource" : "AppDbContext";
  const fields: string[] = [`    private readonly ${dbType} _db;`];
  const ctorParams: string[] = [`${dbType} db`];
  const ctorAssigns: string[] = [`_db = db`];
  if ((requires && gateUsesUser) || seam.needsPrincipal) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${dbType} db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }
  if (seam.needsPrincipal && !gateUsesUser)
    gate += `        var currentUser = _currentUser.User;\n`;

  // Dapper reads the SAME saga-state table the store writes, SELECTing every
  // state column into a private row DTO and mapping it back to the state POCO
  // through each column's `hydrate` — so the `select` projections above (which
  // read domain-typed members off `r`) are byte-identical across adapters.
  const stateCols = dapperWorkflowStateColumns(wf, false);
  const pocoFqn = `global::${ns}.Application.Workflows.${workflowStateClass(wf)}`;
  const rowDecl = usingDapper
    ? `${dapperRowClass("StateDbRow", stateCols)}\n${dapperRowMap("MapState", "StateDbRow", pocoFqn, stateCols)}\n\n`
    : "";
  const stateSql = `SELECT ${stateCols.map((c) => sqlIdent(c.col)).join(", ")} FROM ${sqlIdent(workflowStateTable(wf))}${
    where ? ` WHERE ${where}` : ""
  }`;
  const body = usingDapper
    ? `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);\n` +
      `        var __rows = await conn.QueryAsync<StateDbRow>(new CommandDefinition("${stateSql}"${seam.paramArg}, cancellationToken: cancellationToken));\n` +
      `        return __rows.Select(MapState).Select(r => ${projection}).ToList();\n`
    : `        var rows = await _db.${dbSet}.AsNoTracking()${where ? `.Where(r => ${where})` : ""}.ToListAsync(cancellationToken);\n` +
      `        return rows.Select(r => ${projection}).ToList();\n`;

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
${qpPersistenceUsings(usingDapper)}
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

${rowDecl}    public async ValueTask<IReadOnlyList<${rowName}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}${body}    }
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
  usingDapper: boolean,
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
  const where = filter
    ? usingDapper
      ? whereToSql(filter)
      : renderCsExpr(filter, { thisName: "r", efQuery: true })
    : undefined;
  if (filter && !usingDapper) collectCsExprUsings(filter, usings);
  for (const s of proj.query!.selects ?? []) collectCsExprUsings(s.expr, usings);

  // Authorization gate (default-deny) — same shape as the aggregate/workflow handler.
  const requires = proj.query!.requires;
  const gateUsesUser = exprUsesCurrentUser(requires);
  if (requires) {
    collectCsExprUsings(requires, usings);
    usings.add(`${ns}.Domain.Common`); // ForbiddenException
    if (gateUsesUser) usings.add(`${ns}.Auth`); // ICurrentUserAccessor
  }
  const seam = dapperFilterSeam(usingDapper, filter, ns, usings);

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

  // Ctor injects the persistence handle (not an aggregate repo), plus the
  // request principal when a `currentUser` gate is present.
  const dbType = usingDapper ? "NpgsqlDataSource" : "AppDbContext";
  const fields: string[] = [`    private readonly ${dbType} _db;`];
  const ctorParams: string[] = [`${dbType} db`];
  const ctorAssigns: string[] = [`_db = db`];
  if ((requires && gateUsesUser) || seam.needsPrincipal) {
    fields.push(`    private readonly ICurrentUserAccessor _currentUser;`);
    ctorParams.push(`ICurrentUserAccessor currentUser`);
    ctorAssigns.push(`_currentUser = currentUser`);
  }
  const ctor =
    ctorParams.length === 1
      ? `    public ${handlerName}(${dbType} db) => _db = db;`
      : `    public ${handlerName}(${ctorParams.join(", ")})\n    {\n        ${ctorAssigns.join(";\n        ")};\n    }`;

  let gate = "";
  if (requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: projection ${proj.name}`,
    )});\n`;
  }
  if (seam.needsPrincipal && !gateUsesUser)
    gate += `        var currentUser = _currentUser.User;\n`;

  // Dapper reads the SAME read-model table the fold store upserts, SELECTing
  // every column into a private row DTO and mapping it back to the `<Proj>Row`
  // POCO — so `projectSourceRowArg`'s nullable unwrapping (which reasons about
  // the POCO's nullable columns) is shared verbatim with the EF path.
  const srcCols = dapperProjectionColumns(src);
  const pocoFqn = `global::${ns}.Infrastructure.Persistence.Projections.${projectionRowClass(src)}`;
  const rowDecl = usingDapper
    ? `${dapperRowClass("SourceDbRow", srcCols)}\n${dapperRowMap("MapSource", "SourceDbRow", pocoFqn, srcCols)}\n\n`
    : "";
  const srcSql = `SELECT ${srcCols.map((c) => sqlIdent(c.col)).join(", ")} FROM ${sqlIdent(projectionRowTable(src))}${
    where ? ` WHERE ${where}` : ""
  }`;
  const body = usingDapper
    ? `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);\n` +
      `        var __rows = await conn.QueryAsync<SourceDbRow>(new CommandDefinition("${srcSql}"${seam.paramArg}, cancellationToken: cancellationToken));\n` +
      `        return __rows.Select(MapSource).Select(r => ${projection}).ToList();\n`
    : `        var rows = await _db.${dbSet}.AsNoTracking()${where ? `.Where(r => ${where})` : ""}.ToListAsync(cancellationToken);\n` +
      `        return rows.Select(r => ${projection}).ToList();\n`;

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;${extraUsings ? "\n" + extraUsings : ""}
${qpPersistenceUsings(usingDapper)}
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

${rowDecl}    public async ValueTask<IReadOnlyList<${rowName}>> Handle(${queryName} query, CancellationToken cancellationToken)
    {
${gate}${body}    }
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
