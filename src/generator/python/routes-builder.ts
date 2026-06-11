import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { forApiRead, forCreateInput, hasCreate } from "../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../ir/stdlib/generics.js";
import { variantTag } from "../../ir/stdlib/unions.js";
import {
  type BoundedContextIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type EnrichedEntityPartIR,
  findUsesCurrentUser,
  type OperationIR,
  operationIsGuarded,
  operationUsesCurrentUser,
  type RepositoryIR,
  type TypeIR,
} from "../../ir/types/loom-ir.js";
import {
  camelId,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "../../ir/util/openapi-ids.js";
import { lines } from "../../util/code-builder.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { findUnionSpec } from "../_payload/union-wire.js";
import { requestPyType, responsePyType } from "./emit/http-models.js";
import { emittableFinds } from "./repository-builder.js";

// ---------------------------------------------------------------------------
// Routes emission — `app/http/<snake(agg)>_routes.py`.  One APIRouter
// per aggregate with the canonical route set (parity with the Hono
// routes file):
//   POST   ""              → create (201, {id})           [hasCreate]
//   GET    ""              → all (200, list response)
//   GET    "/{id}"         → byId (200 / 404)
//   DELETE "/{id}"         → canonical destroy (204/404/409)
//   POST   "/{id}/<op>"    → public operation (204/400/404[/403])
//
// DTOs are Pydantic models named for OpenAPI parity
// (`<Agg>Response`, `Create<Agg>Request`, `<Op><Agg>Request`, …) with
// wire-cased (camelCase) attribute names — the DTO layer is
// wire-shaped; handlers coerce into the snake_case domain.
// operationIds use the shared token vocabulary (camelId — compared
// case-insensitively by the conformance gate).
//
// User-declared finds land in S8; returning ops / unions / paged in
// S12; currentUser threading in S16.
// ---------------------------------------------------------------------------

export function buildPyRoutesFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  hasDispatch = false,
): string {
  const slug = snake(plural(agg.name));
  const parts: EnrichedEntityPartIR[] = agg.parts;
  const publicOps = agg.operations.filter((o) => o.visibility === "public" && !o.extern);

  // One <Name>Paged response model per distinct paged carrier.
  const pagedNames = new Set<string>();
  const pagedModels: string[] = [];
  for (const f of emittableFinds(repo)) {
    const paged = pagedReturn(f.returnType);
    if (!paged || pagedNames.has(paged.name)) continue;
    pagedNames.add(paged.name);
    pagedModels.push(
      lines(
        `class ${paged.name}(BaseModel):`,
        `    items: list[${agg.name}Response]`,
        "    page: int",
        "    pageSize: int",
        "    total: int",
        "    totalPages: int",
        "",
        "",
      ),
    );
  }
  const models = lines(
    ...parts.map((p) => responseModel(p.name, p, ctx)),
    responseModel(agg.name, agg, ctx),
    ...pagedModels,
    hasCreateFactory(agg) ? createModels(agg, ctx) : null,
    ...publicOps.map((op) => opRequestModel(agg, op, ctx)),
  );

  const routes = lines(
    `router = APIRouter(prefix="/${slug}", tags=["${slug}"])`,
    "",
    "",
    "def _repo(session: AsyncSession) -> " + `${agg.name}Repository:`,
    hasDispatch
      ? `    return ${agg.name}Repository(session, make_dispatcher(session))`
      : `    return ${agg.name}Repository(session, NoopDomainEventDispatcher())`,
    hasCreateFactory(agg) ? ["", "", createRoute(agg, ctx)] : null,
    "",
    "",
    allRoute(agg),
    // Finds register before /{id}: Starlette matches in declaration
    // order, so the static find paths must win over the id pattern.
    ...emittableFinds(repo).flatMap((f) => ["", "", findRoute(agg, f, ctx)]),
    "",
    "",
    byIdRoute(agg),
    agg.canonicalDestroy ? ["", "", destroyRoute(agg)] : null,
    ...publicOps.map((op) => ["", "", operationRoute(agg, op, ctx)]),
  );

  const body = `${models}\n\n\n${routes}`;
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const enumNames = ctx.enums
    .map((e) => e.name)
    .filter(refersTo)
    .sort();
  const voDomainNames = ctx.valueObjects
    .map((v) => v.name)
    .filter(refersTo)
    .sort();
  const voModelImports = ctx.valueObjects
    .map((v) => v.name)
    .filter((n) => refersTo(`${n}Model`))
    .sort();
  const idNames = [agg.name, ...agg.fields.map(idTargetOf).filter((n): n is string => n != null)]
    .map((n) => `${n}Id`)
    .filter((n, i, arr) => refersTo(n) && arr.indexOf(n) === i)
    .sort();

  return lines(
    `"""${agg.name} HTTP routes + wire DTOs.  Auto-generated."""`,
    "",
    refersTo("datetime") ? "from datetime import datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("datetime") || refersTo("Decimal") ? "" : null,
    `from fastapi import ${["APIRouter", "Depends", refersTo("Request") ? "Request" : null, refersTo("Response") ? "Response" : null].filter(Boolean).join(", ")}`,
    refersTo("JSONResponse") ? "from fastapi.responses import JSONResponse" : null,
    "from pydantic import BaseModel",
    refersTo("IntegrityError") ? "from sqlalchemy.exc import IntegrityError" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    publicOps.some(operationUsesCurrentUser) || emittableFinds(repo).some(findUsesCurrentUser)
      ? "from app.auth.user import User"
      : null,
    "from app.db.engine import get_session",
    `from app.db.repositories.${snake(agg.name)}_repository import ${agg.name}Repository`,
    hasDispatch ? "from app.dispatch import make_dispatcher" : null,
    refersTo("AggregateNotFoundError")
      ? "from app.domain.errors import AggregateNotFoundError"
      : null,
    // Only the create route constructs the domain class directly.
    refersTo(agg.name) ? `from app.domain.${snake(agg.name)} import ${agg.name}` : null,
    hasDispatch ? null : "from app.domain.events import NoopDomainEventDispatcher",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    [...enumNames, ...voDomainNames].length > 0
      ? `from app.domain.value_objects import ${[...enumNames, ...voDomainNames].sort().join(", ")}`
      : null,
    refersTo("problem") ? "from app.http.problem import problem" : null,
    voModelImports.length > 0
      ? `from app.http.wire_models import ${voModelImports.map((n) => `${n} as ${n}Model`).join(", ")}`
      : null,
    "",
    "SessionDep = Annotated[AsyncSession, Depends(get_session)]",
    "",
    "",
    body,
    "",
  );
}

