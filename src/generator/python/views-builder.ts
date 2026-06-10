import type { EnrichedBoundedContextIR, ExprIR, TypeIR, ViewIR } from "../../ir/types/loom-ir.js";
import { camelId, opView } from "../../ir/util/openapi-ids.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { renderPyExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// View routes — `app/http/views_routes.py`, mounted at `/views`.
//
// One `GET /views/<snake(view)>` per aggregate-sourced view:
//   - shorthand (`view X = Y where …`): the source repo's synthesised
//     view find + `to_wire` projection (reuses `<Agg>Response`).
//   - full form (custom `fields` + `bind`): bulk-load every `X id`
//     follow's foreign aggregates via `find_many_by_ids`, then project
//     each row through the bind expressions with follow rewriting —
//     the Python port of Hono's `renderBindWithFollows`.
//
// Workflow-sourced views land with S15.  Wire parity notes: money
// binds serialize as strings on view rows (TS rows carry decimal.js
// instances that JSON-stringify to strings — copied, not invented).
// ---------------------------------------------------------------------------

export function buildPyViewsFile(ctx: EnrichedBoundedContextIR): string | null {
  const views = ctx.views.filter((v) => v.source.kind === "aggregate");
  if (views.length === 0) return null;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));

  const models: string[] = [];
  for (const view of views) {
    if (!view.output) continue;
    models.push(
      lines(
        `class ${view.name}Row(BaseModel):`,
        view.output.fields.map((f) => `    ${f.name}: ${rowFieldType(f.type)}`),
        "",
        "",
      ),
    );
  }

  const routes = views.map((v) => viewRoute(v, ctx)).join("\n\n\n");
  const body = `${models.join("")}router = APIRouter(prefix="/views", tags=["views"])\n\n\n${routes}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const sourceAggs = [...new Set(views.map((v) => v.source.name))];
  const auxAggs = [
    ...new Set(views.flatMap((v) => (v.output?.auxiliaries ?? []).map((a) => a.aggName))),
  ];
  const repoAggs = [...new Set([...sourceAggs, ...auxAggs])]
    .filter((n) => aggsByName.has(n))
    .sort();
  const responseAggs = sourceAggs.filter((n) => refersTo(`${n}Response`)).sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();

  return lines(
    `"""Read-model view routes.  Auto-generated."""`,
    "",
    "from fastapi import APIRouter, Depends",
    models.length > 0 ? "from pydantic import BaseModel" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    "from app.db.engine import get_session",
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    "from app.domain.events import NoopDomainEventDispatcher",
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    ...responseAggs.map((n) => `from app.http.${snake(n)}_routes import ${n}Response`),
    "",
    "SessionDep = Annotated[AsyncSession, Depends(get_session)]",
    "",
    "",
    body,
    "",
  );
}

function viewRoute(view: ViewIR, ctx: EnrichedBoundedContextIR): string {
  const src = view.source.name;
  const fn = snake(view.name);
  const opId = camelId(opView(view.name));
  const repoInit = `    repo = ${src}Repository(session, NoopDomainEventDispatcher())`;
  if (!view.output) {
    return lines(
      `@router.get("/${fn}", response_model=list[${src}Response], operation_id="${opId}")`,
      `async def ${fn}_view(session: SessionDep) -> list[dict[str, object]]:`,
      repoInit,
      `    return [repo.to_wire(r) for r in await repo.${fn}()]`,
    );
  }
  // Full form: bulk-load follows (dependency order — shortest path
  // first), then project binds per row.
  const out: string[] = [
    `@router.get("/${fn}", response_model=list[${view.name}Row], operation_id="${opId}")`,
    `async def ${fn}_view(session: SessionDep) -> list[dict[str, object]]:`,
    repoInit,
    `    rows = await repo.${fn}()`,
  ];
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  for (const aux of view.output.auxiliaries) {
    const mapVar = snake(aux.mapVar);
    const repoVar = `${snake(aux.aggName)}_repo`;
    out.push(`    ${repoVar} = ${aux.aggName}Repository(session, NoopDomainEventDispatcher())`);
    const idsSource =
      aux.path.length === 1
        ? `[r.${snake(aux.path[0]!)} for r in rows]`
        : (() => {
            const prev = pathToMap.get(aux.path.slice(0, -1).join("."));
            const finalField = snake(aux.path[aux.path.length - 1]!);
            return prev ? `[a.${finalField} for a in ${prev.mapVar}.values()]` : "[]";
          })();
    out.push(
      `    ${mapVar} = {str(a.id): a for a in await ${repoVar}.find_many_by_ids(${idsSource})}`,
    );
    pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
  }
  out.push("    return [");
  out.push("        {");
  for (const b of view.output.binds) {
    out.push(`            "${b.name}": ${renderBind(b.expr, b.type, pathToMap)},`);
  }
  out.push("        }");
  out.push("        for r in rows");
  out.push("    ]");
  return out.join("\n");
}

/** Money binds serialize as strings on view rows (TS parity — see the
 *  module header); everything else passes through. */
function renderBind(
  expr: ExprIR,
  type: TypeIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  const rendered = renderBindWithFollows(expr, pathToMap);
  if (type.kind === "primitive" && type.name === "money") return `str(${rendered})`;
  return rendered;
}

/** Bind expression with `X id` follow rewriting: a member access whose
 *  receiver is id-typed routes through the auxiliary map. */
function renderBindWithFollows(
  expr: ExprIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const receiver = renderIdReceiver(expr.receiver, pathToMap);
        return `${map.mapVar}[str(${receiver})].${snake(expr.member)}`;
      }
    }
  }
  return renderPyExpr(expr, { thisName: "r" });
}

function renderIdReceiver(
  expr: ExprIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "ref") return `r.${snake(expr.name)}`;
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderIdReceiver(expr.receiver, pathToMap);
        return `${map.mapVar}[str(${inner})].${snake(expr.member)}`;
      }
    }
  }
  return renderPyExpr(expr, { thisName: "r" });
}

function idFollowPath(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") return [e.name];
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = idFollowPath(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

/** Pydantic type for a view-row field (mirrors Hono's zodForRow —
 *  money is a string on view rows, datetimes ride as ISO strings). */
function rowFieldType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "int";
        case "decimal":
          return "float";
        case "money":
        case "string":
        case "guid":
        case "datetime":
          return "str";
        case "bool":
          return "bool";
        default:
          return "object";
      }
    case "id":
      return "str";
    case "enum":
      return t.name;
    case "array":
      return `list[${rowFieldType(t.element)}]`;
    case "optional":
      return `${rowFieldType(t.inner)} | None`;
    default:
      return "object";
  }
}
