// ---------------------------------------------------------------------------
// Vanilla workflow execution emit — `lib/<app>/<ctx>/workflows/<wf>.ex` +
// `lib/<app>_web/controllers/workflows_controller.ex`.  Slice 5c of
// vanilla-foundation-tdd-plan.md.
//
// Workflows are plain Elixir modules.  A workflow becomes a module with
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
//   ✓ repo-let     → `{:ok, <name>} <- Context.get_<agg>(id)` (getById)
//                    OR `{:ok, <name>} <- Context.<find>_<agg>(args...)`
//                    (custom find via the per-find defdelegate emitted by
//                    `context-emit.ts` → `repository-emit.ts:renderFindFn`)
//   ✓ emit         → `Phoenix.PubSub.broadcast(App.PubSub, "events",
//                     %App.Ctx.Events.<Name>{...})` — rendered INSIDE the
//                    with-chain's do-branch so a failed precondition / op
//                    short-circuits and the broadcast is skipped.  The
//                    `Events.<Name>` struct module is emitted by the
//                    orchestrator's `emitVanillaEventModules` hook.
//   ✓ resource-call → `_ = <App>.Resources.<Type>.<res>_<verb>(args)` —
//                     bare side-effect call (Phase 4), rendered INSIDE
//                     the with-chain's do-branch like `emit`.  The
//                     adapter helper modules are emitted by the
//                     orchestrator's `emitPhoenixResourceFiles` reuse.
//   ✓ repo-run     → `{:ok, <name>} <- Context.run_<ret>_<agg>(args..., limit:, offset:)`
//                     against the per-context retrieval defdelegate (the
//                     vanilla retrieval `run/N` returns `{:ok, [_]}`).
//                     Pagination opts ride as a trailing keyword list.
//   ✓ for-each     → `{:ok, _} <- Enum.reduce_while(xs, {:ok, nil}, fn x, _acc ->
//                                    case Context.<op>_<agg>(x, %{}) do ... end
//                                  end)` — first body-op failure halts the
//                     reduce and bubbles `{:error, _}` up the with-chain.  A
//                     single op-call keeps the flat `case` shape; a broader
//                     body (op-call + factory-let / emit / expr-let / guards)
//                     lowers through a per-iteration `with`-chain whose first
//                     failed clause halts the reduce.
//   ✓ if-let       → `{:ok, _} <- (var = case ...run_<ret>...; if var != nil
//                     do <thenBody> else <elseBody> end)`.  Both branches lower
//                     the full statement set (op-call / factory-let / emit /
//                     expr-let; a guard-bearing branch wraps in a `with`-chain
//                     so a failed `precondition` / `requires` threads `{:error,
//                     tag}` up the outer with-chain).
// Every WorkflowStmtIR kind now lowers to real Elixir — there is no
// `default:` / `# TODO` fallthrough remaining.  The switch over
// `lowerStatement` is exhaustive over the IR union; if a new kind is
// added to `WorkflowStmtIR`, TypeScript fails compile until a matching
// arm is added here AND in `collectWorkflowStmtParamRefs`.
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
  type IsolationLevel,
  type OperationIR,
  operationUsesCurrentUser,
  type StmtIR,
  type SystemIR,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowEmitsCommandRoute,
  workflowUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import type { OriginRef } from "../../../ir/types/origin.js";
import { classifyDomainServiceTier } from "../../../ir/util/domain-service-tier.js";
import { resolveWorkflowIsolation } from "../../../ir/util/resolve-datasource.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { lineCount, type SourceMapRecorder } from "../../_trace/sourcemap.js";
import type { ApiRoute } from "../api-emit.js";
import { inlineMutatingServiceCall } from "../domain-service-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { renderFunctionBodyLines } from "./function-emit.js";

export interface VanillaWorkflowExecResult {
  routes: ApiRoute[];
  /** This context's command-triggered workflows (those that emit a POST
   *  `/workflows/<name>` route).  Collected project-wide by the orchestrator so
   *  the single deployable-level `WorkflowsController` can aggregate every hosted
   *  context's actions — the HTTP surface is per-DEPLOYABLE, not per-context, so
   *  a deployable serving N contexts must emit ONE controller (writing one
   *  `workflows_controller.ex` per context to a fixed path clobbers all but the
   *  last).  Empty when the context has no command workflows. */
  commandWorkflows: WorkflowIR[];
}

export function emitVanillaWorkflowExecution(
  _appName: string,
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  resourceModules: Map<string, string> = new Map(),
  sys?: SystemIR,
  sourcemap?: SourceMapRecorder,
): VanillaWorkflowExecResult {
  if (ctx.workflows.length === 0) return { routes: [], commandWorkflows: [] };

  const ctxModule = upperFirst(ctx.name);
  const ctxSnake = snake(ctx.name);
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  const routes: ApiRoute[] = [];

  const commandWorkflows = ctx.workflows.filter(workflowEmitsCommandRoute);
  if (commandWorkflows.length === 0) return { routes: [], commandWorkflows: [] };

  // Per-workflow `run/1` modules are context-namespaced
  // (`<App>.<Ctx>.Workflows.<Wf>`), so they never collide across contexts.  The
  // single `WorkflowsController` that fronts them is a DEPLOYABLE-level artifact,
  // though — emitted ONCE by the orchestrator (`emitVanillaWorkflowsController`)
  // over every hosted context's `commandWorkflows`, so a multi-context deployable
  // gets one controller with all actions rather than per-context overwrites.
  for (const wf of commandWorkflows) {
    const wfSnake = snake(wf.name);
    const path = `lib/${appSnake}/${ctxSnake}/workflows/${wfSnake}.ex`;
    const { content, statementRegions } = renderWorkflowModule(
      appModule,
      ctxModule,
      wf,
      resourceModules,
      ctx,
      sys,
      !!sourcemap,
    );
    out.set(path, content);
    const construct = `${ctx.name}.${wf.name}`;
    sourcemap?.file(path, content, wf.origin, construct);
    // M13 — one independent `fragment()` anchor per top-level statement (see
    // `WorkflowModuleResult.statementRegions`); `undefined` origins were
    // already filtered out by `renderWorkflowModule`.
    for (const r of statementRegions) {
      sourcemap?.fragment(path, content, r.text, [
        { rel: [1, lineCount(r.text)], origin: r.origin, construct },
      ]);
    }
  }

  for (const wf of commandWorkflows) {
    routes.push({
      method: "post",
      path: `/workflows/${snake(wf.name)}`,
      controller: "WorkflowsController",
      action: `:${snake(wf.name)}`,
    });
  }

  return { routes, commandWorkflows };
}

/** One context's command workflows, paired with the context (for resolving the
 *  per-workflow module FQ name + the `currentUser` threading decision). */
export interface WorkflowControllerGroup {
  ctx: BoundedContextIR;
  workflows: WorkflowIR[];
}

/** Emit the single deployable-level `WorkflowsController` aggregating the command
 *  workflows of every context the deployable hosts.  Called ONCE by the
 *  orchestrator after the per-context loop (the sibling of
 *  `emitVanillaViewsController`).  No-op when no context has a command workflow. */
export function emitVanillaWorkflowsController(
  appName: string,
  appModule: string,
  groups: WorkflowControllerGroup[],
  out: Map<string, string>,
): void {
  const nonEmpty = groups.filter((g) => g.workflows.length > 0);
  if (nonEmpty.length === 0) return;
  out.set(
    `lib/${appName}_web/controllers/workflows_controller.ex`,
    renderWorkflowsController(appModule, nonEmpty),
  );
}

