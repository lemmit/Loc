import type { BoundedContextIR, ParamIR, WorkflowIR, WorkflowStmtIR } from "../../ir/loom-ir.js";
import { upperFirst, snake } from "../../util/naming.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";

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
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;

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
  const moduleName = `${contextModule}.Workflows.${upperFirst(wf.name)}`;
  const renderCtx: RenderCtx = { thisName: "record", contextModule };

  const params = wf.params.map((p) => snake(p.name));
  const paramPattern =
    params.length === 0 ? "_args" : `%{${params.map((p) => `${p}: ${p}`).join(", ")}}`;

  const bodyLines = renderWorkflowBody(wf, ctx, renderCtx, contextModule, appModule);

  // Collect precondition statements to generate a validate_args/1 private
  // function that runs at the top of the with chain (mirrors dotnet Mediator
  // validation pipeline pattern).
  const precondStmts = wf.statements.filter(
    (s): s is Extract<typeof s, { kind: "precondition" | "requires" }> =>
      s.kind === "precondition" || s.kind === "requires",
  );
  const validateArgsSection = renderValidateArgsFunction(
    wf.name,
    wf.params,
    precondStmts,
    renderCtx,
  );

  // Emit event broadcasts that are collected separately (stmt-level emits
  // are woven into the with-chain by renderWorkflowBody).
  const body = wf.transactional
    ? renderTransactionalBody(bodyLines, appModule, wf, contextModule)
    : renderSequentialBody(bodyLines);

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Workflow: ${upperFirst(wf.name)}"

  alias ${contextModule}

  # currentUser threading.  Controllers pass
  # \`conn.assigns.current_user\` as the second positional arg; LiveView
  # callers pass \`socket.assigns.current_user\`.  Workflows that don't
  # reference currentUser ignore the param (default = nil).
  def run(${paramPattern}, current_user \\\\ nil) do
    _ = current_user
${body}
  end
${validateArgsSection}end
`;
}

// ---------------------------------------------------------------------------
// validate_args/1 — private validation helper for workflow params.
//
// Mirrors the .NET Mediator validation pipeline: precondition / requires
// statements whose predicates reference only workflow parameters are
// lowered to a `validate_args(args)` private function that the `run/1`
// function calls first via an `:ok <-` with-clause.
//
// The function returns `:ok` on success and `{:error, reason}` on failure,
// matching the with-chain protocol.
//
// When no precondition / requires statements exist, an empty string is
// returned so no dead code is emitted.
// ---------------------------------------------------------------------------

type PrecondOrRequires = Extract<WorkflowStmtIR, { kind: "precondition" | "requires" }>;

function renderValidateArgsFunction(
  _wfName: string,
  params: ParamIR[],
  stmts: PrecondOrRequires[],
  renderCtx: RenderCtx,
): string {
  if (stmts.length === 0 && params.length === 0) return "";
  // Only emit the function when there are actual guard predicates.
  if (stmts.length === 0) return "";

  const paramKeys = new Set(params.map((p) => p.name));

  // Build the body: each stmt becomes one guard clause.
  const guardLines: string[] = [];
  for (const stmt of stmts) {
    const exprStr = renderExpr(stmt.expr, { ...renderCtx, thisName: "args" });
    if (stmt.kind === "precondition") {
      const msg = JSON.stringify(`Precondition failed: ${stmt.source}`);
      guardLines.push(`    if not (${exprStr}), do: throw({:error, ${msg}})`);
    } else {
      guardLines.push(`    if not (${exprStr}), do: throw({:error, :forbidden})`);
    }
  }
  void paramKeys; // available for future extension (matches-on-param-type)

  const body = guardLines.join("\n");
  return `
  defp validate_args(args) do
    try do
