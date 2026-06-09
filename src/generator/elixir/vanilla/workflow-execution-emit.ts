// ---------------------------------------------------------------------------
// Vanilla workflow execution emit — `lib/<app>/<ctx>/workflows/<wf>.ex` +
// `lib/<app>_web/controllers/workflows_controller.ex`.  Slice 5c of
// vanilla-foundation-tdd-plan.md.
//
// On vanilla, workflows are plain Elixir modules — no Ash code
// interface, no Ash.transaction.  A workflow becomes a module with
// `run/1` returning `{:ok, _} | {:error, _}`; `transactional`
// workflows wrap their body in `Repo.transaction/1`.  Cross-aggregate
// operation calls (`<aggregate>.<op>(args)` in the workflow body)
// route through the per-context named-operation functions emitted
// by `context-emit.ts` (Slice 5c prerequisite).
//
// Body lowering for the full WorkflowStmtIR kind set
// (factory-let / repo-let / op-call / emit / precondition / requires /
// expr-let / for-each / repo-run) is intentionally incremental.  This
// slice ships:
//   - the workflow module shape (`run/1`, optional `Repo.transaction`),
//   - the WorkflowsController + spliced POST /workflows/<name> routes,
//   - the prerequisite (named-operation context functions),
// with workflow bodies stubbed to `{:ok, params}`.  Each statement
// kind lands as its own follow-up so the body fills incrementally
// and every step is validated by the `elixir-vanilla-build.yml`
// mix-compile gate.
// ---------------------------------------------------------------------------