/** Same constructibility gate the domain emitter uses — no `create`
 *  factory ⇒ no POST route (parity with Hono's `emitCreate`). */
function hasCreateFactory(agg: EnrichedAggregateIR): boolean {
  return hasCreate(agg);
}

function idTargetOf(f: { type: TypeIR }): string | null {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "id") return t.targetName;
  if (t.kind === "array" && t.element.kind === "id") return t.element.targetName;
  return null;
}

// --- DTO models ---------------------------------------------------------------

function responseModel(
  name: string,
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const fields = forApiRead(wireShapeFor(ent));
  return lines(
    `class ${name}Response(BaseModel):`,
    fields.map((wf) => {
      const t =
        wf.source === "containment"
          ? containmentResponseType(wf.type)
          : responsePyType(wf.type, ctx);
      const optional = wf.optional || wf.type.kind === "optional";
      const suffix =
        optional && !t.endsWith("| None") ? " | None = None" : optional ? " = None" : "";
      return `    ${wf.name}: ${t}${suffix}`;
    }),
    "",
    "",
  );
}

function containmentResponseType(t: TypeIR): string {
  if (t.kind === "array" && t.element.kind === "entity") return `list[${t.element.name}Response]`;
  if (t.kind === "entity") return `${t.name}Response | None`;
  return "object";
}

function createModels(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  // Event-sourced create: the request shape is the create ACTION's
  // params (the command), not the field set (appliers A2.2).
  const esCreate = agg.persistedAs === "eventLog" ? agg.creates?.[0] : undefined;
  if (esCreate) {
    return lines(
      `class Create${agg.name}Request(BaseModel):`,
      esCreate.params.length > 0
        ? esCreate.params.map((p) => `    ${p.name}: ${requestPyType(p.type, ctx)}`)
        : ["    pass"],
      "",
      "",
      `class Create${agg.name}Response(BaseModel):`,
      "    id: str",
      "",
      "",
    );
  }
  const inputs = forCreateInput(agg.fields);
  return lines(
    `class Create${agg.name}Request(BaseModel):`,
    inputs.length > 0
      ? inputs.map((f) => {
          const t = requestPyType(f.type, ctx);
          const suffix =
            f.optional && !t.endsWith("| None") ? " | None = None" : f.optional ? " = None" : "";
          return `    ${f.name}: ${t}${suffix}`;
        })
      : ["    pass"],
    "",
    "",
    `class Create${agg.name}Response(BaseModel):`,
    "    id: str",
    "",
    "",
  );
}

