import type {
  BoundedContextIR,
  SystemIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { resolveWorkflowIsolation } from "../../ir/util/resolve-datasource.js";
import { snake, upperFirst } from "../../util/naming.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";
import { buildPhoenixResourceModules } from "./adapters/resource-clients.js";
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
  sys?: SystemIR,
): void {
  if (ctx.workflows.length === 0) return;
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;

  for (const wf of ctx.workflows) {
    const path = `lib/${appName}/${ctxSnake}/workflows/${snake(wf.name)}.ex`;
    const content = renderWorkflow(wf, ctx, contextModule, appModule, sys);
    out.set(path, content);
  }
}

function renderWorkflow(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  contextModule: string,
  appModule: string,
  sys: SystemIR | undefined,
): string {
  const moduleName = `${contextModule}.Workflows.${upperFirst(wf.name)}`;
  // Resource-op routing (Phase 4c): resourceName → helper module.
  const resourceModules = buildPhoenixResourceModules(sys, appModule);
  const renderCtx: RenderCtx = { thisName: "record", contextModule, resourceModules };

  const params = wf.params.map((p) => snake(p.name));
  const paramPattern =
    params.length === 0 ? "_args" : `%{${params.map((p) => `${p}: ${p}`).join(", ")}}`;

  const bodyLines = renderWorkflowBody(wf, ctx, renderCtx, contextModule, appModule);

  // Effective isolation: workflow's `transactional(<level>)` wins; else
  // the state-kind dataSource for this context's `isolationLevel:`; else
  // undefined (connection default applies at runtime).
  const effectiveIsolation = sys ? resolveWorkflowIsolation(wf, ctx, sys) : wf.isolation;
  // Emit event broadcasts that are collected separately (stmt-level emits
  // are woven into the with-chain by renderWorkflowBody).
  const body = wf.transactional
    ? renderTransactionalBody(bodyLines, appModule, wf, contextModule, effectiveIsolation)
    : renderSequentialBody(bodyLines, wf);

  // Workflow narrative — `workflow_started` at the run/1 entry,
  // `workflow_completed` at the success tail (woven into the body
  // renderers).  Always-on info-level events; the catalog identity is
  // shared with Hono / .NET so dashboards pivot on one event name.
  const startedCall = renderPhoenixLogCall("workflowStarted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
  ]);

  // precondition / requires statements short-circuit with
  // `throw({:error, …})`.  The controller calls `run/2` inside a
  // `case`, which does NOT catch throws — an uncaught throw crashes the
  // request (500) instead of yielding the `{:error, reason}` the
  // controller maps to 403 / 400.  Wrap the body in `try/catch :throw`
  // so a thrown `{:error, …}` becomes the function's return value.  Only
  // emit the wrapper when a guard can actually throw, keeping
  // guard-free workflows unchanged.
  const hasGuards = wf.statements.some((s) => s.kind === "precondition" || s.kind === "requires");
  const runBody = hasGuards
    ? [
        "    try do",
        indentLines(body, "  "),
        "    catch",
        "      :throw, {:error, _} = err -> err",
        "    end",
      ].join("\n")
    : body;

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Workflow: ${upperFirst(wf.name)}"

  require Logger

  # currentUser threading.  Controllers pass
  # \`conn.assigns.current_user\` as the second positional arg; LiveView
  # callers pass \`socket.assigns.current_user\`.  Workflows that don't
  # reference currentUser ignore the param (default = nil).
  def run(${paramPattern}, current_user \\\\ nil) do
    _ = current_user
    ${startedCall}
${runBody}
  end
