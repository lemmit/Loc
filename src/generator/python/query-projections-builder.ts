import type {
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
  WireField,
} from "../../ir/types/loom-ir.js";
import { isQueryTimeProjection } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { responsePyType } from "./emit/http-models.js";
import { renderPyExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Query-time projection routes — `app/http/query_projections_routes.py`,
// mounted at `/projections` (read-path-architecture.md rev.13).
//
// A QUERY-TIME projection (`from <Agg> where … join … select …`, no folds) is
// the always-current read model that was a `view`'s full form.  It reads the
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

  const models = projections.map((p) => projectionRowModels(p, ctx)).join("");
  const routeBlocks = projections.map((p) => projectionRoute(p, dispatcherExpr));
  const body = `${models}router = APIRouter(prefix="/projections", tags=["projections"])\n\n\n${routeBlocks.join("\n\n\n")}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);

  // Repos touched: the query source + every join follow target.
  const repoAggs = [
    ...new Set(
      projections.flatMap((p) => [
        ...(p.query?.source ? [p.query.source] : []),
        ...(p.query?.auxiliaries ?? []).map((a) => a.aggName),
      ]),
    ),
  ].sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();

  return lines(
    `"""Query-time projection routes.  Auto-generated."""`,
    "",
    "from fastapi import APIRouter, Depends",
    "from pydantic import BaseModel, RootModel",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    "from app.db.engine import get_session",
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
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
  const out: string[] = [
    `@router.get("/${fn}", response_model=${proj.name}Response, operation_id="projection${proj.name}")`,
    `async def ${fn}_projection(session: SessionDep) -> list[dict[str, object]]:`,
    `    repo = ${source}Repository(session, ${dispatcherExpr})`,
    `    rows = await repo.${fn}()`,
  ];
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