// ---------------------------------------------------------------------------
// Body lowering — per-WorkflowStmtIR-kind translation to plain Elixir.
// ---------------------------------------------------------------------------

export interface BodyLine {
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
  /** M13 — the source `WorkflowStmtIR` this line was lowered from (stamped
   *  by `lowerStatements`, not the individual `lowerStatement` arms).  A
   *  `for-each`/`if-let` blob lowers to ONE `BodyLine` whose `text` embeds
   *  its nested statements' own rendering — it keeps only the OUTER
   *  statement's origin (nested per-statement granularity is out of scope,
   *  the same contract the reactor/dispatch `renderWorkflowStmtChunks`
   *  sibling uses).  A `domain-service-call` that expands to several
   *  with-clauses stamps every clause with the SAME origin (one source
   *  statement, several rendered lines). */
  origin?: OriginRef;
}

export function lowerStatements(
  stmts: WorkflowStmtIR[],
  contextModule: string,
  renderCtx: RenderCtx,
  ctx?: BoundedContextIR,
): BodyLine[] {
  const lines: BodyLine[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i]!;
    // M-T6.21 — pass the downstream statements so a `let` binding no later
    // statement references can be `_`-prefixed; an unread real-named bind trips
    // `mix compile --warnings-as-errors` (the same move the for-each / if-let
    // body binds already make via `bindUsedLater`).
    for (const line of lowerStatement(st, contextModule, renderCtx, ctx, stmts.slice(i + 1))) {
      lines.push({ ...line, origin: st.origin });
    }
  }
  return lines;
}

