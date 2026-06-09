// ---------------------------------------------------------------------------
// Vanilla controllers — `lib/<app>_web/controllers/<agg>_controller.ex`.
// Slice 1 of vanilla-foundation-tdd-plan.md.
//
// Read path only at Slice 1: `GET /<aggs>` (list) and `GET /<aggs>/{id}`
// (show), with `with`-block dispatch over `{:ok,_}|{:error,_}` from the
// Repository.  Per-variant error mapping → status code is minimal here
// (just :not_found → 404 ProblemDetails); Slice 4 lands the full
// exception-less ProblemDetails parity.
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
        conn
        |> put_status(404)
        |> json(%{
          type: "/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "${aggPascal} #{id} not found"
        })
    end
  end

  defp serialize(record) do
    record
    |> Map.from_struct()
    |> Map.drop([:__meta__, :__struct__])
  end
end
`;
}
