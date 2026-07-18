import type { EnrichedBoundedContextIR, ProjectionIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import { responsePyType } from "./emit/http-models.js";
import { wireHelperImport } from "./py-type-imports.js";
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
  if (ctx.projections.length === 0) return null;

  const models = ctx.projections.map((p) => projectionResponseModels(p, ctx)).join("");
  const routeBlocks = ctx.projections.map(projectionRoutes);
  const routes = routeBlocks.join("\n\n\n");
  const body = `${models}router = APIRouter(prefix="/projections", tags=["projections"])\n\n\n${routes}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const projRows = ctx.projections.map((p) => `${p.name}Row`).sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();

  return lines(
    `"""Projection read-model routes.  Auto-generated."""`,
    "",
    "from fastapi import APIRouter, Depends, Path",
    "from pydantic import BaseModel, RootModel",
    "from sqlalchemy import select",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    "from app.db.engine import get_session",
    `from app.db.schema import ${projRows.join(", ")}`,
    "from app.domain.errors import AggregateNotFoundError",
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
function projectionRoutes(proj: ProjectionIR): string {
  const T = upperFirst(proj.name);
  const slug = snake(proj.name);
  const row = `${proj.name}Row`;
  const shape = proj.wireShape ?? [];
  const project = (rowVar: string): string =>
    shape.map((f) => `"${f.name}": ${instanceFieldValue(rowVar, f)}`).join(", ");
  const list = lines(
    `@router.get("/${slug}", response_model=${T}ListResponse, operation_id="list${T}")`,
    `async def ${slug}_list(session: SessionDep) -> list[dict[str, object]]:`,
    `    rows = (await session.execute(select(${row}))).scalars().all()`,
    `    return [{${project("row")}} for row in rows]`,
  );
  const key = 'key: Annotated[str, Path(json_schema_extra={"format": "uuid"})]';
  const byKey = lines(
    `@router.get("/${slug}/{key}", response_model=${T}Response, operation_id="get${T}"${errorResponsesKwarg("getById")})`,
    `async def ${slug}_get(${key}, session: SessionDep) -> dict[str, object]:`,
    `    row = await session.get(${row}, key)`,
    "    if row is None:",
    `        raise AggregateNotFoundError("not_found")`,
    `    return {${project("row")}}`,
  );
  return [list, byKey].join("\n\n\n");
}
