import {
  type BoundedContextIR,
  type EnrichedBoundedContextIR,
  type ExprIR,
  type OperationIR,
  operationUsesCurrentUser,
  type SystemIR,
  type WireField,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowIsGuarded,
  workflowUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import { type ReadPort, readPortsForOperation } from "../../ir/util/domain-service-read-ports.js";
import {
  camelId,
  opWorkflow,
  opWorkflowInstanceById,
  opWorkflowInstances,
} from "../../ir/util/openapi-ids.js";
import { resolveWorkflowIsolation } from "../../ir/util/resolve-datasource.js";
import { commandWorkflowsOf } from "../../ir/util/workflow-command-route.js";
import { workflowCorrIdValueType } from "../../ir/util/workflow-instances.js";
import { walkExpr } from "../../ir/validate/checks/shared.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst, workflowFnSnake } from "../../util/naming.js";
import { LogEvents } from "../_obs/log-events.js";
import { statementSubRegions } from "../_trace/sourcemap.js";
import { renderWorkflowStmtChunks, type WorkflowStmtTarget } from "../_workflow/stmt-target.js";
import type { OpFragment } from "./emit/aggregate.js";
import { domainServiceImportLinesForWorkflow } from "./emit/domain-service.js";
import { responsePyType } from "./emit/http-models.js";
import { wireHelperImport } from "./py-type-imports.js";
import {
  type PyRenderContext,
  renderPyExpr,
  renderPyNegatedGuard,
  renderPyType,
} from "./render-expr.js";
import { renderPyStatements } from "./render-stmt.js";
import { resourceImportLines } from "./resource-clients.js";
import {
  errorResponsesKwarg,
  ID_PARAM,
  pyWireToDomain,
  requestFieldDecl,
} from "./routes-builder.js";
import { esFns } from "./workflow-eventsourced-emit.js";

// ---------------------------------------------------------------------------
// Workflow routes — `app/http/workflows_routes.py`, mounted at
// `/workflows`.  One `POST /workflows/<snake(wf)>` per command-surfaced
// workflow (parity with the Hono workflow builder): params coerce to
// domain locals, the body's WorkflowStmtIR sequence executes over the
// request session, let-bound aggregates save at exit, collected emits
// dispatch at the end, 204 on success.
//
// One DB transaction per request: repositories flush, the session
// dependency commits once after the handler returns — so a
// `transactional` workflow's saves are atomic by construction.
//
// Event-triggered starters / `on(...)` reactors (the saga dispatcher +
// correlation state tables) live in `dispatch-builder.ts` / `schema.ts`;
// `emitsCommandRoute` mirrors the Hono facade rule, so a reactor-only
// workflow emits no POST route here.
//
// Read-only instance endpoints (workflow-instance-visibility.md) — GET
// `/<snake>/instances` (list) + `/<snake>/instances/{id}` (one by correlation
// id, 404 if absent) — are emitted for every observable workflow (one with an
// enriched `instanceWireShape`), reading the persisted saga-state row the
// dispatcher upserts.  Driven off `instanceWireShape` independently of the
// command route, so an event-triggered-only saga is still observable — parity
// with the Hono / .NET / Elixir-vanilla instance reads.
// ---------------------------------------------------------------------------

// `commandWorkflowsOf` / `emitsCommandRoute` now live in
// `ir/util/workflow-command-route`; re-exported here so `python/index.ts`'s
// import point is unchanged.
export { commandWorkflowsOf };

/** Observable workflows — correlation-bearing, state-table-backed sagas the
 *  enricher gave an `instanceWireShape` (workflow-instance-visibility.md).
 *  Each gets the read-only instance endpoints over its persisted saga row. */
export function observableWorkflowsOf(ctx: EnrichedBoundedContextIR): WorkflowIR[] {
  return ctx.workflows.filter((wf) => wf.instanceWireShape != null);
}

export function buildPyWorkflowsFile(
  ctx: EnrichedBoundedContextIR,
  hasDispatch = false,
  sys?: SystemIR,
  /** Source-map Milestone 11 (workflow-body statement regions) — allocated by
   *  the caller (`src/generator/python/index.ts`) ONLY when a recorder is
   *  present.  `app/http/workflows_routes.py` pools every command workflow,
   *  so it never gets a `sourcemap.file(...)` whole-file region (mirrors the
   *  Elixir pooled-file precedent) — these fragment-only statement regions
   *  are the only mapping this file gets.  Reactor / event-`create` starter
   *  bodies live in `dispatch-builder.ts` (`app/dispatch.py`), out of scope
   *  for this slice. */
  opFragments?: OpFragment[],
): string | null {
  const wfs = commandWorkflowsOf(ctx);
  const obsWfs = observableWorkflowsOf(ctx);
  if (wfs.length === 0 && obsWfs.length === 0) return null;
  // Resource verb-helper imports for any `<resource>.<verb>(...)` the
  // workflows call (resources.md).
  const resourceImports = sys
    ? resourceImportLines(
        sys,
        wfs.flatMap((wf) => wf.statements),
      )
    : [];
  const dispatcherExpr = hasDispatch ? "make_dispatcher(session)" : "NoopDomainEventDispatcher()";
  const anyUser = wfs.some(
    (wf) => workflowUsesCurrentUser(wf) || callsUserGatedOp(wf.statements, ctx),
  );

  const models = wfs
    .map((wf) =>
      lines(
        `class ${upperFirst(wf.name)}Request(BaseModel):`,
        wf.params.length > 0
          ? wf.params.map((p) => `    ${p.name}: ${requestFieldDecl(p.type, false, ctx)}`)
          : ["    pass"],
        "",
        "",
      ),
    )
    .join("");

  // Read-only instance response DTOs (+ list carrier) for observable sagas.
  const instanceModels = obsWfs.map((wf) => instanceResponseModels(wf, ctx)).join("");

  const routeBlocks = [
    ...wfs.map((wf) => workflowRoute(wf, ctx, dispatcherExpr, sys, opFragments)),
    ...obsWfs.map((wf) => instanceRoutes(wf)),
  ];
  const routes = routeBlocks.join("\n\n\n");
  // Workflow `function` helpers — module-scoped `def`s, namespaced by workflow
  // (workflows share this file), emitted before the routes so the create/handle
  // bodies can call them.  Expression-bodied + pure over params (validator-guaranteed).
  const helperDefs = wfs.flatMap((wf) => workflowFnHelpers(wf)).join("\n\n");
  const helpersBlock = helperDefs ? `${helperDefs}\n\n\n` : "";
  const body = `${models}${instanceModels}${helpersBlock}router = APIRouter(prefix="/workflows", tags=["workflows"])\n\n\n${routes}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  // Includes the read-port repos a `reading`-tier domain-service call needs
  // (domain-services.md rev. 4, Slice 1): the route constructs them, so the
  // file must import their classes even when the workflow body never reads them.
  const repoAggs = [
    ...new Set(
      wfs.flatMap((wf) => mergeReadPortRepos(reposFor(wf), wf, ctx).map((r) => r.aggName)),
    ),
  ].sort();
  const eventNames = [
    ...new Set(wfs.flatMap((wf) => collectEmits(wf.statements).map((e) => e.eventName))),
  ].sort();
  const idNames = [...new Set([...scanIdNames(scan, ctx)])].sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  const voModelImports = ctx.valueObjects
    .map((v) => v.name)
    .filter((n) => refersTo(`${n}Model`))
    .sort();

  return lines(
    `"""Workflow routes.  Auto-generated."""`,
    "",
    refersTo("math") ? "import math" : null,
    // A5 temporal — workflow bodies render domain expressions, so
    // `timedelta` rides in on use (like UTC/datetime).
    refersTo("datetime") || refersTo("timedelta")
      ? `from datetime import ${[
          ...(refersTo("datetime") ? ["UTC", "datetime"] : []),
          ...(refersTo("timedelta") ? ["timedelta"] : []),
        ].join(", ")}`
      : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    `from fastapi import ${[
      "APIRouter",
      "Depends",
      refersTo("Path") ? "Path" : null,
      refersTo("Request") ? "Request" : null,
      refersTo("Response") ? "Response" : null,
    ]
      .filter(Boolean)
      .join(", ")}`,
    `from pydantic import ${["BaseModel", refersTo("RootModel") ? "RootModel" : null].filter(Boolean).join(", ")}`,
    refersTo("select") ? "from sqlalchemy import select" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    anyUser ? "from app.auth.user import User" : null,
    "from app.db.engine import get_session",
    // Command-workflow routes always log the lifecycle narrative; observable-
    // only contexts (no command route) emit no `log(...)` call, so gate on wfs.
    wfs.length > 0 ? "from app.obs.log import in_child_context, log" : null,
    ...resourceImports,
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    (() => {
      // State-based sagas read their `<Wf>Row` correlation row from schema; an
      // event-sourced workflow has no such row (it folds the event stream).
      const stateRows = obsWfs.filter((wf) => !wf.eventSourced).map((wf) => `${wf.name}Row`);
      return stateRows.length > 0
        ? `from app.db.schema import ${stateRows.sort().join(", ")}`
        : null;
    })(),
    (() => {
      // Event-sourced sagas fold via the dispatch fold helpers (the `<Wf>State`
      // fold class + `_fold`/`_load`/`_load_all`), reused from `app.dispatch`
      // so the read body mirrors the dispatch-handler load/fold machinery.
      const esObs = obsWfs.filter((wf) => wf.eventSourced);
      if (esObs.length === 0) return null;
      const names = new Set<string>();
      for (const wf of esObs) {
        const fns = esFns(wf);
        names.add(fns.fold);
        names.add(fns.load);
        names.add(fns.loadAll);
      }
      return `from app.dispatch import ${[...names].sort().join(", ")}`;
    })(),
    wireHelperImport(refersTo),
    hasDispatch && refersTo("make_dispatcher") ? "from app.dispatch import make_dispatcher" : null,
    (() => {
      const names = ["AggregateNotFoundError", "DomainError", "ForbiddenError"].filter(refersTo);
      return names.length > 0 ? `from app.domain.errors import ${names.join(", ")}` : null;
    })(),
    eventsImports(refersTo, hasDispatch, eventNames),
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    ...[
      ...new Set(
        wfs.flatMap((wf) =>
          wf.statements
            .filter((st) => st.kind === "factory-let")
            .map((st) => (st as { aggName: string }).aggName),
        ),
      ),
    ]
      .sort()
      .map((n) => `from app.domain.${snake(n)} import ${n}`),
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    // Domain-service calls render as bare functions (`quote(...)`) — import
    // them by name from app.domain.services.* (domain-services.md).
    ...domainServiceImportLinesForWorkflow(wfs.flatMap((wf) => wf.statements)),
    refersTo("ProblemDetails") ? "from app.http.problem import ProblemDetails" : null,
    voModelImports.length > 0
      ? `from app.http.wire_models import ${voModelImports.map((n) => `${n} as ${n}Model`).join(", ")}`
      : null,
    "",
    "SessionDep = Annotated[AsyncSession, Depends(get_session)]",
    "",
    "",
    body,
    "",
  );
}

/** The events-module import line.  Noop only ships when the deployable
 *  has no live dispatcher; with one, the line can vanish entirely
 *  (a workflow set with no emits and no DomainEvent reference). */
function eventsImports(
  refersTo: (n: string) => boolean,
  hasDispatch: boolean,
  eventNames: string[],
): string | null {
  const names = [
    refersTo("DomainEvent") ? "DomainEvent" : null,
    !hasDispatch && refersTo("NoopDomainEventDispatcher") ? "NoopDomainEventDispatcher" : null,
    ...eventNames,
  ].filter((n): n is string => n != null);
  return names.length > 0 ? `from app.domain.events import ${names.join(", ")}` : null;
}

/** The workflow body calls a currentUser-gated operation — the op's
 *  method signature takes a trailing `current_user` argument the
 *  op-call renderer threads through, so the actor must be bound even
 *  if the workflow body itself never names `currentUser`. */
function callsUserGatedOp(sts: WorkflowStmtIR[], ctx: EnrichedBoundedContextIR): boolean {
  return sts.some((s) => {
    if (s.kind === "op-call") {
      const o = lookupOp(ctx, s.aggName, s.op);
      return !!o && operationUsesCurrentUser(o);
    }
    if (s.kind === "for-each") return callsUserGatedOp(s.body, ctx);
    return false;
  });
}

function lookupOp(
  ctx: EnrichedBoundedContextIR,
  aggName: string,
  opName: string,
): OperationIR | undefined {
  return ctx.aggregates.find((a) => a.name === aggName)?.operations.find((o) => o.name === opName);
}

interface RepoNeed {
  repoName: string;
  aggName: string;
}

function reposFor(wf: WorkflowIR): RepoNeed[] {
  const out = new Map<string, RepoNeed>();
  const visit = (sts: WorkflowStmtIR[]): void => {
    for (const st of sts) {
      if (st.kind === "repo-let" || st.kind === "repo-run" || st.kind === "repo-delete") {
        out.set(st.repoName, { repoName: st.repoName, aggName: st.aggName });
      }
      if (st.kind === "for-each") {
        visit(st.body);
        for (const s of st.savesPerIteration) {
          out.set(s.repoName, { repoName: s.repoName, aggName: s.aggName });
        }
      }
      if (st.kind === "if-let") {
        // The retrieval itself reads through the repo, and each branch carries
        // its own saves (mirrors the Hono `collectReposFromStmts` walk).
        out.set(st.repoName, { repoName: st.repoName, aggName: st.aggName });
        for (const s of [...st.savesInThen, ...st.savesInElse]) {
          out.set(s.repoName, { repoName: s.repoName, aggName: s.aggName });
        }
        visit(st.thenBody);
        visit(st.elseBody ?? []);
      }
    }
  };
  visit(wf.statements);
  for (const s of wf.savesAtExit) out.set(s.repoName, { repoName: s.repoName, aggName: s.aggName });
  return [...out.values()];
}

// --- read-port wiring (domain-services.md rev. 4, Slice 1) -----------------
//
// A `reading`-tier domain-service operation declares one read-port repository
// parameter per repo it reads; the orchestrating workflow constructs each
// repo handle and passes it ahead of the user args.  Both the call-site
// prepend (`workflowReadPortResolver`) and the repo construction
// (`mergeReadPortRepos`) consume the SAME shared `readPortsForOperation`
// derivation, so they stay in lockstep.  A PURE service call has zero ports →
// no handle, no `await` → byte-identical.

/** Build the read-port resolver for a workflow's `reading`-tier domain-service
 *  calls.  Given a `<service>.<op>` call, returns the repository handle var
 *  names (`snake(repo)` — the var the workflow constructs) to prepend, in
 *  first-read order.  A pure service op has no ports → `[]` → byte-identical. */
function workflowReadPortResolver(
  ctx: EnrichedBoundedContextIR,
): (service: string, op: string) => string[] {
  return (service, op) => {
    const svc = ctx.domainServices.find((s) => s.name === service);
    const operation = svc?.operations.find((o) => o.name === op);
    if (!operation) return [];
    return readPortsForOperation(operation).map((p) => snake(p.repo));
  };
}

/** Every read-port a workflow's `reading`-tier domain-service calls require —
 *  the repositories those services read, so the workflow constructs them even
 *  when its own body never reads that repository directly.  De-duplicated by
 *  repository name across all service calls in the body. */
function collectServiceReadPorts(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): ReadPort[] {
  const byRepo = new Map<string, ReadPort>();
  const visit = (e: ExprIR | undefined): void =>
    walkExpr(e, (n) => {
      if (n.kind === "call" && n.callKind === "domain-service" && n.serviceRef) {
        const svc = ctx.domainServices.find((s) => s.name === n.serviceRef!.service);
        const operation = svc?.operations.find((o) => o.name === n.serviceRef!.op);
        if (operation) {
          for (const p of readPortsForOperation(operation)) {
            if (!byRepo.has(p.repo)) byRepo.set(p.repo, p);
          }
        }
      }
    });
  const walkStmts = (stmts: WorkflowStmtIR[]): void => {
    for (const st of stmts) {
      switch (st.kind) {
        case "precondition":
        case "requires":
        case "expr-let":
          visit(st.expr);
          break;
        case "emit":
        case "factory-let":
          for (const f of st.fields) visit(f.value);
          break;
        case "repo-let":
        case "op-call":
          for (const a of st.args) visit(a);
          break;
        case "repo-run":
          for (const a of st.retrievalArgs) visit(a);
          break;
        case "resource-call":
          visit(st.call);
          break;
        case "for-each":
          visit(st.iterable);
          walkStmts(st.body);
          break;
        case "if-let":
          for (const a of st.retrievalArgs) visit(a);
          walkStmts(st.thenBody);
          if (st.elseBody) walkStmts(st.elseBody);
          break;
      }
    }
  };
  walkStmts(wf.statements);
  return [...byRepo.values()];
}

/** Merge a workflow's directly-used repos with the read-port repos its
 *  `reading`-tier domain-service calls require, de-duplicated by repository
 *  name (a repo the workflow already constructs is not added twice).  Service
 *  ports append after the workflow's own repos so a port-only project stays a
 *  pure extension. */
function mergeReadPortRepos(
  own: RepoNeed[],
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
): RepoNeed[] {
  const seen = new Set(own.map((r) => r.repoName));
  const out = [...own];
  for (const port of collectServiceReadPorts(wf, ctx)) {
    if (seen.has(port.repo)) continue;
    seen.add(port.repo);
    out.push({ repoName: port.repo, aggName: port.aggregate });
  }
  return out;
}

/** Names of `let` bindings referenced anywhere in the workflow body.  An
 *  `expr-let` whose name is absent here is dead — Python's ruff rejects the
 *  unused local (F841), so the emitter drops the binding and keeps the (still
 *  side-effecting) RHS as a bare statement.  Aggregate-binding lets
 *  (`repo-let` / `factory-let` / `repo-run`) save at exit and are never
 *  considered unused. */
export function collectUsedLetNames(sts: WorkflowStmtIR[]): Set<string> {
  const used = new Set<string>();
  const addExpr = (e: ExprIR | undefined): void =>
    walkExpr(e, (n) => {
      if (n.kind === "ref" && n.refKind === "let") used.add(n.name);
    });
  const visit = (list: WorkflowStmtIR[]): void => {
    for (const st of list) {
      switch (st.kind) {
        case "precondition":
        case "requires":
        case "expr-let":
          addExpr(st.expr);
          break;
        case "emit":
        case "factory-let":
          for (const f of st.fields) addExpr(f.value);
          break;
        case "repo-let":
        case "op-call":
          for (const a of st.args) addExpr(a);
          break;
        case "repo-run":
          for (const a of st.retrievalArgs) addExpr(a);
          addExpr(st.page?.offset);
          addExpr(st.page?.limit);
          break;
        case "for-each":
          addExpr(st.iterable);
          visit(st.body);
          break;
        case "if-let":
          for (const a of st.retrievalArgs) addExpr(a);
          visit(st.thenBody);
          if (st.elseBody) visit(st.elseBody);
          break;
        case "resource-call":
          addExpr(st.call);
          break;
      }
    }
  };
  visit(sts);
  return used;
}

function collectEmits(sts: WorkflowStmtIR[]): { eventName: string }[] {
  return sts.flatMap((st) =>
    st.kind === "emit"
      ? [{ eventName: st.eventName }]
      : st.kind === "for-each"
        ? collectEmits(st.body)
        : [],
  );
}

function scanIdNames(scan: string, ctx: BoundedContextIR): string[] {
  return ctx.aggregates
    .map((a) => `${a.name}Id`)
    .filter((n) => new RegExp(`\\b${n}\\b`).test(scan));
}

/** Postgres `isolation_level` execution-option string for a DSL level. */
function pyIsolationLevel(level: import("../../ir/types/loom-ir.js").IsolationLevel): string {
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

// Workflow `function` helpers — module-scoped `def`s, namespaced by workflow.
// Pure over params (validator-guaranteed, no `self`), so a plain `renderPyExpr` /
// `renderPyStatements` renders the body safely.  Both the expression form and
// the pure block form (domain-services.md rev. 4) are supported.
function workflowFnHelpers(wf: WorkflowIR): string[] {
  const out: string[] = [];
  for (const fn of wf.functions ?? []) {
    const params = fn.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`).join(", ");
    const name = workflowFnSnake(wf.name, fn.name);
    const head = `def ${name}(${params}) -> ${renderPyType(fn.returnType)}:`;
    // Module-level def → 4-space body indent (methods use 8).
    const body =
      "expr" in fn.body
        ? `    return ${renderPyExpr(fn.body.expr)}`
        : renderPyStatements(fn.body.stmts, "    ");
    out.push(`${head}\n${body}`);
  }
  return out;
}

