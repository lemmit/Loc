import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { emitsRestCreate, forApiRead, forCreateInput } from "../../ir/enrich/wire-projection.js";
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
  type ExprIR,
  exprUsesCurrentUser,
  findUsesCurrentUser,
  type InvariantIR,
  type OperationIR,
  operationIsGuarded,
  operationUsesCurrentUser,
  type PayloadIR,
  type RepositoryIR,
  type TypeIR,
} from "../../ir/types/loom-ir.js";
import { partsChildrenFirst } from "../../ir/util/containment-parent.js";
import { errorStatuses, type OpErrorKind, problemTitle } from "../../ir/util/openapi-errors.js";
import {
  camelId,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "../../ir/util/openapi-ids.js";
import { aggregateIsVersioned } from "../../ir/util/versioned-capability.js";
import {
  classifyForWire,
  type SingleFieldPattern,
  singleFieldConstraints,
} from "../../ir/validate/invariant-classify.js";
import { lines } from "../../util/code-builder.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { findUnionSpec } from "../_payload/union-wire.js";
import { requestPyType, responsePyType } from "./emit/http-models.js";
import { provColumn } from "./emit/provenance.js";
import { renderPyExpr } from "./render-expr.js";
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
    // Can-query companions register after the operation routes (static
    // `can_<op>` paths, no collision with `/{id}`).
    ...whenGatedOps.map((op) => ["", "", canOpRoute(agg, op, ctx)]),
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
  const idNames = ctx.aggregates
    .map((a) => `${a.name}Id`)
    .filter((n, i, arr) => refersTo(n) && arr.indexOf(n) === i)
    .sort();

  return lines(
    `"""${agg.name} HTTP routes + wire DTOs.  Auto-generated."""`,
    "",
    refersTo("math") ? "import math" : null,
    refersTo("datetime") ? "from datetime import datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("math") || refersTo("datetime") || refersTo("Decimal") ? "" : null,
    `from fastapi import ${["APIRouter", "Depends", refersTo("Path") ? "Path" : null, refersTo("Request") ? "Request" : null, refersTo("Response") ? "Response" : null].filter(Boolean).join(", ")}`,
    refersTo("JSONResponse") ? "from fastapi.responses import JSONResponse" : null,
    `from pydantic import ${["BaseModel", refersTo("Field") ? "Field" : null, refersTo("RootModel") ? "RootModel" : null, refersTo("model_validator") ? "model_validator" : null].filter(Boolean).join(", ")}`,
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
      (hasCreateFactory(agg) && stampUsesUser(agg, "create")) ||
      (publicOps.length > 0 && stampUsesUser(agg, "update"))
      ? "from app.auth.user import User"
      : null,
    "from app.db.engine import get_session",
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
    voModelImports.length > 0
      ? `from app.http.wire_models import ${voModelImports.map((n) => `${n} as ${n}Model`).join(", ")}`
      : null,
    // The catalog `log(...)` facade — `aggregate_created` (create route) and
    // `operation_invoked` (operation routes) narrative lines.
    refersTo("log") ? "from app.obs.log import log" : null,
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
): string {
  const statuses = [...new Set([...errorStatuses(kind, guarded), ...extra])].sort((a, b) => a - b);
  if (statuses.length === 0) return "";
  const entries = statuses.map(
    (st) => `${st}: {"model": ProblemDetails, "description": "${problemTitle(st)}"}`,
  );
  return `, responses={${entries.join(", ")}}`;
}

/** A versioned aggregate's `update` declares 409 (stale `If-Match` →
 *  optimistic-concurrency conflict), mirroring the Hono / .NET / Phoenix /
 *  Java contract so the conformance error-response dimension compares equal. */
function versionedConflictStatuses(agg: EnrichedAggregateIR, op: OperationIR): number[] {
  return op.name === "update" && aggregateIsVersioned(agg) ? [409] : [];
}

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
    const idWf = forApiRead(wireShapeFor(ent)).find((wf) => wf.source === "id");
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
function createFieldConstraints(
  invariants: InvariantIR[],
  available: ReadonlySet<string>,
): Map<string, string> {
  const byField = new Map<string, SingleFieldPattern[]>();
  for (const inv of invariants) {
    if (!classifyForWire(inv, { available })) continue;
    const cons = singleFieldConstraints(inv);
    if (!cons) continue;
    for (const { field, pattern } of cons) {
      if (!available.has(field)) continue;
      byField.set(field, [...(byField.get(field) ?? []), pattern]);
    }
  }
  const out = new Map<string, string>();
  for (const [field, patterns] of byField) {
    const kwargs: string[] = [];
    const seen = new Set<string>();
    for (const p of patterns) {
      for (const kw of pydanticKwargs(p)) {
        const key = kw.slice(0, kw.indexOf("="));
        if (seen.has(key)) continue; // first constraint wins on a duplicate key
        seen.add(key);
        kwargs.push(kw);
      }
    }
    if (kwargs.length > 0) out.set(field, `Field(${kwargs.join(", ")})`);
  }
  return out;
}

function pydanticKwargs(p: SingleFieldPattern): string[] {
  switch (p.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a decimal/money field) → pydantic's `gt=`;
      // inclusive keeps `ge=`.
      return [p.exclusive ? `gt=${p.n}` : `ge=${p.n}`];
    case "max":
      return [p.exclusive ? `lt=${p.n}` : `le=${p.n}`];
    case "between":
      return [`ge=${p.lo}`, `le=${p.hi}`];
    case "len-min":
      return [`min_length=${p.n}`];
    case "len-max":
      return [`max_length=${p.n}`];
    case "len-eq":
      return [`min_length=${p.n}`, `max_length=${p.n}`];
    case "len-range":
      return [`min_length=${p.lo}`, `max_length=${p.hi}`];
    case "regex":
      return [`pattern=${pyRawRegex(p.pattern)}`];
  }
}

