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
//   ✓ repo-let     → `{:ok, <name>} <- Context.get_<agg>(id)` (getById only;
//                    custom finds aren't yet exposed via the vanilla context)
//   ✓ emit         → `Phoenix.PubSub.broadcast(App.PubSub, "events",
//                     %App.Ctx.Events.<Name>{...})` — rendered INSIDE the
//                    with-chain's do-branch so a failed precondition / op
//                    short-circuits and the broadcast is skipped.  The
//                    `Events.<Name>` struct module is emitted by the
//                    orchestrator's `emitVanillaEventModules` hook.
//   ✓ default     → preserved as `# TODO:<kind>` comment; the workflow
//                   still compiles and the route is exercisable.
// Remaining kinds (for-each / repo-run / resource-call, plus non-getById
// repo-let) land as their own focused slices each validated by the
// elixir-vanilla-build.yml mix-compile gate.
//
// Param surfacing: a workflow body that references a declared
// create-param (`create(initialTitle: string) { … initialTitle … }`)
// gets a leading destructure of exactly the referenced params off the
// `run/1` map — `%{"initial_title" => initial_title} = params` — so the
// bare-local rendering of a `param` ref resolves.  Params arrive as a
// string-keyed snake_case map (the wire shape).  Only referenced params
// are bound: an unused binding would trip `--warnings-as-errors`.
// ---------------------------------------------------------------------------

import {
  type BoundedContextIR,
  type ExprIR,
  type StmtIR,
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
   *  `emit` lines render INSIDE the `do`-branch before the success result,
   *  so they fire only when the with-chain succeeds (a rolled-back
   *  transaction skips them).  `stmt` is the `# TODO` fallthrough — runs
   *  as a leading statement before the `with`. */
  kind: "with-clause" | "emit" | "stmt";
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

    case "repo-let": {
      // `let wallet = Wallets.getById(walletId)` →
      // `{:ok, wallet} <- Context.get_wallet(wallet_id)`.
      // Only the auto-generated `getById` finder is supported on vanilla
      // today — it maps to the context's `get_<agg>/1` (find_by_id)
      // facade.  Custom repository finds aren't yet exposed through the
      // vanilla context, so a non-getById repo-let stays on the TODO
      // fallthrough (a call to a non-existent fn would fail mix compile).
      // The matching arm in `collectWorkflowStmtParamRefs` is likewise
      // gated to getById.
      if (st.method !== "getById") return todoLine(st.kind);
      const argList = st.args.map((a) => renderExpr(a, renderCtx)).join(", ");
      const call = `${contextModule}.get_${snake(st.aggName)}(${argList})`;
      return [
        {
          kind: "with-clause",
          text: `{:ok, ${snake(st.name)}} <- ${call}`,
          bindName: snake(st.name),
        },
      ];
    }

    case "emit": {
      // `emit OrderConfirmed { order: id, at: now() }` →
      // `Phoenix.PubSub.broadcast(App.PubSub, "events",
      //                           %App.Ctx.Events.OrderConfirmed{order: id, at: ...})`
      // Renders INSIDE the with-chain's `do`-branch (`BodyLine.kind = "emit"`)
      // so a failed precondition / op short-circuits the chain and the
      // broadcast is skipped — listeners only see events for successful
      // workflows.  Inside `Repo.transaction(fn -> ...)` the broadcast
      // fires before commit; that matches the standard Phoenix pattern
      // (a separate "after-commit" hook is out of scope for this slice
      // and matches the Ash path's behaviour anyway).
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const appModule = contextModule.split(".")[0]!;
      const struct = `%${contextModule}.Events.${upperFirst(st.eventName)}{${fields}}`;
      return [
        {
          kind: "emit",
          text: `Phoenix.PubSub.broadcast(${appModule}.PubSub, "events", ${struct})`,
        },
      ];
    }

    default:
      // Unsupported kind today — preserved as a TODO comment so the
      // workflow still compiles.  Future slices add per-kind lowering
      // and remove this fallthrough as each kind moves into a real
      // BodyLine.
      return todoLine(st.kind);
  }
}

/** The `# TODO` fallthrough BodyLine for a not-yet-lowered statement kind —
 *  keeps the workflow compiling while the per-kind lowering is pending. */