function workflowRoute(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  dispatcherExpr: string,
  sys?: SystemIR,
  /** Source-map Milestone 11 — see `buildPyWorkflowsFile`'s `opFragments`. */
  opFragments?: OpFragment[],
): string {
  // A `requires`-guarded workflow declares its 403 outcome; a
  // currentUser-referencing one binds the actor off the request scope
  // before any rendered statement mentions the bare `current_user`.
  const usesUser = workflowUsesCurrentUser(wf) || callsUserGatedOp(wf.statements, ctx);
  const sig = [
    `body: ${upperFirst(wf.name)}Request`,
    ...(usesUser ? ["request: Request"] : []),
    "session: SessionDep",
  ].join(", ");
  const out: string[] = [
    `@router.post("/${snake(wf.name)}", status_code=204, operation_id="${camelId(opWorkflow(wf.name))}"${errorResponsesKwarg("workflow", workflowIsGuarded(wf))})`,
    // A route-invoked workflow runs in a child frame under the request root, so
    // its audit / provenance rows are distinguishable from a direct operation's.
    "@in_child_context",
    `async def ${snake(wf.name)}_workflow(${sig}) -> Response:`,
    ...(usesUser ? ["    current_user: User = request.state.current_user"] : []),
    // Workflow narrative — `workflow_started` at the route entry; shared catalog
    // identity (field `workflow`) across every backend.
    `    log("${LogEvents.workflowStarted.level}", "${LogEvents.workflowStarted.event}", workflow=${JSON.stringify(wf.name)})`,
  ];
  // A `transactional(<level>)` workflow (or its state dataSource's
  // `isolationLevel:`) pins the request transaction's isolation before any
  // query runs — parity with the .NET BeginTransactionAsync(IsolationLevel.X)
  // and Java @Transactional(isolation = …) paths.
  const isolation = sys ? resolveWorkflowIsolation(wf, ctx, sys) : wf.isolation;
  if (isolation) {
    out.push(
      `    await session.connection(execution_options={"isolation_level": "${pyIsolationLevel(isolation)}"})`,
    );
  }
  // Wire params → domain locals (brand ids, build VOs) once up front.
  for (const p of wf.params) {
    out.push(`    ${snake(p.name)} = ${pyWireToDomain(`body.${p.name}`, p.type, ctx)}`);
  }
  // Read-port repos (domain-services.md rev. 4, Slice 1): a `reading`-tier
  // domain-service call the workflow makes needs a live repository handle, so
  // the workflow constructs `<Agg>Repository(session, …)` for those repos even
  // when its own body never reads them — `mergeReadPortRepos` folds the service
  // ports into the workflow's repo set, de-duplicated by repo name.  A pure
  // service call adds no ports → byte-identical.
  const repos = mergeReadPortRepos(reposFor(wf), wf, ctx);
  for (const r of repos) {
    out.push(`    ${snake(r.repoName)} = ${r.aggName}Repository(session, ${dispatcherExpr})`);
  }
  const hasEmit = collectEmits(wf.statements).length > 0;
  if (hasEmit) out.push("    workflow_events: list[DomainEvent] = []");
  // Chunked (one lines-array per top-level statement) rather than the
  // pre-flattened `renderWorkflowStmts` — byte-identical either way
  // (`renderWorkflowStmts` IS `chunks.flat()` by construction), but the
  // per-chunk list lets us surface per-statement sub-regions to the caller
  // that owns the recorder + this file's final content (source-map
  // Milestone 11).  No re-indent transform sits between here and the final
  // file (unlike the .NET transactional path), so the chunk texts collected
  // here are already the exact text that lands in `workflows_routes.py`.
  const stmtChunks = renderWorkflowStmtChunks(
    wf.statements,
    // Thread the read-port resolver so a `reading`-tier domain-service call in
    // the body is supplied its repository handle(s) ahead of the user args
    // (domain-services.md rev. 4, Slice 1).  PURE service calls resolve to
    // `[]` → byte-identical.
    pyWorkflowStmtTarget(
      { thisName: "self", readPortArgs: workflowReadPortResolver(ctx) },
      ctx,
      collectUsedLetNames(wf.statements),
    ),
    "    ",
  );
  out.push(...stmtChunks.flat());
  if (opFragments) {
    const chunkTexts = stmtChunks.map((ls) => ls.join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(wf.statements, chunkTexts, `${ctx.name}.${wf.name}`),
      });
    }
  }
  for (const save of wf.savesAtExit) {
    out.push(`    await ${snake(save.repoName)}.save(${snake(save.name)})`);
  }
  if (hasEmit) {
    out.push(`    dispatcher = ${dispatcherExpr}`);
    out.push("    for ev in workflow_events:");
    out.push("        await dispatcher.dispatch(ev)");
  }
  // `workflow_completed` on the success tail — a raised guard / domain error
  // short-circuits before reaching here.
  out.push(
    `    log("${LogEvents.workflowCompleted.level}", "${LogEvents.workflowCompleted.event}", workflow=${JSON.stringify(wf.name)})`,
  );
  out.push("    return Response(status_code=204)");
  return out.join("\n");
}

