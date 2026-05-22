import type { BoundedContextIR, DeployableIR, SystemIR } from "../../ir/loom-ir.js";
import { plural, snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// API controller emission for Phoenix LiveView / Ash.
//
// Emits three controller files (when applicable) and a companion route list
// that the orchestrator (index.ts) can splice into router.ex:
//
//   lib/<app>_web/controllers/workflows_controller.ex
//     — one action per workflow; delegates to <App>.<Ctx>.Workflows.<Wf>.run/1
//
//   lib/<app>_web/controllers/views_controller.ex
//     — one action per view; delegates to <App>.<Ctx>.Views.<View>.run/1
//
//   lib/<app>_web/controllers/health_controller.ex
//     — ALWAYS emitted; two actions:
//       liveness/2  → GET /health  (cheap, no DB)
//       readiness/2 → GET /ready   (Ecto ping)
//
// Route injection convention
// --------------------------
// The `apiRoutes` array returned here carries routes that land INSIDE the
// `scope "/api"` block.  Routes whose path starts with the sentinel prefix
// `!root:` (e.g. `!root:/health`) are OUTSIDE the api scope; the orchestrator
// must strip the prefix and place them at the router's root level.
//
// Concretely:
//   apiRoutes entries with path "/workflows/…" or "/views/…"
//     → splice as `post|get "<path>", WorkflowsController|ViewsController, :<action>`
//       inside `scope "/api", …Web do … end`
//   apiRoutes entries with path "!root:/health" or "!root:/ready"
//     → strip "!root:" prefix; emit as bare `get "/health", HealthController, :liveness`
//       at the router's top level (outside any scope block).
// ---------------------------------------------------------------------------

export interface ApiEmitArgs {
  contexts: BoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** snake_case application name, e.g. "phoenix_app" */
  appName: string;
  /** PascalCase module prefix, e.g. "PhoenixApp" */
  appModule: string;
}

export interface ApiRoute {
  method: "get" | "post" | "put" | "patch" | "delete";
  /**
   * Path inside `scope "/api"` — e.g. "/workflows/place_order".
   * Paths that start with `!root:` (e.g. `!root:/health`) are outside
   * the api scope; the orchestrator strips the prefix and splices them
   * at router root level.
   */
  path: string;
  /**
   * Controller module local name (without `<App>Web.` prefix),
   * e.g. "WorkflowsController".
   */
  controller: string;
  /** Action atom, e.g. ":place_order". */
  action: string;
}

export interface ApiEmitResult {
  files: Map<string, string>;
  apiRoutes: ApiRoute[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function emitApiControllers(args: ApiEmitArgs): ApiEmitResult {
  const { contexts, deployable, appName, appModule } = args;
  const files = new Map<string, string>();
  const apiRoutes: ApiRoute[] = [];

  const hasServes = deployable.serves.length > 0;

  // Collect all workflows and views across all contexts
  const allWorkflows: Array<{
    ctx: BoundedContextIR;
    wf: import("../../ir/loom-ir.js").WorkflowIR;
  }> = [];
  const allViews: Array<{ ctx: BoundedContextIR; view: import("../../ir/loom-ir.js").ViewIR }> = [];

  for (const ctx of contexts) {
    for (const wf of ctx.workflows) {
      allWorkflows.push({ ctx, wf });
    }
    for (const view of ctx.views) {
      allViews.push({ ctx, view });
    }
  }

  // --- Workflows controller --------------------------------------------------
  if (hasServes && allWorkflows.length > 0) {
    const controllerPath = `lib/${appName}_web/controllers/workflows_controller.ex`;
    files.set(controllerPath, renderWorkflowsController(allWorkflows, appModule));

    for (const { wf } of allWorkflows) {
      const actionSnake = snake(wf.name);
      apiRoutes.push({
        method: "post",
        path: `/workflows/${actionSnake}`,
        controller: "WorkflowsController",
        action: `:${actionSnake}`,
      });
    }
  }

  // --- Views controller ------------------------------------------------------
  if (hasServes && allViews.length > 0) {
    const controllerPath = `lib/${appName}_web/controllers/views_controller.ex`;
    files.set(controllerPath, renderViewsController(allViews, appModule));

    for (const { view } of allViews) {
      const actionSnake = snake(view.name);
      apiRoutes.push({
        method: "get",
        path: `/views/${actionSnake}`,
        controller: "ViewsController",
        action: `:${actionSnake}`,
      });
    }
  }

  // --- Aggregates controller ------------------------------------------------
  // Collect all aggregates across all contexts.
  const allAggregates: Array<{
    ctx: BoundedContextIR;
    agg: import("../../ir/loom-ir.js").AggregateIR;
  }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      allAggregates.push({ ctx, agg });
    }
  }

  if (hasServes && allAggregates.length > 0) {
    const controllerPath = `lib/${appName}_web/controllers/aggregates_controller.ex`;
    files.set(controllerPath, renderAggregatesController(allAggregates, appModule));

    for (const { agg } of allAggregates) {
      const aggSnake = snake(agg.name);
      const aggPlural = snake(plural(agg.name));

      // GET /aggregates/<plural>  → list
      apiRoutes.push({
        method: "get",
        path: `/aggregates/${aggPlural}`,
        controller: "AggregatesController",
        action: `:list_${aggPlural}`,
      });
      // POST /aggregates/<plural>  → create
      apiRoutes.push({
        method: "post",
        path: `/aggregates/${aggPlural}`,
        controller: "AggregatesController",
        action: `:create_${aggSnake}`,
      });
      // GET /aggregates/<plural>/:id  → get
      apiRoutes.push({
        method: "get",
        path: `/aggregates/${aggPlural}/:id`,
        controller: "AggregatesController",
        action: `:get_${aggSnake}`,
      });
      // PATCH /aggregates/<plural>/:id  → update
      apiRoutes.push({
        method: "patch",
        path: `/aggregates/${aggPlural}/:id`,
        controller: "AggregatesController",
        action: `:update_${aggSnake}`,
      });
      // DELETE /aggregates/<plural>/:id  → destroy
      apiRoutes.push({
        method: "delete",
        path: `/aggregates/${aggPlural}/:id`,
        controller: "AggregatesController",
        action: `:destroy_${aggSnake}`,
      });
    }
  }

  // --- Health controller — always emitted ------------------------------------
  const healthPath = `lib/${appName}_web/controllers/health_controller.ex`;
  files.set(healthPath, renderHealthController(appModule));

  // Health/ready routes use the !root: sentinel so the orchestrator places
  // them outside the /api scope.
  apiRoutes.push({
    method: "get",
    path: "!root:/health",
    controller: "HealthController",
    action: ":liveness",
  });
  apiRoutes.push({
    method: "get",
    path: "!root:/ready",
    controller: "HealthController",
    action: ":readiness",
  });

  return { files, apiRoutes };
}

// ---------------------------------------------------------------------------
// WorkflowsController
// ---------------------------------------------------------------------------

function renderWorkflowsController(
  workflows: Array<{ ctx: BoundedContextIR; wf: import("../../ir/loom-ir.js").WorkflowIR }>,
  appModule: string,
): string {
  const webModule = `${appModule}Web`;

  const actions = workflows
    .map(({ ctx, wf }) => renderWorkflowAction(ctx, wf, appModule))
    .join("\n\n");

  return `# Auto-generated.
defmodule ${webModule}.WorkflowsController do
  use ${webModule}, :controller

  @moduledoc """
  HTTP entry points for all workflow code-interface functions.
  Each action delegates to the matching workflow module's run/1.

  TODO: Wire Plug.RequestId for trace_id propagation.
  """

${actions}

  # ---------------------------------------------------------------------------
  # Error helpers
  # ---------------------------------------------------------------------------

  defp error_response(conn, reason) do
    trace_id = get_resp_header(conn, "x-request-id") |> List.first("unknown")
    conn
    |> put_status(:bad_request)
    |> json(%{error: inspect(reason), trace_id: trace_id})
  end
end
`;
}

function renderWorkflowAction(
  ctx: BoundedContextIR,
  wf: import("../../ir/loom-ir.js").WorkflowIR,
  appModule: string,
): string {
  const wfSnake = snake(wf.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const workflowModule = `${contextModule}.Workflows.${upperFirst(wf.name)}`;

  // Build the permitted param key list from the workflow's declared params
  const allowedKeys = wf.params.map((p) => `"${snake(p.name)}"`).join(", ");
  const takeExpr = allowedKeys.length > 0 ? `Map.take(params, [${allowedKeys}])` : `%{}`;

  return `  @doc "POST /api/workflows/${wfSnake}"
  def ${wfSnake}(conn, params) do
    # currentUser threading.  When the deployable has
    # \`auth: required\`, the Auth plug populates
    # \`conn.assigns.current_user\` from the JWT.  We pass it as the
    # second positional arg to run/2; workflows that don't reference
    # currentUser ignore it (the renderer emits a default value).
    current_user = Map.get(conn.assigns, :current_user)
    input = ${takeExpr}

    case ${workflowModule}.run(input, current_user) do
      {:ok, result} ->
        conn
        |> put_status(:ok)
        |> json(%{data: result})

      {:error, reason} ->
        error_response(conn, reason)
    end
  end`;
}

// ---------------------------------------------------------------------------
// ViewsController
// ---------------------------------------------------------------------------

function renderViewsController(
  views: Array<{ ctx: BoundedContextIR; view: import("../../ir/loom-ir.js").ViewIR }>,
  appModule: string,
): string {
  const webModule = `${appModule}Web`;

  const actions = views.map(({ ctx, view }) => renderViewAction(ctx, view, appModule)).join("\n\n");

  return `# Auto-generated.
defmodule ${webModule}.ViewsController do
  use ${webModule}, :controller

  @moduledoc """
  HTTP entry points for all view query modules.
  Each action delegates to the matching view module's run/1 and
  strips Ash internal fields before encoding the JSON response.
  """

${actions}
end
`;
}

function renderViewAction(
  ctx: BoundedContextIR,
  view: import("../../ir/loom-ir.js").ViewIR,
  appModule: string,
): string {
  const viewSnake = snake(view.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const viewModule = `${contextModule}.Views.${upperFirst(view.name)}`;

  // Ash internal metadata fields to strip before JSON encoding
  const ashInternalKeys = `~w(__meta__ __struct__ __order__ __lateral_join_source__ calculations aggregates relationships)a`;

  return `  @doc "GET /api/views/${viewSnake}"
  def ${viewSnake}(conn, _params) do
    # currentUser available to views via run/1 first arg.
    # Views that don't reference currentUser ignore it (default value).
    current_user = Map.get(conn.assigns, :current_user)
    case ${viewModule}.run(current_user) do
      {:ok, records} ->
        data =
          Enum.map(records, fn record ->
            record
            |> Map.from_struct()
            |> Map.drop(${ashInternalKeys})
          end)

        conn
        |> put_status(:ok)
        |> json(%{data: data})

      {:error, reason} ->
        trace_id = get_resp_header(conn, "x-request-id") |> List.first("unknown")

        conn
        |> put_status(:internal_server_error)
        |> json(%{error: inspect(reason), trace_id: trace_id})
    end
  end`;
}

// ---------------------------------------------------------------------------
// AggregatesController
// ---------------------------------------------------------------------------

function renderAggregatesController(
  aggregates: Array<{ ctx: BoundedContextIR; agg: import("../../ir/loom-ir.js").AggregateIR }>,
  appModule: string,
): string {
  const webModule = `${appModule}Web`;

  const actions = aggregates
    .map(({ ctx, agg }) => renderAggregateActions(ctx, agg, appModule))
    .join("\n\n");

  return `# Auto-generated.
defmodule ${webModule}.AggregatesController do
  use ${webModule}, :controller

  @moduledoc """
  HTTP entry points for all aggregate CRUD code-interface functions.
  Each action delegates to the matching Ash domain code-interface entry.
  """

${actions}
end
`;
}

function renderAggregateActions(
  ctx: BoundedContextIR,
  agg: import("../../ir/loom-ir.js").AggregateIR,
  appModule: string,
): string {
  const aggSnake = snake(agg.name);
  const aggPlural = snake(plural(agg.name));
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;

  return `  @doc "GET /api/aggregates/${aggPlural}"
  def list_${aggPlural}(conn, _params) do
    records = ${contextModule}.list_${aggPlural}!()
    json(conn, records)
  end

  @doc "GET /api/aggregates/${aggPlural}/:id"
  def get_${aggSnake}(conn, %{"id" => id}) do
    record = ${contextModule}.get_${aggSnake}!(id)
    json(conn, record)
  end

  @doc "POST /api/aggregates/${aggPlural}"
  def create_${aggSnake}(conn, params) do
    record = ${contextModule}.create_${aggSnake}!(params)
    conn
    |> put_status(:created)
    |> json(record)
  end

  @doc "PATCH /api/aggregates/${aggPlural}/:id"
  def update_${aggSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])
    record = ${contextModule}.update_${aggSnake}!(id, attrs)
    json(conn, record)
  end

  @doc "DELETE /api/aggregates/${aggPlural}/:id"
  def destroy_${aggSnake}(conn, %{"id" => id}) do
    ${contextModule}.destroy_${aggSnake}!(id)
    send_resp(conn, 204, "")
  end`;
}

// ---------------------------------------------------------------------------
// HealthController
// ---------------------------------------------------------------------------

function renderHealthController(appModule: string): string {
  const webModule = `${appModule}Web`;

  return `# Auto-generated.
defmodule ${webModule}.HealthController do
  use ${webModule}, :controller

  @moduledoc """
  Liveness and readiness probes.

  GET /health — cheap liveness check; always returns 200 while the BEAM is running.
  GET /ready  — DB-aware readiness check; returns 503 when the database is unreachable.
  """

  @doc "GET /health — liveness probe (no DB dependency)."
  def liveness(conn, _params) do
    json(conn, %{status: "ok"})
  end

  @doc "GET /ready — readiness probe (pings the database)."
  def readiness(conn, _params) do
    try do
      Ecto.Adapters.SQL.query!(${appModule}.Repo, "SELECT 1", [])
      json(conn, %{status: "ready"})
    rescue
      _e ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{status: "not_ready"})
    end
  end
end
`;
}
