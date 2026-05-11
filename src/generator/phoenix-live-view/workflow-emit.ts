import type {
  BoundedContextIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/loom-ir.js";
import { pascal, snake } from "../../util/naming.js";
import { renderExpr, type RenderCtx } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Workflow emission for Phoenix LiveView / Ash.
//
// For each `workflow X(params) [transactional] { body }` declared in the
// context, emits:
//
//   lib/<app>/<ctx>/workflows/<workflow_snake>.ex
//
// Each workflow becomes a plain Elixir module with a `run/1` function that
// wraps sequential Ash code-interface calls in `Ash.transaction/2` (when
// the workflow is declared `transactional`) or calls them directly.
//
// Workflow body statement lowering:
//   factory-let  → `{:ok, <name>} <- <Domain>.create_<agg>(fields)`
//   repo-let     → `{:ok, <name>} <- <Domain>.<method>_<agg>(args)`
//   op-call      → `{:ok, _} <- <Domain>.<op>_<agg>(<target>, args)`
//   emit         → Phoenix.PubSub.broadcast(...)
//   precondition → early-return {:error, reason} when guard fails
//   requires     → early-return {:error, :forbidden} when guard fails
//   expr-let     → `<name> = <expr>`
//
// Non-transactional workflows that have no `with` chains just sequence
// plain `!` bang calls.  Transactional ones use `with` + `Ash.transaction`.
// ---------------------------------------------------------------------------

export function emitWorkflows(
  appName: string,
  ctx: BoundedContextIR,
  appModule: string,
  out: Map<string, string>,
): void {
  if (ctx.workflows.length === 0) return;
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${pascal(ctx.name)}`;

  for (const wf of ctx.workflows) {
    const path = `lib/${appName}/${ctxSnake}/workflows/${snake(wf.name)}.ex`;
    const content = renderWorkflow(wf, ctx, contextModule, appModule);
    out.set(path, content);
  }
}

function renderWorkflow(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  contextModule: string,
  appModule: string,
): string {
  const moduleName = `${contextModule}.Workflows.${pascal(wf.name)}`;
  const renderCtx: RenderCtx = { thisName: "record", contextModule };

  const params = wf.params.map((p) => snake(p.name));
  const paramPattern =
    params.length === 0
      ? "_args"
      : `%{${params.map((p) => `${p}: ${p}`).join(", ")}}`;

  const bodyLines = renderWorkflowBody(wf, ctx, renderCtx, contextModule, appModule);

  // Emit event broadcasts that are collected separately (stmt-level emits
  // are woven into the with-chain by renderWorkflowBody).
  const body = wf.transactional
    ? renderTransactionalBody(bodyLines, appModule, wf)
    : renderSequentialBody(bodyLines);

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Workflow: ${pascal(wf.name)}"

  alias ${contextModule}

  def run(${paramPattern}) do
${body}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

interface WorkflowBodyLine {
  kind: "with-clause" | "emit" | "precondition" | "requires" | "expr";
  text: string;
  bindName?: string;
}

function renderWorkflowBody(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  contextModule: string,
  appModule: string,
): WorkflowBodyLine[] {
  void appModule;
  const lines: WorkflowBodyLine[] = [];

  for (const st of wf.statements) {
    lines.push(...renderWorkflowStmt(st, ctx, renderCtx, contextModule));
  }

  return lines;
}

function renderWorkflowStmt(
  st: WorkflowStmtIR,
  _ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  contextModule: string,
): WorkflowBodyLine[] {
  switch (st.kind) {
    case "precondition": {
      const expr = renderExpr(st.expr, renderCtx);
      return [{
        kind: "precondition",
        text: `    unless ${expr}, do: throw({:error, ${JSON.stringify(`Precondition failed: ${st.source}`)}})`,
      }];
    }

    case "requires": {
      const expr = renderExpr(st.expr, renderCtx);
      return [{
        kind: "requires",
        text: `    unless ${expr}, do: throw({:error, :forbidden})`,
      }];
    }

    case "factory-let": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const action = `create_${snake(st.aggName)}`;
      const call = `${contextModule}.${action}(%{${fields}})`;
      return [{
        kind: "with-clause",
        text: `      {:ok, ${snake(st.name)}} <- ${call}`,
        bindName: snake(st.name),
      }];
    }

    case "repo-let": {
      const argList = st.args.map((a) => renderExpr(a, renderCtx)).join(", ");
      const action = `${snake(st.method)}_${snake(st.aggName)}`;
      const call = argList
        ? `${contextModule}.${action}(${argList})`
        : `${contextModule}.${action}()`;
      return [{
        kind: "with-clause",
        text: `      {:ok, ${snake(st.name)}} <- ${call}`,
        bindName: snake(st.name),
      }];
    }

    case "op-call": {
      const argList = st.args.map((a) => renderExpr(a, renderCtx)).join(", ");
      const action = `${snake(st.op)}_${snake(st.aggName)}`;
      const callTarget = snake(st.target);
      const call = argList
        ? `${contextModule}.${action}(${callTarget}, %{${argList}})`
        : `${contextModule}.${action}(${callTarget})`;
      return [{
        kind: "with-clause",
        text: `      {:ok, _} <- ${call}`,
      }];
    }

    case "emit": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const eventModule = `${contextModule}.Events.${pascal(st.eventName)}`;
      return [{
        kind: "emit",
        text: `      Phoenix.PubSub.broadcast(${renderCtx.contextModule.split(".")[0]}.PubSub, "events", %${eventModule}{${fields}})`,
      }];
    }

    case "expr-let": {
      const val = renderExpr(st.expr, renderCtx);
      return [{
        kind: "expr",
        text: `    ${snake(st.name)} = ${val}`,
        bindName: snake(st.name),
      }];
    }
  }
}

// ---------------------------------------------------------------------------
// Transactional wrapper — Ash.transaction/2
// ---------------------------------------------------------------------------

function renderTransactionalBody(lines: WorkflowBodyLine[], appModule: string, wf: WorkflowIR): string {
  // Separate preconditions (run before transaction) from the body
  const preconds = lines.filter((l) => l.kind === "precondition" || l.kind === "requires");
  const body = lines.filter((l) => l.kind !== "precondition" && l.kind !== "requires");

  const precondLines = preconds.map((l) => l.text).join("\n");

  // Find the last with-clause bind name to return as the transaction result
  const lastBind = [...body].reverse().find((l) => l.bindName);
  const returnVal = lastBind?.bindName ?? ":ok";

  // Split emit lines from with-chain lines
  const withClauses = body.filter((l) => l.kind === "with-clause");
  const emitLines = body.filter((l) => l.kind === "emit");
  const exprLines = body.filter((l) => l.kind === "expr");

  let txBody: string;
  if (withClauses.length === 0 && exprLines.length === 0) {
    txBody = `      {:ok, :ok}`;
  } else {
    const allLines = [...exprLines, ...withClauses];
    const withBody = allLines.map((l) => l.text).join(",\n");
    txBody = `      with\n${withBody} do\n        {:ok, ${returnVal}}\n      end`;
  }

  const emitSection = emitLines.length > 0
    ? "\n" + emitLines.map((l) => "    " + l.text.trimStart()).join("\n")
    : "";

  // isolation level
  let isolationOpt = "";
  if (wf.isolation) {
    const level = elixirIsolationLevel(wf.isolation);
    isolationOpt = `, isolation_level: :${level}`;
  }

  return `${precondLines ? precondLines + "\n" : ""}    result = Ash.transaction(
      fn ->
${txBody}
      end,
      ${appModule}.Repo${isolationOpt}
    )
${emitSection}
    result`;
}

function renderSequentialBody(lines: WorkflowBodyLine[]): string {
  if (lines.length === 0) return "    :ok";

  const preconds = lines.filter((l) => l.kind === "precondition" || l.kind === "requires");
  const body = lines.filter((l) => l.kind !== "precondition" && l.kind !== "requires");

  const precondSection = preconds.map((l) => l.text).join("\n");

  const withClauses = body.filter((l) => l.kind === "with-clause");
  const emitLines = body.filter((l) => l.kind === "emit");
  const exprLines = body.filter((l) => l.kind === "expr");

  const lastBind = [...body].reverse().find((l) => l.bindName);
  const returnVal = lastBind?.bindName ?? ":ok";

  let bodySection: string;
  if (withClauses.length === 0 && exprLines.length === 0) {
    bodySection = "    :ok";
  } else {
    const allLines = [...exprLines, ...withClauses];
    const withBody = allLines.map((l) => l.text).join(",\n");
    bodySection = `    with\n${withBody} do\n      {:ok, ${returnVal}}\n    end`;
  }

  const emitSection = emitLines.length > 0
    ? "\n" + emitLines.map((l) => "    " + l.text.trimStart()).join("\n")
    : "";

  return `${precondSection ? precondSection + "\n" : ""}${bodySection}${emitSection}`;
}

function elixirIsolationLevel(level: import("../../ir/loom-ir.js").IsolationLevel): string {
  switch (level) {
    case "readUncommitted": return "read_uncommitted";
    case "readCommitted": return "read_committed";
    case "repeatableRead": return "repeatable_read";
    case "serializable": return "serializable";
  }
}