/** Render a regex source as a Python raw-string literal (backslashes are
 *  regex escapes, not string escapes).  Falls back to a JSON string only if
 *  the source contains both quote kinds (regexes effectively never do). */
function pyRawRegex(src: string): string {
  if (!src.includes('"')) return `r"${src}"`;
  if (!src.includes("'")) return `r'${src}'`;
  return JSON.stringify(src);
}

/** Splice a derived `Field(...)` onto a request-field declaration, folding any
 *  existing default (`= None` / `= False`) into `Field(default=…, …)` so the
 *  field's optionality is preserved. */
function withFieldConstraint(name: string, decl: string, fieldExpr: string | undefined): string {
  if (!fieldExpr) return `    ${name}: ${decl}`;
  const eq = decl.indexOf(" = ");
  if (eq === -1) return `    ${name}: ${decl} = ${fieldExpr}`;
  const type = decl.slice(0, eq);
  const dflt = decl.slice(eq + 3);
  const inner = fieldExpr.slice("Field(".length, -1);
  return `    ${name}: ${type} = Field(default=${dflt}, ${inner})`;
}

/** A Pydantic `@model_validator(mode="after")` enforcing the wire-scoped
 *  invariants that are NOT single-field shapes (cross-field comparisons like
 *  `handle != email`, or guarded predicates) — the refine fallback the other
 *  backends emit (Hono's `.refine`, Phoenix's `validate fn`).  Single-field
 *  invariants are handled by `Field(...)` constraints; this raises ValueError
 *  → FastAPI 422 for the rest, so a violation surfaces as 422 (not the
 *  domain's DomainError → 400).  Predicates render against the request DTO's
 *  verbatim camelCase fields (`self.handle`). */