import {
  type BoundedContextIR,
  type WorkflowIR,
  workflowEmitsCommandRoute,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";

export interface VanillaWorkflowExecResult {
  routes: ApiRoute[];
}

export function emitVanillaWorkflowExecution(
  appName: string,
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): VanillaWorkflowExecResult {
  if (ctx.workflows.length === 0) return { routes: [] };

  const ctxModule = upperFirst(ctx.name);
  const ctxSnake = snake(ctx.name);
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  const routes: ApiRoute[] = [];

  const commandWorkflows = ctx.workflows.filter(workflowEmitsCommandRoute);
  if (commandWorkflows.length === 0) return { routes: [] };

  // One module per command-triggered workflow.
  for (const wf of commandWorkflows) {
    const wfSnake = snake(wf.name);
    out.set(
      `lib/${appSnake}/${ctxSnake}/workflows/${wfSnake}.ex`,
      renderWorkflowModule(appModule, ctxModule, wf),
    );
  }

  // One shared WorkflowsController per context.
  out.set(
    `lib/${appName}_web/controllers/workflows_controller.ex`,
    renderWorkflowsController(appModule, ctxModule, commandWorkflows),
  );

  for (const wf of commandWorkflows) {
    routes.push({
      method: "post",
      path: `/workflows/${snake(wf.name)}`,
      controller: "WorkflowsController",
      action: `:${snake(wf.name)}`,
    });
  }

  return { routes };
}

function renderWorkflowModule(appModule: string, ctxModule: string, wf: WorkflowIR): string {
  const wfPascal = upperFirst(wf.name);
  const moduleName = `${appModule}.${ctxModule}.Workflows.${wfPascal}`;
  const repoMod = `${appModule}.Repo`;
  const transactional = !!wf.transactional;

  // Body lowering for the full WorkflowStmtIR kind set is incremental
  // (per-kind follow-up PRs).  Slice 5c ships the SHAPE — run/1 +
  // optional Repo.transaction wrap — with the body stubbed to
  // `{:ok, params}` so the module compiles and the route is
  // exercisable.  Subsequent slices fill in factory-let, op-call,
  // emit, precondition/requires, repo-let, expr-let, for-each.
  const transactionalDoc = transactional
    ? "\n\n  Marked `transactional` — the body runs inside `Repo.transaction/1`;\n  a rejection result rolls the transaction back."
    : "";

  if (transactional) {
    return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Workflow \`${wf.name}\` — vanilla foundation (plain Elixir, no Ash).${transactionalDoc}

  Body lowering for individual workflow statement kinds is incremental;
  the current body returns \`{:ok, params}\` so the module compiles and
  the route is exercisable.  See \`workflow-execution-emit.ts\` head
  comment for the lowering plan.
  """

  alias ${repoMod}

  @spec run(map()) :: {:ok, term()} | {:error, term()}
  def run(params) when is_map(params) do
    Repo.transaction(fn ->
      case run_inner(params) do
        {:ok, result} -> result
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
  end

  defp run_inner(params) when is_map(params) do
    # Slice 5c: workflow body lowering is incremental.  Per-statement-
    # kind lowering (factory-let / op-call / emit / precondition /
    # requires / repo-let / expr-let / for-each) lands in follow-up
    # slices consuming context facade functions \`<op>_<agg>/2\`,
    # \`create_<agg>/1\`, \`get_<agg>/1\` (already emitted by
    # context-emit.ts).
    {:ok, params}
  end
end
`;
  }

  // Non-transactional: no Repo wrap, no alias.
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Workflow \`${wf.name}\` — vanilla foundation (plain Elixir, no Ash).

  Body lowering for individual workflow statement kinds is incremental;
  the current body returns \`{:ok, params}\` so the module compiles and
  the route is exercisable.  See \`workflow-execution-emit.ts\` head
  comment for the lowering plan.
  """

  @spec run(map()) :: {:ok, term()} | {:error, term()}
  def run(params) when is_map(params) do
    # Slice 5c: workflow body lowering is incremental.  Per-statement-
    # kind lowering (factory-let / op-call / emit / precondition /
    # requires / repo-let / expr-let / for-each) lands in follow-up
    # slices consuming context facade functions \`<op>_<agg>/2\`,
    # \`create_<agg>/1\`, \`get_<agg>/1\` (already emitted by
    # context-emit.ts).
    {:ok, params}
  end
end
`;
}

function renderWorkflowsController(
  appModule: string,
  ctxModule: string,
  workflows: WorkflowIR[],
): string {
  const webModule = `${appModule}Web`;

  const actions = workflows
    .map((wf) => {
      const wfSnake = snake(wf.name);
      const wfMod = `${appModule}.${ctxModule}.Workflows.${upperFirst(wf.name)}`;
      return `  def ${wfSnake}(conn, params) do
    case ${wfMod}.run(params) do
      {:ok, result} ->
        conn
        |> put_status(202)
        |> json(%{status: "accepted", result: serialize(result)})

      {:error, %Ecto.Changeset{} = changeset} ->
        ProblemDetails.validation_error_response(conn, changeset)

      {:error, :not_found} ->
        ProblemDetails.problem_response(conn, 404, "Not Found", "Resource not found")

      {:error, :forbidden} ->
        ProblemDetails.problem_response(conn, 403, "Forbidden", "Workflow guard rejected the request")

      {:error, reason} ->
        ProblemDetails.problem_response(conn, 400, "Bad Request", inspect(reason))
    end
  end`;
    })
    .join("\n\n");

  return `# Auto-generated.
defmodule ${webModule}.WorkflowsController do
  use ${webModule}, :controller
  alias ${webModule}.ProblemDetails

  @moduledoc """
  HTTP entry points for command-triggered workflows in the
  ${ctxModule} context.  Each action delegates to its workflow
  module's \`run/1\` and translates the typed result via the shared
  vanilla ProblemDetails helper (Slice 4):

    * \`{:ok, result}\` → 202 Accepted + JSON envelope
    * \`{:error, %Ecto.Changeset{}}\` → 422 ProblemDetails (errors[])
    * \`{:error, :not_found}\` → 404 ProblemDetails
    * \`{:error, :forbidden}\` → 403 ProblemDetails
    * \`{:error, reason}\` → 400 ProblemDetails with inspect(reason)
  """

${actions}

  defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])
  defp serialize(other), do: other
end
`;
}