function lowerStatement(
  st: WorkflowStmtIR,
  contextModule: string,
  renderCtx: RenderCtx,
  ctx?: BoundedContextIR,
  rest: WorkflowStmtIR[] = [],
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
      // A `currentUser`-gated op takes a trailing `current_user` arg —
      // `opCallSource` threads the in-scope binding when `ctx` resolves it.
      const call = opCallSource(st, renderCtx, contextModule, ctx);
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
      // aggregate-shaped value) wins the `{:ok, <last>}` result slot — which
      // also means underscoring an unused binding can never change the
      // workflow's return value.  M-T6.21: a binding no later statement reads
      // (e.g. `let label = match … { … }` with no following use) is
      // `_`-prefixed so `mix compile --warnings-as-errors` stays clean; the
      // expression is still evaluated, only the binding is discarded.
      const expr = renderExpr(st.expr, renderCtx);
      const bind = bindUsedLater(st.name, rest) ? snake(st.name) : `_${snake(st.name)}`;
      return [
        {
          kind: "with-clause",
          text: `${bind} <- (${expr})`,
          bindName: undefined,
        },
      ];
    }

    case "assign": {
      // `field := value` — own-state mutation in a vanilla command-triggered
      // workflow body.  Rebind the immutable workflow `state` struct via a
      // struct update; a with-clause binding always succeeds.  (Event-triggered
      // correlation sagas persist the row in `dispatch-emit.ts`.)
      const value = renderExpr(st.value, renderCtx);
      const field = snake(st.target.segments[0]!);
      return [
        {
          kind: "with-clause",
          text: `state <- (%{state | ${field}: ${value}})`,
          bindName: "state",
        },
      ];
    }

    case "repo-let": {
      // Two shapes, both lowering to a with-clause:
      //
      //   `let wallet = Wallets.getById(walletId)` →
      //     `{:ok, wallet} <- Context.get_wallet(wallet_id)`
      //
      //   `let c = Customers.byEmail(needle)` (custom find) →
      //     `{:ok, c} <- Context.by_email_customer(needle)`
      //
      // The `getById` finder maps to the context's `get_<agg>/1` (find_by_id)
      // facade.  Custom finds map to the per-find defdelegate emitted by
      // `context-emit.ts` (see `customFindsOf`), which routes to the
      // matching `def <find>` in the repository module.
      const argList = st.args.map((a) => renderExpr(a, renderCtx)).join(", ");
      const action =
        st.method === "getById"
          ? `get_${snake(st.aggName)}`
          : `${snake(st.method)}_${snake(st.aggName)}`;
      const call = `${contextModule}.${action}(${argList})`;
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
      // (a separate "after-commit" hook is out of scope for this slice).
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

    case "resource-call": {
      // `files.put(k, v)` (bare statement form, Phase 4) →
      // `<App>.Resources.<ResourceType>.<resource>_<verb>(args)`.
      // The expression renderer routes the call through `resourceModules`
      // (threaded into renderCtx by the orchestrator).  A bare resource-op
      // returns the adapter's raw result — most are `:ok | {:error, _}`
      // shapes; we wrap as a fire-and-forget side-effect line (no with-clause
      // binding) since the statement form discards the result anyway.
      //
      // Lives in the with-chain's `do`-branch (`kind = "emit"`) so a
      // preceding rollback skips the side effect — matches the emit
      // semantics (skipped on with-chain failure).  The validator
      // (loom.workflow-tx-effect) keeps a transactional workflow from
      // mixing resource calls with DB ops, so the in-tx broadcast caveat
      // doesn't apply here.
      return [
        {
          kind: "emit",
          text: `_ = ${renderExpr(st.call, renderCtx)}`,
        },
      ];
    }

    case "domain-service-call": {
      // `Transfer.run(s, d, amount)` — a bare orchestrator call into a
      // `mutating` `domainService` (domain-services.md rev. 4, Slice 3).  On
      // Elixir a mutating service is pure SUGAR for the `with`-chain of its
      // body's param-op calls, each routed through its aggregate's context
      // mutating fn (changeset + `Repo.update` via `persist_change`) — there is
      // no separate service unit (sim §2.5).  The atomic, persisted commit is
      // the workflow's existing `Repo.transaction`; each clause rebinds the
      // mutated arg to the struct the context fn returns (immutable-struct
      // threading).  The clauses are byte-identical to an INLINE `s.withdraw(…)`
      // op-call — the mutating service IS the inline form expanded.
      const clauses = resolveInlinedServiceClauses(st, renderCtx, contextModule, ctx);
      if (clauses.length > 0) {
        return clauses.map((c) => ({
          kind: "with-clause",
          text: c.text,
          bindName: c.bindName,
        }));
      }
      // No resolvable mutating shape (legacy/test path with no ctx index, or a
      // service whose body the classifier can't read) — keep the sound
      // side-effect line so generation never crashes.
      return [
        {
          kind: "emit",
          text: `_ = ${renderExpr(st.call, renderCtx)}`,
        },
      ];
    }

    case "repo-run": {
      // `let xs = Repo.run(<Retrieval>(args), page?)` →
      // `{:ok, xs} <- Context.run_<ret>_<agg>(args..., limit: N, offset: M)`.
      // The vanilla retrieval `run/N` returns `{:ok, [aggregate]}` (a bare
      // list, no page struct), so the bind is consumed directly by
      // a subsequent `for-each`.  Pagination opts (`page: { offset: O, limit: L }`)
      // ride as a trailing keyword list, which Elixir parses positionally
      // into the retrieval's `opts \\ []` arg.
      const args = st.retrievalArgs.map((a) => renderExpr(a, renderCtx));
      // An `ignoring` clause on the inline read rides as trailing keyword opts
      // the retrieval module gates each capability `where` stage on: `ignoring *`
      // → `ignore_all_filters: true`; `ignoring <Cap>` → `ignore_filters: [...]`
      // (the bypassed capability NAMES, which key the retrieval's per-origin gate).
      const optEntries: string[] = [];
      if (st.page) {
        if (st.page.offset) optEntries.push(`offset: ${renderExpr(st.page.offset, renderCtx)}`);
        if (st.page.limit) optEntries.push(`limit: ${renderExpr(st.page.limit, renderCtx)}`);
      }
      if (st.bypassAll) {
        optEntries.push("ignore_all_filters: true");
      } else if ((st.bypassCaps?.length ?? 0) > 0) {
        optEntries.push(
          `ignore_filters: [${st.bypassCaps!.map((c) => JSON.stringify(c)).join(", ")}]`,
        );
      }
      if (optEntries.length > 0) args.push(optEntries.join(", "));
      const action = `run_${snake(st.retrievalName)}_${snake(st.aggName)}`;
      const call = `${contextModule}.${action}(${args.join(", ")})`;
      return [
        {
          kind: "with-clause",
          text: `{:ok, ${snake(st.name)}} <- ${call}`,
          bindName: snake(st.name),
        },
      ];
    }

    case "repo-delete": {
      // `Orders.delete(o)` →
      // `{:ok, _} <- Context.delete_order(o)`
      // The vanilla context's `delete_<agg>/1` delegate (emitted only when the
      // aggregate exposes a REST delete surface — the SAME `emitsRestDelete`
      // gate the scaffold's `canonicalDestroy` condition satisfies) fronts the
      // repository's `delete/1`, which takes the aggregate STRUCT and returns
      // `{:ok, struct} | {:error, changeset}`.  Discard the returned struct
      // (mirrors the op-call `{:ok, _}` shape); a failure threads `{:error, _}`
      // up the with-chain so a transactional workflow rolls back.
      const action = `delete_${snake(st.aggName)}`;
      const call = `${contextModule}.${action}(${renderExpr(st.entity, renderCtx)})`;
      return [
        {
          kind: "with-clause",
          text: `{:ok, _} <- ${call}`,
          bindName: undefined,
        },
      ];
    }

    case "for-each": {
      // `for x in xs { <body> }` →
      // `{:ok, _} <- Enum.reduce_while(xs, {:ok, nil}, fn x, _acc -> ... end)`.
      // Each body statement is rendered as a `case ... do` block returning
      // `{:cont, _}` on success / `{:halt, err}` on failure — the
      // reduce_while bubbles the first error up the with-chain, so a failed
      // op short-circuits the whole workflow and a transactional wrapper
      // rolls back.  The iterable is rendered through `renderExpr` (typically
      // a bare ref to a preceding `repo-run` binding — the validator
      // `loom.workflow-foreach-source` enforces this shape).
      const iterable = renderExpr(st.iterable, renderCtx);
      // Underscore an unread loop var so `--warnings-as-errors` stays clean when
      // the body iterates for effect without naming the row (e.g. a nested
      // find/loop keyed off a workflow param rather than the element).
      const loopVar = bindUsedLater(st.var, st.body) ? snake(st.var) : `_${snake(st.var)}`;
      const bodyLines = renderLoopBody(st.body, renderCtx, contextModule, ctx);
      // Multi-line clause: assembleBody indents the FIRST line at the
      // with-chain's column; subsequent lines keep their authored
      // indentation, so bake in the leading spaces (11 spaces aligns each
      // body line under the `Enum.reduce_while(...` opener).
      const lines = [
        `{:ok, _} <- Enum.reduce_while(${iterable}, {:ok, nil}, fn ${loopVar}, _acc ->`,
        ...bodyLines.map((l) => `           ${l}`),
        `         end)`,
      ];
      return [
        {
          kind: "with-clause",
          text: lines.join("\n"),
          bindName: undefined,
        },
      ];
    }

    case "if-let": {
      // `if let o = Repo.find(<Criterion>) { … } else { … }` → a with-clause
      // wrapping a parenthesized block: run the shared `run_<ret>_<agg>`
      // retrieval capped at `limit: 1`, match its `{:ok, [head | _]}` to a
      // head-or-nil, then `if` over the two branches.  Each branch ends in
      // `{:ok, _}` so the enclosing `{:ok, _} <-` clause threads through the
      // with-chain (a raised create/op rolls the transaction back).
      const action = `run_${snake(st.retrievalName)}_${snake(st.aggName)}`;
      const runArgs = [...st.retrievalArgs.map((a) => renderExpr(a, renderCtx)), "limit: 1"];
      const v = snake(st.var);
      const renderBranch = (body: WorkflowStmtIR[], present: string): string[] => {
        // A branch needs a `with`-chain when it holds a fallible statement that
        // must short-circuit to `{:error, tag}` (so it threads up the outer
        // with-chain): a guard (`precondition` / `requires`) OR nested control
        // flow / repo binds (`for-each` / `if-let` / `repo-run` / `repo-let`).
        // A branch of only flat side-effects keeps the sequential `=`-bind form.
        const needsWith = body.some(
          (s) =>
            s.kind === "precondition" || s.kind === "requires" || NESTED_FLOW_KINDS.has(s.kind),
        );
        if (needsWith) {
          const clauses: string[] = [];
          const tail: string[] = [];
          for (let i = 0; i < body.length; i++) {
            const inner = body[i]!;
            const rest = body.slice(i + 1);
            if (inner.kind === "precondition") {
              clauses.push(
                `:ok <- (if ${renderExpr(inner.expr, renderCtx)}, do: :ok, else: {:error, :precondition_failed})`,
              );
            } else if (inner.kind === "requires") {
              clauses.push(
                `:ok <- (if ${renderExpr(inner.expr, renderCtx)}, do: :ok, else: {:error, :forbidden})`,
              );
            } else if (inner.kind === "op-call") {
              clauses.push(`{:ok, _} <- ${opCallSource(inner, renderCtx, contextModule, ctx)}`);
            } else if (inner.kind === "factory-let") {
              const fields = inner.fields
                .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
                .join(", ");
              const bind = bindUsedLater(inner.name, rest) ? snake(inner.name) : "_";
              clauses.push(
                `{:ok, ${bind}} <- ${contextModule}.create_${snake(inner.aggName)}(%{${fields}})`,
              );
            } else if (inner.kind === "expr-let") {
              const bind = bindUsedLater(inner.name, rest) ? snake(inner.name) : "_";
              clauses.push(`${bind} <- (${renderExpr(inner.expr, renderCtx)})`);
            } else if (NESTED_FLOW_KINDS.has(inner.kind)) {
              // Nested loop / if-let / repo bind — reuse `lowerStatement` so it
              // lowers to a `<-` clause that threads {:error, _} up this branch.
              pushNestedFlow(inner, contextModule, renderCtx, clauses, tail, ctx);
            } else {
              // emit / resource-call — pure side-effects, run in the do-branch.
              tail.push(...renderBranchStmt(inner, renderCtx, contextModule, [], ctx));
            }
          }
          return [
            `with ${clauses.join(",\n                  ")} do`,
            ...tail.map((l) => `  ${l}`),
            `  {:ok, ${present}}`,
            `else`,
            `  err -> err`,
            `end`,
          ];
        }
        const stmtLines = body.flatMap((inner, i) =>
          renderBranchStmt(inner, renderCtx, contextModule, body.slice(i + 1), ctx),
        );
        return [...stmtLines, `{:ok, ${present}}`];
      };
      const lines = [
        `{:ok, _} <- (`,
        `           ${v} = case ${contextModule}.${action}(${runArgs.join(", ")}) do`,
        `             {:ok, [hit | _]} -> hit`,
        `             _ -> nil`,
        `           end`,
        `           if ${v} != nil do`,
        ...renderBranch(st.thenBody, v).map((l) => `             ${l}`),
        `           else`,
        ...renderBranch(st.elseBody ?? [], "nil").map((l) => `             ${l}`),
        `           end`,
        `         )`,
      ];
      return [{ kind: "with-clause", text: lines.join("\n"), bindName: undefined }];
    }
  }
}