// --- instance read endpoints (workflow-instance-visibility.md) ------------------

/** The instance Response DTO + its list carrier for an observable workflow —
 *  walks `instanceWireShape` the same way `routes-builder.responseModel` walks
 *  an aggregate's wire shape (id-source rows are `str`, the rest go through the
 *  shared `responsePyType`).  `<Wf>InstanceListResponse` is a `RootModel` so
 *  FastAPI emits a `$ref` to a named array component (parity with the aggregate
 *  `<Agg>ListResponse`). */
function instanceResponseModels(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): string {
  const T = upperFirst(wf.name);
  const shape = wf.instanceWireShape ?? [];
  const fieldLines = shape.map((f) => {
    const t = f.source === "id" ? "str" : responsePyType(f.type, ctx);
    const optional = f.optional || f.type.kind === "optional";
    const suffix = optional && !t.endsWith("| None") ? " | None = None" : optional ? " = None" : "";
    return `    ${f.name}: ${t}${suffix}`;
  });
  return lines(
    `class ${T}InstanceResponse(BaseModel):`,
    fieldLines.length > 0 ? fieldLines : ["    pass"],
    "",
    "",
    `class ${T}InstanceListResponse(RootModel[list[${T}InstanceResponse]]):`,
    "    pass",
    "",
    "",
  );
}

