import {
  emitsRestCreate,
  forApiRead,
  forCreateInput,
  wireFieldsFor,
} from "../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  PAGED_MAX_PAGE,
  PAGED_MAX_PAGE_SIZE,
  pagedReturn,
} from "../../ir/stdlib/generics.js";
import { variantTag } from "../../ir/stdlib/unions.js";
import {
  type BoundedContextIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type EnrichedEntityPartIR,
  type ExprIR,
  exprUsesCurrentUser,
  type FindIR,
  findGateUsesCurrentUser,
  findUsesCurrentUser,
  type InvariantIR,
  type OperationIR,
  operationUsesCurrentUser,
  type PayloadIR,
  type RepositoryIR,
  type TypeIR,
} from "../../ir/types/loom-ir.js";
import {
  type ApiOperationIR,
  apiStatusContext,
  deriveAggregateOperations,
  isAllFind,
  relativeOpPath,
} from "../../ir/util/api-surface.js";
import { maskedHistoryFields } from "../../ir/util/audit-history.js";
import { partsChildrenFirst } from "../../ir/util/containment-parent.js";
import {
  lifecycleGates,
  lifecycleGatesReadRow,
  lifecycleGatesUseCurrentUser,
  operationBodyUsesCurrentUser,
  operationGates,
  operationGatesUseCurrentUser,
} from "../../ir/util/op-gates.js";
import { errorStatuses, type OpErrorKind, problemTitle } from "../../ir/util/openapi-errors.js";
import {
  camelId,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "../../ir/util/openapi-ids.js";
import { listReadFind } from "../../ir/util/read-gates.js";
import { aggregateIsVersioned } from "../../ir/util/versioned-capability.js";
import { type LinesPart, lines } from "../../util/code-builder.js";
import {
  defaultErrorStatus,
  errorTitle,
  errorTypeUri,
  resolveErrorStatus,
} from "../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { isServerSourcedDefault, isValueObjectDefault } from "../_frontend/server-default.js";
import { findUnionSpec } from "../_payload/union-wire.js";
import { pyHistoryMapperName, renderPyHistoryMapper } from "./emit/audit-history.js";
import { requestPyType, responsePyType, wireModelImport } from "./emit/http-models.js";
import { provColumn } from "./emit/provenance.js";
import {
  createFieldConstraints,
  createModelValidator,
  withFieldConstraint,
} from "./emit/wire-constraints.js";
import { renderPyExpr, renderPyNegatedGuard } from "./render-expr.js";
import { aggHasFieldMask, emittableFinds } from "./repository-builder.js";

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

/** The response serializer call for one entity var — masked or plain.  A
 *  `mask unless` aggregate routes every RESPONSE boundary through
 *  `repo.to_wire_masked(x)` (which reads the ambient principal and redacts
 *  fail-closed); a mask-free aggregate keeps `repo.to_wire(x)` verbatim so
 *  non-mask projects stay byte-identical.  Internal (audit-snapshot) `to_wire`
 *  uses stay unmasked. */
function wireResp(agg: EnrichedAggregateIR, varExpr: string): string {
  return aggHasFieldMask(agg) ? `repo.to_wire_masked(${varExpr})` : `repo.to_wire(${varExpr})`;
}

export function buildPyRoutesFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  hasDispatch = false,
  /** Non-hosted id targets branded in app/domain/ids.py (M-T4.4 — foreign
   *  events / cross-context `X id` fields); candidates for the id import. */
  extraIdNames: readonly string[] = [],
): string {
  const slug = snake(plural(agg.name));
  // THE UNIFICATION SEAM (api-surface.ts): route-set membership, decorator
  // paths, and the declared error statuses come from the shared derivation.
  // This file keeps what is genuinely python's: pydantic models, handler
  // bodies, the union-absent runtime translation, and the entity-history
  // route (`apiSurfaceCoverage.notLifted`).
  const derivedOps = deriveAggregateOperations(agg, repo, apiStatusContext(ctx));
  const createOp = derivedOps.find((o) => o.kind === "create");
  const allOp = derivedOps.find((o) => isAllFind(o));
  const declaredFindOps = derivedOps.filter((o) => o.kind === "find" && !isAllFind(o));
  const getByIdOp = derivedOps.find((o) => o.kind === "getById")!;
  const destroyOp = derivedOps.find((o) => o.kind === "destroy");
  const opEntries = derivedOps.filter((o) => o.kind === "operation");
  const probeEntries = derivedOps.filter((o) => o.kind === "gateProbe");
  // Children-first so a nested part's `<Part>Response` is defined before the
  // `<Parent>Response` that references it (`list[LabelResponse]`) — no Pydantic
  // forward-ref.  Byte-identical when there is no part-in-part nesting.
  const parts: EnrichedEntityPartIR[] = partsChildrenFirst(agg.parts);
  // Extern ops (docs/extern.md, extern (b) Phase 2) route exactly like any
  // other public operation: the aggregate's `<op>` method (preconditions → hook
  // → invariants) is a real method now, so `found.<op>(…)` drives the whole
  // framework flow — no separate registry dispatch.
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  // `when`-gated ops (criterion.md, use site 2) each expose a
  // side-effect-free `GET /{id}/can_<op>` → `{ allowed }` companion.
  const whenGatedOps = publicOps.filter((o) => o.when);

  // One <Name>Paged response model per distinct paged carrier — the explicit
  // paged finds plus (M-T2.6) the implicit paged findAll (`all`, excluded from
  // emittableFinds but paged for a plain relational aggregate).
  const pagedNames = new Set<string>();
  const pagedModels: string[] = [];
  const autoAllFind = repo?.finds.find(
    (f) => f.name === "all" && f.params.length === 0 && !f.filter,
  );
  // A synthesized find (paged-run queryHandler support) is never auto-exposed
  // by the aggregate router — the queryHandler's own route is the exposure — so
  // it contributes no route and no `<Agg>Paged` DTO here.
  const exposedFinds = emittableFinds(repo).filter((f) => !f.synthesized);
  // Entity history (docs/audit.md) — the derived read over `audit_records`.
  // Read off the enrichment-derived `historyFind` rather than re-deriving
  // "is this audited" here, so the endpoint's gate + `ignoring` stance are the
  // ones enrichment resolved and cannot drift from the aggregate's list read.
  const historyFind = repo?.historyFind;
  const pagedCarriers = [...exposedFinds, ...(autoAllFind ? [autoAllFind] : [])];
  for (const f of pagedCarriers) {
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
    responseModel(
      agg.name,
      agg,
      ctx,
      ctx.payloads.find((p) => p.kind === "response" && p.name === `${agg.name}Response`),
    ),
    // Named array component for list endpoints (`<Agg>ListResponse`,
    // RootModel so FastAPI emits a $ref instead of an inline array) —
    // response-schema parity with the other backends.
    `class ${agg.name}ListResponse(RootModel[list[${agg.name}Response]]):`,
    "    pass",
    "",
    "",
    // The `can_<op>` companion's response body — `{ allowed }` (one per
    // routes file when any op is `when`-gated).
    whenGatedOps.length > 0
      ? lines("class CanResponse(BaseModel):", "    allowed: bool", "", "")
      : null,
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
    createOp ? ["", "", createRoute(agg, ctx, createOp)] : null,
    "",
    "",
    allRoute(agg, repo, allOp!),
    // Finds register before /{id}: Starlette matches in declaration
    // order, so the static find paths must win over the id pattern.
    ...declaredFindOps.flatMap((e) => ["", "", findRoute(agg, e.find!, ctx, e)]),
    "",
    "",
    byIdRoute(agg, getByIdOp),
    // Entity history (docs/audit.md) — two path segments, so no collision with
    // the `/{id}` pattern above.  Driven by the enrichment-derived `historyFind`
    // so the read surface cannot disagree with the gate / `ignoring` stance
    // enrichment resolved.
    historyFind
      ? ["", "", renderPyHistoryMapper(agg), "", "", historyRoute(agg, historyFind, ctx)]
      : null,
    destroyOp ? ["", "", destroyRoute(agg, conflictResolver(ctx), destroyOp)] : null,
    ...opEntries.map((e) => ["", "", operationRoute(agg, e.operation!, ctx, e)]),
    // Can-query companions register after the operation routes (static
    // `can_<op>` paths, no collision with `/{id}`).
    ...probeEntries.map((e) => ["", "", canOpRoute(agg, e.operation!, e)]),
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
  // Every `X id` reference in the emitted routes wraps as `XId(...)`, and the
  // target is always an aggregate. Offer every context aggregate's id type as a
  // candidate and let `refersTo` keep only the ones actually emitted — so an id
  // reached via an OPERATION PARAM or a CONTAINED-ENTITY field (not just the
  // aggregate's own fields) is imported. The old `agg.name + agg.fields` set
  // missed those, emitting e.g. `addLine(ProductId(...))` with `ProductId`
  // never imported → NameError at runtime (found by the python behavioral tier).
  // Foreign id brands (M-T4.4): a cross-context `X id` field wraps as
  // `XId(...)` with X hosted elsewhere — `extraIdNames` (threaded from the
  // orchestrator, same set renderPyIds brands) joins the candidate pool.
  const idNames = [
    ...ctx.aggregates.map((a) => `${a.name}Id`),
    ...extraIdNames.map((n) => `${n}Id`),
  ]
    .filter((n, i, arr) => refersTo(n) && arr.indexOf(n) === i)
    .sort();

  return lines(
    `"""${agg.name} HTTP routes + wire DTOs.  Auto-generated."""`,
    "",
    refersTo("math") ? "import math" : null,
    refersTo("datetime")
      ? `from datetime import ${refersTo("UTC") ? "UTC, datetime" : "datetime"}`
      : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("math") || refersTo("datetime") || refersTo("Decimal") ? "" : null,
    `from fastapi import ${["APIRouter", "Depends", refersTo("Path") ? "Path" : null, refersTo("Query") ? "Query" : null, refersTo("Request") ? "Request" : null, refersTo("Response") ? "Response" : null].filter(Boolean).join(", ")}`,
    refersTo("JSONResponse") ? "from fastapi.responses import JSONResponse" : null,
    `from pydantic import ${["BaseModel", refersTo("Field") ? "Field" : null, refersTo("RootModel") ? "RootModel" : null, refersTo("ValidationError") ? "ValidationError" : null, refersTo("model_validator") ? "model_validator" : null].filter(Boolean).join(", ")}`,
    refersTo("PydanticCustomError")
      ? `from pydantic_core import ${refersTo("InitErrorDetails") ? "InitErrorDetails, PydanticCustomError" : "PydanticCustomError"}`
      : null,
    refersTo("JSON.NULL") ? "from sqlalchemy import JSON" : null,
    refersTo("IntegrityError") ? "from sqlalchemy.exc import IntegrityError" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    // `User` is imported only when a route that actually threads the request
    // principal is emitted.  The create/update stamps consume `current_user`,
    // but the create stamp rides the (now `emitsRestCreate`-gated) create
    // route and the update stamp rides the operation routes — so a read-only
    // aggregate (no create surface, no operations) references neither and must
    // not import `User` (ruff F401 under `--warnings-as-errors`).
    publicOps.some(operationUsesCurrentUser) ||
      emittableFinds(repo).some(findUsesCurrentUser) ||
      // A find `requires` gate that reads currentUser binds `current_user: User`.
      emittableFinds(repo).some((f) => !!f.requires && exprUsesCurrentUser(f.requires)) ||
      // …and so does a canonical `create` / `destroy` gate that reads it.
      lifecycleGatesUseCurrentUser(agg.canonicalCreate) ||
      lifecycleGatesUseCurrentUser(agg.canonicalDestroy) ||
      // …including the LIST read's gate, which `emittableFinds` excludes (the
      // list endpoint has its own route shape).  Its route binds the same
      // `current_user: User`, so it needs the same import.
      (() => {
        const g = listReadFind(repo)?.requires;
        return !!g && exprUsesCurrentUser(g);
      })() ||
      (hasCreateFactory(agg) && stampUsesUser(agg, "create")) ||
      (publicOps.length > 0 && stampUsesUser(agg, "update")) ||
      // A `currentUser.*` create-field default binds `current_user: User` in
      // the create handler for its per-request coalesce.
      (hasCreateFactory(agg) &&
        forCreateInput(agg.fields).some(
          (f) =>
            f.default !== undefined &&
            isServerSourcedDefault(f.default) &&
            exprUsesCurrentUser(f.default),
        ))
      ? "from app.auth.user import User"
      : null,
    // The history mapper's masked-field blocks read the ambient principal
    // through `current_user()` (the non-raising getter — an unauthenticated
    // caller drops every masked entry).  Imported only when the aggregate
    // actually serves history AND masks something, else ruff flags F401.
    // Emitted separately from the `User` line above because the two conditions
    // are independent: a masked history needs the accessor but not the type.
    historyFind && maskedHistoryFields(agg).length > 0
      ? "from app.auth.user import current_user"
      : null,
    historyFind
      ? "from app.audit.history import AuditEntryListResponse, audit_snapshot_value, audit_value_changed"
      : null,
    historyFind ? "from app.db.audit import AuditRecordRow" : null,
    "from app.db.engine import get_session",
    // Wire-format helpers for a scalar operation-return value (money → its
    // canonical decimal string, datetime → ISO-8601) — the same projection
    // `to_wire` uses, reused when a non-void/non-union op answers 200.
    refersTo("iso") || refersTo("money_str")
      ? `from app.db.wire import ${[refersTo("iso") ? "iso" : null, refersTo("money_str") ? "money_str" : null].filter(Boolean).join(", ")}`
      : null,
    `from app.db.repositories.${snake(agg.name)}_repository import ${agg.name}Repository`,
    hasDispatch ? "from app.dispatch import make_dispatcher" : null,
    errorImports(refersTo),
    // Only the create route constructs the domain class directly.
    refersTo(agg.name) ? `from app.domain.${snake(agg.name)} import ${agg.name}` : null,
    hasDispatch ? null : "from app.domain.events import NoopDomainEventDispatcher",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    [...enumNames, ...voDomainNames].length > 0
      ? `from app.domain.value_objects import ${[...enumNames, ...voDomainNames].sort().join(", ")}`
      : null,
    problemImports(refersTo),
    wireModelImport(voModelImports, refersTo),
    // The catalog `log(...)` facade — `aggregate_created` (create route) and
    // `operation_invoked` (operation routes) narrative lines.
    refersTo("log") ? "from app.obs.log import log" : null,
    // Domain metrics (M-T7.1) — the per-operation counter, recorded next to
    // the operation_invoked / aggregate_created log lines.
    refersTo("record_domain_operation")
      ? "from app.obs.metrics import record_domain_operation"
      : null,
    "",
    "SessionDep = Annotated[AsyncSession, Depends(get_session)]",
    "",
    "",
    body,
    "",
  );
}

/** `app.http.problem` names this routes file references. */
/** The repo method a MUTATION route loads through: `get_by_id_for_write` when
 *  the aggregate carries a `writeScopeFilter` (authorization Phase 3 P3.1 — the
 *  write scope is narrower than the read scope), else `get_by_id` (byte-
 *  identical).  Read routes always use `get_by_id`. */
function cmdLoad(agg: EnrichedAggregateIR): string {
  return agg.writeScopeFilter ? "get_by_id_for_write" : "get_by_id";
}

function problemImports(refersTo: (n: string) => boolean): string | null {
  const names = [
    refersTo("ProblemDetails") ? "ProblemDetails" : null,
    refersTo("problem") ? "problem" : null,
  ].filter((n): n is string => n != null);
  return names.length > 0 ? `from app.http.problem import ${names.join(", ")}` : null;
}

/** The per-route error-response matrix (openapi-errors.ts) as a
 *  FastAPI `responses=` kwarg.  Declared via `"model": ProblemDetails`
 *  (which registers the shared component); `install_openapi` re-keys
 *  the content to application/problem+json — and routes that declare
 *  their own 422 here suppress FastAPI's auto HTTPValidationError. */
export function errorResponsesKwarg(
  kind: OpErrorKind,
  guarded = false,
  extra: number[] = [],
  /** Structural-conflict status resolver (M-T3.4a) — threaded so the
   *  `destroy` FK-restrict declaration (`ReferencedInUse`) moves with the
   *  `httpStatus` override; omitted ⇒ literal 409 (byte-identical default). */
  resolve?: (name: string) => number,
): string {
  const statuses = [...new Set([...errorStatuses(kind, guarded, resolve), ...extra])].sort(
    (a, b) => a - b,
  );
  if (statuses.length === 0) return "";
  const entries = statuses.map(
    (st) => `${st}: {"model": ProblemDetails, "description": "${problemTitle(st)}"}`,
  );
  return `, responses={${entries.join(", ")}}`;
}

/** The DERIVED operation's declared non-2xx set as the FastAPI `responses=`
 *  kwarg — `op.errorStatuses` is already httpStatus-resolved, sorted, and
 *  deduped (base table + when/versioned conflicts + union error arms), so the
 *  route renders it verbatim.  This is the unification seam: the numbers come
 *  from `deriveAggregateOperations`, only the kwarg idiom is python's. */
function derivedResponsesKwarg(op: ApiOperationIR): string {
  if (op.errorStatuses.length === 0) return "";
  const entries = op.errorStatuses.map(
    (st) => `${st}: {"model": ProblemDetails, "description": "${problemTitle(st)}"}`,
  );
  return `, responses={${entries.join(", ")}}`;
}

/** `resolveErrorStatus` bound to a context's `httpStatus` override map — the
 *  structural-conflict status resolver every route in the file threads
 *  (M-T3.4a). With no override every conflict resolves to 409 (byte-identical). */
export function conflictResolver(ctx: EnrichedBoundedContextIR): (name: string) => number {
  return (name) => resolveErrorStatus(name, ctx.structuralErrorStatuses);
}

/** The two pagination controls of a paged read, as FastAPI parameter
 *  declarations.  Both carry a DECLARED range: `ge=1` was already implied by
 *  the emitted repository, but nothing bounded the top, so an in-contract
 *  `page × pageSize` overflowed the SQL `OFFSET` and the read 500s
 *  (schemathesis F4).  `Query(...)` publishes `minimum`/`maximum` into the
 *  spec and turns an out-of-range value into FastAPI's standard 422 — the same
 *  bounds all five backends declare (`PAGED_MAX_PAGE` / `PAGED_MAX_PAGE_SIZE`). */
export const PY_PAGED_CONTROLS: readonly string[] = [
  `page: Annotated[int, Query(ge=1, le=${PAGED_MAX_PAGE})] = ${PAGED_DEFAULT_PAGE}`,
  `pageSize: Annotated[int, Query(ge=1, le=${PAGED_MAX_PAGE_SIZE})] = ${PAGED_DEFAULT_PAGE_SIZE}`,
];

/** `{id}` path-param annotation carrying the uuid format every backend
 *  declares (paramTypeDiffs parity).  Shared with the workflow-instance
 *  byId route (workflows-builder.ts), whose correlation-id param must
 *  carry the same format. */
export const ID_PARAM = 'id: Annotated[str, Path(json_schema_extra={"format": "uuid"})]';

/** The domain error names this routes file actually references. */
function errorImports(refersTo: (n: string) => boolean): string | null {
  const names = [
    "AggregateNotFoundError",
    "DisallowedError",
    "DomainError",
    "ForbiddenError",
  ].filter(refersTo);
  return names.length > 0 ? `from app.domain.errors import ${names.join(", ")}` : null;
}

/** Whether the REST layer exposes a create surface (POST route + request
 *  models) — an explicit / crudish canonical `create` (or a creation event
 *  for an ES aggregate).  Symmetric with the DELETE gate; parity with Hono's
 *  `emitCreate`.  Distinct from the DOMAIN `create` factory, which stays on
 *  `isConstructible`. */
function hasCreateFactory(agg: EnrichedAggregateIR): boolean {
  return emitsRestCreate(agg);
}

// --- DTO models ---------------------------------------------------------------

function responseModel(
  name: string,
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  ctx: EnrichedBoundedContextIR,
  declared?: PayloadIR,
): string {
  // Co-located provenance lineage (provenance.md): each `provenanced` field
  // exposes a trailing `<field>_provenance` carrying the current lineage on
  // the wire (root-only; parts never carry provenanced fields).
  const provFields = ent.fields.filter((f) => f.provenanced);
  // M-T5.10 (PR4): when the context declares a `response <Agg>Response` record
  // (spliced by `scaffoldHandlers`), READ that record's fields instead of
  // re-deriving from `wireShape` — byte-identical for the scaffolded form,
  // authoritative for a hand-declared divergent one.  The record omits `id`
  // (grammar-reserved), so the synthetic wire-shape id row is re-prepended;
  // a containment field is already the sibling `<Part>Response` name and is
  // rendered directly to avoid a double `Response` suffix.
  if (declared) {
    const idWf = forApiRead(wireFieldsFor(ent)).find((wf) => wf.source === "id");
    return lines(
      `class ${name}Response(BaseModel):`,
      idWf ? `    ${idWf.name}: ${responsePyType(idWf.type, ctx)}` : [],
      declared.fields.map((f) => {
        const t = payloadFieldPyType(f.type, ctx);
        const optional = f.optional || f.type.kind === "optional";
        const suffix =
          optional && !t.endsWith("| None") ? " | None = None" : optional ? " = None" : "";
        return `    ${f.name}: ${t}${suffix}`;
      }),
      provFields.map((f) => `    ${provColumn(f.name)}: dict[str, object] | None = None`),
      "",
      "",
    );
  }
  const fields = forApiRead(wireFieldsFor(ent));
  return lines(
    `class ${name}Response(BaseModel):`,
    fields.map((wf) => {
      const t =
        wf.source === "containment"
          ? containmentResponseType(wf.type)
          : responsePyType(wf.type, ctx);
      // A `mask unless` field can be redacted to null on a response (fail-closed),
      // so the wire schema must admit null even when the field is declared
      // non-optional (authorization.md §5).
      const optional = wf.optional || wf.type.kind === "optional" || wf.maskUnless !== undefined;
      const suffix =
        optional && !t.endsWith("| None") ? " | None = None" : optional ? " = None" : "";
      return `    ${wf.name}: ${t}${suffix}`;
    }),
    provFields.map((f) => `    ${provColumn(f.name)}: dict[str, object] | None = None`),
    "",
    "",
  );
}

function containmentResponseType(t: TypeIR): string {
  if (t.kind === "array" && t.element.kind === "entity") return `list[${t.element.name}Response]`;
  if (t.kind === "entity") return `${t.name}Response | None`;
  return "object";
}

/** True iff `name` is a declared `response` payload in the context — a
 *  containment field's already-wire type, which must not be re-suffixed. */
function isResponsePayloadName(ctx: EnrichedBoundedContextIR, name: string): boolean {
  return ctx.payloads.some((p) => p.kind === "response" && p.name === name);
}

/** Pydantic type for a field of a DECLARED `response` payload record (M-T5.10).
 *  A VO / scalar / enum / id field carries its DOMAIN type, so `responsePyType`
 *  maps it as the wireShape path does.  A CONTAINMENT field is ALREADY the
 *  sibling `<Part>Response` name (PR1 rewrote the raw entity part, which context
 *  scope can't reference) — it must be rendered DIRECTLY (`list[LineResponse]`),
 *  since running it through `containmentResponseType` would append a second
 *  `Response` (`list[LineResponseResponse]`). */
function payloadFieldPyType(t: TypeIR, ctx: EnrichedBoundedContextIR): string {
  if (
    t.kind === "array" &&
    t.element.kind === "entity" &&
    isResponsePayloadName(ctx, t.element.name)
  )
    return `list[${t.element.name}]`;
  if (t.kind === "entity" && isResponsePayloadName(ctx, t.name)) return `${t.name} | None`;
  return responsePyType(t, ctx);
}

/** Map each create-input field to a Pydantic `Field(...)` expression carrying
 *  the constraints implied by the aggregate's single-field invariants, so an
 *  invalid create is rejected by FastAPI at the request boundary with 422
 *  (matching Hono's zod chains / Phoenix's changeset validations) instead of
 *  reaching the domain and raising DomainError → 400.  Mirrors the wire-scope
 *  + classifier filtering Hono uses (`takeSingleFieldChain`); `&&` conjuncts
 *  on one field (e.g. `email.matches(r) && email.length <= 120`) become a
 *  single `Field(pattern=, max_length=)`. */
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
  const available = new Set(inputs.map((f) => f.name));
  const constraints = createFieldConstraints(agg.invariants, available);
  return lines(
    `class Create${agg.name}Request(BaseModel):`,
    inputs.length > 0
      ? inputs.map((f) =>
          withFieldConstraint(
            f.name,
            requestFieldDecl(f.type, f.optional, ctx, f.default),
            constraints.get(f.name),
          ),
        )
      : ["    pass"],
    createModelValidator(agg.invariants, available, `Create${agg.name}Request`),
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
  // Field-level invariants (SYS-1): the op's request DTO gets the SAME wire
  // constraints as Create<Agg>Request, plus the op's own preconditions.
  // `available = op.params` drops any invariant over a field the op doesn't
  // take (mirrors the create-input filter), so an invalid update fails at the
  // FastAPI boundary (422) instead of reaching the domain floor.
  const cls = `${upperFirst(op.name)}${agg.name}Request`;
  const available = new Set(op.params.map((p) => p.name));
  const invariants: InvariantIR[] = [...agg.invariants, ...preconditionsAsInvariants(op)];
  const constraints = createFieldConstraints(invariants, available);
  return lines(
    `class ${cls}(BaseModel):`,
    op.params.length > 0
      ? op.params.map((p) =>
          withFieldConstraint(
            p.name,
            requestFieldDecl(p.type, false, ctx, undefined, "operation"),
            constraints.get(p.name),
          ),
        )
      : ["    pass"],
    createModelValidator(invariants, available, cls),
    "",
    "",
  );
}

/** Lift each `precondition` statement on an operation to an `InvariantIR` so the
 *  same wire classification (single-field `Field(...)` + cross-field
 *  `model_validator`) handles wire-translatable preconditions on `<Op>Request`,
 *  mirroring Hono's `preconditionsAsInvariants`. */
function preconditionsAsInvariants(op: OperationIR): InvariantIR[] {
  const out: InvariantIR[] = [];
  for (const s of op.statements) {
    if (s.kind === "precondition") out.push({ expr: s.expr, source: s.source, message: s.message });
  }
  return out;
}

/** Request-model field declaration with the cross-backend required-set
 *  semantics: a field with an EXPLICIT declared default becomes
 *  optional-with-that-default (matching Hono's `.default(<declared>)`);
 *  otherwise optional-typed values default to None, and a bare bool carries
 *  the language-defined implicit `= False`.
 *
 *  `defaultExpr` (the field's lowered `= <expr>` default) must win over the
 *  implicit bool `= False` — else `active: bool = true` omitted on create would
 *  arrive `False` (RS-6; surfaced by the python behavioral tier).
 *
 *  `slot` scopes the implicit bool rule to CREATE input, which is the only
 *  place it is defined (`hasImplicitDefault` in wire-projection.ts: "an omitted
 *  create input is well-defined without an explicit `= default`").  On an
 *  OPERATION body — `update` included — there is nothing to construct, so an
 *  omitted field is a missing required one, not a `False`: emitting `= False`
 *  there let a PUT that left out `active: bool = true` silently overwrite a
 *  stored `true` (RS-26, the inverse of RS-6). */
export function requestFieldDecl(
  t: TypeIR,
  optional: boolean,
  ctx: BoundedContextIR,
  defaultExpr?: ExprIR,
  slot: "create" | "operation" = "create",
): string {
  const base = requestPyType(t, ctx);
  // A SERVER-SOURCED default (`now()` / `currentUser.*`) must NOT be a Pydantic
  // field default: the expression is evaluated once at class definition (module
  // load), so `= datetime.now(UTC)` freezes every omitted row to boot time, and
  // `= current_user.tenant_id` is an outright import-time AttributeError (the
  // module-level `current_user` is the accessor function, not a request user).
  // Emit the field as optional (`| None = None`); the create handler coalesces
  // the per-request value.
  if (defaultExpr && isServerSourcedDefault(defaultExpr)) {
    return base.endsWith("| None") ? `${base} = None` : `${base} | None = None`;
  }
  // A VALUE-OBJECT default constructs the DOMAIN class, but this field is
  // typed as the WIRE model (`requestPyType` maps a VO to `<VO>Model`), so
  // `renderPyExpr` would put `Money(...)` in a `MoneyModel` slot — a
  // `mypy --strict` incompatible-assignment.  Re-render it in the wire shape.
  // Pydantic evaluates a field default per model instantiation, so unlike the
  // server-sourced case there is nothing frozen at import and no coalesce
  // needed — the default can simply BE the wire value.
  if (defaultExpr && isValueObjectDefault(defaultExpr) && defaultExpr.kind === "call") {
    const args = defaultExpr.args
      .map((a, i) => {
        const slot = defaultExpr.argNames?.[i];
        return `${slot ? `${slot}=` : ""}${renderPyExpr(a)}`;
      })
      .join(", ");
    return `${base} = ${defaultExpr.name}Model(${args})`;
  }
  if (defaultExpr) return `${base} = ${renderPyExpr(defaultExpr)}`;
  const isOpt = optional || t.kind === "optional";
  if (isOpt) return base.endsWith("| None") ? `${base} = None` : `${base} | None = None`;
  if (slot === "create" && t.kind === "primitive" && t.name === "bool") return `${base} = False`;
  return base;
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
      // Money arrives as its canonical decimal string (`requestPyType` →
      // `str`, wire parity with Hono/.NET); the domain works in Decimal.
      if (t.name === "money") return `Decimal(${expr})`;
      return expr;
    default:
      return expr;
  }
}