/** A single op-call as the threaded `op_<agg>(target, %{...})` call source.
 *  When the called operation's guard/body references `currentUser`, the
 *  context function carries a trailing `current_user \\ nil` arity (emitted by
 *  `context-emit.ts` / `operation-returns-emit.ts`); thread the workflow's
 *  in-scope `current_user` binding through so the op guard resolves at runtime
 *  rather than raising on an unbound `current_user`.  `ctx` is undefined only on
 *  legacy/test call paths with no aggregate index — then no actor is threaded
 *  (byte-identical to the pre-fix output). */
function opCallSource(
  st: Extract<WorkflowStmtIR, { kind: "op-call" }>,
  renderCtx: RenderCtx,
  contextModule: string,
  ctx?: BoundedContextIR,
): string {
  const argTexts = st.args.map((arg) => renderExpr(arg, renderCtx));
  const op = ctx ? lookupOp(ctx, st.aggName, st.op) : undefined;
  const argFields = opCallParamFields(argTexts, op, `${st.aggName}.${st.op}`);
  const actor = ctx && opCallThreadsUser(st, ctx) ? ", current_user" : "";
  return `${contextModule}.${snake(st.op)}_${snake(st.aggName)}(${snake(st.target)}, %{${argFields}}${actor})`;
}

/** Resolve a `mutating` `domain-service-call` to its inlined with-clauses
 *  (domain-services.md rev. 4, Slice 3).  Looks the service op up in `ctx`,
 *  then delegates to `inlineMutatingServiceCall`, which expands the body's
 *  param-op calls into context mutating-fn with-clauses.  Returns `[]` when
 *  `ctx` is absent (legacy/test path) or the op isn't resolvable/mutating — the
 *  caller then keeps the sound side-effect fallback. */
function resolveInlinedServiceClauses(
  st: Extract<WorkflowStmtIR, { kind: "domain-service-call" }>,
  renderCtx: RenderCtx,
  contextModule: string,
  ctx?: BoundedContextIR,
): { text: string; bindName?: string }[] {
  if (!ctx) return [];
  const svc = (ctx.domainServices ?? []).find((s) => s.name === st.service);
  const op = svc?.operations.find((o) => o.name === st.op);
  if (!op) return [];
  const callArgs = st.call.kind === "call" ? st.call.args : [];
  return inlineMutatingServiceCall(op, callArgs, ctx, contextModule, (e) =>
    renderExpr(e, renderCtx),
  );
}

/** Look up an operation by aggregate + op name in the context's aggregate
 *  index — mirrors the Hono workflow builder's `lookupOp`. */
export function lookupOp(
  ctx: BoundedContextIR,
  aggName: string,
  opName: string,
): OperationIR | undefined {
  const agg = ctx.aggregates.find((a) => a.name === aggName);
  return agg?.operations.find((o) => o.name === opName);
}

/** Render the `params`-map fields for an `op-call` keyed by the called
 *  operation's REAL parameter names as STRING keys (`"label" => value`).  The
 *  context-facade op function reads them with `Map.get(params, "<name>")`
 *  (`context-emit.ts` / `domain-core-emit.ts` / `operation-returns-emit.ts`), so
 *  positional atom keys (`arg0:`) would silently resolve to `nil` (the BUG-2
 *  regression).  The op MUST be resolved — every real op-call targets a
 *  validated operation in the threaded context, so an unresolved op is a
 *  generator invariant violation, not a tolerable fallback: fail loudly with
 *  the offending name rather than re-emit positional keys.  `label` is the
 *  `<Agg>.<op>` the call targets, for the error message. */
export function opCallParamFields(
  argTexts: string[],
  op: OperationIR | undefined,
  label: string,
): string {
  // No args ⇒ `%{}`; the op need not resolve since there is nothing to key.
  if (argTexts.length === 0) return "";
  if (!op) {
    throw new Error(
      `elixir op-call to unresolved operation '${label}': cannot key the params map by ` +
        `parameter name (positional keys would mis-resolve in the op facade). This is a ` +
        `generator bug — the op-call should reference a validated aggregate operation.`,
    );
  }
  return argTexts.map((t, i) => `${JSON.stringify(op.params[i]!.name)} => ${t}`).join(", ");
}

/** Resolve the tier of a `domainService.<op>` referenced in a workflow body
 *  (domain-services.md rev. 4).  Threaded onto the workflow render context so a
 *  `reading` service call renders as a context fn (decision B); a `pure` call
 *  (or an unresolvable ref) keeps the `Domain.Services` module shape. */
function lookupServiceTier(
  ctx: BoundedContextIR,
  service: string,
  opName: string,
): "pure" | "reading" | "mutating" | undefined {
  const svc = (ctx.domainServices ?? []).find((s) => s.name === service);
  const op = svc?.operations.find((o) => o.name === opName);
  return op ? classifyDomainServiceTier(op) : undefined;
}

/** True when this op-call targets a `currentUser`-gated operation — its context
 *  function takes the trailing `current_user` arg, so the call must pass it. */
function opCallThreadsUser(
  st: Extract<WorkflowStmtIR, { kind: "op-call" }>,
  ctx: BoundedContextIR,
): boolean {
  const op = lookupOp(ctx, st.aggName, st.op);
  return !!op && operationUsesCurrentUser(op);
}

/** True when the workflow body itself names `currentUser`, OR it calls a
 *  `currentUser`-gated operation (whose context fn takes the trailing actor).
 *  Either way the workflow function must thread `current_user \\ nil` so the
 *  binding is in scope for the rendered guard / op-call.  Recurses into
 *  `for-each` / `if-let` bodies. */
function workflowNeedsCurrentUser(wf: WorkflowIR, ctx: BoundedContextIR): boolean {
  return workflowUsesCurrentUser(wf) || stmtsCallUserGatedOp(wf.statements, ctx);
}

function stmtsCallUserGatedOp(sts: WorkflowStmtIR[], ctx: BoundedContextIR): boolean {
  return sts.some((s) => {
    if (s.kind === "op-call") return opCallThreadsUser(s, ctx);
    if (s.kind === "for-each") return stmtsCallUserGatedOp(s.body, ctx);
    if (s.kind === "if-let")
      return stmtsCallUserGatedOp(s.thenBody, ctx) || stmtsCallUserGatedOp(s.elseBody ?? [], ctx);
    return false;
  });
}

/** Statement kinds that are themselves fallible control flow / repo binds —
 *  inside a `for-each` body or an `if-let` branch they lower (via the shared
 *  `lowerStatement`) to a `<-` with-clause that threads `{:error, _}`, so they
 *  must sit in a `with`-chain rather than the flat sequential form. */
const NESTED_FLOW_KINDS: ReadonlySet<WorkflowStmtIR["kind"]> = new Set([
  "for-each",
  "if-let",
  "repo-run",
  "repo-let",
  "repo-delete",
]);