function opRequestModel(
  agg: EnrichedAggregateIR,
  op: OperationIR,
  ctx: EnrichedBoundedContextIR,
): string {
  return lines(
    `class ${upperFirst(op.name)}${agg.name}Request(BaseModel):`,
    op.params.length > 0
      ? op.params.map((p) => `    ${p.name}: ${requestPyType(p.type, ctx)}`)
      : ["    pass"],
    "",
    "",
  );
}

// --- wire → domain coercion -----------------------------------------------------

/** Coerce one validated request value into the domain argument shape:
 *  brand ids, construct VOs positionally, pass parsed scalars through. */
export function pyWireToDomain(expr: string, t: TypeIR, ctx: BoundedContextIR): string {
  switch (t.kind) {
    case "id":
      return `${t.targetName}Id(${expr})`;
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      if (!vo) return expr;
      const args = vo.fields
        .map((vf) => pyWireToDomain(`${expr}.${vf.name}`, vf.type, ctx))
        .join(", ");
      return `${t.name}(${args})`;
    }
    case "array": {
      const inner = pyWireToDomain("__v", t.element, ctx);
      return inner === "__v" ? `list(${expr})` : `[${inner} for __v in ${expr}]`;
    }
    case "optional": {
      const inner = pyWireToDomain(expr, t.inner, ctx);
      return inner === expr ? expr : `(${inner} if ${expr} is not None else None)`;
    }
    case "primitive":
      if (t.name === "money") return expr;
      return expr;
    default:
      return expr;
  }
}

// --- routes ---------------------------------------------------------------------

function createRoute(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  const esCreate = agg.persistedAs === "eventLog" ? agg.creates?.[0] : undefined;
  if (esCreate) {
    const args = esCreate.params
      .map((p) => `${snake(p.name)}=${pyWireToDomain(`body.${p.name}`, p.type, ctx)}`)
      .join(", ");
    return lines(
      `@router.post("", status_code=201, response_model=Create${agg.name}Response, operation_id="${camelId(opCreate(agg.name))}")`,
      `async def create_${snake(agg.name)}(body: Create${agg.name}Request, session: SessionDep) -> dict[str, object]:`,
      `    created = ${agg.name}.create(${args})`,
      "    await _repo(session).save(created)",
      `    return {"id": created.id}`,
    );
  }
  const inputs = forCreateInput(agg.fields);
  const args = inputs
    .map((f) => `${snake(f.name)}=${pyWireToDomain(`body.${f.name}`, f.type, ctx)}`)
    .join(", ");
  return lines(
    `@router.post("", status_code=201, response_model=Create${agg.name}Response, operation_id="${camelId(opCreate(agg.name))}")`,
    `async def create_${snake(agg.name)}(body: Create${agg.name}Request, session: SessionDep) -> dict[str, object]:`,
    `    created = ${agg.name}.create(${args})`,
    "    await _repo(session).save(created)",
    `    return {"id": created.id}`,
  );
}

function allRoute(agg: EnrichedAggregateIR): string {
  return lines(
    `@router.get("", response_model=list[${agg.name}Response], operation_id="all${agg.name}")`,
    `async def all_${snake(plural(agg.name))}(session: SessionDep) -> list[dict[str, object]]:`,
    "    repo = _repo(session)",
    "    return [repo.to_wire(root) for root in await repo.all()]",
  );
}

function byIdRoute(agg: EnrichedAggregateIR): string {
  return lines(
    `@router.get("/{id}", response_model=${agg.name}Response, operation_id="${camelId(opGetById(agg.name))}")`,
    `async def get_${snake(agg.name)}_by_id(id: str, session: SessionDep) -> dict[str, object]:`,
    "    repo = _repo(session)",
    `    return repo.to_wire(await repo.get_by_id(${agg.name}Id(id)))`,
  );
}