// --- lifecycle stamps -----------------------------------------------------------

/** The stamp assignments for one lifecycle event (create / update). */
function stampRules(agg: EnrichedAggregateIR, event: "create" | "update") {
  return (agg.contextStamps ?? []).filter((r) => r.event === event).flatMap((r) => r.assignments);
}

/** Whether this aggregate carries a lifecycle stamp for `event`. */
function hasStamp(agg: EnrichedAggregateIR, event: "create" | "update"): boolean {
  return stampRules(agg, event).length > 0;
}

/** Whether the `event` stamp references the request principal (so the route
 *  must thread `current_user` into the stamp call). */
function stampUsesUser(agg: EnrichedAggregateIR, event: "create" | "update"): boolean {
  return stampRules(agg, event).some((a) => exprUsesCurrentUser(a.value));
}

/** The `<var>._stamp_on_<event>([current_user])` call line — emitted right
 *  before the repository persist (parity with Java's service stamp call). */
function stampCall(agg: EnrichedAggregateIR, event: "create" | "update", varName: string): string {
  return `    ${varName}._stamp_on_${event}(${stampUsesUser(agg, event) ? "current_user" : ""})`;
}

// --- routes ---------------------------------------------------------------------

// The lifecycle audit row for a `create(...) audited` — staged through the repo
// (same session, so it commits with the save).  Asymmetry: `before` is JSON null
// (JSON.NULL → the `null` literal, satisfying the NOT NULL jsonb column),
// `after` is the freshly-created wire snapshot keyed by the generated id.
function createAuditCall(agg: EnrichedAggregateIR): string[] {
  return [
    "    await repo.record_audit(",
    `        operation_id=${JSON.stringify(`create${agg.name}`)},`,
    '        action="create",',
    `        target_type=${JSON.stringify(agg.name)},`,
    "        target_id=str(created.id),",
    "        before=JSON.NULL,",
    "        after=repo.to_wire(created),",
    "    )",
  ];
}