function createModelValidator(
  invariants: InvariantIR[],
  available: ReadonlySet<string>,
  cls: string,
): string | null {
  const refines = invariants.filter(
    (inv) => classifyForWire(inv, { available }) && !singleFieldConstraints(inv),
  );
  if (refines.length === 0) return null;
  const checks = refines.map((inv) => {
    const pred = renderPyExpr(inv.expr, { thisName: "self", wireField: true });
    const ok = inv.guard
      ? `not (${renderPyExpr(inv.guard, { thisName: "self", wireField: true })}) or (${pred})`
      : pred;
    return lines(
      `        if not (${ok}):`,
      `            raise ValueError(${JSON.stringify(`Invariant violated: ${inv.source}`)})`,
    );
  });
  return lines(
    "",
    '    @model_validator(mode="after")',
    `    def _check_invariants(self) -> "${cls}":`,
    ...checks,
    "        return self",
  );
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
            requestFieldDecl(p.type, false, ctx),
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
    if (s.kind === "precondition") out.push({ expr: s.expr, source: s.source });
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
 *  arrive `False` (RS-6; surfaced by the python behavioral tier). */
export function requestFieldDecl(
  t: TypeIR,
  optional: boolean,
  ctx: BoundedContextIR,
  defaultExpr?: ExprIR,
): string {
  const base = requestPyType(t, ctx);
  if (defaultExpr) return `${base} = ${renderPyExpr(defaultExpr)}`;
  const isOpt = optional || t.kind === "optional";
  if (isOpt) return base.endsWith("| None") ? `${base} = None` : `${base} | None = None`;
  if (t.kind === "primitive" && t.name === "bool") return `${base} = False`;
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

function createRoute(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  const createAction = agg.persistedAs === "eventLog" ? agg.creates?.[0] : agg.canonicalCreate;
  const auditCreate = !!createAction?.audited;
  const esCreate = agg.persistedAs === "eventLog" ? agg.creates?.[0] : undefined;
  if (esCreate) {
    const args = esCreate.params
      .map((p) => `${snake(p.name)}=${pyWireToDomain(`body.${p.name}`, p.type, ctx)}`)
      .join(", ");
    return lines(
      `@router.post("", status_code=201, response_model=Create${agg.name}Response, operation_id="${camelId(opCreate(agg.name))}"${errorResponsesKwarg("create")})`,
      `async def create_${snake(agg.name)}(body: Create${agg.name}Request, session: SessionDep) -> dict[str, object]:`,
      `    created = ${agg.name}.create(${args})`,
      auditCreate ? "    repo = _repo(session)" : null,
      auditCreate ? "    await repo.save(created)" : "    await _repo(session).save(created)",
      ...(auditCreate ? createAuditCall(agg) : []),
      `    log("info", "aggregate_created", aggregate=${JSON.stringify(agg.name)}, id=created.id)`,
      `    return {"id": created.id}`,
    );
  }
  const inputs = forCreateInput(agg.fields);
  const args = inputs
    .map((f) => `${snake(f.name)}=${pyWireToDomain(`body.${f.name}`, f.type, ctx)}`)
    .join(", ");
  // Lifecycle stamps (audit / softDelete): apply onCreate stamps right before
  // the persist.  A principal-referencing stamp threads `current_user` off the
  // request scope (the route then takes a `request: Request` param).
  const stampUsesPrincipal = stampUsesUser(agg, "create");
  const sig = [
    `body: Create${agg.name}Request`,
    ...(stampUsesPrincipal ? ["request: Request"] : []),
    "session: SessionDep",
  ].join(", ");
  return lines(
    `@router.post("", status_code=201, response_model=Create${agg.name}Response, operation_id="${camelId(opCreate(agg.name))}"${errorResponsesKwarg("create")})`,
    `async def create_${snake(agg.name)}(${sig}) -> dict[str, object]:`,
    stampUsesPrincipal ? "    current_user: User = request.state.current_user" : null,
    `    created = ${agg.name}.create(${args})`,
    hasStamp(agg, "create") ? stampCall(agg, "create", "created") : null,
    auditCreate ? "    repo = _repo(session)" : null,
    auditCreate ? "    await repo.save(created)" : "    await _repo(session).save(created)",
    ...(auditCreate ? createAuditCall(agg) : []),
    `    log("info", "aggregate_created", aggregate=${JSON.stringify(agg.name)}, id=created.id)`,
    `    return {"id": created.id}`,
  );
}

function allRoute(agg: EnrichedAggregateIR): string {
  return lines(
    `@router.get("", response_model=${agg.name}ListResponse, operation_id="all${agg.name}")`,
    `async def all_${snake(plural(agg.name))}(session: SessionDep) -> list[dict[str, object]]:`,
    "    repo = _repo(session)",
    "    return [repo.to_wire(root) for root in await repo.all()]",
  );
}

function byIdRoute(agg: EnrichedAggregateIR): string {
  return lines(
    `@router.get("/{id}", response_model=${agg.name}Response, operation_id="${camelId(opGetById(agg.name))}"${errorResponsesKwarg("getById")})`,
    `async def get_${snake(agg.name)}_by_id(${ID_PARAM}, session: SessionDep) -> dict[str, object]:`,
    "    repo = _repo(session)",
    `    return repo.to_wire(await repo.get_by_id(${agg.name}Id(id)))`,
  );
}

function destroyRoute(agg: EnrichedAggregateIR): string {
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
  return lines(
    `@router.delete("/{id}", status_code=204, operation_id="${camelId(opDestroy(agg.name))}"${errorResponsesKwarg("destroy")})`,
    `async def destroy_${snake(agg.name)}(${ID_PARAM}, request: Request, session: SessionDep) -> Response:`,
    "    repo = _repo(session)",
    auditDestroy
      ? `    __loaded = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`
      : `    await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
    auditDestroy ? "    __before = repo.to_wire(__loaded)" : null,
    ...destroyAuditCall,
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

/** The `when` state-gate line(s) injected after the aggregate loads and
 *  before the operation body runs — false → DisallowedError (409),
 *  matching the side-effect-free `can_<op>` predicate. */
function whenGate(agg: EnrichedAggregateIR, op: OperationIR): string[] {
  if (!op.when) return [];
  const pred = renderPyExpr(op.when, { thisName: "found" });
  return [
    `    if not (${pred}):`,
    `        raise DisallowedError(${JSON.stringify(
      `operation '${op.name}' is not allowed in the current state of ${agg.name}.`,
    )})`,
  ];
}

/** The auto-exposed, side-effect-free `GET /{id}/can_<op>` companion of a
 *  `when`-gated operation — loads the aggregate, evaluates the predicate,
 *  returns `{ allowed }` so a UI can enable/disable the action without
 *  invoking it (the canCommand pattern). */
function canOpRoute(
  agg: EnrichedAggregateIR,
  op: OperationIR,
  _ctx: EnrichedBoundedContextIR,
): string {
  const opSnake = snake(op.routeSlug ?? op.name);
  const pred = renderPyExpr(op.when as ExprIR, { thisName: "found" });
  return lines(
    `@router.get("/{id}/can_${opSnake}", response_model=CanResponse, operation_id="${camelId(opOperation(agg.name, `can_${op.name}`))}"${errorResponsesKwarg("getById")})`,
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
    // Update stamps apply right before the persist; a principal-referencing
    // stamp needs `current_user` bound (the route already takes `request`).
    const stampUpdateUsesUser = stampUsesUser(agg, "update");
    const callArgs = [...op.params.map((p) => pyWireToDomain(`body.${p.name}`, p.type, ctx))];
    if (usesUser) callArgs.push("current_user");
    const vsave = versionedSave(agg);
    return lines(
      `@router.post("/{id}/${opSnake}", response_model=None, operation_id="${camelId(opOperation(agg.name, op.name))}"${errorResponsesKwarg("operation", operationIsGuarded(op), versionedConflictStatuses(agg, op))})`,
      `async def ${snake(op.name)}_${snake(agg.name)}(${ID_PARAM}, body: ${upperFirst(op.name)}${agg.name}Request, request: Request, session: SessionDep) -> dict[str, object] | JSONResponse:`,
      usesUser || stampUpdateUsesUser
        ? "    current_user: User = request.state.current_user"
        : null,
      "    repo = _repo(session)",
      `    found = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
      `    log("info", "operation_invoked", aggregate=${JSON.stringify(agg.name)}, op=${JSON.stringify(op.name)}, id=id)`,
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
  const usesUser = operationUsesCurrentUser(op);
  // Update stamps apply right before the persist; a principal-referencing
  // stamp threads `current_user` off the request scope (and takes `request`).
  const stampUpdateUsesUser = stampUsesUser(agg, "update");
  const versioned = aggregateIsVersioned(agg);
  const needsRequest = usesUser || stampUpdateUsesUser || versioned;
  const opSig = [
    ID_PARAM,
    `body: ${upperFirst(op.name)}${agg.name}Request`,
    ...(needsRequest ? ["request: Request"] : []),
    "session: SessionDep",
  ].join(", ");
  const callArgs = [...op.params.map((p) => pyWireToDomain(`body.${p.name}`, p.type, ctx))];
  if (usesUser) callArgs.push("current_user");
  const vsave = versionedSave(agg);
  return lines(
    `@router.post("/{id}/${opSnake}", status_code=204, operation_id="${camelId(opOperation(agg.name, op.name))}"${errorResponsesKwarg("operation", operationIsGuarded(op), versionedConflictStatuses(agg, op))})`,
    `async def ${snake(op.name)}_${snake(agg.name)}(${opSig}) -> Response:`,
    usesUser || stampUpdateUsesUser ? "    current_user: User = request.state.current_user" : null,
    "    repo = _repo(session)",
    `    found = await repo.${cmdLoad(agg)}(${agg.name}Id(id))`,
    `    log("info", "operation_invoked", aggregate=${JSON.stringify(agg.name)}, op=${JSON.stringify(op.name)}, id=id)`,
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
      `@router.get("/${findSnake}", response_model=${agg.name}Response, operation_id="${opId}", responses={${absentStatus}: {"model": ProblemDetails, "description": ${JSON.stringify(problemTitle(absentStatus))}}})`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> dict[str, object] | JSONResponse:`,
      userBind,
      "    repo = _repo(session)",
      ...absent,
      // Found → the success variant directly (untagged); a single-success union
      // find is wire-identical to `<Agg>?` / `<Agg> option`.
      `    return repo.to_wire(found)`,
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
      `@router.get("/${findSnake}", response_model=${agg.name}ListResponse, operation_id="${opId}")`,
      `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> list[dict[str, object]]:`,
      userBind,
      "    repo = _repo(session)",
      `    return [repo.to_wire(r) for r in await repo.${findSnake}(${args})]`,
    );
  }
  return lines(
    `@router.get("/${findSnake}", response_model=${agg.name}Response, operation_id="${opId}"${errorResponsesKwarg("findOptional")})`,
    `async def ${findSnake}_${snake(plural(agg.name))}(${sig}) -> dict[str, object]:`,
    userBind,
    "    repo = _repo(session)",
    `    found = await repo.${findSnake}(${args})`,
    "    if found is None:",
    `        raise AggregateNotFoundError("not_found")`,
    "    return repo.to_wire(found)",
  );
}
