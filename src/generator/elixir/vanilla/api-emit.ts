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

import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";

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
    out.set(
      `lib/${appName}_web/controllers/${aggSnake}_controller.ex`,
      renderController(appModule, ctxModule, agg.name, aggSnake),
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
    if (agg.operations.length > 0) {
      routes.push({
        method: "patch",
        path: `/${aggsPath}/:id`,
        controller: controllerName,
        action: ":update",
      });
    }
    if ((agg.destroys ?? []).length > 0) {
      routes.push({
        method: "delete",
        path: `/${aggsPath}/:id`,
        controller: controllerName,
        action: ":delete",
      });
    }
  }

  return { routes };
}

function renderController(
  appModule: string,
  ctxModule: string,
  aggName: string,
  aggSnake: string,
): string {
  const aggPascal = upperFirst(aggName);
  const facadeMod = `${appModule}.${ctxModule}`;

  return `# Auto-generated.
defmodule ${appModule}Web.${aggPascal}Controller do
  use ${appModule}Web, :controller
  alias ${facadeMod}

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
        not_found(conn, "${aggPascal}", id)
    end
  end

  def create(conn, params) do
    case ${ctxModule}.create_${aggSnake}(params) do
      {:ok, record} ->
        conn
        |> put_status(201)
        |> json(serialize(record))

      {:error, %Ecto.Changeset{} = changeset} ->
        validation_error(conn, changeset)
    end
  end

  def update(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id),
         {:ok, updated} <- ${ctxModule}.update_${aggSnake}(record, attrs) do
      json(conn, serialize(updated))
    else
      {:error, :not_found} ->
        not_found(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        validation_error(conn, changeset)
    end
  end

  def delete(conn, %{"id" => id}) do
    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id),
         {:ok, _} <- ${ctxModule}.delete_${aggSnake}(record) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} ->
        not_found(conn, "${aggPascal}", id)

      {:error, %Ecto.Changeset{} = changeset} ->
        validation_error(conn, changeset)
    end
  end

  defp serialize(record) do
    record
    |> Map.from_struct()
    |> Map.drop([:__meta__, :__struct__])
  end

  defp not_found(conn, kind, id) do
    conn
    |> put_status(404)
    |> json(%{
      type: "/errors/not-found",
      title: "Not Found",
      status: 404,
      detail: "#{kind} #{id} not found"
    })
  end

  defp validation_error(conn, changeset) do
    errors =
      Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
        Enum.reduce(opts, msg, fn {key, value}, acc ->
          String.replace(acc, "%{#{key}}", to_string(value))
        end)
      end)

    conn
    |> put_status(422)
    |> json(%{
      type: "/errors/validation",
      title: "Validation Failed",
      status: 422,
      detail: "Request body failed validation",
      errors: errors
    })
  end
end
`;
}