/** Lower a nested control-flow / repo-bind statement that appears inside a
 *  `for-each` body or an `if-let` branch by reusing the top-level
 *  `lowerStatement` dispatch.  Each produced `with-clause` BodyLine becomes a
 *  `<-` clause in the surrounding with-chain (so a nested loop/branch failure
 *  short-circuits the same way a flat op does); `emit` / `resource-call`
 *  side-effects land in the enclosing `do`-branch.  Returns the last bound
 *  name (if any), so a loop body can thread it out as `{:cont, {:ok, <name>}}`. */
function pushNestedFlow(
  inner: WorkflowStmtIR,
  contextModule: string,
  renderCtx: RenderCtx,
  clauses: string[],
  sideEffects: string[],
  ctx?: BoundedContextIR,
): string | undefined {
  let bind: string | undefined;
  for (const bl of lowerStatement(inner, contextModule, renderCtx, ctx)) {
    if (bl.kind === "with-clause") {
      clauses.push(bl.text);
      if (bl.bindName) bind = bl.bindName;
    } else {
      sideEffects.push(bl.text);
    }
  }
  return bind;
}

/** Render the body of a `for <var> in xs` loop as the inner Elixir lines of
 *  the `Enum.reduce_while(...)` callback (which must return `{:cont, _}` on
 *  success / `{:halt, err}` on first failure).
 *
 *  The common single-`op-call` body keeps the flat `case ... do {:cont}/{:halt}`
 *  shape.  A broader body (mixing op-calls with `factory-let` / `emit` /
 *  `expr-let` / guards) is lowered through a per-iteration `with`-chain: every
 *  fallible statement (op-calls, factory-lets, guards) becomes a `<-` clause so
 *  the first failure short-circuits to `{:halt, err}`; `emit` / `expr-let`
 *  side-effects render inside the `do`-branch before `{:cont, {:ok, _}}`. */
function renderLoopBody(
  body: WorkflowStmtIR[],
  renderCtx: RenderCtx,
  contextModule: string,
  ctx?: BoundedContextIR,
): string[] {
  // Fast path: a lone op-call keeps the original byte-for-byte shape.
  if (body.length === 1 && body[0]!.kind === "op-call") {
    return [
      `case ${opCallSource(body[0]!, renderCtx, contextModule, ctx)} do`,
      `  {:ok, updated} -> {:cont, {:ok, updated}}`,
      `  err -> {:halt, err}`,
      `end`,
    ];
  }
  if (body.length === 0) {
    // Empty loop body — iterate for the side effect of paging only.
    return ["{:cont, {:ok, nil}}"];
  }

  // General path: a per-iteration with-chain.  Fallible statements become
  // `<-` clauses; pure side-effects (emit / resource-call) render in the
  // do-branch; the last bound name is threaded out as `{:cont, {:ok, <last>}}`.
  const clauses: string[] = [];
  const doLines: string[] = [];
  let lastBind = "nil";
  for (let i = 0; i < body.length; i++) {
    const inner = body[i]!;
    const rest = body.slice(i + 1);
    switch (inner.kind) {
      case "op-call": {
        lastBind = "loop_updated";
        clauses.push(`{:ok, ${lastBind}} <- ${opCallSource(inner, renderCtx, contextModule, ctx)}`);
        break;
      }
      case "factory-let": {
        const fields = inner.fields
          .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
          .join(", ");
        // The new aggregate is the iteration result only when nothing reads it
        // later; otherwise keep the real name and thread it out.
        lastBind = snake(inner.name);
        const bind = bindUsedLater(inner.name, rest) ? lastBind : "_";
        clauses.push(
          `{:ok, ${bind}} <- ${contextModule}.create_${snake(inner.aggName)}(%{${fields}})`,
        );
        if (bind === "_") lastBind = "nil";
        break;
      }
      case "precondition":
        clauses.push(
          `:ok <- (if ${renderExpr(inner.expr, renderCtx)}, do: :ok, else: {:error, :precondition_failed})`,
        );
        break;
      case "requires":
        clauses.push(
          `:ok <- (if ${renderExpr(inner.expr, renderCtx)}, do: :ok, else: {:error, :forbidden})`,
        );
        break;
      case "expr-let": {
        const bind = bindUsedLater(inner.name, rest) ? snake(inner.name) : "_";
        clauses.push(`${bind} <- (${renderExpr(inner.expr, renderCtx)})`);
        break;
      }
      case "emit": {
        const fields = inner.fields
          .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
          .join(", ");
        const appModule = contextModule.split(".")[0]!;
        doLines.push(
          `Phoenix.PubSub.broadcast(${appModule}.PubSub, "events", %${contextModule}.Events.${upperFirst(inner.eventName)}{${fields}})`,
        );
        break;
      }
      case "domain-service-call": {
        // A `mutating` domain-service call inside a loop body — inline the same
        // with-chain of context mutating-fn clauses the top-level arm emits, so
        // each mutated arg persists (and a failed clause halts the reduce).
        // Falls back to the sound side-effect line when unresolvable.
        const inlined = resolveInlinedServiceClauses(inner, renderCtx, contextModule, ctx);
        if (inlined.length > 0) {
          for (const c of inlined) clauses.push(c.text);
        } else {
          doLines.push(`_ = ${renderExpr(inner.call, renderCtx)}`);
        }
        break;
      }
      case "resource-call":
        doLines.push(`_ = ${renderExpr(inner.call, renderCtx)}`);
        break;
      case "assign": {
        // `field := value` — own-state mutation inside a loop body.  Rebind the
        // immutable workflow `state` struct via a struct update (vanilla command
        // path; persistence of correlation sagas is handled in dispatch-emit).
        lastBind = "state";
        doLines.push(
          `state = %{state | ${snake(inner.target.segments[0]!)}: ${renderExpr(inner.value, renderCtx)}}`,
        );
        break;
      }
      case "for-each":
      case "if-let":
      case "repo-run":
      case "repo-delete":
      case "repo-let": {
        // Nested control flow (a loop / if-let inside this loop body) and
        // repo binds reuse the top-level `lowerStatement` dispatch — which
        // already lowers each to a `<-` with-clause threading {:error, _}.
        // Slotting them as clauses in this iteration's with-chain means a
        // nested failure short-circuits to {:halt, err} just like a flat op.
        const b = pushNestedFlow(inner, contextModule, renderCtx, clauses, doLines, ctx);
        if (b) lastBind = b;
        break;
      }
      default: {
        // Exhaustive over WorkflowStmtIR — a new kind is a compile error here
        // rather than a silently-emitted `# TODO` into generated Elixir.
        const _never: never = inner;
        void _never;
        break;
      }
    }
  }

  if (clauses.length === 0) {
    // Pure side-effect body (emit / expr-let only) — no fallible clause to
    // gate on; run the side effects then continue.
    return [...doLines, `{:cont, {:ok, ${lastBind}}}`];
  }
  return [
    `with ${clauses.join(",\n     ")} do`,
    ...doLines.map((l) => `  ${l}`),
    `  {:cont, {:ok, ${lastBind}}}`,
    `else`,
    `  err -> {:halt, err}`,
    `end`,
  ];
}

