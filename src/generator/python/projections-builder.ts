import type { EnrichedBoundedContextIR, ProjectionIR } from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isMaterializedProjection } from "../../ir/types/loom-ir.js";
import { type LinesPart, lines } from "../../util/code-builder.js";
import { resolveErrorStatus } from "../../util/error-defaults.js";
import { snake, upperFirst } from "../../util/naming.js";
import { responsePyType } from "./emit/http-models.js";
import { wireHelperImport } from "./py-type-imports.js";
import { renderPyNegatedGuard } from "./render-expr.js";
import { errorResponsesKwarg } from "./routes-builder.js";
import { instanceFieldValue } from "./workflows-builder.js";

// ---------------------------------------------------------------------------
// Projection read-model routes — `app/http/projections_routes.py`, mounted at
// `/projections` (projection.md).  The read side of a projection: pure SELECTs
// over the `<Proj>Row` read-model table the dispatch fold upserts.
//
//   GET /projections/<snake>        → every row (list)
//   GET /projections/<snake>/{key}  → one row by correlation id (404 if absent)
//
// Row → wire projection reuses `instanceFieldValue` (the saga-instance
// projector), so datetime / money serialise identically to every other read.
// Non-key wire fields are optional (the read-model columns are nullable — a
// fold upserts partial rows).
// ---------------------------------------------------------------------------