function createRoute(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  apiOp: ApiOperationIR,
): string {
  const createAction = agg.persistedAs === "eventLog" ? agg.creates?.[0] : agg.canonicalCreate;
  const auditCreate = !!createAction?.audited;
  const esCreate = agg.persistedAs === "eventLog" ? agg.creates?.[0] : undefined;
  if (esCreate) {
    const args = esCreate.params
      .map((p) => `${snake(p.name)}=${pyWireToDomain(`body.${p.name}`, p.type, ctx)}`)
      .join(", ");
    return lines(
      `@router.post("${relativeOpPath(apiOp)}", status_code=201, response_model=Create${agg.name}Response, operation_id="${camelId(opCreate(agg.name))}"${derivedResponsesKwarg(apiOp)})`,
      `async def create_${snake(agg.name)}(body: Create${agg.name}Request, session: SessionDep) -> dict[str, object]:`,
      `    created = ${agg.name}.create(${args})`,
      auditCreate ? "    repo = _repo(session)" : null,
      auditCreate ? "    await repo.save(created)" : "    await _repo(session).save(created)",
      ...(auditCreate ? createAuditCall(agg) : []),
      `    log("info", "aggregate_created", aggregate=${JSON.stringify(agg.name)}, id=created.id)`,
      `    record_domain_operation(${JSON.stringify(agg.name)}, "create")`,
      `    return {"id": created.id}`,
    );
  }
  const inputs = forCreateInput(agg.fields);
  // A server-sourced field default (`now()` / `currentUser.*`) is applied
  // per-request HERE (the request field is optional): the factory arg coalesces
  // the client's value with the freshly-evaluated default.  In the handler body
  // `renderPyExpr` yields `datetime.now(UTC)` / `current_user.<claim>` off the
  // request-scoped local — authoritative server-side, not frozen at import.
  const args = inputs
    .map((f) => {
      const wire = pyWireToDomain(`body.${f.name}`, f.type, ctx);
      if (f.default !== undefined && isServerSourcedDefault(f.default)) {
        return `${snake(f.name)}=${wire} if body.${f.name} is not None else ${renderPyExpr(f.default)}`;
      }
      return `${snake(f.name)}=${wire}`;
    })
    .join(", ");
  // Lifecycle stamps (audit / softDelete): apply onCreate stamps right before
  // the persist.  A principal-referencing stamp threads `current_user` off the
  // request scope (the route then takes a `request: Request` param).  A
  // `currentUser.*` field default needs the same binding.
  const defaultUsesPrincipal = inputs.some(
    (f) =>
      f.default !== undefined &&
      isServerSourcedDefault(f.default) &&
      !(f.default.kind === "literal" && f.default.lit === "now"),
  );
  const stampUsesPrincipal = stampUsesUser(agg, "create") || defaultUsesPrincipal;
  // The canonical create's `requires` gate needs the same request-scoped
  // principal the stamps and `currentUser.*` defaults do — one binding serves
  // all three (a second `current_user: User = …` would be a redefinition ruff
  // flags).
  const gateUsesPrincipal = lifecycleGatesUseCurrentUser(agg.canonicalCreate);
  const bindPrincipal = stampUsesPrincipal || gateUsesPrincipal;
  const sig = [
    `body: Create${agg.name}Request`,
    ...(bindPrincipal ? ["request: Request"] : []),
    "session: SessionDep",
  ].join(", ");
  return lines(
    `@router.post("${relativeOpPath(apiOp)}", status_code=201, response_model=Create${agg.name}Response, operation_id="${camelId(opCreate(agg.name))}"${derivedResponsesKwarg(apiOp)})`,
    `async def create_${snake(agg.name)}(${sig}) -> dict[str, object]:`,
    bindPrincipal ? "    current_user: User = request.state.current_user" : null,
    // BEFORE the factory: a denied create must construct nothing (and, when
    // audited, stage nothing).
    ...lifecycleGate(agg.canonicalCreate),
    `    created = ${agg.name}.create(${args})`,
    hasStamp(agg, "create") ? stampCall(agg, "create", "created") : null,
    auditCreate ? "    repo = _repo(session)" : null,
    auditCreate ? "    await repo.save(created)" : "    await _repo(session).save(created)",
    ...(auditCreate ? createAuditCall(agg) : []),
    `    log("info", "aggregate_created", aggregate=${JSON.stringify(agg.name)}, id=created.id)`,
    `    record_domain_operation(${JSON.stringify(agg.name)}, "create")`,
    `    return {"id": created.id}`,
  );
}

