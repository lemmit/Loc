import type {
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
  WireField,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { isQueryTimeProjection, queryProjectionUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { responsePyType } from "./emit/http-models.js";
import { lowerWorkflowFilterToSqlAlchemy, type PyPredicate } from "./find-predicate.js";
import { renderPyExpr } from "./render-expr.js";

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
  const wfLowered = new Map<string, PyPredicate | null>();
  for (const p of projections) {
    if (!isWorkflowSourced(p)) continue;
    const wf = wfByName.get(p.query!.source!)!;
    wfLowered.set(
      p.name,
      p.query!.filter ? lowerWorkflowFilterToSqlAlchemy(p.query!.filter, wf) : null,
    );
  }

  const models = projections.map((p) => projectionRowModels(p, ctx)).join("");
  const routeBlocks = projections.map((p) =>
    isWorkflowSourced(p)
      ? workflowProjectionRoute(p, wfByName.get(p.query!.source!)!, wfLowered.get(p.name) ?? null)
      : projectionRoute(p, dispatcherExpr),
  );
  const body = `${models}router = APIRouter(prefix="/projections", tags=["projections"])\n\n\n${routeBlocks.join("\n\n\n")}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);

  // Repos touched: the query source + every join follow target.  A WORKFLOW
  // source reads its saga-state table directly (no repository), so it never
  // contributes a repository import.
  const repoAggs = [
    ...new Set(
      projections.flatMap((p) => [
        ...(p.query?.source && !isWorkflowSourced(p) ? [p.query.source] : []),
        ...(p.query?.auxiliaries ?? []).map((a) => a.aggName),
      ]),
    ),
  ].sort();
  // Saga-state row classes read from `app.db.schema` (one per workflow source),
  // plus the SQLAlchemy helpers a workflow-projection route calls: `select` for
  // the saga read + any `and_`/`or_`/`not_`/`func` its lowered filter needs.
  const wfProjections = projections.filter(isWorkflowSourced);
  const schemaRows = [...new Set(wfProjections.map((p) => `${p.query!.source!}Row`))]
    .filter(refersTo)
    .sort();
  const saOps = new Set<string>(wfProjections.length > 0 ? ["select"] : []);
  for (const pred of wfLowered.values()) for (const op of pred?.ops ?? []) saOps.add(op);
  const saNames = [...saOps].filter(refersTo).sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();

  return lines(
    `"""Query-time projection routes.  Auto-generated."""`,
    "",
    `from fastapi import ${["APIRouter", "Depends", refersTo("Request") ? "Request" : null].filter(Boolean).join(", ")}`,
    "from pydantic import BaseModel, RootModel",
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
  return lines(
    `class ${proj.name}Row(BaseModel):`,
    fieldLines.length > 0 ? fieldLines : ["    pass"],
    "",
    "",
    `class ${proj.name}Response(RootModel[list[${proj.name}Row]]):`,
    "    pass",
    "",
    "",
  );
}

/** `GET /projections/<name>`: source rows via the synthesised repo find,
 *  bulk-load each `join` follow, then project each row through `select`. */
function projectionRoute(proj: ProjectionIR, dispatcherExpr: string): string {
  const source = proj.query!.source!;
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
          `    if not (${renderPyExpr(gate)}):`,
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

/** `GET /projections/<name>` for a `from <Workflow>` projection: read the
 *  workflow's persisted saga-state table (`<Wf>Row`) directly — workflows have
 *  no repository — with the `where` pushed to SQL, then project each row's
 *  instance fields through `select` (the candidate alias `f` → the row var `r`).
 *  A validated workflow source carries no `join`/`ignoring`, so there is no
 *  bulk-load / alias-map step. */
function workflowProjectionRoute(
  proj: ProjectionIR,
  wf: WorkflowIR,
  pred: PyPredicate | null,
): string {
  const fn = snake(proj.name);
  const row = `${wf.name}Row`;
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
          `    if not (${renderPyExpr(gate)}):`,
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