function destroyRoute(agg: EnrichedAggregateIR): string {
  return lines(
    `@router.delete("/{id}", status_code=204, operation_id="${camelId(opDestroy(agg.name))}")`,
    `async def destroy_${snake(agg.name)}(id: str, request: Request, session: SessionDep) -> Response:`,
    "    repo = _repo(session)",
    `    await repo.get_by_id(${agg.name}Id(id))`,
    "    try:",
    `        await repo.delete(${agg.name}Id(id))`,
    "    except IntegrityError:",
    "        await session.rollback()",
    "        return problem(",
    "            request,",
    "            409,",
    `            "Conflict",`,
    `            "${agg.name} is still referenced and cannot be deleted.",`,
    "        )",
    "    return Response(status_code=204)",
  );
}

function operationRoute(
  agg: EnrichedAggregateIR,
  op: OperationIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const opSnake = snake(op.routeSlug ?? op.name);
  // Exception-less operation (`operation foo(): X or NotFound`): the
  // route intercepts each error variant and translates it to an
  // RFC-7807 ProblemDetails at its mapped status; success rides as the
  // tagged dict the statement renderer produced (exception-less.md).
  if (op.returnType?.kind === "union") {
    const errorTags = op.returnType.variants
      .map((v) => variantTag(v))
      .filter((tag) => ctx.payloads.some((pl) => pl.name === tag && pl.kind === "error"));
    const translations = errorTags.flatMap((tag) => {
      const st = ctx.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag);
      return [
        `    if result["type"] == ${JSON.stringify(tag)}:`,
        "        return JSONResponse(",
        `            {**result, "type": ${JSON.stringify(errorTypeUri(tag))}, "title": ${JSON.stringify(errorTitle(tag))}, "status": ${st}, "detail": ${JSON.stringify(errorTitle(tag))}, "instance": request.url.path},`,
        `            status_code=${st},`,
        '            media_type="application/problem+json",',
        "        )",
      ];
    });
    const usesUser = operationUsesCurrentUser(op);
    const forbidden = operationIsGuarded(op)
      ? ', responses={403: {"description": "Forbidden"}}'
      : "";
    const callArgs = [...op.params.map((p) => pyWireToDomain(`body.${p.name}`, p.type, ctx))];
    if (usesUser) callArgs.push("current_user");
    return lines(
      `@router.post("/{id}/${opSnake}", response_model=None, operation_id="${camelId(opOperation(agg.name, op.name))}"${forbidden})`,
      `async def ${snake(op.name)}_${snake(agg.name)}(id: str, body: ${upperFirst(op.name)}${agg.name}Request, request: Request, session: SessionDep) -> dict[str, object] | JSONResponse:`,
      usesUser ? "    current_user: User = request.state.current_user" : null,
      "    repo = _repo(session)",
      `    found = await repo.get_by_id(${agg.name}Id(id))`,
      `    result = found.${snake(op.name)}(${callArgs.join(", ")})`,
      "    await repo.save(found)",
      ...translations,
      "    return result",
    );
  }
  // currentUser-gated ops read the actor the auth middleware stashed on
  // the request scope and thread it as the trailing domain argument; a
  // `requires`-guarded op additionally declares its 403 outcome.
  const usesUser = operationUsesCurrentUser(op);
  const forbidden = operationIsGuarded(op) ? ', responses={403: {"description": "Forbidden"}}' : "";
  const opSig = [
    "id: str",
    `body: ${upperFirst(op.name)}${agg.name}Request`,
    ...(usesUser ? ["request: Request"] : []),
    "session: SessionDep",
  ].join(", ");
  const callArgs = [...op.params.map((p) => pyWireToDomain(`body.${p.name}`, p.type, ctx))];
  if (usesUser) callArgs.push("current_user");
  return lines(
    `@router.post("/{id}/${opSnake}", status_code=204, operation_id="${camelId(opOperation(agg.name, op.name))}"${forbidden})`,
    `async def ${snake(op.name)}_${snake(agg.name)}(${opSig}) -> Response:`,
    usesUser ? "    current_user: User = request.state.current_user" : null,
    "    repo = _repo(session)",
    `    found = await repo.get_by_id(${agg.name}Id(id))`,
    `    found.${snake(op.name)}(${callArgs.join(", ")})`,
    "    await repo.save(found)",
    "    return Response(status_code=204)",
  );
}