function allRoute(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  apiOp: ApiOperationIR,
): string {
  // The implicit findAll is paged (M-T2.6) for a plain relational aggregate: the
  // list GET carries the `<Agg>Paged` envelope + page/pageSize/sort/dir query
  // controls and maps the `PagedResult` carrier to the wire shape — matching
  // every other backend.  A non-paged findAll keeps the bare-array list.
  const autoAll = repo?.finds.find((f) => f.name === "all" && f.params.length === 0 && !f.filter);
  const paged = autoAll ? pagedReturn(autoAll.returnType) : null;
  // The LIST read's authorization gate.  The list endpoint is emitted here
  // rather than in the named-find loop (`emittableFinds` filters `all` out — it
  // has a bespoke paged shape), which is exactly how its `requires` came to be
  // dropped while every named find's was honoured.  Same 403-before-query
  // contract as `findRoute` below, down to the message and the negated-guard
  // rendering (`x not in y`, ruff E713).
  const listRead = listReadFind(repo);
  const gate = listRead?.requires;
  const gateUsesUser = !!gate && exprUsesCurrentUser(gate);
  const userParam = gateUsesUser ? ["request: Request"] : [];
  const gateLines: LinesPart = gate
    ? [
        gateUsesUser ? "    current_user: User = request.state.current_user" : null,
        `    if ${renderPyNegatedGuard(gate)}:`,
        `        raise ForbiddenError(${JSON.stringify(`Forbidden: find ${listRead!.name}`)})`,
      ]
    : null;
  if (paged) {
    // `request` (when the gate needs it) precedes the defaulted params — Python
    // forbids a non-default parameter after a defaulted one.
    const sig = [
      ...userParam,
      "session: SessionDep",
      ...PY_PAGED_CONTROLS,
      `sort: str = "id"`,
      `dir: str = "asc"`,
    ].join(", ");
    return lines(
      `@router.get("${relativeOpPath(apiOp)}", response_model=${paged.name}, operation_id="all${agg.name}"${derivedResponsesKwarg(apiOp)})`,
      `async def all_${snake(plural(agg.name))}(${sig}) -> dict[str, object]:`,
      gateLines,
      "    repo = _repo(session)",
      "    result = await repo.all(page, pageSize, sort, dir)",
      "    return {",
      `        "items": [${wireResp(agg, "r")} for r in result.items],`,
      '        "page": result.page,',
      '        "pageSize": result.page_size,',
      '        "total": result.total,',
      '        "totalPages": result.total_pages,',
      "    }",
    );
  }
  return lines(
    `@router.get("${relativeOpPath(apiOp)}", response_model=${agg.name}ListResponse, operation_id="all${agg.name}"${derivedResponsesKwarg(apiOp)})`,
    `async def all_${snake(plural(agg.name))}(${[...userParam, "session: SessionDep"].join(", ")}) -> list[dict[str, object]]:`,
    gateLines,
    "    repo = _repo(session)",
    `    return [${wireResp(agg, "root")} for root in await repo.all()]`,
  );
}