/** Collect every `ref` name reachable from `e` (any refKind) into `acc`. */
function collectRefNames(e: ExprIR | undefined, acc: Set<string>): void {
  if (!e) return;
  switch (e.kind) {
    case "ref":
      acc.add(e.name);
      return;
    case "member":
      collectRefNames(e.receiver, acc);
      return;
    case "method-call":
      collectRefNames(e.receiver, acc);
      for (const a of e.args) collectRefNames(a, acc);
      return;
    case "call":
      for (const a of e.args) collectRefNames(a, acc);
      return;
    case "lambda":
      collectRefNames(e.body, acc);
      return;
    case "new":
    case "object":
      for (const f of e.fields) collectRefNames(f.value, acc);
      return;
    case "list":
      for (const el of e.elements) collectRefNames(el, acc);
      return;
    case "paren":
      collectRefNames(e.inner, acc);
      return;
    case "unary":
      collectRefNames(e.operand, acc);
      return;
    case "binary":
      collectRefNames(e.left, acc);
      collectRefNames(e.right, acc);
      return;
    case "ternary":
      collectRefNames(e.cond, acc);
      collectRefNames(e.then, acc);
      collectRefNames(e.otherwise, acc);
      return;
    case "convert":
      collectRefNames(e.value, acc);
      return;
    case "match":
      for (const arm of e.arms) {
        collectRefNames(arm.cond, acc);
        collectRefNames(arm.value, acc);
      }
      collectRefNames(e.otherwise, acc);
      return;
  }
}

/** Is `name` referenced by any statement in `rest`?  Used to decide whether a
 *  branch/loop `let`-bind needs its real name or can be `_`-discarded (an
 *  unread real-named bind trips `mix compile --warnings-as-errors`). */
function bindUsedLater(name: string, rest: WorkflowStmtIR[]): boolean {
  const refs = new Set<string>();
  for (const st of rest) collectWorkflowStmtParamRefsAll(st, refs);
  return refs.has(name);
}

/** Like `collectWorkflowStmtParamRefs` but collects ALL ref names (not just
 *  declared create-params) — feeds the unused-bind discard check. */
function collectWorkflowStmtParamRefsAll(st: WorkflowStmtIR, acc: Set<string>): void {
  switch (st.kind) {
    case "precondition":
    case "requires":
    case "expr-let":
      collectRefNames(st.expr, acc);
      return;
    case "factory-let":
    case "emit":
      for (const f of st.fields) collectRefNames(f.value, acc);
      return;
    case "op-call":
      acc.add(st.target);
      for (const a of st.args) collectRefNames(a, acc);
      return;
    case "repo-let":
      for (const a of st.args) collectRefNames(a, acc);
      return;
    case "repo-delete":
      collectRefNames(st.entity, acc);
      return;
    case "resource-call":
      collectRefNames(st.call, acc);
      return;
    case "domain-service-call":
      // `Transfer.run(a, b, q)` — its call args may reference an earlier
      // `let q = …`; without this the binding reads as unused and gets wrongly
      // `_`-prefixed, then the service call references an undefined variable.
      collectRefNames(st.call, acc);
      return;
    case "assign":
      // `total := q.amount` reads the binding `q`.
      collectRefNames(st.value, acc);
      return;
    case "repo-run":
      for (const a of st.retrievalArgs) collectRefNames(a, acc);
      return;
    case "for-each":
      collectRefNames(st.iterable, acc);
      for (const inner of st.body) collectWorkflowStmtParamRefsAll(inner, acc);
      return;
    case "if-let":
      for (const a of st.retrievalArgs) collectRefNames(a, acc);
      for (const inner of st.thenBody) collectWorkflowStmtParamRefsAll(inner, acc);
      for (const inner of st.elseBody ?? []) collectWorkflowStmtParamRefsAll(inner, acc);
      return;
  }
}

/** Render a single `if-let` branch statement (`thenBody` / `elseBody`) as the
 *  inner sequential Elixir lines.  `rest` is the statements that follow `st`
 *  in the same branch — used to `_`-discard an unread `let`-bind.  The branch
 *  ends in `{:ok, present}` (added by the caller) so the enclosing
 *  `{:ok, _} <-` clause threads through the with-chain.  Branch statements run
 *  sequentially with `=` binds (a raised error rolls the transaction back),
 *  covering the full statement set the validator admits inside an if-let
 *  branch: op-call / factory-let / emit / expr-let / resource-call (guards
 *  ride the with-chain path in `renderBranch`). */
