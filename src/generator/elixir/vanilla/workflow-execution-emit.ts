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
// Body lowering by WorkflowStmtIR kind (incremental):
//   ✓ factory-let → `{:ok, <name>} <- Context.create_<agg>(%{...})`
//   ✓ op-call     → `{:ok, _}      <- Context.<op>_<agg>(target, %{...})`
//   ✓ precondition → `:ok <- (if <cond>, do: :ok, else: {:error, :precondition_failed})`
//   ✓ requires     → `:ok <- (if <cond>, do: :ok, else: {:error, :forbidden})`
//   ✓ expr-let     → `<name> <- (<expr>)` (always succeeds; binds `name`)
//   ✓ default     → preserved as `# TODO:<kind>` comment; the workflow
//                   still compiles and the route is exercisable.
// Remaining kinds (emit / repo-let / for-each / repo-run) land as their
// own focused slices each validated by the elixir-vanilla-build.yml
// mix-compile gate.
// ---------------------------------------------------------------------------

import {
  type BoundedContextIR,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowEmitsCommandRoute,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

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

  for (const wf of commandWorkflows) {
    const wfSnake = snake(wf.name);
    out.set(
      `lib/${appSnake}/${ctxSnake}/workflows/${wfSnake}.ex`,
      renderWorkflowModule(appModule, ctxModule, wf),
    );
  }

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

// ---------------------------------------------------------------------------
// Body lowering — per-WorkflowStmtIR-kind translation to plain Elixir.
// ---------------------------------------------------------------------------

interface BodyLine {
  /** `with-clause` lines stack into the `with ... do ... end` chain.
   *  `pre` lines run before the `with` (preconditions / requires).
   *  `post` lines run after a successful `with` body (e.g. `emit`). */
  kind: "with-clause" | "pre" | "post" | "stmt";
  text: string;
  /** Bind name for `with-clause` lines — used to pick the final result
   *  of `run/1` (last bound name, or `:ok` if no binds). */
  bindName?: string;
}

function lowerStatements(
  stmts: WorkflowStmtIR[],
  contextModule: string,
  renderCtx: RenderCtx,
): BodyLine[] {
  const lines: BodyLine[] = [];
  for (const st of stmts) {
    lines.push(...lowerStatement(st, contextModule, renderCtx));
  }
  return lines;
}

function lowerStatement(
  st: WorkflowStmtIR,
  contextModule: string,
  renderCtx: RenderCtx,
): BodyLine[] {
  switch (st.kind) {
    case "factory-let": {
      // `let order = Order.create({ field: value, … })` →
      // `{:ok, order} <- Context.create_order(%{field: value, …})`
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const action = `create_${snake(st.aggName)}`;
      const call = `${contextModule}.${action}(%{${fields}})`;
      return [
        {
          kind: "with-clause",
          text: `{:ok, ${snake(st.name)}} <- ${call}`,
          bindName: snake(st.name),
        },
      ];
    }

    case "op-call": {
      // `order.confirm(args)` →
      // `{:ok, _} <- Context.confirm_order(order, %{args...})`
      const argFields = st.args
        .map((arg, i) => `arg${i}: ${renderExpr(arg, renderCtx)}`)
        .join(", ");
      const target = snake(st.target);
      const action = `${snake(st.op)}_${snake(st.aggName)}`;
      const call = `${contextModule}.${action}(${target}, %{${argFields}})`;
      return [
        {
          kind: "with-clause",
          text: `{:ok, _} <- ${call}`,
          bindName: undefined,
        },
      ];
    }

    case "precondition": {
      // `precondition <expr>` →
      // `:ok <- (if <cond>, do: :ok, else: {:error, :precondition_failed})`
      // A failure tag flows naturally through the with-chain to
      // `{:error, :precondition_failed}` → controller maps to 422.
      const cond = renderExpr(st.expr, renderCtx);
      return [
        {
          kind: "with-clause",
          text: `:ok <- (if ${cond}, do: :ok, else: {:error, :precondition_failed})`,
          bindName: undefined,
        },
      ];
    }

    case "requires": {
      // `requires <expr>` (authorisation guard) →
      // `:ok <- (if <cond>, do: :ok, else: {:error, :forbidden})`
      // A failure tag flows to `{:error, :forbidden}` → controller maps to 403.
      const cond = renderExpr(st.expr, renderCtx);
      return [
        {
          kind: "with-clause",
          text: `:ok <- (if ${cond}, do: :ok, else: {:error, :forbidden})`,
          bindName: undefined,
        },
      ];
    }

    case "expr-let": {
      // `let foo = <expr>` (pure binding inside a workflow body) →
      // `foo <- (<expr>)` — a with-clause binding always succeeds.
      // `bindName` is undefined so a subsequent `factory-let` (an
      // aggregate-shaped value) wins the `{:ok, <last>}` result slot.
      const expr = renderExpr(st.expr, renderCtx);
      return [
        {
          kind: "with-clause",
          text: `${snake(st.name)} <- (${expr})`,
          bindName: undefined,
        },
      ];
    }

    default:
      // Unsupported kind today — preserved as a TODO comment so the
      // workflow still compiles.  Future slices add per-kind lowering
      // and remove this fallthrough as each kind moves into a real
      // BodyLine.
      return [
        {
          kind: "stmt",
          text: `# TODO: lower workflow statement kind '${st.kind}' (vanilla-foundation-tdd-plan.md follow-up)`,
        },
      ];
  }
}

/** Compose lowered body lines into the inner-function body that the
 *  workflow module's `run_inner` (transactional) or inline body
 *  (non-transactional) executes.  Two assembly modes:
 *
 *  - Pure `with`-chain when every line is a `with-clause`:
 *      with {:ok, x} <- ...,
 *           {:ok, _} <- ...,
 *           do: {:ok, x}
 *  - Sequential when stmt lines are mixed in:
 *      stmt
 *      with {:ok, x} <- ..., do: {:ok, x}
 *
 *  The final result is `{:ok, <last-bound-name>}` or `{:ok, params}`
 *  if no binds were produced — matching the contract `run/1` returns
 *  `{:ok, _} | {:error, _}`. */
function assembleBody(lines: BodyLine[]): string {
  const withClauses = lines.filter((l) => l.kind === "with-clause");
  const stmtLines = lines.filter((l) => l.kind === "stmt");
  const lastBind = withClauses.reverse().find((l) => l.bindName)?.bindName;
  withClauses.reverse(); // restore order

  const resultExpr = lastBind ? `{:ok, ${lastBind}}` : "{:ok, params}";

  if (stmtLines.length === 0 && withClauses.length > 0) {
    // Pure with-chain.
    const clauses = withClauses.map((l) => `      ${l.text}`).join(",\n");
    return `    with ${withClauses[0]!.text.trimStart()}${
      withClauses.length > 1
        ? `,\n${withClauses
            .slice(1)
            .map((l) => `         ${l.text}`)
            .join(",\n")}`
        : ""
    } do
      ${resultExpr}
    end`;
  }

  if (withClauses.length === 0 && stmtLines.length > 0) {
    return `    # Workflow body — incremental lowering (see workflow-execution-emit.ts).
${stmtLines.map((l) => `    ${l.text}`).join("\n")}
    ${resultExpr}`;
  }

  if (withClauses.length === 0 && stmtLines.length === 0) {
    // Empty body — keep the stub semantics.
    return `    {:ok, params}`;
  }

  // Mixed: stmt lines first, then with-chain.
  const stmtBlock = stmtLines.map((l) => `    ${l.text}`).join("\n");
  const withBlock = withClauses
    .map((l, i) => (i === 0 ? `with ${l.text}` : `         ${l.text}`))
    .join(",\n");
  return `${stmtBlock}
    ${withBlock} do
      ${resultExpr}
    end`;
}

function renderWorkflowModule(appModule: string, ctxModule: string, wf: WorkflowIR): string {
  const wfPascal = upperFirst(wf.name);
  const moduleName = `${appModule}.${ctxModule}.Workflows.${wfPascal}`;
  const contextModuleFq = `${appModule}.${ctxModule}`;
  const repoMod = `${appModule}.Repo`;
  const transactional = !!wf.transactional;

  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: contextModuleFq,
    foundation: "vanilla",
  };
  const lines = lowerStatements(wf.statements ?? [], contextModuleFq, renderCtx);
  const body = assembleBody(lines);
  const hasContextCall = lines.some((l) => l.kind === "with-clause");
  const contextAlias = hasContextCall ? `\n  alias ${contextModuleFq}, as: Context` : "";
  // Rewrite the body's fully-qualified context module to the `Context`
  // alias to keep the rendered Elixir tidy and avoid long-line warnings.
  const aliasedBody = hasContextCall ? body.replaceAll(contextModuleFq, "Context") : body;

  const transactionalDoc = transactional
    ? "\n\n  Marked `transactional` — the body runs inside `Repo.transaction/1`;\n  a rejection result rolls the transaction back."
    : "";

  if (transactional) {
    return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Workflow \`${wf.name}\` — vanilla foundation (plain Elixir, no Ash).${transactionalDoc}

  Body lowering for individual statement kinds is incremental.  See
  \`workflow-execution-emit.ts\` for the per-kind status.
  """

  alias ${repoMod}${contextAlias}

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
${aliasedBody}
  end
end
`;
  }

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Workflow \`${wf.name}\` — vanilla foundation (plain Elixir, no Ash).

  Body lowering for individual statement kinds is incremental.  See
  \`workflow-execution-emit.ts\` for the per-kind status.
  """${hasContextCall ? `\n${contextAlias.trimStart()}\n` : ""}

  @spec run(map()) :: {:ok, term()} | {:error, term()}
  def run(params) when is_map(params) do
${aliasedBody}
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

      {:error, :precondition_failed} ->
        ProblemDetails.problem_response(conn, 422, "Precondition Failed", "Workflow precondition rejected the request")

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
  ${ctxModule} context.
  """

${actions}

  defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])
  defp serialize(other), do: other
end
`;
}