function byIdRoute(agg: EnrichedAggregateIR, apiOp: ApiOperationIR): string {
  return lines(
    `@router.get("${relativeOpPath(apiOp)}", response_model=${agg.name}Response, operation_id="${camelId(opGetById(agg.name))}"${derivedResponsesKwarg(apiOp)})`,
    `async def get_${snake(agg.name)}_by_id(${ID_PARAM}, session: SessionDep) -> dict[str, object]:`,
    "    repo = _repo(session)",
    `    return ${wireResp(agg, `await repo.get_by_id(${agg.name}Id(id))`)}`,
  );
}

/** `GET /{id}/history` — the per-entity audit trail (docs/audit.md).
 *
 *  Three guards, in order, mirroring the Hono port exactly:
 *    1. the inherited `requires` gate → 403 before any query runs;
 *    2. ENTITY reachability via `get_by_id`, which already carries every
 *       capability query-filter (the `tenantOwned` tenant floor included) —
 *       `audit_records` has no tenant column of its own to scope, so a row the
 *       caller cannot read 404s here rather than yielding a readable timeline;
 *    3. the per-caller mask, applied inside the mapper.
 */
function historyRoute(
  agg: EnrichedAggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const gateUsesUser = findGateUsesCurrentUser(find);
  return lines(
    `@router.get("/{id}/history", response_model=AuditEntryListResponse, operation_id="${camelId(opFind(agg.name, "history"))}"${errorResponsesKwarg("getById", false, [], conflictResolver(ctx))})`,
    `async def history_${snake(agg.name)}(${ID_PARAM}, session: SessionDep) -> list[dict[str, object]]:`,
    "    repo = _repo(session)",
    gateUsesUser ? "    current_user_ = current_user()" : null,
    find.requires
      ? `    if ${renderPyNegatedGuard(find.requires, { thisName: "self", currentUserExpr: "current_user_" })}:\n        raise ForbiddenError("Forbidden")`
      : null,
    // (2) — reachability, not a predicate on the audit table.
    `    await repo.get_by_id(${agg.name}Id(id))`,
    `    __rows = await repo.history(${agg.name}Id(id))`,
    `    return [${pyHistoryMapperName(agg)}(__r) for __r in __rows]`,
  );
}

