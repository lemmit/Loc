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

import { emitsRestCreate as sharedEmitsRestCreate } from "../../../ir/enrich/wire-projection.js";
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
import { problemTitle } from "../../../ir/util/openapi-errors.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import type { ApiRoute } from "../api-emit.js";
import { opUsesCurrentUser } from "../domain/predicates.js";
import { auditRecordCall, createAuditMeta, destroyAuditMeta } from "./audit-emit.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";
import { CRUD_RESERVED_NAMES } from "./context-emit.js";
import { isVanillaDocAgg } from "./document-emit.js";
import { isEventSourced, renderEsController } from "./eventsourced-emit.js";
import { aggregateHasUnionFind, findRoutes, renderFindActions } from "./find-controller.js";
import { isAbstractBase } from "./inheritance-emit.js";
import {
  aggregateHasReturningOpError,
  GUARD_RESCUE,
  isReturningOperation,
  opHasGuards,
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
    routes.push({
      method: "get",
      path: `/${aggsPath}`,
      controller: controllerName,
      action: ":index",
    });
    routes.push(...findRoutes(agg, ctx));
    routes.push({
      method: "get",
      path: `/${aggsPath}/:id`,
      controller: controllerName,
      action: ":show",
    });
    // Write path.  The create route rides the shared `emitsRestCreate`
    // predicate — the SAME gate the OpenAPI `post` operation uses — so the
    // route and the documented contract can never diverge (`generators.md`:
    // "POST / → create").  See `emitsRestCreate` for the constructibility
    // rationale.
    if (emitsRestCreate(agg)) {
      routes.push({
        method: "post",
        path: `/${aggsPath}`,
        controller: controllerName,
        action: ":create",
      });
    }
    // Event-sourced aggregates have no generic field-update / delete surface —
    // their only mutations are the per-operation member endpoints below.  The
    // generic PATCH is now gated on an EXPLICIT `update` operation (symmetric
    // with create/destroy), not merely on the aggregate having some operation.
    if (!es && agg.operations.some((o) => o.name === "update")) {
      routes.push({
        method: "patch",
        path: `/${aggsPath}/:id`,
        controller: controllerName,
        action: ":update",
      });
    }
    if (emitsRestDelete(agg)) {
      routes.push({
        method: "delete",
        path: `/${aggsPath}/:id`,
        controller: controllerName,
        action: ":delete",
      });
    }
    // Per-operation member endpoints — `POST /<plural>/:id/<op>`, one per
    // public non-CRUD operation, matching the node/dotnet/python/java
    // backends.  The URL segment uses
    // `routeSlug` (D-URLSTYLE) while the action atom stays the op verb.
    for (const op of memberOps) {
      routes.push({
        method: "post",
        path: `/${aggsPath}/:id/${snake(op.routeSlug ?? op.name)}`,
        controller: controllerName,
        action: `:${snake(op.name)}`,
      });
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
  // The create action has no read-filter `cuBind`, so bind `current_user` there
  // when a principal stamp needs it.
  const createCuBind = stampPrincipal
    ? "    current_user = Map.get(conn.assigns, :current_user)\n"
    : "";
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
      // A guarded op's context fn short-circuits to `{:error, :forbidden}` (403)
      // or `{:error, :precondition_failed}` (422) — the typed denials that
      // replaced `raise(ArgumentError, …)` (→ 500).  Emit the matching `else`
      // arms only when the op has a guard (else they'd be unreachable clauses —
      // `--warnings-as-errors`).  Same status + ProblemDetails body as the
      // ES-command controller.
      const denialArms = opHasGuards(op)
        ? `

      {:error, :forbidden} ->
        ProblemDetails.problem_response(conn, 403, "Forbidden", "Operation not permitted")

      {:error, :precondition_failed} ->
        ProblemDetails.problem_response(conn, 422, "Unprocessable Entity", "A precondition failed")`
        : "";
      return `
  def ${opSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])
${opCuBind}    ${renderPhoenixLogCall("operationInvoked", [
        { name: "aggregate", valueExpr: `"${aggPascal}"` },
        { name: "op", valueExpr: `"${op.name}"` },
        { name: "id", valueExpr: "id" },
      ])}

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

  // Shared error-variant responder, emitted once when the aggregate has a
  // returning op WITH an error variant or a union find (else it'd be an unused
  // private fn under --warnings-as-errors — a returning op with a scalar /
  // success-only return never calls it).
  const problemVariant =
    aggregateHasReturningOpError(agg, ctx) || aggregateHasUnionFind(ctx, agg)
      ? `\n${renderProblemVariantHelper()}\n`
      : "";

  // `GET /<plural>/<find>` actions for the aggregate's custom finds.
  const findActions = renderFindActions(ctxModule, agg, ctx);

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
  after: "serialize(record)",
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

        conn
        |> put_status(201)
        |> json(serialize(record))

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

        conn
        |> put_status(201)
        |> json(serialize(record))

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
  before: "serialize(record)",
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
  const versioned = aggregateIsVersioned(agg);
  const versionBind = versioned ? "    expected_version = __expected_version(conn)\n" : "";
  const versionCallArg = versioned ? ", expected_version" : "";
  const conflictClause = versioned
    ? `

      {:error, :conflict} ->
        ProblemDetails.conflict_response(conn)`
    : "";
  // Private helper — parse the client's expected `version` from the `if-match`
  // request header (bare int or a quoted ETag).  Absent/unparseable → nil, which
  // the write path treats as write-time CAS (the loaded row's own version).
  const versionHelper = versioned
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
  // op body — the op's own member endpoint does.)
  const hasUpdateOp = agg.operations.some((o) => o.name === "update");
  const updateAction = !hasUpdateOp
    ? ""
    : `  def update(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])
${cuBind}${updateCuBind}${versionBind}
    with {:ok, record} <- ${ctxModule}.${cmdGet}(id${getActor}),
         {:ok, updated} <- ${ctxModule}.update_${aggSnake}(record, attrs${updateActor}${versionCallArg}) do
      json(conn, serialize(updated))
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
  end

${writeActions}
${findActions}
${opActions}
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
        contextModule: facadeMod,
      })
    : renderWireSerialize(agg, ctx, { contextModule: facadeMod });
  const nested = helpers.length > 0 ? `\n\n${helpers.join("\n\n")}` : "";
  return `${serialize}${nested}${refIdsHelper}`;
})()}
end
`;
}
