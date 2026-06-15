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
// extension shape byte-identical to the Ash tower) lands in Slice 4.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { CRUD_RESERVED_NAMES } from "./context-emit.js";
import { isEventSourced, renderEsController } from "./eventsourced-emit.js";
import {
  aggregateHasReturningOp,
  isReturningOperation,
  renderProblemVariantHelper,
  renderReturningOpControllerAction,
} from "./operation-returns-emit.js";

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

export function emitVanillaApiControllers(
  appName: string,
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
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
    out.set(
      `lib/${appName}_web/controllers/${aggSnake}_controller.ex`,
      es
        ? renderEsController(appModule, ctxModule, agg)
        : renderController(appModule, ctxModule, agg, aggSnake, memberOps, ctx),
    );

    // Read path
    routes.push({
      method: "get",
      path: `/${aggsPath}`,
      controller: controllerName,
      action: ":index",
    });
    routes.push({
      method: "get",
      path: `/${aggsPath}/:id`,
      controller: controllerName,
      action: ":show",
    });
    // Write path — Slice 2.  Always emitted when the aggregate has a
    // canonical create / destroy / mutate operation.  The aggregate
    // shape from `with crudish` always carries these.
    if ((agg.creates ?? []).length > 0) {
      routes.push({
        method: "post",
        path: `/${aggsPath}`,
        controller: controllerName,
        action: ":create",
      });
    }
    // Event-sourced aggregates have no generic field-update / delete surface —
    // their only mutations are the per-operation member endpoints below.
    if (!es && agg.operations.length > 0) {
      routes.push({
        method: "patch",
        path: `/${aggsPath}/:id`,
        controller: controllerName,
        action: ":update",
      });
    }
    if (!es && (agg.destroys ?? []).length > 0) {
      routes.push({
        method: "delete",
        path: `/${aggsPath}/:id`,
        controller: controllerName,
        action: ":delete",
      });
    }
    // Per-operation member endpoints — `POST /<plural>/:id/<op>`, one per
    // public non-CRUD operation, matching the Ash path (`elixir/api-emit.ts`)
    // and the node/dotnet/python/java backends.  The URL segment uses
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
): string {
  const aggPascal = upperFirst(agg.name);
  const facadeMod = `${appModule}.${ctxModule}`;

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
      return `
  def ${opSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id),
         {:ok, _updated} <- ${ctxModule}.${opSnake}_${aggSnake}(record, attrs) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end
  end`;
    })
    .join("\n");

  // Shared error-variant responder, emitted once when the aggregate has any
  // returning op (else it'd be an unused private fn under --warnings-as-errors).
  const problemVariant = aggregateHasReturningOp(agg) ? `\n${renderProblemVariantHelper()}\n` : "";

  return `# Auto-generated.
defmodule ${appModule}Web.${aggPascal}Controller do
  use ${appModule}Web, :controller
  alias ${facadeMod}
  alias ${appModule}Web.ProblemDetails

  def index(conn, _params) do
    with {:ok, records} <- ${ctxModule}.list_${aggSnake}s() do
      json(conn, %{items: Enum.map(records, &serialize/1)})
    end
  end

  def show(conn, %{"id" => id}) do
    case ${ctxModule}.get_${aggSnake}(id) do
      {:ok, record} ->
        json(conn, serialize(record))

      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end

  def create(conn, params) do
    case ${ctxModule}.create_${aggSnake}(params) do
      {:ok, record} ->
        conn
        |> put_status(201)
        |> json(serialize(record))

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end
  end

  def update(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id),
         {:ok, updated} <- ${ctxModule}.update_${aggSnake}(record, attrs) do
      json(conn, serialize(updated))
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end
  end

  def delete(conn, %{"id" => id}) do
    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id),
         {:ok, _} <- ${ctxModule}.delete_${aggSnake}(record) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)
    end
  end
${opActions}
${problemVariant}
  defp serialize(record) do
    record
    |> Map.from_struct()
    |> Map.drop([:__meta__, :__struct__])
  end
end
`;
}