function destroyRoute(
  agg: EnrichedAggregateIR,
  resolve: (name: string) => number,
  apiOp: ApiOperationIR,
): string {
  // The cross-aggregate `X id` FK is ON DELETE RESTRICT — a still-referenced
  // delete raises IntegrityError → the `ReferencedInUse` structural conflict,
  // remappable via `httpStatus` (M-T3.4a). Default resolves to 409.
  const referencedInUse = resolve("ReferencedInUse");
  // Audited destroy: snapshot the loaded wire shape, stage the audit row through
  // the repo (same session → commits with the delete), THEN hard-delete.
  // Asymmetry: `before` is the last snapshot, `after` is JSON null (JSON.NULL →
  // the `null` literal, satisfying the NOT NULL jsonb column).
  const auditDestroy = !!agg.canonicalDestroy?.audited;
  const destroyAuditCall = auditDestroy
    ? [
        "    await repo.record_audit(",
        `        operation_id=${JSON.stringify(`destroy${agg.name}`)},`,
        '        action="destroy",',
        `        target_type=${JSON.stringify(agg.name)},`,
        "        target_id=str(id),",
        "        before=__before,",
        "        after=JSON.NULL,",
        "    )",
      ]
    : [];
  // The canonical destroy's `requires` gate runs AFTER the load (it may read
  // the row) and BEFORE the audit row is staged, so a denied delete records
  // nothing.  A principal-only gate reads no field, so it needs no receiver —
  // the load still runs as the 404 probe but is not bound (ruff F841).
  const destroyGateReadsRow = lifecycleGatesReadRow(agg.canonicalDestroy);
  const destroyGateUsesUser = lifecycleGatesUseCurrentUser(agg.canonicalDestroy);
  const bindLoaded = auditDestroy || destroyGateReadsRow;
  return lines(
    `@router.delete("${relativeOpPath(apiOp)}", status_code=204, operation_id="${camelId(opDestroy(agg.name))}"${derivedResponsesKwarg(apiOp)})`,
    `async def destroy_${snake(agg.name)}(${ID_PARAM}, request: Request, session: SessionDep) -> Response:`,
    "    repo = _repo(session)",
    bindLoaded
      ? `    __loaded = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`
      : `    await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
    destroyGateUsesUser ? "    current_user: User = request.state.current_user" : null,
    ...lifecycleGate(agg.canonicalDestroy, destroyGateReadsRow ? "__loaded" : undefined),
    auditDestroy ? "    __before = repo.to_wire(__loaded)" : null,
    ...destroyAuditCall,
    "    try:",
    `        await repo.delete(${agg.name}Id(id))`,
    "    except IntegrityError:",
    "        await session.rollback()",
    "        return problem(",
    "            request,",
    `            ${referencedInUse},`,
    `            "Conflict",`,
    `            "${agg.name} is still referenced and cannot be deleted.",`,
    "        )",
    "    return Response(status_code=204)",
  );
}

/** The `when` state-gate line(s) injected after the aggregate loads and
 *  before the operation body runs — false → DisallowedError (409),
 *  matching the side-effect-free `can_<op>` predicate. */
/** The hoisted authorization gate — the leading run of `requires` statements,
 *  evaluated by the HANDLER rather than the aggregate (`src/ir/util/op-gates.ts`).
 *
 *  Emitted post-load (so a row-aware term reads the loaded `found`) and BEFORE
 *  the `when` state gate: 403 precedes 409, so an unauthorized caller never
 *  learns the row's state. */
function requiresGate(op: OperationIR, ctx: BoundedContextIR): string[] {
  return operationGates(op).flatMap((g) => {
    // `renderPyNegatedGuard` (not a bare `not (...)`) so a membership gate keeps
    // the idiomatic `x not in y` the statement renderer produced before the
    // hoist — the check moved, its spelling shouldn't.
    const guard = renderPyNegatedGuard(g.expr, {
      thisName: "found",
      // Operation params are NOT locals here — the handler holds them at the
      // wire-read expression the call is about to pass.
      paramExpr: (name) => {
        const p = op.params.find((q) => q.name === name);
        return p ? pyWireToDomain(`body.${p.name}`, p.type, ctx) : undefined;
      },
    });
    return [
      `    if ${guard}:`,
      `        raise ForbiddenError(${JSON.stringify(`Forbidden: ${g.source}`)})`,
    ];
  });
}

/** The canonical `create` / `destroy` authorization gate, in the ROUTE.
 *
 *  The same statements, the same `renderPyNegatedGuard` spelling and the same
 *  `ForbiddenError` (→ 403) as `requiresGate` above — the lifecycle gate is the
 *  operation gate with a different receiver:
 *
 *    create  — none.  It runs BEFORE the factory, so it reads the principal
 *              only (`loom.lifecycle-guard-unreadable` enforces that).
 *    destroy — `__loaded`, the row the route already loaded for its 404 probe,
 *              so an unreachable id answers 404 before 403. */
function lifecycleGate(action: OperationIR | null | undefined, thisName?: string): string[] {
  return lifecycleGates(action).flatMap((g) => [
    `    if ${renderPyNegatedGuard(g.expr, thisName ? { thisName } : undefined)}:`,
    `        raise ForbiddenError(${JSON.stringify(`Forbidden: ${g.source}`)})`,
  ]);
}

function whenGate(agg: EnrichedAggregateIR, op: OperationIR): string[] {
  if (!op.when) return [];
  return [
    `    if ${renderPyNegatedGuard(op.when, { thisName: "found" })}:`,
    `        raise DisallowedError(${JSON.stringify(
      `operation '${op.name}' is not allowed in the current state of ${agg.name}.`,
    )})`,
  ];
}

/** The auto-exposed, side-effect-free `GET /{id}/can_<op>` companion of a
 *  `when`-gated operation — loads the aggregate, evaluates the predicate,
 *  returns `{ allowed }` so a UI can enable/disable the action without
 *  invoking it (the canCommand pattern). */
function canOpRoute(agg: EnrichedAggregateIR, op: OperationIR, apiOp: ApiOperationIR): string {
  const pred = renderPyExpr(op.when as ExprIR, { thisName: "found" });
  return lines(
    `@router.get("${relativeOpPath(apiOp)}", response_model=CanResponse, operation_id="${camelId(opOperation(agg.name, `can_${op.name}`))}"${derivedResponsesKwarg(apiOp)})`,
    `async def can_${snake(op.name)}_${snake(agg.name)}(${ID_PARAM}, session: SessionDep) -> dict[str, object]:`,
    "    repo = _repo(session)",
    `    found = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
    `    return {"allowed": ${pred}}`,
  );
}