/** GET `/<snake>/instances` (list) + `/<snake>/instances/{id}` (by correlation
 *  id, 404 if absent) over the persisted saga-state row the dispatcher upserts.
 *  Reads the `<Wf>Row` SQLAlchemy model directly (the same row
 *  `dispatch-builder` loads-or-allocates); each row projects through
 *  `instanceWireShape` (camelCase wire key ← snake column), datetimes ISO-coded
 *  exactly as the aggregate `to_wire`.  `session.get` keys on the PK (the
 *  correlation field). */
function instanceRoutes(wf: WorkflowIR): string {
  const T = upperFirst(wf.name);
  const slug = snake(wf.name);
  const row = `${wf.name}Row`;
  const shape = wf.instanceWireShape ?? [];
  const proj = (rowVar: string): string =>
    shape.map((f) => `"${f.name}": ${instanceFieldValue(rowVar, f)}`).join(", ");
  // The read body diverges on `wf.eventSourced`: a state-based saga selects the
  // `<Wf>Row` correlation row directly, while an event-sourced workflow folds
  // the per-correlation `<wf>_events` stream via the dispatch fold helpers —
  // LIST through `_load_all_<wf>` (group-fold, mirroring the ES-aggregate
  // repository list), byId through `_load_<wf>_events` + `_fold_<wf>` (404 on an
  // empty stream).  The folded `<Wf>State` instance exposes the same public
  // snake-cased attrs `instance_field_value` projects, so the projection,
  // operationIds, and route paths stay identical to the state path.
  const fns = esFns(wf);
  // The `{id}` param annotation derives from the correlation id's value type —
  // guid → the uuid-format str `ID_PARAM`, int/long → `int`, string → plain
  // `str` — parity with Hono / .NET / Java / Phoenix by construction
  // (docs/old/plans/non-guid-id-http-params.md).
  const corrVt = workflowCorrIdValueType(wf);
  const idParam = corrVt === "guid" ? ID_PARAM : corrVt === "string" ? "id: str" : "id: int";
  // `_load_<wf>_events` / `_fold_<wf>` key streams as str; a numeric id stringifies.
  const idAsKey = corrVt === "int" || corrVt === "long" ? "str(id)" : "id";
  const list = wf.eventSourced
    ? lines(
        `@router.get("/${slug}/instances", response_model=${T}InstanceListResponse, operation_id="${camelId(opWorkflowInstances(wf.name))}")`,
        `async def ${slug}_instances(session: SessionDep) -> list[dict[str, object]]:`,
        `    rows = await ${fns.loadAll}(session)`,
        `    return [{${proj("row")}} for row in rows]`,
      )
    : lines(
        `@router.get("/${slug}/instances", response_model=${T}InstanceListResponse, operation_id="${camelId(opWorkflowInstances(wf.name))}")`,
        `async def ${slug}_instances(session: SessionDep) -> list[dict[str, object]]:`,
        `    rows = (await session.execute(select(${row}))).scalars().all()`,
        `    return [{${proj("row")}} for row in rows]`,
      );
  const byId = wf.eventSourced
    ? lines(
        `@router.get("/${slug}/instances/{id}", response_model=${T}InstanceResponse, operation_id="${camelId(opWorkflowInstanceById(wf.name))}"${errorResponsesKwarg("getById")})`,
        `async def ${slug}_instance(${idParam}, session: SessionDep) -> dict[str, object]:`,
        `    __stream = await ${fns.load}(session, ${idAsKey})`,
        "    if not __stream:",
        `        raise AggregateNotFoundError("not_found")`,
        `    row = ${fns.fold}(${idAsKey}, __stream)`,
        `    return {${proj("row")}}`,
      )
    : lines(
        `@router.get("/${slug}/instances/{id}", response_model=${T}InstanceResponse, operation_id="${camelId(opWorkflowInstanceById(wf.name))}"${errorResponsesKwarg("getById")})`,
        `async def ${slug}_instance(${idParam}, session: SessionDep) -> dict[str, object]:`,
        `    row = await session.get(${row}, id)`,
        "    if row is None:",
        `        raise AggregateNotFoundError("not_found")`,
        `    return {${proj("row")}}`,
      );
  return [list, byId].join("\n\n\n");
}