end
`;
}

/** Prefix every non-empty line of a multi-line block with `pad`.  Used
 *  to re-indent a rendered workflow body when nesting it inside a
 *  `try/catch` wrapper. */
function indentLines(block: string, pad: string): string {
  return block
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

interface WorkflowBodyLine {
  // `stmt` — a standalone full statement (e.g. a `repo-run` bind) that is
  //   NOT a `with`-clause; `loop` — a multi-line standalone block (an
  //   `Enum.reduce_while` for a `for` loop).  Both force the body to be
  //   rendered as an ordered sequence rather than a single `with`-chain.
  kind: "with-clause" | "emit" | "precondition" | "requires" | "expr" | "stmt" | "loop";
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

  // precondition / requires are emitted as standalone `unless ... throw`
  // lines (kind: "precondition" | "requires") and hoisted by
  // renderTransactionalBody / renderSequentialBody to run before the
  // with-chain — no separate validate_args helper to thread current_user
  // through.
  for (const st of wf.statements) {
    lines.push(...renderWorkflowStmt(st, ctx, renderCtx, contextModule));
  }

  return lines;
}

function renderWorkflowStmt(
  st: WorkflowStmtIR,
  ctx: BoundedContextIR,
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
      // The auto-generated `getById` finder maps to Ash's primary-key read
      // code-interface, which is just `get_<resource>/1` — `get_by_id_<res>`
      // would name a separate `:by_id` read action that doesn't exist.
      const action =
        st.method === "getById"
          ? `get_${snake(st.aggName)}`
          : `${snake(st.method)}_${snake(st.aggName)}`;
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
      // Ash actions take a NAMED-arg map (`%{key: value}`).  Zip the
      // positional st.args with the operation's param names so an op
      // like `promote(env: string)` called as `b.promote("production")`
      // emits `%{env: "production"}` — bare `%{"production"}` is invalid
      // Elixir map syntax.
      const op = ctx.aggregates
        .find((a) => a.name === st.aggName)
        ?.operations.find((o) => o.name === st.op);
      const argEntries = (op?.params ?? []).map(
        (p, i) => `${snake(p.name)}: ${renderExpr(st.args[i]!, renderCtx)}`,
      );
      const action = `${snake(st.op)}_${snake(st.aggName)}`;
      const callTarget = snake(st.target);
      const call = argEntries.length
        ? `${contextModule}.${action}(${callTarget}, %{${argEntries.join(", ")}})`
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
    case "resource-call":
      // 4c: the Phoenix ResourceAdapter renders the call here.
      // renderExpr already throws via the resource-op guard; keep an
      // explicit branch so the switch stays exhaustive.
      return [{ kind: "expr", text: `    ${renderExpr(st.call, renderCtx)}` }];
    case "repo-run": {
      // `Repo.run(<Retrieval>(args), page?)` → the `run_<ret>_<agg>!`
      // code-interface (bang variant: returns the page struct directly
      // and raises on failure, so it composes inside `Ash.transaction`
      // which converts a raise to a rolled-back `{:error, _}`).  Page
      // rides as a `page: [offset:, limit:]` keyword opt.
      const args = st.retrievalArgs.map((a) => renderExpr(a, renderCtx));
      if (st.page) {
        const entries: string[] = [];
        if (st.page.offset) entries.push(`offset: ${renderExpr(st.page.offset, renderCtx)}`);
        if (st.page.limit) entries.push(`limit: ${renderExpr(st.page.limit, renderCtx)}`);
        args.push(`page: [${entries.join(", ")}]`);
      }
      const action = `run_${snake(st.retrievalName)}_${snake(st.aggName)}`;
      return [
        {
          kind: "stmt",
          text: `    ${snake(st.name)} = ${contextModule}.${action}!(${args.join(", ")})`,
          bindName: snake(st.name),
        },
      ];
    }
    case "for-each": {
      // `for c in xs { … }` → `Enum.reduce_while` over the page's
      // `.results` (offset pagination returns `%Ash.Page.Offset{}`, not a
      // bare list).  Each body op-call runs as an Ash update (persisting);
      // a failure halts the reduce with the error tuple so the enclosing
      // transaction rolls back.
      const iterable = `${renderExpr(st.iterable, renderCtx)}.results`;
      const bodyLines = st.body.flatMap((inner) =>
        renderLoopBodyStmt(inner, ctx, renderCtx, contextModule),
      );
      const loop = [
        `    Enum.reduce_while(${iterable}, {:ok, nil}, fn ${snake(st.var)}, _acc ->`,
        ...bodyLines.map((l) => `  ${l}`),
        `    end)`,
      ].join("\n");
      return [{ kind: "loop", text: loop }];
    }
  }
}

/** Render a `for`-loop body statement as Elixir inside the
 *  `Enum.reduce_while` callback — op-calls become a `case` that threads
 *  `{:cont, {:ok, _}}` / `{:halt, err}`.  v1 loop bodies are op-calls
 *  (the validator restricts the shape); anything else is rendered as a
 *  bare line (defensive). */
function renderLoopBodyStmt(
  st: WorkflowStmtIR,
  ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  contextModule: string,
): string[] {
  if (st.kind === "op-call") {
    const op = ctx.aggregates
      .find((a) => a.name === st.aggName)
      ?.operations.find((o) => o.name === st.op);
    const argEntries = (op?.params ?? []).map(
      (p, i) => `${snake(p.name)}: ${renderExpr(st.args[i]!, renderCtx)}`,
    );
    const action = `${snake(st.op)}_${snake(st.aggName)}`;
    const target = snake(st.target);
    const call = argEntries.length
      ? `${contextModule}.${action}(${target}, %{${argEntries.join(", ")}})`
      : `${contextModule}.${action}(${target})`;
    return [
      `    case ${call} do`,
      `      {:ok, updated} -> {:cont, {:ok, updated}}`,
      `      err -> {:halt, err}`,
      `    end`,
    ];
  }
  // Non-op-call body statements aren't expected in v1 loops; render the
  // underlying stmt lines as a fallback so the switch stays total.
  return renderWorkflowStmt(st, ctx, renderCtx, contextModule).map((l) => l.text);
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
  effectiveIsolation: WorkflowIR["isolation"],
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
  // `stmt` / `loop` lines (repo-run bind + for-each reduce_while) can't be
  // `with`-clauses — when present, render the body as an ordered sequence
  // ending in the loop's `{:ok,_}`/`{:error,_}` rather than a with-chain.
  const seqLines = body.filter((l) => l.kind === "stmt" || l.kind === "loop");

  let txBody: string;
  if (seqLines.length > 0) {
    txBody = seqLines.map((l) => indentBlock(l.text, "      ")).join("\n");
  } else if (withClauses.length === 0 && exprLines.length === 0) {
    txBody = `      {:ok, :ok}`;
  } else {
    // Elixir's `with` must start with its first clause on the same line —
    // a bare `with` followed by clauses on subsequent lines parses each
    // clause as a standalone `<-` expression (invalid outside `with`),
    // which manifests as "syntax error before: do" at the chain tail.
    const allLines = [...exprLines, ...withClauses];
    const trimmed = allLines.map((l) => l.text.trimStart());
    const indent = "      ";
    const cont = `${indent}     `;
    const firstLine = `${indent}with ${trimmed[0]}`;
    const restLines = trimmed.slice(1).map((t) => `${cont}${t}`);
    const withBody = [firstLine, ...restLines].join(",\n");
    txBody = `${withBody} do\n${indent}  {:ok, ${returnVal}}\n${indent}end`;
  }

  const emitSection =
    emitLines.length > 0 ? "\n" + emitLines.map((l) => "    " + l.text.trimStart()).join("\n") : "";

  // isolation_level is an opts keyword in Ash 3.x (third positional arg).
  const isolationOptLine = effectiveIsolation
    ? `,\n      isolation_level: :${elixirIsolationLevel(effectiveIsolation)}`
    : "";

  // `workflow_completed` fires only on the {:ok, _} branch — failures
  // (precondition / with-mismatch / DB error) propagate untouched.
  const completedCall = renderPhoenixLogCall("workflowCompleted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
  ]);

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
    case result do
      {:ok, _} ->
        ${completedCall}
        result
      _ ->
        result
    end`;
}