/** Per-operation audit capture (audit-and-logging.md): an `audited` op records
 *  a who/what/when + before/after wire snapshot.  before/after are the
 *  aggregate's wire projection (`repo.to_wire`) either side of the mutation;
 *  the record is persisted through the repo INSIDE the request session (same
 *  txn as the save) via `record_audit`.  The actor + correlation / scope /
 *  parent ids are stamped from the ambient RequestContext inside record_audit.
 *  Parity with the Hono transactional route + the .NET / Java service insert. */
function auditRecordCall(agg: EnrichedAggregateIR, op: OperationIR): string[] {
  return [
    "    await repo.record_audit(",
    `        operation_id=${JSON.stringify(`${op.name}${agg.name}`)},`,
    `        action=${JSON.stringify(op.name)},`,
    `        target_type=${JSON.stringify(agg.name)},`,
    "        target_id=str(id),",
    "        before=__before,",
    "        after=__after,",
    "    )",
  ];
}

/** Optimistic-concurrency plumbing for a `versioned` aggregate's mutating
 *  route.  Reads the caller's expected version off the `If-Match` header
 *  (absent/malformed ⇒ write-time CAS against the loaded version) and threads
 *  it to the guarded repository save, which raises ConcurrencyError → 409 when
 *  the stored version no longer matches.  A non-versioned aggregate keeps the
 *  bare `save(found)` and emits nothing extra (byte-identical). */
function versionedSave(
  agg: EnrichedAggregateIR,
  foundVar = "found",
): { ifMatch: string[]; save: string } {
  if (!aggregateIsVersioned(agg)) {
    return { ifMatch: [], save: `    await repo.save(${foundVar})` };
  }
  return {
    ifMatch: [
      // `chr(34)` is a literal double-quote — used instead of a quoted `"` so
      // the routes-file import scanner's string-blanking regex (which pairs
      // double-quotes) isn't thrown off by a lone quote inside a Python string.
      '    _if_match = request.headers.get("if-match", "").strip(chr(34))',
      "    _expected = int(_if_match) if _if_match.isdigit() else None",
    ],
    save: `    await repo.save(${foundVar}, expected_version=_expected)`,
  };
}

/** Serialize a scalar operation-return domain value to its wire form —
 *  the same per-scalar handling the repository's `to_wire` projection uses:
 *  money → its canonical decimal string (`money_str`), datetime → ISO-8601
 *  (`iso`), every other scalar rides as-is.  Optionals guard `None` so a
 *  `T?` return doesn't feed `None` into the string helper. */
function pyScalarReturnToWire(expr: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "primitive" && (inner.name === "money" || inner.name === "datetime")) {
    const wire = inner.name === "money" ? `money_str(${expr})` : `iso(${expr})`;
    return t.kind === "optional" ? `${wire} if ${expr} is not None else None` : wire;
  }
  return expr;
}