/** One saga-row field projected to its wire value.  Mirrors the aggregate
 *  `wireValue`: datetimes ISO-encode, everything else (id / enum stored as its
 *  value text / scalar) passes through the column verbatim.  Shared with the
 *  workflow-sourced view emitter (views-builder.ts). */
export function instanceFieldValue(rowVar: string, f: WireField): string {
  const attr = `${rowVar}.${snake(f.name)}`;
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "primitive" && t.name === "datetime") {
    return f.optional || f.type.kind === "optional"
      ? `(None if ${attr} is None else iso(${attr}))`
      : `iso(${attr})`;
  }
  if (t.kind === "primitive" && t.name === "money") {
    // Precise-decimal string on the wire (parity with the other backends).
    return f.optional || f.type.kind === "optional"
      ? `(None if ${attr} is None else money_str(${attr}))`
      : `money_str(${attr})`;
  }
  return attr;
}

// The Python leaf table for the shared workflow statement spine
// (`_workflow/stmt-target.ts`). One method per `WorkflowStmtIR` kind; the
// dispatch + `for-each` recursion live in the spine.  The table closes
// over the render context (saga handlers render `this.<state>` against
// the tracked row via `thisName: "state"`) and, when a context is
// given, threads the actor into currentUser-gated op-calls.
export function pyWorkflowStmtTarget(
  rctx: PyRenderContext = { thisName: "self" },
  ctx?: EnrichedBoundedContextIR,
  usedLets?: ReadonlySet<string>,
): WorkflowStmtTarget {
  return {
    indentUnit: "    ",
    precondition: (st, i) => [
      `${i}if ${renderPyNegatedGuard(st.expr, rctx)}:`,
      `${i}    raise DomainError(${JSON.stringify(`Precondition failed: ${st.source}`)})`,
    ],
    requires: (st, i) => [
      `${i}if ${renderPyNegatedGuard(st.expr, rctx)}:`,
      `${i}    raise ForbiddenError(${JSON.stringify(`Forbidden: ${st.source}`)})`,
    ],
    emit: (st, i) => {
      const kwargs = st.fields
        .map((f) => `${snake(f.name)}=${renderPyExpr(f.value, rctx)}`)
        .join(", ");
      return [`${i}workflow_events.append(${st.eventName}(${kwargs}))`];
    },
    factoryLet: (st, i) => {
      const kwargs = st.fields
        .map((f) => `${snake(f.name)}=${renderPyExpr(f.value, rctx)}`)
        .join(", ");
      return [`${i}${snake(st.name)} = ${st.aggName}.create(${kwargs})`];
    },
    repoLet: (st, i) => {
      const args = st.args.map((a) => renderPyExpr(a, rctx)).join(", ");
      return [`${i}${snake(st.name)} = await ${snake(st.repoName)}.${snake(st.method)}(${args})`];
    },
    repoRun: (st, i) => {
      const args = [
        ...st.retrievalArgs.map((a) => renderPyExpr(a, rctx)),
        ...(st.page?.offset ? [`offset=${renderPyExpr(st.page.offset, rctx)}`] : []),
        ...(st.page?.limit ? [`limit=${renderPyExpr(st.page.limit, rctx)}`] : []),
      ].join(", ");
      const call = `await ${snake(st.repoName)}.run_${snake(st.retrievalName)}(${args})`;
      // A `run` retrieval is a read (no exit-save), so a binding never read is
      // dead — keep the (still-awaited) call but drop the assignment, or ruff
      // rejects the unused local (F841).  Mirrors the `exprLet` arm.
      if (usedLets && !usedLets.has(st.name)) return [`${i}${call}`];
      return [`${i}${snake(st.name)} = ${call}`];
    },
    exprLet: (st, i) => {
      const rendered = renderPyExpr(st.expr, rctx);
      // A dead `let` (binding never read) would trip ruff F841 — drop the
      // assignment but keep the RHS, which is still side-effecting (a resource
      // get/fetch).  A bare resource-op renders as `(await …)`; strip the parens
      // so it's a statement, mirroring the `resourceCall` arm.
      if (usedLets && !usedLets.has(st.name)) {
        const bare = rendered.startsWith("(await ") ? rendered.slice(1, -1) : rendered;
        return [`${i}${bare}`];
      }
      return [`${i}${snake(st.name)} = ${rendered}`];
    },
    // `field := value` — own-state mutation.  Render the LHS as a synthetic
    // `this-prop` ref so it reuses the `state.<snake>` mapping (persisted
    // correlation row, `thisName = "state"`); the handler saves the row at exit.
    assign: (st, i) => {
      const lhs = renderPyExpr(
        { kind: "ref", name: st.target.segments[0]!, refKind: "this-prop", type: st.targetType },
        rctx,
      );
      return [`${i}${lhs} = ${renderPyExpr(st.value, rctx)}`];
    },
    opCall: (st, i) => {
      // A currentUser-gated op takes the actor as its trailing argument
      // (in scope: the route bound `current_user` for this workflow).
      const op = ctx ? lookupOp(ctx, st.aggName, st.op) : undefined;
      const args = [
        ...st.args.map((a) => renderPyExpr(a, rctx)),
        ...(op && operationUsesCurrentUser(op) ? ["current_user"] : []),
      ].join(", ");
      return [`${i}${snake(st.target)}.${snake(st.op)}(${args})`];
    },
    repoDelete: (st, i) => {
      // `<Repo>.delete(o)` → `await <repo>.delete(<entity>.id)`.  The generated
      // repository's `delete(id)` takes the aggregate's id token, so append
      // `.id`.  Repo var mirrors the repo-let arm (`snake(repoName)`).
      return [`${i}await ${snake(st.repoName)}.delete(${renderPyExpr(st.entity, rctx)}.id)`];
    },
    forEach: (st, i, body) => {
      const saves = st.savesPerIteration.map(
        (s) => `${i}    await ${snake(s.repoName)}.save(${snake(s.name)})`,
      );
      return [
        `${i}for ${snake(st.var)} in ${renderPyExpr(st.iterable, rctx)}:`,
        ...(body.length + saves.length > 0 ? [...body, ...saves] : [`${i}    pass`]),
      ];
    },
    ifLet: (st, i, thenLines, elseLines) => {
      // `if let o = Repo.find(<Criterion>) { … } else { … }` → run the shared
      // `find_all_by_<criterion>` retrieval with `limit=1`, take the first row
      // (or `None`), and branch.  Each branch's dirty bindings save inside it.
      const v = snake(st.var);
      const hits = `__${v}_hits`;
      const inner = `${i}    `;
      const args = [...st.retrievalArgs.map((a) => renderPyExpr(a, rctx)), "limit=1"].join(", ");
      const thenSaves = st.savesInThen.map(
        (s) => `${inner}await ${snake(s.repoName)}.save(${snake(s.name)})`,
      );
      const elseSaves = st.savesInElse.map(
        (s) => `${inner}await ${snake(s.repoName)}.save(${snake(s.name)})`,
      );
      const thenAll = [...thenLines, ...thenSaves];
      const elseAll = [...elseLines, ...elseSaves];
      const out = [
        `${i}${hits} = await ${snake(st.repoName)}.run_${snake(st.retrievalName)}(${args})`,
        `${i}${v} = ${hits}[0] if ${hits} else None`,
        `${i}if ${v} is not None:`,
        ...(thenAll.length > 0 ? thenAll : [`${inner}pass`]),
      ];
      if (elseAll.length > 0) out.push(`${i}else:`, ...elseAll);
      return out;
    },
    // Bare `<resource>.<verb>(...)` statement — render-expr wraps the
    // resource-op in `(await …)`; a bare statement drops the parens.
    resourceCall: (st, i) => {
      const rendered = renderPyExpr(st.call, rctx);
      const bare = rendered.startsWith("(await ") ? rendered.slice(1, -1) : rendered;
      return [`${i}${bare}`];
    },
    // Bare `Transfer.run(src, dst, amount)` domain-service call
    // (domain-services.md rev. 4, the `mutating` tier).  Renders the bare module
    // function (`run(src, dst, amount)`); a reading service is `(await …)` —
    // strip the wrapping parens so it's a statement, like `resourceCall`.  The
    // mutated args persist via the workflow's exit-saves (`session` unit-of-work
    // `commit()` at the route boundary).
    domainServiceCall: (st, i) => {
      const rendered = renderPyExpr(st.call, rctx);
      const bare = rendered.startsWith("(await ") ? rendered.slice(1, -1) : rendered;
      return [`${i}${bare}`];
    },
  };
}
