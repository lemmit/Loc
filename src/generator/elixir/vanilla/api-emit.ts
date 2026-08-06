// ---------------------------------------------------------------------------
// Vanilla controllers — `lib/<app>_web/controllers/<agg>_controller.ex`.
// Slice 1+2 of vanilla-foundation-tdd-plan.md.
//
//   Slice 1: read path — `GET /<aggs>` (list) + `GET /<aggs>/{id}`
//     (show), with `with`-block / `case` dispatch over
//     `{:ok,_}|{:error,_}` from the Repository.
//   Slice 2: write path — `POST /<aggs>` (create), `PATCH /<aggs>/{id}`
//     (update), `DELETE /<aggs>/{id}` (destroy).  Validation errors
//     from changeset surface as 422 ProblemDetails; not-found stays
//     404.
//
// Full RFC 7807 ProblemDetails parity (envelope fields, errors[]
// extension shape byte-identical to the other backends) lands in Slice 4.
// ---------------------------------------------------------------------------

import {
  createInputFields,
  emitsRestCreate as sharedEmitsRestCreate,
} from "../../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  BoundedContextIR,
  OperationIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import {
  type ApiOperationIR,
  apiStatusContext,
  deriveAggregateOperations,
  isAllFind,
  relativeOpPath,
} from "../../../ir/util/api-surface.js";
import { problemTitle } from "../../../ir/util/openapi-errors.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { isServerSourcedDefault } from "../../_frontend/server-default.js";
import { renderPhoenixDomainOperation, renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import type { ApiRoute } from "../api-emit.js";
import { opUsesCurrentUser } from "../domain/predicates.js";
import { renderExpr as renderElixirExpr } from "../render-expr.js";
import { auditRecordCall, createAuditMeta, destroyAuditMeta } from "./audit-emit.js";
import {
  aggregateServesHistoryRoute,
  renderVanillaHistoryAction,
  renderVanillaHistoryMapper,
  vanillaHistoryFind,
} from "./audit-history-emit.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";
import { CRUD_RESERVED_NAMES } from "./context-emit.js";
import { isVanillaDocAgg } from "./document-emit.js";
import { isEventSourced, renderEsController } from "./eventsourced-emit.js";
import { findRoutes, renderFindActions } from "./find-controller.js";
import { isAbstractBase } from "./inheritance-emit.js";
import {
  GUARD_RESCUE,
  isReturningOperation,
  opHasGuards,
  opHasWhenGate,
  renderProblemVariantHelper,
  renderReturningOpControllerAction,
} from "./operation-returns-emit.js";
import { hasRefColls } from "./ref-collection-emit.js";
import { emitsRestDelete } from "./rest-surface.js";
import { stampUsesPrincipal } from "./stamp-emit.js";
import { renderWireSerialize } from "./wire-serialize.js";

/** Public operations that earn a dedicated `POST /<plural>/:id/<op>`
 *  member endpoint.  CRUD-verb-named ops (create/update/destroy/…) are
 *  served by the generic create/update/delete routes — and have no
 *  `<op>_<agg>` context function to call — so they're excluded here, in
 *  lockstep with the named-op emission in `context-emit.ts`. */
function memberOperations(agg: { operations: readonly OperationIR[] }): OperationIR[] {
  return agg.operations.filter(
    (op) => op.visibility === "public" && !CRUD_RESERVED_NAMES.has(op.name),
  );
}

export interface VanillaApiEmitResult {
  routes: ApiRoute[];
}

/** The DERIVED operation/probe entries this backend actually serves — the
 *  derivation minus two elixir-local stances, applied identically by the
 *  router (below) and the OpenAPI spec (`openapi-emit.ts`), the same
 *  "one predicate, both halves" pattern as `emitsRestCreate`:
 *
 *   1. a CRUD-verb-named op other than `update` has no controller action to
 *      route to (the atom would collide with the Phoenix REST actions), so it
 *      is not served — and, since this helper drives the spec too, no longer
 *      DOCUMENTED either (the spec used to advertise every public op,
 *      including these phantom routes);
 *   2. an event-sourced aggregate has no generic `update` surface (its only
 *      mutations are its per-op commands).
 *
 *  Everything else — membership, paths (routeSlug included), the private-op
 *  and canonical exclusions — is the derivation's. */
export function servedOperationEntries(
  agg: AggregateIR,
  derivedOps: readonly ApiOperationIR[],
): { opEntries: ApiOperationIR[]; probeByOp: Map<OperationIR, ApiOperationIR> } {
  const es = isEventSourced(agg);
  const serves = (op: OperationIR): boolean => {
    if (CRUD_RESERVED_NAMES.has(op.name) && op.name !== "update") return false;
    if (es && op.name === "update") return false;
    return true;
  };
  const opEntries = derivedOps.filter((o) => o.kind === "operation" && serves(o.operation!));
  const probeByOp = new Map<OperationIR, ApiOperationIR>(
    derivedOps
      .filter((o) => o.kind === "gateProbe" && serves(o.operation!))
      .map((o) => [o.operation!, o]),
  );
  return { opEntries, probeByOp };
}

/** `relativeOpPath` in the Plug router's param spelling (`{id}` → `:id`). */
export function plugRelativePath(op: ApiOperationIR): string {
  return relativeOpPath(op).replace(/\{(\w+)\}/g, ":$1");
}

/** Does this aggregate's controller serve `GET /<plural>/:id/history`?
 *
 *  An event-sourced aggregate has its own controller (`renderEsController`)
 *  with no CRUD read seam for the reachability guard to ride, and an abstract
 *  inheritance base is a read-only polymorphic reader that is never a command
 *  target — neither can host the endpoint, so neither gets the route.  Both are
 *  HONEST gaps: no route is emitted, rather than one that 500s.
 *
 *  Exported and consumed by `openapi-emit.ts` too, for the same reason
 *  `emitsRestCreate` is: this backend has twice shipped a route its own
 *  published spec disagreed with (the PATCH-vs-POST `update` path, the unmounted
 *  `can_<op>` probe), and `conformance-parity` cannot see it because it diffs
 *  SPECS.  One predicate, both halves. */
export function servesHistory(ctx: BoundedContextIR, agg: AggregateIR): boolean {
  if (isEventSourced(agg) || isAbstractBase(agg)) return false;
  return aggregateServesHistoryRoute(ctx, agg);
}

/**
 * Whether the vanilla Phoenix backend exposes a REST create surface — the
 * `POST /<plural>` route AND its OpenAPI `post` operation — for this
 * aggregate.  Derived ONCE here and consumed by both `emitVanillaApiControllers`
 * (the router) and `emitOpenApiSpec` (the spec), so the two can never disagree
 * (the class of bug where the controller `create` action was generated and
 * documented but left unrouted).
 *
 * Matches the node/dotnet/python/java backends, which gate the REST create
 * on an EXPLICIT canonical `create` (`agg.canonicalCreate != null` — written
 * by hand or synthesised by `with crudish`), symmetric with how DELETE gates
 * on a canonical `destroy`.  Merely being constructible (`isConstructible`)
 * no longer exposes a POST — that predicate now gates only the DOMAIN factory
 * seeds/tests call.  Event-sourced aggregates keep the creation-event gate —
 * they are created via their declared `create` event.  An abstract
 * inheritance base is read-only (no `create` action emitted), so it never
 * exposes create.
 *
 * The ES / canonical-create core is the shared {@link sharedEmitsRestCreate}
 * predicate every backend uses — this wrapper only adds the Phoenix-specific
 * abstract-base guard, so the cross-backend gate can never silently diverge.
 */
export function emitsRestCreate(agg: AggregateIR): boolean {
  if (isAbstractBase(agg)) return false;
  return sharedEmitsRestCreate(agg);
}

export function emitVanillaApiControllers(
  appName: string,
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
  sourcemap?: SourceMapRecorder,
): VanillaApiEmitResult {
  const ctxModule = upperFirst(ctx.name);
  const routes: ApiRoute[] = [];

  for (const agg of ctx.aggregates) {
    const aggPascal = upperFirst(agg.name);
    const aggSnake = snake(agg.name);
    const aggsPath = snake(plural(agg.name)); // "tasks" for Task
    const controllerName = `${aggPascal}Controller`;
    const memberOps = memberOperations(agg);
    const es = isEventSourced(agg);
    // THE UNIFICATION SEAM (api-surface.ts): which routes exist and at which
    // path comes from the shared derivation — the SAME list the OpenAPI spec
    // (`openapi-emit.ts`) documents, so the router and the published contract
    // can no longer diverge (they have, three separate times).  An abstract
    // base derives nothing (the derivation's aggregate skip): its read-only
    // index/show below stay an elixir-local extra, like the history route.
    const derivedOps = isAbstractBase(agg)
      ? []
      : deriveAggregateOperations(
          agg,
          ctx.repositories.find((r) => r.aggregateName === agg.name),
          apiStatusContext(ctx),
        );
    const abstract = isAbstractBase(agg);
    const routeOf = (o: ApiOperationIR, action: string): ApiRoute => ({
      method: o.method,
      path: `/${aggsPath}${plugRelativePath(o)}`,
      controller: controllerName,
      action,
    });
    const controllerPath = `lib/${appName}_web/controllers/${aggSnake}_controller.ex`;
    const controllerContent = es
      ? renderEsController(appModule, ctxModule, agg, ctx)
      : renderController(
          appModule,
          ctxModule,
          agg,
          aggSnake,
          memberOps,
          ctx,
          isVanillaDocAgg(agg, ctx, sys),
          isAbstractBase(agg),
        );
    out.set(controllerPath, controllerContent);
    sourcemap?.file(controllerPath, controllerContent, agg.origin, `${ctx.name}.${agg.name}`);

    // Read path.  Custom-find routes (`GET /<plural>/<find>`) MUST precede the
    // `/:id` show route — Phoenix matches in registration order, so a literal
    // `/<find>` segment has to come first or `:id` would swallow it.
    const allEntry = derivedOps.find((o) => isAllFind(o));
    if (allEntry) routes.push(routeOf(allEntry, ":index"));
    else if (abstract) {
      // Read-only polymorphic index over the subtype tables — not derived
      // (abstract bases have no derived surface), served here on purpose.
      routes.push({
        method: "get",
        path: `/${aggsPath}`,
        controller: controllerName,
        action: ":index",
      });
    }
    routes.push(...findRoutes(agg, ctx, derivedOps));
    const getByIdEntry = derivedOps.find((o) => o.kind === "getById");
    if (getByIdEntry) routes.push(routeOf(getByIdEntry, ":show"));
    else if (abstract) {
      routes.push({
        method: "get",
        path: `/${aggsPath}/:id`,
        controller: controllerName,
        action: ":show",
      });
    }
    // Entity history (docs/audit.md) — the derived read over `audit_records`.
    // Two path segments, so no collision with the `/:id` show route above.
    // Driven by the enrichment-derived `historyFind` so the route and the gate
    // it enforces cannot disagree with the aggregate's list read.
    if (servesHistory(ctx, agg)) {
      routes.push({
        method: "get",
        path: `/${aggsPath}/:id/history`,
        controller: controllerName,
        action: ":history",
      });
    }
    // Write path.  The create route rides the shared `emitsRestCreate`
    // predicate — the SAME gate the OpenAPI `post` operation uses — so the
    // route and the documented contract can never diverge (`generators.md`:
    // "POST / → create").  See `emitsRestCreate` for the constructibility
    // rationale.
    const createEntry = derivedOps.find((o) => o.kind === "create");
    if (createEntry) routes.push(routeOf(createEntry, ":create"));
    // Event-sourced aggregates have no generic field-update / delete surface —
    // their only mutations are the per-operation member endpoints below.  The
    // generic PATCH is now gated on an EXPLICIT `update` operation (symmetric
    // with create/destroy), not merely on the aggregate having some operation.
    // (The canonical `update` route — `POST /:id/update`, `:update` action,
    // NOT a member PATCH — now rides the served-operation loop below: the
    // derivation lifts `update` as an ordinary operation entry, and
    // `servedOperationEntries` keeps this backend's two local stances.  The
    // 12-line PATCH-vs-POST history that used to sit here lives on in
    // experience_gathered.md §57 / the servedOperationEntries doc.)
    const destroyEntry = derivedOps.find((o) => o.kind === "destroy");
    if (destroyEntry && emitsRestDelete(agg)) routes.push(routeOf(destroyEntry, ":delete"));
    // Per-operation member endpoints — `POST /<plural>/:id/<op>`, one per
    // public non-CRUD operation, matching the node/dotnet/python/java
    // backends.  The URL segment uses
    // `routeSlug` (D-URLSTYLE) while the action atom stays the op verb.
    const served = servedOperationEntries(agg, derivedOps);
    for (const entry of served.opEntries) {
      const op = entry.operation!;
      routes.push(routeOf(entry, `:${snake(op.name)}`));
      // The side-effect-free `GET /<plural>/:id/can_<op>` companion of a
      // `when`-gated op (criterion.md, use site 2).  It was once DECLARED in
      // this backend's own OpenAPI and never mounted (the published probe
      // 404'd) — served and documented off the same derived entry now.
      const probe = served.probeByOp.get(op);
      if (probe) routes.push(routeOf(probe, `:can_${snake(op.name)}`));
    }
  }

  return { routes };
}

function renderController(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  aggSnake: string,
  memberOps: readonly OperationIR[],
  ctx: BoundedContextIR,
  isDoc = false,
  /** Abstract inheritance base — never instantiated, so the controller is
   *  READ-ONLY (index + show over the polymorphic reader; no create/update/
   *  delete actions, which would call write-seam context fns the read-only base
   *  context never defines). */
  readOnly = false,
): string {
  const aggPascal = upperFirst(agg.name);
  const facadeMod = `${appModule}.${ctxModule}`;

  // A `mask unless` aggregate emits a redacting `serialize/1` (responses) plus an
  // unmasked `serialize_unmasked/1`; audit before/after snapshots must record the
  // REAL value, so they project through the unmasked one (authorization.md §5).
  const auditSerialize = agg.fields.some((f) => f.maskUnless)
    ? "serialize_unmasked(record)"
    : "serialize(record)";

  // Reference collections (`X id[]` → `many_to_many`) are projected to id arrays
  // in the wire response: each loaded relationship is mapped to its members'
  // ids by `__ref_ids/1` (emitted directly by the wireShape-driven serializer).
  const refIdsHelper = hasRefColls(agg)
    ? `

  # Project a loaded \`many_to_many\` relationship to its members' ids (an
  # unloaded relationship serializes as an empty list).
  defp __ref_ids(%Ecto.Association.NotLoaded{}), do: []
  defp __ref_ids(records) when is_list(records), do: Enum.map(records, & &1.id)
  defp __ref_ids(_), do: []`
    : "";

  // A principal (tenancy) `filter` scopes every read by the request actor, so the
  // controller pulls `current_user` off `conn.assigns` (set by the Auth plug,
  // which the validator requires when a principal filter is present) and threads
  // it into the context reads.  Non-principal aggregates stay byte-identical.
  const principal = aggregateUsesPrincipalContextFilter(agg);
  const cuBind = principal ? "    current_user = Map.get(conn.assigns, :current_user)\n" : "";
  const listArg = principal ? "current_user" : "";
  const getActor = principal ? ", current_user" : "";
  // The auto-`findAll` is paged-by-default (M-T2.6): the `index` action parses
  // `page`/`pageSize`/`sort`/`dir` query controls (via the shared `page_param`
  // helper find-controller emits — always present now that every non-abstract
  // controller pages) and returns the `%{items, …}` envelope.  A read-only
  // abstract-base controller keeps the plain unpaged list (honest gate).
  const listAllFind = (ctx.repositories ?? [])
    .find((r) => r.aggregateName === agg.name)
    ?.finds?.find((f) => f.name === "all");
  const indexPaged = !readOnly && (listAllFind ? !!pagedReturn(listAllFind.returnType) : false);
  const pagedListArgs = `page_param(params, "page", ${PAGED_DEFAULT_PAGE}), page_param(params, "pageSize", ${PAGED_DEFAULT_PAGE_SIZE}), Map.get(params, "sort", "id"), Map.get(params, "dir", "asc")${principal ? ", current_user" : ""}`;
  const indexAction = indexPaged
    ? `  def index(conn, params) do
${cuBind}    with {:ok, result} <- ${ctxModule}.list_${aggSnake}s(${pagedListArgs}) do
      json(conn, %{result | items: Enum.map(result.items, &serialize/1)})
    end
  end`
    : `  def index(conn, _params) do
${cuBind}    with {:ok, records} <- ${ctxModule}.list_${aggSnake}s(${listArg}) do
      json(conn, Enum.map(records, &serialize/1))
    end
  end`;
  // Command-load context fn a MUTATION action loads through (authorization
  // Phase 3 P3.1): `get_<agg>_for_write` when the aggregate's write scope is
  // narrower than its read scope, else `get_<agg>` (byte-identical).  Reads
  // (`show`) always use `get_<agg>`.
  const cmdGet = agg.writeScopeFilter ? `get_${aggSnake}_for_write` : `get_${aggSnake}`;

  // A principal-referencing lifecycle stamp (`createdBy := currentUser`) threads
  // the request actor into the create/update WRITE seam — the controller pulls
  // `current_user` off `conn.assigns` and passes it as the trailing arg to
  // `create_<agg>`/`update_<agg>` (the Auth plug populated it; the validator
  // requires `auth: required` for a principal stamp).  Non-principal stamps
  // (`createdAt := now()`) need no actor, so the write seam stays byte-identical.
  const stampPrincipal = stampUsesPrincipal(agg);
  // Server-sourced field defaults (`now()` / `currentUser.*`): applied
  // per-request in the create action by coalescing the wire params BEFORE the
  // changeset (`params["createdAt"] || DateTime.utc_now()`), so an omitted key
  // materialises the real per-request value instead of failing `validate_required`
  // — the Phoenix twin of the node/.NET/python/java coalesce.
  const serverDefaults = createInputFields(agg).filter(
    (f) => f.default !== undefined && isServerSourcedDefault(f.default),
  );
  const defaultUsesPrincipal = serverDefaults.some((f) => exprUsesCurrentUser(f.default));
  // The wire keys are camelCase (`params` is the raw JSON body); the changeset
  // snake-cases them downstream, so coalesce on the camelCase key here.
  const createParamDefaults =
    serverDefaults.length === 0
      ? ""
      : `    params =\n      params\n${serverDefaults
          .map(
            (f) =>
              `      |> Map.put(${JSON.stringify(f.name)}, params[${JSON.stringify(f.name)}] || ${renderElixirExpr(f.default as NonNullable<typeof f.default>)})`,
          )
          .join("\n")}\n`;
  // The create action has no read-filter `cuBind`, so bind `current_user` there
  // when a principal stamp OR a `currentUser.*` field default needs it.  The
  // params coalesce runs after the bind (it may read `current_user`).
  const createCuBind =
    stampPrincipal || defaultUsesPrincipal
      ? `    current_user = Map.get(conn.assigns, :current_user)\n${createParamDefaults}`
      : createParamDefaults;
  const createActor = stampPrincipal ? ", current_user" : "";
  // The update action already binds `current_user` when the aggregate has a
  // principal READ filter; bind it here too when only a principal stamp needs
  // it (avoid a double bind when both apply).
  const updateCuBind =
    !principal && stampPrincipal ? "    current_user = Map.get(conn.assigns, :current_user)\n" : "";
  const updateActor = stampPrincipal ? ", current_user" : "";

  // Per-operation member actions.  A returning operation (`: A or B`) translates
  // its tagged result to HTTP (success → 200, error variant → ProblemDetails);
  // a plain side-effecting op returns 204.  Validation failures surface as 422;
  // a missing row is 404.
  const opActions = memberOps
    .map((op) => {
      if (isReturningOperation(op)) {
        return renderReturningOpControllerAction(ctxModule, agg, op, ctx);
      }
      const opSnake = snake(op.name);
      // An op whose guard/body references `currentUser` needs `current_user`
      // threaded into the context call (the context fn carries the matching
      // `current_user \\ nil` arity).  Bind it off `conn.assigns` here unless
      // the read-filter `cuBind` already did.
      const opActor = opUsesCurrentUser(op);
      const opCuBind =
        principal || !opActor
          ? cuBind
          : "    current_user = Map.get(conn.assigns, :current_user)\n";
      const opCallActor = opActor ? ", current_user" : "";
      // A guarded op's context fn short-circuits to a typed denial tuple — the
      // `when` state gate to `{:error, :disallowed}` (409), a `requires` to
      // `{:error, :forbidden}` (403), a `precondition` to `{:error,
      // :precondition_failed}` (422) — the denials that replaced `raise(
      // ArgumentError, …)` (→ 500).  Emit each `else` arm only when the op has the
      // matching guard (else it'd be an unreachable clause — `--warnings-as-
      // errors`).  Same status + ProblemDetails body as the ES-command controller.
      const whenArm = opHasWhenGate(op)
        ? `

      {:error, {:disallowed, detail}} ->
        ProblemDetails.problem_response(conn, 409, "Disallowed", detail)`
        : "";
      const denialArms =
        whenArm +
        (opHasGuards(op)
          ? `

      {:error, {:forbidden, detail}} ->
        ProblemDetails.problem_response(conn, 403, "Forbidden", detail)

      {:error, {:precondition_failed, detail}} ->
        ProblemDetails.problem_response(conn, 422, "Unprocessable Entity", detail)`
          : "");
      return `
  def ${opSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])
${opCuBind}    ${renderPhoenixLogCall("operationInvoked", [
        { name: "aggregate", valueExpr: `"${aggPascal}"` },
        { name: "op", valueExpr: `"${op.name}"` },
        { name: "id", valueExpr: "id" },
      ])}
    ${renderPhoenixDomainOperation(aggPascal, op.name)}

    with {:ok, record} <- ${ctxModule}.${cmdGet}(id${getActor}),
         {:ok, _updated} <- ${ctxModule}.${opSnake}_${aggSnake}(record, attrs${opCallActor}) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)${denialArms}
    end
${GUARD_RESCUE}
  end`;
    })
    .join("\n");

  // The `can_<op>` probe actions.  Each loads the aggregate and answers the
  // SAME `when` predicate the guard chain enforces, via the context's
  // `can_<op>_<agg>/1` — so the probe can never drift from the gate it probes.
  // `{ allowed }` is the shared envelope every other backend sends.
  const canActions = memberOps
    .filter((op) => op.when)
    .map((op) => {
      const opSnake = snake(op.name);
      return `
  def can_${opSnake}(conn, %{"id" => id}) do
${cuBind}    case ${ctxModule}.${cmdGet}(id${getActor}) do
      {:ok, record} ->
        json(conn, %{"allowed" => ${ctxModule}.can_${opSnake}_${aggSnake}(record)})

      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end`;
    })
    .join("\n");

  // `GET /<plural>/<find>` actions for the aggregate's custom finds.
  const findActions = renderFindActions(appModule, ctxModule, agg, ctx);

  // Audited lifecycle actions — the create/destroy handler stages an audit row
  // INSIDE a forced `Repo.transaction` so it commits atomically with the
  // insert/delete (parity with the Hono/Python/.NET/Java lifecycle audit).
  // create → before:null / after=wire(created), recorded AFTER the insert;
  // destroy → before=wire(loaded) / after:null, recorded BEFORE the delete.
  const auditCreate = (agg.creates ?? []).some((c) => c.audited);
  const auditDestroy = (agg.destroys ?? []).some((d) => d.audited);
  const createMeta = createAuditMeta(agg);
  const destroyMeta = destroyAuditMeta(agg);

  // The `:create` controller action rides the SAME `emitsRestCreate` gate as
  // its router route + OpenAPI `post` — an aggregate with no canonical create
  // emits no create action (rather than an orphaned `def create` no route
  // reaches, mirroring how `delete` is `emitsRestDelete`-gated below).
  //
  // RS-13 — the 201 body is the ID ENVELOPE (`%{"id" => record.id}`), NOT the
  // serialized aggregate.  That is what this backend's own OpenAPI declares
  // (`Create<Agg>Response`, openapi-emit.ts: "the create endpoint returns just
  // the new id") and what the other four backends send.  Serializing the whole
  // record here was a runtime-only divergence the spec-diff is structurally
  // blind to — the specs AGREED; only the bytes differed — so it took the
  // M-T9.11 wire-golden differential to surface it.  The string-keyed map
  // matches the serializer's own `"id" => …` entry, so the id's wire form is
  // identical on the create and read paths.
  const createAction = !emitsRestCreate(agg)
    ? ""
    : auditCreate
      ? `  def create(conn, params) do
${createCuBind}    result =
      ${appModule}.Repo.transaction(fn ->
        case ${ctxModule}.create_${aggSnake}(params${createActor}) do
          {:ok, record} ->
${auditRecordCall({
  appModule,
  operationId: createMeta.operationId,
  action: createMeta.action,
  targetType: aggPascal,
  targetId: "record.id",
  before: "nil",
  after: auditSerialize,
  indent: "            ",
})}

            record

          {:error, %Ecto.Changeset{} = changeset} ->
            ${appModule}.Repo.rollback(changeset)
        end
      end)

    case result do
      {:ok, record} ->
        ${renderPhoenixLogCall("aggregateCreated", [
          { name: "aggregate", valueExpr: `"${aggPascal}"` },
          { name: "id", valueExpr: "record.id" },
        ])}
        ${renderPhoenixDomainOperation(aggPascal, "create")}

        conn
        |> put_status(201)
        |> json(%{"id" => record.id})

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end
  end`
      : `  def create(conn, params) do
${createCuBind}    case ${ctxModule}.create_${aggSnake}(params${createActor}) do
      {:ok, record} ->
        ${renderPhoenixLogCall("aggregateCreated", [
          { name: "aggregate", valueExpr: `"${aggPascal}"` },
          { name: "id", valueExpr: "record.id" },
        ])}
        ${renderPhoenixDomainOperation(aggPascal, "create")}

        conn
        |> put_status(201)
        |> json(%{"id" => record.id})

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end
  end`;

  // FK-restrict destroy conflict (M-T3.4a) — deleting a still-referenced
  // aggregate trips a Postgres foreign_key_violation (23503; a cross-aggregate
  // `X id` FK is ON DELETE RESTRICT), which `Repo.delete/1` raises as
  // `Ecto.ConstraintError` (type `:foreign_key`).  Previously unhandled → 500,
  // while the OpenAPI already declared 409 (a runtime/spec drift + cross-backend
  // divergence — every other backend serves 409).  Reconcile by rescuing that
  // ConstraintError and serving the resolved `ReferencedInUse` status (409 by
  // default, or the `httpStatus ReferencedInUse -> <Code>` override).  A non-FK
  // constraint can't fire on a delete, so any other type reraises (keeps its
  // 500).  Mirrors the Hono 23503 → 409 arm.
  const referencedInUseStatus = resolveErrorStatus("ReferencedInUse", ctx.structuralErrorStatuses);
  const fkRestrictRescue = `
  rescue
    fk_error in Ecto.ConstraintError ->
      if fk_error.type == :foreign_key do
        ProblemDetails.problem_response(
          conn,
          ${referencedInUseStatus},
          ${JSON.stringify(problemTitle(referencedInUseStatus))},
          "${aggPascal} is still referenced and cannot be deleted."
        )
      else
        reraise(fk_error, __STACKTRACE__)
      end`;
  // The CRUD `delete` action is emitted only when the aggregate exposes a REST
  // delete surface (a reachable `destroy` op).  Without it the action, its
  // context `delete_<agg>` call, and the repository `delete/1` it drives were
  // dead code the router never routed to (audit: dead hard-`delete`).  Gated on
  // the SAME `emitsRestDelete` predicate the router (above) and the context /
  // repository seams use.
  const deleteAction = !emitsRestDelete(agg)
    ? ""
    : auditDestroy
      ? `  def delete(conn, %{"id" => id}) do
${cuBind}    with {:ok, record} <- ${ctxModule}.${cmdGet}(id${getActor}),
         {:ok, _} <-
           ${appModule}.Repo.transaction(fn ->
${auditRecordCall({
  appModule,
  operationId: destroyMeta.operationId,
  action: destroyMeta.action,
  targetType: aggPascal,
  targetId: "id",
  before: auditSerialize,
  after: "nil",
  indent: "             ",
})}

             case ${ctxModule}.delete_${aggSnake}(record) do
               {:ok, deleted} -> deleted
               {:error, %Ecto.Changeset{} = changeset} -> ${appModule}.Repo.rollback(changeset)
             end
           end) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end${fkRestrictRescue}
  end`
      : `  def delete(conn, %{"id" => id}) do
${cuBind}    with {:ok, record} <- ${ctxModule}.${cmdGet}(id${getActor}),
         {:ok, _} <- ${ctxModule}.delete_${aggSnake}(record) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end${fkRestrictRescue}
  end`;

  // Optimistic concurrency (`versioned` capability, D-VERSIONED).  The update
  // reads the client's expected version from the `if-match` request header
  // (parsed to int by `__expected_version/1`), threads it into the context
  // update, and maps the `{:error, :conflict}` a stale write yields (the
  // repository rescued `Ecto.StaleEntryError`) onto a 409 ProblemDetails.
  // Gated: a non-versioned aggregate's update action stays byte-identical.
  // The `__expected_version/1` helper (and its binding) is only consumed by the
  // generic `update` action, so it is gated on BOTH `versioned` AND the presence
  // of an explicit `update` op — otherwise a versioned aggregate with no update
  // op (default-on versioning makes EVERY aggregate versioned) would emit an
  // unused private fn and fail `mix compile --warnings-as-errors`.
  const hasUpdateOp = agg.operations.some((o) => o.name === "update");
  const versioned = aggregateIsVersioned(agg);
  const versionsUpdate = versioned && hasUpdateOp;
  const versionBind = versionsUpdate ? "    expected_version = __expected_version(conn)\n" : "";
  const versionCallArg = versionsUpdate ? ", expected_version" : "";
  const conflictClause = versionsUpdate
    ? `

      {:error, :conflict} ->
        ProblemDetails.conflict_response(conn)`
    : "";
  // Private helper — parse the client's expected `version` from the `if-match`
  // request header (bare int or a quoted ETag).  Absent/unparseable → nil, which
  // the write path treats as write-time CAS (the loaded row's own version).
  const versionHelper = versionsUpdate
    ? `

  # Parse the optimistic-concurrency precondition (the client's expected
  # \`version\`) from the \`if-match\` request header.  Absent or unparseable → nil,
  # which the write path treats as write-time CAS (the loaded row's own version).
  defp __expected_version(conn) do
    case get_req_header(conn, "if-match") do
      [value | _] ->
        case value |> String.trim("\\"") |> Integer.parse() do
          {n, _} -> n
          :error -> nil
        end

      _ ->
        nil
    end
  end
`
    : "";

  // The mutating actions (create / update / delete).  An abstract inheritance
  // base is read-only — it emits none of these (no write-seam context fns to
  // call).  Concrete / plain aggregates emit the full set, as before.
  // The generic field-update `:update` action is emitted only when the
  // aggregate declares an EXPLICIT `update` operation — the SAME gate the
  // PATCH route (above) and the `update_<agg>` context defdelegate use, so a
  // routed action is never left calling an undefined context fn and no unused
  // action survives `--warnings-as-errors`.  (The generic action does
  // `Map.drop(params, ["id"])` → `update_<agg>`; it does not dispatch to the
  // op body — the op's own member endpoint does.)  (`hasUpdateOp` is computed
  // above, alongside the optimistic-concurrency gate.)
  //
  // The action answers `204` with NO BODY, not `200` + the serialized
  // aggregate.  `update` is an ordinary void `operation` (crudish synthesizes
  // it with no `: T`), so `deriveContextOperations` types it void and every
  // typed client — Loom's own in-system client included — declares
  // `Promise<void>` and never reads the body.  The other four backends all
  // answer 204 here, and this backend's own OpenAPI declares `204 => No
  // Content` for the operation path.  Returning a body was this backend
  // disagreeing with its own published contract for the SECOND time on the
  // same route (the first was the PATCH-vs-POST path above), and the same
  // reason applies for why nothing caught it: `conformance-parity` diffs the
  // emitted specs, which agreed.
  const updateAction = !hasUpdateOp
    ? ""
    : `  def update(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])
${cuBind}${updateCuBind}${versionBind}
    with {:ok, record} <- ${ctxModule}.${cmdGet}(id${getActor}),
         {:ok, _updated} <- ${ctxModule}.update_${aggSnake}(record, attrs${updateActor}${versionCallArg}) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)${conflictClause}

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end
  end`;
  const writeActions = readOnly
    ? ""
    : [createAction, updateAction, deleteAction].filter((a) => a !== "").join("\n\n");

  // Entity history (docs/audit.md) — the `history` action + its per-aggregate
  // row → entry mapper.  The mapper is per-aggregate because it needs the
  // aggregate's diff field set and — the point of the exercise — its
  // `mask unless` predicates, which render against the same ambient principal
  // the redacting `serialize/1` above masks against.
  const historyFind = servesHistory(ctx, agg) ? vanillaHistoryFind(ctx, agg) : undefined;
  const historyAction = historyFind
    ? `\n\n${renderVanillaHistoryAction(appModule, ctxModule, ctx, agg, historyFind, principal)}`
    : "";
  const historyMapper = historyFind ? `\n\n${renderVanillaHistoryMapper(appModule, ctx, agg)}` : "";

  // Shared error-variant responder — emitted iff a rendered section actually
  // CALLS it.  The old declarative gate (has-returning-op-error || has-union-find)
  // drifted from the render sites the moment the find-absence arms moved to the
  // token producer (#2448's elixir round): api-call's controller emitted the
  // helper with zero callers, an unused private fn under --warnings-as-errors.
  // Deriving the gate from the assembled sections cannot drift again
  // (CLAUDE.md: derive, don't stamp).
  const problemVariant = [writeActions, findActions, opActions, canActions].some((s) =>
    s.includes("problem_variant("),
  )
    ? `\n${renderProblemVariantHelper()}\n`
    : "";

  return `# Auto-generated.
defmodule ${appModule}Web.${aggPascal}Controller do
  use ${appModule}Web, :controller
  require Logger
  alias ${facadeMod}
  alias ${appModule}Web.ProblemDetails

${indexAction}

  def show(conn, %{"id" => id}) do
${cuBind}    case ${ctxModule}.get_${aggSnake}(id${getActor}) do
      {:ok, record} ->
        json(conn, serialize(record))

      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end${historyAction}

${writeActions}
${findActions}
${opActions}
${canActions}
${problemVariant}${versionHelper}
${((): string => {
  // Route A: the document controller roots the SAME wireShape serializer at the
  // rehydrated `%<Agg>.Data{}` embed (`record = row.data`), with `id` off the
  // root row — so containments + value objects project through the shared
  // `serialize_<part|vo>/1` helpers (camelCase, byte-identical to relational),
  // no bespoke document serializer.
  const { serialize, helpers } = isDoc
    ? renderWireSerialize(agg, ctx, {
        headVar: "row",
        bind: "    record = row.data",
        idExpr: "row.id",
        // `version` lives on the root row (`field :version`), not the `:data`
        // embed — read it off `row`, not the rehydrated `record` (which no longer
        // carries it; B5).
        versionExpr: "row.version",
        contextModule: facadeMod,
      })
    : renderWireSerialize(agg, ctx, { contextModule: facadeMod });
  const nested = helpers.length > 0 ? `\n\n${helpers.join("\n\n")}` : "";
  return `${serialize}${nested}${refIdsHelper}`;
})()}${historyMapper}
end
`;
}