function renderBranchStmt(
  st: WorkflowStmtIR,
  renderCtx: RenderCtx,
  contextModule: string,
  rest: WorkflowStmtIR[] = [],
  ctx?: BoundedContextIR,
): string[] {
  switch (st.kind) {
    case "op-call":
      return [opCallSource(st, renderCtx, contextModule, ctx)];
    case "factory-let": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const bind = bindUsedLater(st.name, rest) ? snake(st.name) : "_";
      return [`{:ok, ${bind}} = ${contextModule}.create_${snake(st.aggName)}(%{${fields}})`];
    }
    case "emit": {
      const fields = st.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      const appModule = contextModule.split(".")[0]!;
      return [
        `Phoenix.PubSub.broadcast(${appModule}.PubSub, "events", %${contextModule}.Events.${upperFirst(st.eventName)}{${fields}})`,
      ];
    }
    case "expr-let": {
      const bind = bindUsedLater(st.name, rest) ? snake(st.name) : "_";
      return [`${bind} = ${renderExpr(st.expr, renderCtx)}`];
    }
    case "resource-call":
      return [`_ = ${renderExpr(st.call, renderCtx)}`];
    default:
      // Defence-in-depth: `renderBranch` routes guards + nested control flow
      // (`for-each` / `if-let` / `repo-run` / `repo-let`) through the with-chain
      // path, so the flat path only ever sees the kinds handled above.  A future
      // kind reaching here surfaces as a visible TODO rather than silent-wrong.
      return [`# TODO: lower if-let branch statement kind '${st.kind}'`];
  }
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
export function collectParamRefs(e: ExprIR | undefined, acc: Set<string>): void {
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

/** Collect referenced create-params from EVERY lowered statement kind —
 *  every kind now lowers to real code emitting its param refs, so the
 *  full WorkflowStmtIR union is covered.  Must stay in lock-step with
 *  `lowerStatement`; if a future kind is added without a matching arm
 *  here, an unused param destructure could trip `--warnings-as-errors`. */
export function collectWorkflowStmtParamRefs(st: WorkflowStmtIR, acc: Set<string>): void {
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
      // Every repo-let is now lowered — getById maps to `get_<agg>/1`, a
      // custom find maps to `<find>_<agg>(args...)` via the context
      // defdelegate emitted by context-emit.ts.
      for (const a of st.args) collectParamRefs(a, acc);
      return;
    case "repo-delete":
      // `<Repo>.delete(o)` → `Context.delete_<agg>(o)`.  The entity operand may
      // reference a create-param directly (`Orders.delete(param)`), so surface
      // its refs for the `run/1` destructure.
      collectParamRefs(st.entity, acc);
      return;
    case "resource-call":
      collectParamRefs(st.call, acc);
      return;
    case "domain-service-call":
      // A `mutating` `Transfer.run(s, d, amount)` references the workflow's
      // create-params through its call args (`amount`); they must be
      // destructured off `run/1` so the inlined with-chain's `%{arg0: amount}`
      // resolves.  Without this the bound binding is undefined (the pre-Slice-3
      // placeholder bug).
      if (st.call.kind === "call") for (const a of st.call.args) collectParamRefs(a, acc);
      return;
    case "repo-run":
      for (const a of st.retrievalArgs) collectParamRefs(a, acc);
      collectParamRefs(st.page?.offset, acc);
      collectParamRefs(st.page?.limit, acc);
      return;
    case "for-each":
      collectParamRefs(st.iterable, acc);
      for (const inner of st.body) collectWorkflowStmtParamRefs(inner, acc);
      return;
    case "if-let":
      for (const a of st.retrievalArgs) collectParamRefs(a, acc);
      for (const inner of st.thenBody) collectWorkflowStmtParamRefs(inner, acc);
      for (const inner of st.elseBody ?? []) collectWorkflowStmtParamRefs(inner, acc);
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
function assembleBody(lines: BodyLine[], completedCall: string): string {
  const withClauses = lines.filter((l) => l.kind === "with-clause");
  const emitLines = lines.filter((l) => l.kind === "emit");
  const stmtLines = lines.filter((l) => l.kind === "stmt");
  const lastBind = [...withClauses].reverse().find((l) => l.bindName)?.bindName;

  const resultExpr = lastBind ? `{:ok, ${lastBind}}` : "{:ok, params}";
  // The `do`-branch body: emits first (only run on with-chain success),
  // then `workflow_completed` (the success tail), then the success result.
  // Indented to match the `with ... do ... end` shape — 6 spaces under
  // `run_inner`.  The log fires only on success (the with-chain's do-branch),
  // never on an `{:error, _}` short-circuit.
  const doBody =
    emitLines.length > 0
      ? `${emitLines.map((l) => `      ${l.text}`).join("\n")}\n      ${completedCall}\n      ${resultExpr}`
      : `      ${completedCall}\n      ${resultExpr}`;

  if (stmtLines.length === 0 && withClauses.length === 0 && emitLines.length === 0) {
    // Empty body — keep the stub semantics; still announce completion.
    return `    ${completedCall}\n    {:ok, params}`;
  }

  if (stmtLines.length === 0 && withClauses.length === 0 && emitLines.length > 0) {
    // Emit-only body — no with-chain to gate on, broadcasts run
    // unconditionally then return :ok.
    return `${emitLines.map((l) => `    ${l.text}`).join("\n")}\n    ${completedCall}\n    {:ok, :emitted}`;
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
    ${completedCall}
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

/** SQL-92 isolation-level name for a DSL level — Ecto has no `isolation_level:`
 *  option, so the level is set with `SET TRANSACTION ISOLATION LEVEL <NAME>`
 *  as the first statement inside the `Repo.transaction/1` fn. */
function elixirIsolationSql(level: IsolationLevel): string {
  switch (level) {
    case "readUncommitted":
      return "READ UNCOMMITTED";
    case "readCommitted":
      return "READ COMMITTED";
    case "repeatableRead":
      return "REPEATABLE READ";
    case "serializable":
      return "SERIALIZABLE";
  }
}

interface WorkflowModuleResult {
  content: string;
  /** M13 — one entry per top-level `WorkflowStmtIR` with an origin, its text
   *  ALREADY put through the same `contextModuleFq` → `Context` alias
   *  rewrite `content` itself went through, so it anchors verbatim via
   *  `SourceMapRecorder.fragment` regardless of the bucketing that moved it
   *  (with-clauses vs. `emit`s land in different structural positions —
   *  see `assembleBody`).  Empty when the caller didn't ask for it. */
  statementRegions: { text: string; origin: OriginRef | undefined }[];
}

function renderWorkflowModule(
  appModule: string,
  ctxModule: string,
  wf: WorkflowIR,
  resourceModules: Map<string, string>,
  ctx?: BoundedContextIR,
  sys?: SystemIR,
  /** Only collect `statementRegions` when a source-map recorder is present
   *  upstream (zero cost otherwise). */
  wantRegions = false,
): WorkflowModuleResult {
  const wfPascal = upperFirst(wf.name);
  const moduleName = `${appModule}.${ctxModule}.Workflows.${wfPascal}`;
  const contextModuleFq = `${appModule}.${ctxModule}`;
  const repoMod = `${appModule}.Repo`;
  const transactional = !!wf.transactional;
  // Resolved transaction isolation (workflow override → state-dataSource
  // default → undefined).  Only meaningful on the transactional path.
  const isolation =
    transactional && ctx && sys ? resolveWorkflowIsolation(wf, ctx, sys) : wf.isolation;

  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: contextModuleFq,
    foundation: "vanilla",
    resourceModules,
    // Domain-service call wiring (domain-services.md rev. 4, Slice 1; Elixir
    // decision B).  A workflow that calls a `reading`-tier service (e.g.
    // `precondition Registration.isEmailAvailable(holder)`) renders it as a
    // CONTEXT FUNCTION on this context module — `<Context>.is_email_available(…)`
    // — with NO read-port handle (the ambient `Repo` is free).  `readingServiceModule`
    // is the fully-qualified context module, rewritten to the `Context` alias
    // by the same `replaceAll` that aliases the rest of the body.  A `pure`
    // service call falls through to the `Domain.Services` module shape
    // (byte-identical).  `ctx` is undefined only on legacy/test paths — then no
    // tier is resolved and every call stays the pure module shape.
    domainServiceTier: ctx
      ? (service, opName) => lookupServiceTier(ctx, service, opName)
      : undefined,
    readingServiceModule: contextModuleFq,
  };
  // Workflow lifecycle narrative — `workflow_started` at run entry, woven into
  // the success tail of the body by `assembleBody` (`workflow_completed`).  The
  // workflow name is a compile-time string literal, so it interpolates straight
  // into the `valueExpr` (no inline `case`/expr that would mis-parse as a
  // keyword-arg value).  Shared catalog identity (field `workflow`) with
  // every backend.
  // Workflow `function` helpers — `defp <snake(fn)>(params) do … end` in this
  // per-workflow module (no scope prefix — the module already namespaces them).
  // Pure over params (validator-guaranteed).  Both the expression form and the
  // pure block form (domain-services.md rev. 4) render via `renderFunctionBodyLines`.
  const helperDefs = (wf.functions ?? [])
    .map((fn) => {
      const params = fn.params.map((p) => snake(p.name)).join(", ");
      const bodyLines = renderFunctionBodyLines(fn.body, renderCtx).join("\n");
      return `\n  defp ${snake(fn.name)}(${params}) do\n${bodyLines}\n  end`;
    })
    .join("");
  const startedCall = renderPhoenixLogCall("workflowStarted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
  ]);
  const completedCall = renderPhoenixLogCall("workflowCompleted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
  ]);
  const lines = lowerStatements(wf.statements ?? [], contextModuleFq, renderCtx, ctx);
  const body = assembleBody(lines, completedCall);
  // A workflow that names `currentUser` in a guard/body — or calls a
  // `currentUser`-gated op — threads `current_user \\ nil` into `run/1`
  // (and `run_inner` on the transactional path) so the rendered bare token
  // `current_user` (and the trailing op-call actor) bind.  The
  // `WorkflowsController` passes `conn.assigns[:current_user]`.  A workflow
  // that references no actor renders byte-identically to before (no extra arg).
  const needsUser = ctx ? workflowNeedsCurrentUser(wf, ctx) : workflowUsesCurrentUser(wf);
  const userParam = needsUser ? ", current_user \\\\ nil" : "";
  const hasContextCall = lines.some((l) => l.kind === "with-clause");
  const contextAlias = hasContextCall ? `\n  alias ${contextModuleFq}, as: Context` : "";
  // Rewrite the body's fully-qualified context module to the `Context`
  // alias to keep the rendered Elixir tidy and avoid long-line warnings.
  const aliasedBody = hasContextCall ? body.replaceAll(contextModuleFq, "Context") : body;
  // M13 — one `fragment()` anchor per statement, independent of position
  // (assembleBody's with-clause/emit bucketing REORDERS statements relative
  // to source order, so a single cursor-walked fragment can't be used — see
  // docs/old/plans/source-map-and-debugging.md).  Each line's own text is put
  // through the SAME `Context`-alias rewrite `aliasedBody` got, so the
  // anchor matches the final content verbatim.
  const statementRegions: { text: string; origin: OriginRef | undefined }[] = wantRegions
    ? lines
        .filter((l) => l.origin)
        .map((l) => ({
          text: hasContextCall ? l.text.replaceAll(contextModuleFq, "Context") : l.text,
          origin: l.origin,
        }))
    : [];
  // Surface referenced create-params as locals via a leading map
  // destructure — the body's bare `param` refs (`initial_title`) bind off
  // the `run/1` map.  Empty when no params are referenced, so a
  // param-free workflow renders byte-identically to before.
  const params = referencedParams(wf);
  const paramDestructure =
    params.length > 0
      ? `    %{${params.map((n) => `"${snake(n)}" => ${snake(n)}`).join(", ")}} = params\n`
      : "";
  // `workflow_started` runs first thing in the body (before the destructure +
  // the with-chain), so it fires at run/1 entry on every invocation.
  const finalBody = `    ${startedCall}\n` + paramDestructure + aliasedBody;

  const transactionalDoc = transactional
    ? "\n\n  Marked `transactional` — the body runs inside `Repo.transaction/1`;\n  a rejection result rolls the transaction back."
    : "";

  if (transactional) {
    // Ecto has no `isolation_level:` option, so when an isolation level
    // resolves we set it as the FIRST statement inside the transaction fn.
    // Omitted entirely otherwise (connection default applies) — byte-identical
    // to the no-isolation output.
    // `run_inner` carries `current_user` only when the body references it; `run`
    // always passes it through the transaction fn so the binding stays in scope.
    const innerArgs = needsUser ? "params, current_user" : "params";
    const innerParam = needsUser ? "params, current_user" : "params";
    const txnBody = isolation
      ? `\n      Repo.query!("SET TRANSACTION ISOLATION LEVEL ${elixirIsolationSql(isolation)}")\n      commit_result(run_inner(${innerArgs}))\n    `
      : ` commit_result(run_inner(${innerArgs})) `;
    const content = `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Workflow \`${wf.name}\` — plain Elixir.${transactionalDoc}
  """

  require Logger
  alias ${repoMod}${contextAlias}

  @spec run(map()${needsUser ? ", term()" : ""}) :: {:ok, term()} | {:error, term()}
  def run(params${userParam}) when is_map(params) do
    # A workflow is a per-dispatch boundary: run it in a child execution frame
    # (parent_id <- the request's root scope) so its audit / provenance rows
    # record their call-structure position.
    ${appModule}.RequestContext.with_child_frame(fn ->
      Repo.transaction(fn ->${txnBody}end)
    end)
  end

  # Public (not defp): Elixir 1.18 narrows a private fn's parameter to
  # run_inner's inferred result, which flags whichever arm this workflow's
  # body can't produce (e.g. a body that can't fail makes the rollback arm
  # "never match").  A public fn keeps both arms at their full clause domain.
  def commit_result({:ok, result}), do: result
  def commit_result({:error, reason}), do: Repo.rollback(reason)

  defp run_inner(${innerParam}) when is_map(params) do
${finalBody}
  end${helperDefs}
end
`;
    return { content, statementRegions };
  }

  const content = `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Workflow \`${wf.name}\` — plain Elixir.
  """

  require Logger${hasContextCall ? `${contextAlias}\n` : ""}

  @spec run(map()${needsUser ? ", term()" : ""}) :: {:ok, term()} | {:error, term()}
  def run(params${userParam}) when is_map(params) do
    # A workflow is a per-dispatch boundary: run it in a child execution frame
    # (parent_id <- the request's root scope) so its audit / provenance rows
    # record their call-structure position.
    ${appModule}.RequestContext.with_child_frame(fn ->
${finalBody}
    end)
  end${helperDefs}
end
`;
  return { content, statementRegions };
}

function renderWorkflowsController(appModule: string, groups: WorkflowControllerGroup[]): string {
  const webModule = `${appModule}Web`;

  // One action per command workflow across ALL hosted contexts.  Each action
  // routes to its own context-namespaced `<App>.<Ctx>.Workflows.<Wf>` module, so
  // workflows from different contexts coexist in this single controller (the HTTP
  // surface is per-deployable).  `currentUser` threading is decided per workflow
  // against its OWN context.
  const actions = groups
    .flatMap((g) => {
      const ctxModule = upperFirst(g.ctx.name);
      return g.workflows.map((wf) => {
        const wfSnake = snake(wf.name);
        const wfMod = `${appModule}.${ctxModule}.Workflows.${upperFirst(wf.name)}`;
        // When the workflow threads `current_user` (it names `currentUser` or
        // calls a `currentUser`-gated op), bind it off `conn.assigns` and pass it
        // through — mirrors the per-op controller action (api-emit.ts).
        const needsUser = workflowNeedsCurrentUser(wf, g.ctx);
        if (needsUser) {
          return `  def ${wfSnake}(conn, params) do
    current_user = Map.get(conn.assigns, :current_user)
    respond(conn, ${wfMod}.run(params, current_user))
  end`;
        }
        return `  def ${wfSnake}(conn, params) do
    respond(conn, ${wfMod}.run(params))
  end`;
      });
    })
    .join("\n\n");

  const ctxList = groups.map((g) => upperFirst(g.ctx.name)).join(", ");

  return `# Auto-generated.
defmodule ${webModule}.WorkflowsController do
  use ${webModule}, :controller
  alias ${webModule}.ProblemDetails

  @moduledoc """
  HTTP entry points for command-triggered workflows
  (${ctxList}).
  """

${actions}

  # Shared result handler.  Each workflow's run/1 result flows through
  # here; keeping the dispatch in one multi-clause function (rather than a
  # case inlined per action) means Elixir 1.18's type checker doesn't
  # narrow the scrutinee to a single workflow's exact result shape and
  # flag the error branches that workflow can't produce.
  def respond(conn, {:ok, result}) do
    conn
    |> put_status(202)
    |> json(%{status: "accepted", result: serialize(result)})
  end

  def respond(conn, {:error, %Ecto.Changeset{} = changeset}),
    do: ProblemDetails.validation_error_response(conn, changeset)

  def respond(conn, {:error, :not_found}),
    do: ProblemDetails.problem_response(conn, 404, "Not Found", "Resource not found")

  def respond(conn, {:error, :forbidden}),
    do: ProblemDetails.problem_response(conn, 403, "Forbidden", "Workflow guard rejected the request")

  def respond(conn, {:error, :precondition_failed}),
    do: ProblemDetails.problem_response(conn, 422, "Precondition Failed", "Workflow precondition rejected the request")

  def respond(conn, {:error, reason}),
    do: ProblemDetails.problem_response(conn, 400, "Bad Request", inspect(reason))

  defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])
  defp serialize(other), do: other
end
`;
}