${body}
      :ok
    catch
      {:error, _} = err -> err
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

  // When the workflow has precondition/requires statements, inject a
  // `validate_args(args)` with-clause at the head of the chain — mirrors
  // the .NET Mediator validation pipeline pattern.  The private
  // `validate_args/1` function (emitted below `run/1`) contains the actual
  // guards; this keeps `run/1` declarative.
  const hasPreconditions = wf.statements.some(
    (s) => s.kind === "precondition" || s.kind === "requires",
  );
  const paramPattern =
    wf.params.length > 0 ? `%{${wf.params.map((p) => `${snake(p.name)}: _`).join(", ")}}` : "_args";
  void paramPattern;
  if (hasPreconditions && wf.params.length > 0) {
    // Use the arg map pattern that run/1 destructures.
    const argsVar = wf.params.map((p) => `${snake(p.name)}: ${snake(p.name)}`).join(", ");
    lines.push({
      kind: "with-clause",
      text: `      :ok <- validate_args(%{${argsVar}})`,
    });
  } else if (hasPreconditions) {
    // No named params — validate_args receives an empty map.
    lines.push({
      kind: "with-clause",
      text: `      :ok <- validate_args(%{})`,
    });
  }

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
      return [
        {
          kind: "precondition",
          text: `    unless ${expr}, do: throw({:error, ${JSON.stringify(`Precondition failed: ${st.source}`)}})`,
        },
      ];
    }

    case "requires": {
      const expr = renderExpr(st.expr, renderCtx);
      return [
        {
          kind: "requires",
          text: `    unless ${expr}, do: throw({:error, :forbidden})`,
        },
      ];
    }

    case "factory-let": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const action = `create_${snake(st.aggName)}`;
      const call = `${contextModule}.${action}(%{${fields}})`;
      return [
        {
          kind: "with-clause",
          text: `      {:ok, ${snake(st.name)}} <- ${call}`,
          bindName: snake(st.name),
        },
      ];
    }

    case "repo-let": {
      const argList = st.args.map((a) => renderExpr(a, renderCtx)).join(", ");
      const action = `${snake(st.method)}_${snake(st.aggName)}`;
      const call = argList
        ? `${contextModule}.${action}(${argList})`
        : `${contextModule}.${action}()`;
      return [
        {
          kind: "with-clause",
          text: `      {:ok, ${snake(st.name)}} <- ${call}`,
          bindName: snake(st.name),
        },
      ];
    }

    case "op-call": {
      const argList = st.args.map((a) => renderExpr(a, renderCtx)).join(", ");
      const action = `${snake(st.op)}_${snake(st.aggName)}`;
      const callTarget = snake(st.target);
      const call = argList
        ? `${contextModule}.${action}(${callTarget}, %{${argList}})`
        : `${contextModule}.${action}(${callTarget})`;
      return [
        {
          kind: "with-clause",
          text: `      {:ok, _} <- ${call}`,
        },
      ];
    }

    case "emit": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const eventModule = `${contextModule}.Events.${upperFirst(st.eventName)}`;
      return [
        {
          kind: "emit",
          text: `      Phoenix.PubSub.broadcast(${renderCtx.contextModule.split(".")[0]}.PubSub, "events", %${eventModule}{${fields}})`,
        },
      ];
    }

    case "expr-let": {
      const val = renderExpr(st.expr, renderCtx);
      return [
        {
          kind: "expr",
          text: `    ${snake(st.name)} = ${val}`,
          bindName: snake(st.name),
        },
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Transactional wrapper — Ash.transaction/2
//
// Ash 3.x signature: Ash.transaction(domain_or_resources, fn -> ... end, opts)
//
//   Ash.transaction([MyApp.Sales], fn -> ... end)
//   Ash.transaction([MyApp.Sales.Order, MyApp.Catalog.Product], fn -> ... end)
//
// The second argument is a **domain module** (or list of resources / domains)
// — NOT an Ecto Repo.  Passing the context's domain module is correct for the
// single-context case that the workflow emitter targets.  When a workflow
// touches resources from multiple domains, callers should pass a list; that
// scenario is not representable in the current IR, so passing the domain alone
// is the safe default.
// ---------------------------------------------------------------------------

function renderTransactionalBody(
  lines: WorkflowBodyLine[],
  _appModule: string,
  wf: WorkflowIR,
  contextModule: string,
): string {
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

  const emitSection =
    emitLines.length > 0 ? "\n" + emitLines.map((l) => "    " + l.text.trimStart()).join("\n") : "";

  // isolation_level is an opts keyword in Ash 3.x (third positional arg).
  const isolationOptLine = wf.isolation
    ? `,\n      isolation_level: :${elixirIsolationLevel(wf.isolation)}`
    : "";

  // Ash 3.x: first arg is the domain (or list of domains/resources).
  // The context module IS the Ash.Domain — wrapping it in a list satisfies
  // both the single-domain and multi-domain overloads.
  return `${precondLines ? precondLines + "\n" : ""}    result = Ash.transaction(
      [${contextModule}],
      fn ->
${txBody}
      end${isolationOptLine}
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

  const emitSection =
    emitLines.length > 0 ? "\n" + emitLines.map((l) => "    " + l.text.trimStart()).join("\n") : "";

  return `${precondSection ? precondSection + "\n" : ""}${bodySection}${emitSection}`;
}

function elixirIsolationLevel(level: import("../../ir/loom-ir.js").IsolationLevel): string {
  switch (level) {
    case "readUncommitted":
      return "read_uncommitted";
    case "readCommitted":
      return "read_committed";
    case "repeatableRead":
      return "repeatable_read";
    case "serializable":
      return "serializable";
  }
}