function operationRoute(
  agg: EnrichedAggregateIR,
  op: OperationIR,
  ctx: EnrichedBoundedContextIR,
  apiOp: ApiOperationIR,
): string {
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
    const usesUser = operationBodyUsesCurrentUser(op);
    const gateUsesUser = operationGatesUseCurrentUser(op);
    // Update stamps apply right before the persist; a principal-referencing
    // stamp needs `current_user` bound (the route already takes `request`).
    const stampUpdateUsesUser = stampUsesUser(agg, "update");
    const callArgs = [...op.params.map((p) => pyWireToDomain(`body.${p.name}`, p.type, ctx))];
    if (usesUser) callArgs.push("current_user");
    const vsave = versionedSave(agg);
    return lines(
      // NAMED FIX (unification): the declared set now includes the union
      // error arms' statuses — this route always ANSWERED them (the
      // ProblemDetails translations below) but never declared them.
      `@router.post("${relativeOpPath(apiOp)}", response_model=None, operation_id="${camelId(opOperation(agg.name, op.name))}"${derivedResponsesKwarg(apiOp)})`,
      `async def ${snake(op.name)}_${snake(agg.name)}(${ID_PARAM}, body: ${upperFirst(op.name)}${agg.name}Request, request: Request, session: SessionDep) -> dict[str, object] | JSONResponse:`,
      usesUser || gateUsesUser || stampUpdateUsesUser
        ? "    current_user: User = request.state.current_user"
        : null,
      "    repo = _repo(session)",
      `    found = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
      `    log("info", "operation_invoked", aggregate=${JSON.stringify(agg.name)}, op=${JSON.stringify(op.name)}, id=id)`,
      `    record_domain_operation(${JSON.stringify(agg.name)}, ${JSON.stringify(op.name)})`,
      ...requiresGate(op, ctx),
      ...whenGate(agg, op),
      op.audited ? "    __before = repo.to_wire(found)" : null,
      `    result = found.${snake(op.name)}(${callArgs.join(", ")})`,
      hasStamp(agg, "update") ? stampCall(agg, "update", "found") : null,
      ...vsave.ifMatch,
      vsave.save,
      op.audited ? "    __after = repo.to_wire(found)" : null,
      ...(op.audited ? auditRecordCall(agg, op) : []),
      ...translations,
      "    return result",
    );
  }
  // currentUser-gated ops read the actor the auth middleware stashed on
  // the request scope and thread it as the trailing domain argument; a
  // `requires`-guarded op additionally declares its 403 outcome.
  const usesUser = operationBodyUsesCurrentUser(op);
  const gateUsesUser = operationGatesUseCurrentUser(op);
  // Update stamps apply right before the persist; a principal-referencing
  // stamp threads `current_user` off the request scope (and takes `request`).
  const stampUpdateUsesUser = stampUsesUser(agg, "update");
  const versioned = aggregateIsVersioned(agg);
  const needsRequest = usesUser || gateUsesUser || stampUpdateUsesUser || versioned;
  const opSig = [
    ID_PARAM,
    `body: ${upperFirst(op.name)}${agg.name}Request`,
    ...(needsRequest ? ["request: Request"] : []),
    "session: SessionDep",
  ].join(", ");
  const callArgs = [...op.params.map((p) => pyWireToDomain(`body.${p.name}`, p.type, ctx))];
  if (usesUser) callArgs.push("current_user");
  const vsave = versionedSave(agg);
  // A scalar (non-void, non-union) return type — `operation describe(): string`.
  // Structurally a one-success / zero-error union: capture the returned domain
  // value exactly as the union arm does (`result = found.<op>(...)`), serialize
  // it to wire, and answer 200 with the value declared as `response_model` (so
  // it lands in the OpenAPI spec), instead of the 204 that discarded it.
  if (op.returnType) {
    const wireType = responsePyType(op.returnType, ctx);
    return lines(
      `@router.post("${relativeOpPath(apiOp)}", response_model=${wireType}, operation_id="${camelId(opOperation(agg.name, op.name))}"${derivedResponsesKwarg(apiOp)})`,
      `async def ${snake(op.name)}_${snake(agg.name)}(${opSig}) -> ${wireType}:`,
      usesUser || gateUsesUser || stampUpdateUsesUser
        ? "    current_user: User = request.state.current_user"
        : null,
      "    repo = _repo(session)",
      `    found = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
      `    log("info", "operation_invoked", aggregate=${JSON.stringify(agg.name)}, op=${JSON.stringify(op.name)}, id=id)`,
      `    record_domain_operation(${JSON.stringify(agg.name)}, ${JSON.stringify(op.name)})`,
      ...requiresGate(op, ctx),
      ...whenGate(agg, op),
      op.audited ? "    __before = repo.to_wire(found)" : null,
      `    result = found.${snake(op.name)}(${callArgs.join(", ")})`,
      hasStamp(agg, "update") ? stampCall(agg, "update", "found") : null,
      ...vsave.ifMatch,
      vsave.save,
      op.audited ? "    __after = repo.to_wire(found)" : null,
      ...(op.audited ? auditRecordCall(agg, op) : []),
      `    return ${pyScalarReturnToWire("result", op.returnType)}`,
    );
  }
  return lines(
    `@router.post("${relativeOpPath(apiOp)}", status_code=204, operation_id="${camelId(opOperation(agg.name, op.name))}"${derivedResponsesKwarg(apiOp)})`,
    `async def ${snake(op.name)}_${snake(agg.name)}(${opSig}) -> Response:`,
    usesUser || gateUsesUser || stampUpdateUsesUser
      ? "    current_user: User = request.state.current_user"
      : null,
    "    repo = _repo(session)",
    `    found = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
    `    log("info", "operation_invoked", aggregate=${JSON.stringify(agg.name)}, op=${JSON.stringify(op.name)}, id=id)`,
    `    record_domain_operation(${JSON.stringify(agg.name)}, ${JSON.stringify(op.name)})`,
    ...requiresGate(op, ctx),
    ...whenGate(agg, op),
    op.audited ? "    __before = repo.to_wire(found)" : null,
    `    found.${snake(op.name)}(${callArgs.join(", ")})`,
    hasStamp(agg, "update") ? stampCall(agg, "update", "found") : null,
    ...vsave.ifMatch,
    vsave.save,
    op.audited ? "    __after = repo.to_wire(found)" : null,
    ...(op.audited ? auditRecordCall(agg, op) : []),
    "    return Response(status_code=204)",
  );
}

function findRoute(
  agg: EnrichedAggregateIR,
  find: import("../../ir/types/loom-ir.js").FindIR,
  ctx: EnrichedBoundedContextIR,
  apiOp: ApiOperationIR,
): string {
  const findSnake = snake(find.name);
  const isList = find.returnType.kind === "array";
  // A currentUser-scoped find (`where … == currentUser.x`) reads the
  // actor off the request scope and passes it as the trailing repo arg.
  const usesUser = findUsesCurrentUser(find);
  // A `requires` authorization gate (default-deny) runs before the query and
  // raises ForbiddenError (→ 403) when the predicate fails — the read-side twin
  // of a read `requires` gate.  It needs the principal bound when it reads currentUser.
  const gateUsesUser = !!find.requires && exprUsesCurrentUser(find.requires);
  const needsUser = usesUser || gateUsesUser;
  const userBind = needsUser ? "    current_user: User = request.state.current_user" : null;
  const gateLines: LinesPart = find.requires
    ? [
        // renderPyNegatedGuard so a bare `.contains(...)` membership gate emits
        // `x not in y` rather than `not (x in y)` (ruff E713) — the same helper
        // the operation/workflow/projection `requires` guards use.
        `    if ${renderPyNegatedGuard(find.requires)}:`,
        `        raise ForbiddenError(${JSON.stringify(`Forbidden: find ${find.name}`)})`,
      ]
    : null;
  const params = find.params.map((p) => `${p.name}: ${requestPyType(p.type, ctx)}`);
  const sig = [...params, ...(needsUser ? ["request: Request"] : []), "session: SessionDep"].join(
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
    // The absent variant's HTTP status: `none` rides the AggregateNotFoundError
    // → 404 handler; an `error` payload becomes a ProblemDetails at its mapped
    // status.  Declared on the OpenAPI route so the error response is typed
    // (was missing) and the 200 is the SUCCESS variant directly — never a
    // tagged union (exception-less.md §4).
    const absentStatus =
      unionSpec.absent.kind === "none"
        ? 404
        : (ctx.errorStatusOverrides?.[unionSpec.absent.tag] ??
          defaultErrorStatus(unionSpec.absent.tag));
    const absent =
      unionSpec.absent.kind === "none"
        ? [
            `    if (found := await repo.${findSnake}(${args})) is None:`,
            '        raise AggregateNotFoundError("not_found")',
          ]
        : (() => {
            const tag = unionSpec.absent.tag;
            const resourceExt = unionSpec.absent.hasResource
              ? `"resource": ${JSON.stringify(agg.name)}, `
              : "";
            return [
              `    if (found := await repo.${findSnake}(${args})) is None:`,
              "        return JSONResponse(",
              `            {${resourceExt}"type": ${JSON.stringify(errorTypeUri(tag))}, "title": ${JSON.stringify(errorTitle(tag))}, "status": ${absentStatus}, "detail": ${JSON.stringify(errorTitle(tag))}, "instance": request.url.path},`,
              `            status_code=${absentStatus},`,
              '            media_type="application/problem+json",',
              "        )",
            ];
          })();
    return lines(
      // The union arm's declared set (incl. the gated 403 and the resolved
      // absent status) comes from the derivation — the same numbers the
      // RUNTIME translation above answers with, so the two cannot drift.
      // (This decorator was the two-arms landmine: hand-built separately from
      // the optional arm, it once published [404] while its sibling published
      // [403].)
      `@router.get("${relativeOpPath(apiOp)}", response_model=${agg.name}Response, operation_id="${opId}"${derivedResponsesKwarg(apiOp)})`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> dict[str, object] | JSONResponse:`,
      userBind,
      gateLines,
      "    repo = _repo(session)",
      ...absent,
      // Found → the success variant directly (untagged); a single-success union
      // find is wire-identical to `<Agg>?` / `<Agg> option`.
      `    return ${wireResp(agg, "found")}`,
    );
  }
  const paged = pagedReturn(find.returnType);
  if (paged) {
    // Defaulted params last (python syntax) — FastAPI is order-agnostic.
    const pagedSig = [
      ...params,
      ...(needsUser ? ["request: Request"] : []),
      "session: SessionDep",
      ...PY_PAGED_CONTROLS,
      // Server-side sort controls (M-T2.6) — the repo whitelists `sort`.
      `sort: str = "id"`,
      `dir: str = "asc"`,
    ].join(", ");
    const callArgs = [
      ...find.params.map((p) => pyWireToDomain(p.name, p.type, ctx)),
      ...(usesUser ? ["current_user"] : []),
      "page",
      "pageSize",
      "sort",
      "dir",
    ];
    return lines(
      `@router.get("${relativeOpPath(apiOp)}", response_model=${paged.name}, operation_id="${opId}"${derivedResponsesKwarg(apiOp)})`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${pagedSig}) -> dict[str, object]:`,
      userBind,
      gateLines,
      "    repo = _repo(session)",
      `    result = await repo.${findSnake}(${callArgs.join(", ")})`,
      "    return {",
      `        "items": [${wireResp(agg, "r")} for r in result.items],`,
      '        "page": result.page,',
      '        "pageSize": result.page_size,',
      '        "total": result.total,',
      '        "totalPages": result.total_pages,',
      "    }",
    );
  }
  if (isList) {
    return lines(
      `@router.get("${relativeOpPath(apiOp)}", response_model=${agg.name}ListResponse, operation_id="${opId}"${derivedResponsesKwarg(apiOp)})`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> list[dict[str, object]]:`,
      userBind,
      gateLines,
      "    repo = _repo(session)",
      `    return [${wireResp(agg, "r")} for r in await repo.${findSnake}(${args})]`,
    );
  }
  return lines(
    `@router.get("${relativeOpPath(apiOp)}", response_model=${agg.name}Response, operation_id="${opId}"${derivedResponsesKwarg(apiOp)})`,
    `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> dict[str, object]:`,
    userBind,
    gateLines,
    "    repo = _repo(session)",
    `    found = await repo.${findSnake}(${args})`,
    "    if found is None:",
    `        raise AggregateNotFoundError("not_found")`,
    `    return ${wireResp(agg, "found")}`,
  );
}
