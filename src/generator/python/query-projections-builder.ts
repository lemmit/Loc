import type {
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionAggregateIR,
  ProjectionIR,
  WireField,
} from "../../ir/types/loom-ir.js";
import { isQueryTimeProjection, queryProjectionUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { tableOwnerName } from "../../ir/util/inheritance.js";
import {
  type AggregateSelect,
  aggregateCoercion,
  wholeTableAggregates,
} from "../../ir/util/projection-aggregate.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { responsePyType } from "./emit/http-models.js";
import {
  lowerProjectionFilterToSqlAlchemy,
  lowerToSqlAlchemy,
  lowerWorkflowFilterToSqlAlchemy,
  type PyPredicate,
} from "./find-predicate.js";
import { rowClassName } from "./py-columns.js";
import { renderPyExpr, renderPyNegatedGuard } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Query-time projection routes — `app/http/query_projections_routes.py`,
// mounted at `/projections` (read-path-architecture.md rev.13).
//
// A QUERY-TIME projection (`from <Agg> where … join … select …`, no folds) is
// the always-current read model of the query-time projection read.  It reads the
// SAME way: the source aggregate's repository synthesises a parameterless
// `repo.<projName>()` find from the `where` (repository-builder.ts), the route
// bulk-loads every `join` follow (`query.auxiliaries`) via that aggregate's
// repository, and projects each row through the `select` expressions — a join
// binds an ALIAS (`c`) to the loaded-by-id map, so `select … = c.name` reads
// `<map>[str(<idRow>)].name`.  The Python twin of the Hono
// `projection-query-routes-builder.ts`.
// ---------------------------------------------------------------------------

export function buildPyQueryProjectionsFile(
  ctx: EnrichedBoundedContextIR,
  hasDispatch = false,
): string | null {
  const projections = (ctx.projections ?? []).filter(isQueryTimeProjection);
  if (projections.length === 0) return null;

  const dispatcherExpr = hasDispatch ? "make_dispatcher(session)" : "NoopDomainEventDispatcher()";

  // A `from <Workflow>` projection reads the workflow's persisted saga-state
  // table (`<Wf>Row`) directly — workflows have no repository — applying the
  // `where` in SQL and projecting instance fields via `select`.  Lower each
  // one's filter once (reused by the route + the SQLAlchemy-op import scan).
  const wfByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));
  const isWorkflowSourced = (p: ProjectionIR): boolean =>
    p.query?.sourceKind === "workflow" && !!p.query.source && wfByName.has(p.query.source);
  // A `from <Projection>` projection reads the SOURCE folded projection's
  // persisted `<Proj>Row` read-model table directly — folded projections have
  // no repository — applying the `where` in SQL and projecting the source row's
  // fields via `select`.  The structural twin of the workflow-sourced route.
  const projByName = new Map(ctx.projections.map((p) => [p.name, p] as const));
  const isProjectionSourced = (p: ProjectionIR): boolean =>
    p.query?.sourceKind === "projection" && !!p.query.source && projByName.has(p.query.source);
  const rowLowered = new Map<string, PyPredicate | null>();
  for (const p of projections) {
    if (isWorkflowSourced(p)) {
      const wf = wfByName.get(p.query!.source!)!;
      rowLowered.set(
        p.name,
        p.query!.filter ? lowerWorkflowFilterToSqlAlchemy(p.query!.filter, wf) : null,
      );
    } else if (isProjectionSourced(p)) {
      rowLowered.set(
        p.name,
        p.query!.filter
          ? lowerProjectionFilterToSqlAlchemy(p.query!.filter, p.query!.source!)
          : null,
      );
    }
  }

  const models = projections.map((p) => projectionRowModels(p, ctx)).join("");
  // WHOLE-TABLE AGGREGATION takes precedence over every other shape: it queries
  // the table directly, never through a repository, because the point of the
  // shape is to materialise no rows at all.  Its `where` lowers here so a
  // filtered aggregation keeps its filter (mirrors `rowLowered` above).
  const aggLowered = new Map<string, PyPredicate | null>();
  for (const p of projections) {
    if (!wholeTableAggregates(p) || !p.query?.source) continue;
    const agg = ctx.aggregates.find((a) => a.name === p.query!.source);
    aggLowered.set(
      p.name,
      agg && p.query.filter ? lowerToSqlAlchemy(p.query.filter, agg, ctx) : null,
    );
  }
  const routeBlocks = projections.map((p) =>
    wholeTableAggregates(p)
      ? aggregateProjectionRoute(p, ctx, aggLowered.get(p.name) ?? null)
      : isWorkflowSourced(p) || isProjectionSourced(p)
        ? rowSourcedProjectionRoute(p, `${p.query!.source!}Row`, rowLowered.get(p.name) ?? null)
        : projectionRoute(p, dispatcherExpr, ctx),
  );
  const body = `${models}router = APIRouter(prefix="/projections", tags=["projections"])\n\n\n${routeBlocks.join("\n\n\n")}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);

  // Repos touched: the query source + every join follow target.  A WORKFLOW or
  // PROJECTION source reads its persisted row table directly (no repository), so
  // it never contributes a repository import.
  const repoAggs = [
    ...new Set(
      projections.flatMap((p) => [
        // An AGGREGATION queries the table directly — no repository — so it
        // must not drag in a repo import ruff would flag as unused (F401).
        ...(p.query?.source &&
        !isWorkflowSourced(p) &&
        !isProjectionSourced(p) &&
        !wholeTableAggregates(p)
          ? [p.query.source]
          : []),
        ...(p.query?.auxiliaries ?? []).map((a) => a.aggName),
      ]),
    ),
  ].sort();
  // Persisted row classes read from `app.db.schema` (one per workflow saga-state
  // source and one per folded-projection read-model source), plus the SQLAlchemy
  // helpers a row-sourced projection route calls: `select` for the row read + any
  // `and_`/`or_`/`not_`/`func` its lowered filter needs.
  const rowSourcedProjections = projections.filter(
    (p) => isWorkflowSourced(p) || isProjectionSourced(p),
  );
  const aggregatingProjections = projections.filter((p) => wholeTableAggregates(p) !== null);
  const schemaRows = [
    ...new Set([
      ...rowSourcedProjections.map((p) => `${p.query!.source!}Row`),
      // An aggregation names the SOURCE aggregate's ORM row class as a value
      // (`select(func.count()).select_from(OrderRow)`), so it needs the same
      // `app.db.schema` import a raw-table source does.
      ...aggregatingProjections.map((p) => rowClassName(p.query!.source!)),
    ]),
  ]
    .filter(refersTo)
    .sort();
  const saOps = new Set<string>(
    rowSourcedProjections.length + aggregatingProjections.length > 0 ? ["select"] : [],
  );
  if (aggregatingProjections.length > 0) saOps.add("func");
  for (const pred of rowLowered.values()) for (const op of pred?.ops ?? []) saOps.add(op);
  for (const pred of aggLowered.values()) for (const op of pred?.ops ?? []) saOps.add(op);
  const saNames = [...saOps].filter(refersTo).sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();

  return lines(
    `"""Query-time projection routes.  Auto-generated."""`,
    "",
    `from fastapi import ${["APIRouter", "Depends", refersTo("Request") ? "Request" : null].filter(Boolean).join(", ")}`,
    // `RootModel` wraps a LIST response; a singleton aggregation's response is
    // the row itself, so a file of only aggregations must not import it (F401).
    projections.some((p) => wholeTableAggregates(p) === null)
      ? "from pydantic import BaseModel, RootModel"
      : "from pydantic import BaseModel",
    saNames.length > 0 ? `from sqlalchemy import ${saNames.join(", ")}` : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    // A `requires` auth gate (or a currentUser-scoped where/select) binds the
    // request principal — `current_user: User` off the request scope — and a
    // failing gate raises `ForbiddenError` (→ 403) before the query runs.
    refersTo("User") ? "from app.auth.user import User" : null,
    "from app.db.engine import get_session",
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    schemaRows.length > 0 ? `from app.db.schema import ${schemaRows.join(", ")}` : null,
    refersTo("ForbiddenError") ? "from app.domain.errors import ForbiddenError" : null,
    hasDispatch && refersTo("make_dispatcher") ? "from app.dispatch import make_dispatcher" : null,
    !hasDispatch && refersTo("NoopDomainEventDispatcher")
      ? "from app.domain.events import NoopDomainEventDispatcher"
      : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    "",
    "SessionDep = Annotated[AsyncSession, Depends(get_session)]",
    "",
    "",
    body,
    "",
  );
}

/** The projection's `<Proj>Row` / `<Proj>Response` DTOs — from its `wireShape`
 *  (the declared row shape), id-source columns as `str`. */
function projectionRowModels(proj: ProjectionIR, ctx: EnrichedBoundedContextIR): string {
  const fieldLines = (proj.wireShape ?? []).map((f: WireField) => {
    const t = f.source === "id" ? "str" : responsePyType(f.type, ctx);
    const optional = f.optional || f.type.kind === "optional";
    const suffix = optional && !t.endsWith("| None") ? " | None = None" : optional ? " = None" : "";
    return `    ${f.name}: ${t}${suffix}`;
  });
  // A whole-table aggregation yields ONE row, so its response is the row
  // itself — not a list of one.  (The list wrapper on a singleton was the shape
  // that made `select orders = count()` look like a list of counts.)
  const singleton = wholeTableAggregates(proj) !== null;
  return lines(
    `class ${proj.name}Row(BaseModel):`,
    fieldLines.length > 0 ? fieldLines : ["    pass"],
    "",
    "",
    singleton
      ? `class ${proj.name}Response(${proj.name}Row):`
      : `class ${proj.name}Response(RootModel[list[${proj.name}Row]]):`,
    "    pass",
    "",
    "",
  );
}

/** `GET /projections/<name>`: source rows via the synthesised repo find,
 *  bulk-load each `join` follow, then project each row through `select`.
 *
 *  Shorthand form (`from <Agg> where …`, no declared fields / no `select`): the
 *  enriched `wireShape` already equals the source aggregate's full wire shape, so
 *  each row is just the aggregate's OWN domain→wire serialization — `repo.to_wire(r)`
 *  — exactly what the aggregate's findAll route returns per row. No per-`select`
 *  projection dict is built. */
function projectionRoute(
  proj: ProjectionIR,
  dispatcherExpr: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const source = proj.query!.source!;
  const isShorthand =
    (proj.query!.selects?.length ?? 0) === 0 && !!ctx.aggregates.find((a) => a.name === source);
  const fn = snake(proj.name);
  // A `requires` gate (default-deny) — or a currentUser-scoped where/select —
  // binds the request principal off the request scope; a failing gate raises
  // ForbiddenError (→ 403) BEFORE the query runs, the read-side twin of a find
  // `requires` gate.
  const gate = proj.query!.requires;
  const needsUser = queryProjectionUsesCurrentUser(proj) || !!gate;
  const sig = [...(needsUser ? ["request: Request"] : []), "session: SessionDep"].join(", ");
  const out: string[] = [
    `@router.get("/${fn}", response_model=${proj.name}Response, operation_id="projection${proj.name}")`,
    `async def ${fn}_projection(${sig}) -> list[dict[str, object]]:`,
    needsUser ? "    current_user: User = request.state.current_user" : null,
    ...(gate
      ? [
          // renderPyNegatedGuard: a `.contains(...)` membership gate emits
          // `x not in y`, not `not (x in y)` (ruff E713).
          `    if ${renderPyNegatedGuard(gate)}:`,
          `        raise ForbiddenError(${JSON.stringify(`Forbidden: projection ${proj.name}`)})`,
        ]
      : []),
    `    repo = ${source}Repository(session, ${dispatcherExpr})`,
    `    rows = await repo.${fn}()`,
  ].filter((l): l is string => l != null);
  // join alias → { mapVar, idRow } and the bulk-load lines (dependency order).
  const aliasMap = new Map<string, { mapVar: string; idRow: string }>();
  const joins = proj.query!.joins;
  const auxes = proj.query!.auxiliaries;
  for (let i = 0; i < auxes.length; i++) {
    const aux = auxes[i]!;
    const join = joins[i];
    const mapVar = snake(aux.mapVar);
    const repoVar = `${snake(aux.aggName)}_repo`;
    out.push(`    ${repoVar} = ${aux.aggName}Repository(session, ${dispatcherExpr})`);
    // First hop reads the source aggregate rows (proper id types); later hops
    // read hydrated aggregates from the prior map.
    const idsSource =
      aux.path.length === 1
        ? `[r.${snake(aux.path[0]!)} for r in rows]`
        : (() => {
            const prev = aliasMap.get(joins[i - 1]?.alias ?? "");
            const finalField = snake(aux.path[aux.path.length - 1]!);
            return prev ? `[a.${finalField} for a in ${prev.mapVar}.values()]` : "[]";
          })();
    out.push(
      `    ${mapVar} = {str(a.id): a for a in await ${repoVar}.find_many_by_ids(${idsSource})}`,
    );
    if (join)
      aliasMap.set(join.alias, { mapVar, idRow: renderPyExpr(join.idRef, { thisName: "r" }) });
  }
  if (isShorthand) {
    // No declared fields / no `select`: each row is the source aggregate's own
    // domain→wire serialization, which equals `<Proj>Row` (same field
    // names/order/types, since `wireShape` was enriched to the aggregate's).
    out.push("    return [repo.to_wire(r) for r in rows]");
    return out.join("\n");
  }
  out.push("    return [");
  out.push("        {");
  for (const s of proj.query!.selects ?? []) {
    out.push(`            "${s.field}": ${renderProjectionSelect(s.expr, aliasMap)},`);
  }
  out.push("        }");
  out.push("        for r in rows");
  out.push("    ]");
  return out.join("\n");
}

/** `GET /projections/<name>` for a WHOLE-TABLE AGGREGATION (M-T1.3 Phase 0):
 *  one SQL query with `COUNT(*)`/`SUM(...)` over the source table, no rows
 *  materialised.  The shape exists precisely to avoid the naive read — a
 *  `SELECT *` over the whole table with every row rehydrated into a domain
 *  object to produce one integer, which is the scaling failure M-T2.6 removed
 *  from `findAll`.  One row out, so the response is the row itself. */
function aggregateProjectionRoute(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  pred: PyPredicate | null,
): string {
  const aggregates = wholeTableAggregates(proj)!;
  const source = proj.query!.source!;
  const agg = ctx.aggregates.find((a) => a.name === source);
  // TPH concretes query the base's shared table — the same owner rule the
  // filter lowering uses, so the `where` and the `select_from` can't disagree.
  const row = rowClassName(agg ? tableOwnerName(agg, ctx.aggregates) : source);
  const fn = snake(proj.name);
  const gate = proj.query!.requires;
  const needsUser = queryProjectionUsesCurrentUser(proj) || !!gate;
  const sig = [...(needsUser ? ["request: Request"] : []), "session: SessionDep"].join(", ");
  const cols = aggregates.map((s) => pyAggregate(s.aggregate, row)).join(", ");
  const where = pred ? `.where(${pred.expr})` : "";
  const out: string[] = [
    `@router.get("/${fn}", response_model=${proj.name}Response, operation_id="projection${proj.name}")`,
    `async def ${fn}_projection(${sig}) -> dict[str, object]:`,
    needsUser ? "    current_user: User = request.state.current_user" : null,
    ...(gate
      ? [
          `    if ${renderPyNegatedGuard(gate)}:`,
          `        raise ForbiddenError(${JSON.stringify(`Forbidden: projection ${proj.name}`)})`,
        ]
      : []),
    `    row = (await session.execute(select(${cols}).select_from(${row})${where})).one()`,
    "    return {",
    ...aggregates.map((s, i) => `        "${s.field}": ${pyCoerce(s, `row[${i}]`)},`),
    "    }",
  ].filter((l): l is string => l != null);
  return out.join("\n");
}

/** The SQLAlchemy aggregate call for one `select`.  `count` counts ROWS (no
 *  column — `COUNT(*)`); the rest take the aggregated column, which is
 *  source-row-rooted so it names the ORM row class's attribute. */
function pyAggregate(agg: ProjectionAggregateIR, row: string): string {
  if (agg.op === "count" || !agg.arg) return "func.count()";
  const arg = agg.arg;
  if (arg.kind !== "member") {
    throw new Error(
      "internal: a whole-table aggregation argument must be a source column reference",
    );
  }
  return `func.${agg.op}(${row}.${snake(arg.member)})`;
}

/** Coerce one aggregate result to the projection row's declared wire type.
 *  Postgres returns `numeric` aggregates as `Decimal`/`None` through asyncpg,
 *  so this is load-bearing: an uncoerced `sum` would fail the response model
 *  over an empty table, or ship a Decimal where the row declares a string. */
function pyCoerce(s: AggregateSelect, expr: string): string {
  const c = aggregateCoercion(s);
  if (c.isCount) return `int(${expr} or 0)`;
  if (c.optional) return `None if ${expr} is None else ${c.asString ? "str" : "float"}(${expr})`;
  return c.asString ? `str(${expr} or "0")` : `float(${expr} or 0)`;
}

/** `GET /projections/<name>` for a `from <Workflow>` / `from <Projection>`
 *  projection: read the source's persisted row table (`<Wf>Row` saga-state, or a
 *  folded projection's `<Proj>Row` read-model) directly — neither source has a
 *  repository — with the `where` pushed to SQL, then project each row's fields
 *  through `select` (the candidate alias → the row var `r`).  A validated
 *  workflow/projection source carries no `join`/`ignoring`, so there is no
 *  bulk-load / alias-map step. */
function rowSourcedProjectionRoute(
  proj: ProjectionIR,
  row: string,
  pred: PyPredicate | null,
): string {
  const fn = snake(proj.name);
  const where = pred ? `.where(${pred.expr})` : "";
  // A `requires` gate (default-deny) — or a currentUser-scoped select — binds the
  // request principal off the request scope; a failing gate raises ForbiddenError
  // (→ 403) BEFORE the saga read runs.
  const gate = proj.query!.requires;
  const needsUser = queryProjectionUsesCurrentUser(proj) || !!gate;
  const sig = [...(needsUser ? ["request: Request"] : []), "session: SessionDep"].join(", ");
  const out: string[] = [
    `@router.get("/${fn}", response_model=${proj.name}Response, operation_id="projection${proj.name}")`,
    `async def ${fn}_projection(${sig}) -> list[dict[str, object]]:`,
    needsUser ? "    current_user: User = request.state.current_user" : null,
    ...(gate
      ? [
          // renderPyNegatedGuard: a `.contains(...)` membership gate emits
          // `x not in y`, not `not (x in y)` (ruff E713).
          `    if ${renderPyNegatedGuard(gate)}:`,
          `        raise ForbiddenError(${JSON.stringify(`Forbidden: projection ${proj.name}`)})`,
        ]
      : []),
    `    rows = (await session.execute(select(${row})${where})).scalars().all()`,
    "    return [",
    "        {",
    ...(proj.query!.selects ?? []).map(
      (s) => `            "${s.field}": ${renderPyExpr(s.expr, { thisName: "r" })},`,
    ),
    "        }",
    "        for r in rows",
    "    ]",
  ].filter((l): l is string => l != null);
  return out.join("\n");
}

/** Render a `select` expression against the source row `r` + join alias maps.
 *  A member access on a join alias (`c.name`) → `<map>[str(<idRow>)].name`;
 *  source reads (`o.id`, bare fields) lower to `this` and render off `r`. */
function renderProjectionSelect(
  expr: ExprIR,
  aliasMap: Map<string, { mapVar: string; idRow: string }>,
): string {
  if (expr.kind === "member" && expr.receiver.kind === "ref") {
    const alias = aliasMap.get(expr.receiver.name);
    if (alias) return `${alias.mapVar}[str(${alias.idRow})].${snake(expr.member)}`;
  }
  return renderPyExpr(expr, { thisName: "r" });
}