function findRoute(
  agg: EnrichedAggregateIR,
  find: import("../../ir/types/loom-ir.js").FindIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const findSnake = snake(find.name);
  const isList = find.returnType.kind === "array";
  // A currentUser-scoped find (`where … == currentUser.x`) reads the
  // actor off the request scope and passes it as the trailing repo arg.
  const usesUser = findUsesCurrentUser(find);
  const userBind = usesUser ? "    current_user: User = request.state.current_user" : null;
  const params = find.params.map((p) => `${p.name}: ${requestPyType(p.type, ctx)}`);
  const sig = [...params, ...(usesUser ? ["request: Request"] : []), "session: SessionDep"].join(
    ", ",
  );
  const args = [
    ...find.params.map((p) => pyWireToDomain(p.name, p.type, ctx)),
    ...(usesUser ? ["current_user"] : []),
  ].join(", ");
  const opId = camelId(opFind(agg.name, find.name));
  const unionSpec = findUnionSpec(find.returnType, agg.name, ctx);
  if (unionSpec) {
    const sig = [...params, "request: Request", "session: SessionDep"].join(", ");
    const absent =
      unionSpec.absent.kind === "none"
        ? [
            `    if (found := await repo.${findSnake}(${args})) is None:`,
            '        raise AggregateNotFoundError("not_found")',
          ]
        : (() => {
            const tag = unionSpec.absent.tag;
            const st = ctx.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag);
            const resourceExt = unionSpec.absent.hasResource
              ? `"resource": ${JSON.stringify(agg.name)}, `
              : "";
            return [
              `    if (found := await repo.${findSnake}(${args})) is None:`,
              "        return JSONResponse(",
              `            {${resourceExt}"type": ${JSON.stringify(errorTypeUri(tag))}, "title": ${JSON.stringify(errorTitle(tag))}, "status": ${st}, "detail": ${JSON.stringify(errorTitle(tag))}, "instance": request.url.path},`,
              `            status_code=${st},`,
              '            media_type="application/problem+json",',
              "        )",
            ];
          })();
    return lines(
      `@router.get("/${findSnake}", response_model=None, operation_id="${opId}")`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> dict[str, object] | JSONResponse:`,
      userBind,
      "    repo = _repo(session)",
      ...absent,
      // Found → the tagged success variant ({type: "<Agg>", …wire}).
      `    return {"type": ${JSON.stringify(unionSpec.successTag)}, **repo.to_wire(found)}`,
    );
  }
  const paged = pagedReturn(find.returnType);
  if (paged) {
    // Defaulted params last (python syntax) — FastAPI is order-agnostic.
    const pagedSig = [
      ...params,
      ...(usesUser ? ["request: Request"] : []),
      "session: SessionDep",
      `page: int = ${PAGED_DEFAULT_PAGE}`,
      `pageSize: int = ${PAGED_DEFAULT_PAGE_SIZE}`,
    ].join(", ");
    const callArgs = [
      ...find.params.map((p) => pyWireToDomain(p.name, p.type, ctx)),
      ...(usesUser ? ["current_user"] : []),
      "page",
      "pageSize",
    ];
    return lines(
      `@router.get("/${findSnake}", response_model=${paged.name}, operation_id="${opId}")`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${pagedSig}) -> dict[str, object]:`,
      userBind,
      "    repo = _repo(session)",
      `    result = await repo.${findSnake}(${callArgs.join(", ")})`,
      "    return {",
      '        "items": [repo.to_wire(r) for r in result.items],',
      '        "page": result.page,',
      '        "pageSize": result.page_size,',
      '        "total": result.total,',
      '        "totalPages": result.total_pages,',
      "    }",
    );
  }
  if (isList) {
    return lines(
      `@router.get("/${findSnake}", response_model=list[${agg.name}Response], operation_id="${opId}")`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> list[dict[str, object]]:`,
      userBind,
      "    repo = _repo(session)",
      `    return [repo.to_wire(r) for r in await repo.${findSnake}(${args})]`,
    );
  }
  return lines(
    `@router.get("/${findSnake}", response_model=${agg.name}Response, operation_id="${opId}")`,
    `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> dict[str, object]:`,
    userBind,
    "    repo = _repo(session)",
    `    found = await repo.${findSnake}(${args})`,
    "    if found is None:",
    `        raise AggregateNotFoundError("not_found")`,
    "    return repo.to_wire(found)",
  );
}