export function buildPyProjectionsFile(ctx: EnrichedBoundedContextIR): string | null {
  // FOLDED (materialized) projections only — the event-folded read model with a
  // physical `<Proj>Row` table.  Query-time projections (read-path-architecture.md
  // rev.13) are emitted by `buildPyQueryProjectionsFile` instead.
  const folded = ctx.projections.filter(isMaterializedProjection);
  if (folded.length === 0) return null;

  const models = folded.map((p) => projectionResponseModels(p, ctx)).join("");
  const routeBlocks = folded.map((p) => projectionRoutes(p, ctx));
  const routes = routeBlocks.join("\n\n\n");
  const body = `${models}router = APIRouter(prefix="/projections", tags=["projections"])\n\n\n${routes}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  // FOLDED projections only.  A query-time projection has no `<Proj>Row` table
  // — it is computed per read — so listing it here emitted
  // `from app.db.schema import OpenOrdersRow` for a name `db/schema.py` never
  // defines: `ruff` F401'd it and `mypy --strict` failed with "Module
  // app.db.schema has no attribute OpenOrdersRow".  Any context declaring one of
  // each kind failed to compile on python; no fixture had that combination.
  const projRows = folded.map((p) => `${p.name}Row`).sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();

  return lines(
    `"""Projection read-model routes.  Auto-generated."""`,
    "",
    `from fastapi import ${refersTo("Request") ? "APIRouter, Depends, Path, Request" : "APIRouter, Depends, Path"}`,
    "from pydantic import BaseModel, RootModel",
    "from sqlalchemy import select",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    "from app.db.engine import get_session",
    `from app.db.schema import ${projRows.join(", ")}`,
    refersTo("ForbiddenError")
      ? "from app.domain.errors import AggregateNotFoundError, ForbiddenError"
      : "from app.domain.errors import AggregateNotFoundError",
    // The gate binds `current_user: User` off the request scope; imported only
    // when a projection actually declares one (ruff F401 otherwise).
    refersTo("User") ? "from app.auth.user import User" : null,
    refersTo("ProblemDetails") ? "from app.http.problem import ProblemDetails" : null,
    wireHelperImport(refersTo),
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

/** The `<Proj>Response` (one row) + `<Proj>Response`-list carrier, walking the
 *  projection's wire shape — id-source rows are `str`, the rest go through
 *  `responsePyType`; every non-key field is optional (nullable read model). */
function projectionResponseModels(proj: ProjectionIR, ctx: EnrichedBoundedContextIR): string {
  const T = upperFirst(proj.name);
  const shape = proj.wireShape ?? [];
  const fieldLines = shape.map((f) => {
    if (f.source === "id") return `    ${f.name}: str`;
    const t = responsePyType(f.type, ctx);
    return `    ${f.name}: ${t.endsWith("| None") ? t : `${t} | None`} = None`;
  });
  return lines(
    `class ${T}Response(BaseModel):`,
    fieldLines.length > 0 ? fieldLines : ["    pass"],
    "",
    "",
    `class ${T}ListResponse(RootModel[list[${T}Response]]):`,
    "    pass",
    "",
    "",
  );
}

/** The list + by-key read routes for one projection. */
function projectionRoutes(proj: ProjectionIR, ctx: EnrichedBoundedContextIR): string {
  const T = upperFirst(proj.name);
  const slug = snake(proj.name);
  const row = `${proj.name}Row`;
  const shape = proj.wireShape ?? [];
  // Folded read-model columns are ALL nullable (a projection row is written
  // incrementally), so even a source-required `datetime`/`money` arrives off the
  // ORM row as `T | None`.  Serialize every non-key field as optional so
  // `iso()` / `money_str()` get their None-guard — otherwise `mypy --strict`
  // rejects `iso(row.<dt>)` on a `datetime | None` column.
  const project = (rowVar: string): string =>
    shape
      .map((f) => {
        const wf = f.source === "id" ? f : { ...f, optional: true };
        return `"${f.name}": ${instanceFieldValue(rowVar, wf)}`;
      })
      .join(", ");
  // The `requires` gate — 403 before the read, on BOTH read-model routes.  A
  // folded projection is a table of rows a client can GET; that it is written
  // by folds rather than queried live changes nothing about who may read it.
  const gate = proj.query?.requires;
  const gateUsesUser = !!gate && exprUsesCurrentUser(gate);
  const userParam = gateUsesUser ? "request: Request, " : "";
  const gateLines: LinesPart = gate
    ? [
        gateUsesUser ? "    current_user: User = request.state.current_user" : null,
        // renderPyNegatedGuard so a `.contains(...)` gate emits `x not in y`
        // rather than `not (x in y)` (ruff E713) — same helper as every other gate.
        `    if ${renderPyNegatedGuard(gate)}:`,
        `        raise ForbiddenError(${JSON.stringify(`Forbidden: projection ${proj.name}`)})`,
      ]
    : null;
  // Declared statuses come from the SHARED table, keyed exactly as a find's
  // are: the list read is a `findList` (nothing but the gate's 403), the by-key
  // read a `findOptional` (403 + the 404 it already declared).  Both resolve
  // `Forbidden` through the context's `httpStatus` map, so a remapped rung
  // moves the declaration and the handler together.  Ungated ⇒ byte-identical
  // to the previous `""` / `getById` kwargs.
  const resolve = (name: string): number => resolveErrorStatus(name, ctx.structuralErrorStatuses);
  const list = lines(
    `@router.get("/${slug}", response_model=${T}ListResponse, operation_id="list${T}"${errorResponsesKwarg("findList", !!gate, [], resolve)})`,
    `async def ${slug}_list(${userParam}session: SessionDep) -> list[dict[str, object]]:`,
    gateLines,
    `    rows = (await session.execute(select(${row}))).scalars().all()`,
    `    return [{${project("row")}} for row in rows]`,
  );
  const key = 'key: Annotated[str, Path(json_schema_extra={"format": "uuid"})]';
  const byKey = lines(
    `@router.get("/${slug}/{key}", response_model=${T}Response, operation_id="get${T}"${gate ? errorResponsesKwarg("findOptional", true, [], resolve) : errorResponsesKwarg("getById")})`,
    `async def ${slug}_get(${key}, ${userParam}session: SessionDep) -> dict[str, object]:`,
    // Gate first: a caller who fails it must not learn whether the key exists.
    gateLines,
    `    row = await session.get(${row}, key)`,
    "    if row is None:",
    // RS-27 extends here — a projection row read by correlation KEY is by-id.
    `        raise AggregateNotFoundError(f"${T} {key} not found")`,
    `    return {${project("row")}}`,
  );
  return [list, byKey].join("\n\n\n");
}