function renderSequentialBody(lines: WorkflowBodyLine[], wf: WorkflowIR): string {
  // `workflow_completed` fires inside the with-chain's do-branch (so
  // failures short-circuit untouched) or just before the bare `:ok`
  // when the workflow body is empty.
  const completedCall = renderPhoenixLogCall("workflowCompleted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
  ]);

  if (lines.length === 0) return `    ${completedCall}\n    :ok`;

  const preconds = lines.filter((l) => l.kind === "precondition" || l.kind === "requires");
  const body = lines.filter((l) => l.kind !== "precondition" && l.kind !== "requires");

  const precondSection = preconds.map((l) => l.text).join("\n");

  const withClauses = body.filter((l) => l.kind === "with-clause");
  const emitLines = body.filter((l) => l.kind === "emit");
  const exprLines = body.filter((l) => l.kind === "expr");
  const seqLines = body.filter((l) => l.kind === "stmt" || l.kind === "loop");

  const lastBind = [...body].reverse().find((l) => l.bindName);
  const returnVal = lastBind?.bindName ?? ":ok";

  let bodySection: string;
  if (seqLines.length > 0) {
    // Ordered sequence: stmt binds then the loop's reduce_while as the
    // terminal expression.  The completed-log fires before the loop runs
    // (a loop failure returns its own {:error,_}; success falls through).
    bodySection = [`    ${completedCall}`, ...seqLines.map((l) => l.text)].join("\n");
  } else if (withClauses.length === 0 && exprLines.length === 0) {
    bodySection = `    ${completedCall}\n    :ok`;
  } else {
    // See renderTransactionalBody — `with` must hug its first clause.
    const allLines = [...exprLines, ...withClauses];
    const trimmed = allLines.map((l) => l.text.trimStart());
    const indent = "    ";
    const cont = `${indent}     `;
    const firstLine = `${indent}with ${trimmed[0]}`;
    const restLines = trimmed.slice(1).map((t) => `${cont}${t}`);
    const withBody = [firstLine, ...restLines].join(",\n");
    bodySection = `${withBody} do\n${indent}  ${completedCall}\n${indent}  {:ok, ${returnVal}}\n${indent}end`;
  }

  const emitSection =
    emitLines.length > 0 ? "\n" + emitLines.map((l) => "    " + l.text.trimStart()).join("\n") : "";

  return `${precondSection ? precondSection + "\n" : ""}${bodySection}${emitSection}`;
}

/** Re-indent a multi-line block (whose lines start at 4-space base) to a
 *  new base indent — used to lift sequenced stmt/loop bodies into the
 *  transaction's `fn -> … end` (6-space) without disturbing their
 *  internal relative indentation. */
function indentBlock(text: string, base: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length === 0) return line;
      const stripped = line.replace(/^ {4}/, "");
      return `${base}${stripped}`;
    })
    .join("\n");
}

function elixirIsolationLevel(level: import("../../ir/types/loom-ir.js").IsolationLevel): string {
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