function todoLine(kind: string): BodyLine[] {
  return [
    {
      kind: "stmt",
      text: `# TODO: lower workflow statement kind '${kind}' (vanilla-foundation-tdd-plan.md follow-up)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Param surfacing — collect the declared create-params a workflow body
// actually references, so exactly those (and no unused ones) are
// destructured off the `run/1` map.
// ---------------------------------------------------------------------------

/** Add every `refKind: "param"` name reachable from `e` into `acc`.
 *  Exhaustive over the child-bearing `ExprIR` kinds (a stricter superset
 *  of the validate-layer `walkExpr` — it also descends `list` / `convert`
 *  / `match`, which can appear in a workflow create-body). */
function collectParamRefs(e: ExprIR | undefined, acc: Set<string>): void {
  if (!e) return;
  switch (e.kind) {
    case "ref":
      if (e.refKind === "param") acc.add(e.name);
      return;
    case "member":
      collectParamRefs(e.receiver, acc);
      return;
    case "method-call":
      collectParamRefs(e.receiver, acc);
      for (const a of e.args) collectParamRefs(a, acc);
      return;
    case "call":
      for (const a of e.args) collectParamRefs(a, acc);
      return;
    case "lambda":
      collectParamRefs(e.body, acc);
      if (e.block) for (const s of e.block) collectParamRefsInStmt(s, acc);
      return;
    case "new":
    case "object":
      for (const f of e.fields) collectParamRefs(f.value, acc);
      return;
    case "list":
      for (const el of e.elements) collectParamRefs(el, acc);
      return;
    case "paren":
      collectParamRefs(e.inner, acc);
      return;
    case "unary":
      collectParamRefs(e.operand, acc);
      return;
    case "binary":
      collectParamRefs(e.left, acc);
      collectParamRefs(e.right, acc);
      return;
    case "ternary":
      collectParamRefs(e.cond, acc);
      collectParamRefs(e.then, acc);
      collectParamRefs(e.otherwise, acc);
      return;
    case "convert":
      collectParamRefs(e.value, acc);
      return;
    case "match":
      for (const arm of e.arms) {
        collectParamRefs(arm.cond, acc);
        collectParamRefs(arm.value, acc);
      }
      collectParamRefs(e.otherwise, acc);
      return;
    default:
      // Leaf kinds (`literal` / `this` / `id`) bind no params.
      return;
  }
}

/** A `StmtIR` (lambda block body) — only the expression-bearing arms can
 *  carry a param reference; collect from each. */
function collectParamRefsInStmt(s: StmtIR, acc: Set<string>): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      collectParamRefs(s.expr, acc);
      return;
    case "assign":
    case "add":
    case "remove":
    case "return":
      collectParamRefs(s.value, acc);
      return;
    case "emit":
      for (const f of s.fields) collectParamRefs(f.value, acc);
      return;
    case "call":
      for (const a of s.args) collectParamRefs(a, acc);
      return;
  }
}

/** Collect referenced create-params, but ONLY from the statement kinds
 *  that today lower to real code emitting the param ref (precondition /
 *  requires / expr-let / factory-let / op-call / emit, plus a `getById`
 *  repo-let).  The kinds still on the `# TODO` fallthrough (non-getById
 *  `repo-let` / `repo-run` / `for-each` / `resource-call`) don't render
 *  their param refs yet — binding a param only those reference would leave
 *  an unused local that trips `--warnings-as-errors`.  When a future slice
 *  lowers one of those kinds, it adds the matching arm here in the same
 *  change.  This MUST stay in lock-step with `lowerStatement`. */
function collectWorkflowStmtParamRefs(st: WorkflowStmtIR, acc: Set<string>): void {
  switch (st.kind) {
    case "precondition":
    case "requires":
    case "expr-let":
      collectParamRefs(st.expr, acc);
      return;
    case "factory-let":
      for (const f of st.fields) collectParamRefs(f.value, acc);
      return;
    case "op-call":
      for (const a of st.args) collectParamRefs(a, acc);
      return;
    case "emit":
      for (const f of st.fields) collectParamRefs(f.value, acc);
      return;
    case "repo-let":
      // Gated to the lowered form — see the `repo-let` arm in lowerStatement.
      if (st.method === "getById") for (const a of st.args) collectParamRefs(a, acc);
      return;
    default:
      // repo-run / for-each / resource-call — not yet lowered to
      // param-referencing code (see lowerStatement default arm).
      return;
  }
}

/** The declared create-params referenced anywhere in the body, in
 *  declaration order (stable output). */
function referencedParams(wf: WorkflowIR): string[] {
  const refs = new Set<string>();
  for (const st of wf.statements ?? []) collectWorkflowStmtParamRefs(st, refs);
  return (wf.params ?? []).map((p) => p.name).filter((n) => refs.has(n));
}

/** Compose lowered body lines into the inner-function body that the
 *  workflow module's `run_inner` (transactional) or inline body
 *  (non-transactional) executes.  Three line kinds:
 *
 *  - `with-clause` → stacks into the `with ... do ... end` chain.
 *  - `emit`        → renders INSIDE the `do`-branch before the success
 *                    return, so it fires only on with-chain success.
 *  - `stmt`        → leading statement before the `with` (the `# TODO`
 *                    fallthrough form).
 *
 *  The final result is `{:ok, <last-bound-name>}` or `{:ok, params}`
 *  if no binds were produced — matching the contract `run/1` returns
 *  `{:ok, _} | {:error, _}`.  An emit-only `do`-branch ends with
 *  `:ok` so the workflow still satisfies the `{:ok, _} | {:error, _}`
 *  contract. */
function assembleBody(lines: BodyLine[]): string {
  const withClauses = lines.filter((l) => l.kind === "with-clause");
  const emitLines = lines.filter((l) => l.kind === "emit");
  const stmtLines = lines.filter((l) => l.kind === "stmt");
  const lastBind = [...withClauses].reverse().find((l) => l.bindName)?.bindName;

  const resultExpr = lastBind ? `{:ok, ${lastBind}}` : "{:ok, params}";
  // The `do`-branch body: emits first (only run on with-chain success),
  // then the success result.  Indented to match the `with ... do ... end`
  // shape — 6 spaces under `run_inner`.
  const doBody =
    emitLines.length > 0
      ? `${emitLines.map((l) => `      ${l.text}`).join("\n")}\n      ${resultExpr}`
      : `      ${resultExpr}`;

  if (stmtLines.length === 0 && withClauses.length === 0 && emitLines.length === 0) {
    // Empty body — keep the stub semantics.
    return `    {:ok, params}`;
  }

  if (stmtLines.length === 0 && withClauses.length === 0 && emitLines.length > 0) {
    // Emit-only body — no with-chain to gate on, broadcasts run
    // unconditionally then return :ok.
    return `${emitLines.map((l) => `    ${l.text}`).join("\n")}\n    {:ok, :emitted}`;
  }

  if (stmtLines.length === 0 && withClauses.length > 0) {
    // Pure with-chain (optionally with emits in the do-branch).
    return `    with ${withClauses[0]!.text.trimStart()}${
      withClauses.length > 1
        ? `,\n${withClauses
            .slice(1)
            .map((l) => `         ${l.text}`)
            .join(",\n")}`
        : ""
    } do
${doBody}
    end`;
  }

  if (withClauses.length === 0 && stmtLines.length > 0) {
    return `    # Workflow body — incremental lowering (see workflow-execution-emit.ts).
${stmtLines.map((l) => `    ${l.text}`).join("\n")}${
  emitLines.length > 0 ? `\n${emitLines.map((l) => `    ${l.text}`).join("\n")}` : ""
}
    ${resultExpr}`;
  }

  // Mixed: stmt lines first, then with-chain (emits in its do-branch).
  const stmtBlock = stmtLines.map((l) => `    ${l.text}`).join("\n");
  const withBlock = withClauses
    .map((l, i) => (i === 0 ? `with ${l.text}` : `         ${l.text}`))
    .join(",\n");
  return `${stmtBlock}
    ${withBlock} do
${doBody}
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
  // Surface referenced create-params as locals via a leading map
  // destructure — the body's bare `param` refs (`initial_title`) bind off
  // the `run/1` map.  Empty when no params are referenced, so a
  // param-free workflow renders byte-identically to before.
  const params = referencedParams(wf);
  const paramDestructure =
    params.length > 0
      ? `    %{${params.map((n) => `"${snake(n)}" => ${snake(n)}`).join(", ")}} = params\n`
      : "";
  const finalBody = paramDestructure + aliasedBody;

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
${finalBody}
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
${finalBody}
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
