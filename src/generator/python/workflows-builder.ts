import {
  type BoundedContextIR,
  type EnrichedBoundedContextIR,
  type OperationIR,
  operationUsesCurrentUser,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowIsGuarded,
  workflowUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import { camelId, opWorkflow } from "../../ir/util/openapi-ids.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import { requestPyType } from "./emit/http-models.js";
import { type PyRenderContext, renderPyExpr } from "./render-expr.js";
import { pyWireToDomain } from "./routes-builder.js";

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
// correlation state tables) are S15b — `emitsCommandRoute` mirrors the
// Hono facade rule, so reactor-only workflows emit nothing here.
// ---------------------------------------------------------------------------

function emitsCommandRoute(wf: WorkflowIR): boolean {
  const facade =
    wf.creates.find((c) => c.name === null && c.triggerKind === "command") ?? wf.creates[0];
  return !facade || facade.triggerKind === "command";
}

export function commandWorkflowsOf(ctx: EnrichedBoundedContextIR): WorkflowIR[] {
  return ctx.workflows.filter(emitsCommandRoute);
}

export function buildPyWorkflowsFile(
  ctx: EnrichedBoundedContextIR,
  hasDispatch = false,
): string | null {
  const wfs = commandWorkflowsOf(ctx);
  if (wfs.length === 0) return null;
  const dispatcherExpr = hasDispatch ? "make_dispatcher(session)" : "NoopDomainEventDispatcher()";
  const anyUser = wfs.some(
    (wf) => workflowUsesCurrentUser(wf) || callsUserGatedOp(wf.statements, ctx),
  );

  const models = wfs
    .map((wf) =>
      lines(
        `class ${upperFirst(wf.name)}Request(BaseModel):`,
        wf.params.length > 0
          ? wf.params.map((p) => `    ${p.name}: ${requestPyType(p.type, ctx)}`)
          : ["    pass"],
        "",
        "",
      ),
    )
    .join("");

  const routes = wfs.map((wf) => workflowRoute(wf, ctx, dispatcherExpr)).join("\n\n\n");
  const body = `${models}router = APIRouter(prefix="/workflows", tags=["workflows"])\n\n\n${routes}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const repoAggs = [...new Set(wfs.flatMap((wf) => reposFor(wf).map((r) => r.aggName)))].sort();
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
    refersTo("datetime") ? "from datetime import UTC, datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    `from fastapi import APIRouter, Depends, ${anyUser ? "Request, " : ""}Response`,
    "from pydantic import BaseModel",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    anyUser ? "from app.auth.user import User" : null,
    "from app.db.engine import get_session",
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    hasDispatch ? "from app.dispatch import make_dispatcher" : null,
    refersTo("DomainError") || refersTo("ForbiddenError")
      ? `from app.domain.errors import ${[
          refersTo("DomainError") ? "DomainError" : null,
          refersTo("ForbiddenError") ? "ForbiddenError" : null,
        ]
          .filter(Boolean)
          .join(", ")}`
      : null,
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
    hasDispatch ? null : "NoopDomainEventDispatcher",
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
      if (st.kind === "repo-let" || st.kind === "repo-run") {
        out.set(st.repoName, { repoName: st.repoName, aggName: st.aggName });
      }
      if (st.kind === "for-each") {
        visit(st.body);
        for (const s of st.savesPerIteration) {
          out.set(s.repoName, { repoName: s.repoName, aggName: s.aggName });
        }
      }
    }
  };
  visit(wf.statements);
  for (const s of wf.savesAtExit) out.set(s.repoName, { repoName: s.repoName, aggName: s.aggName });
  return [...out.values()];
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

function workflowRoute(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  dispatcherExpr: string,
): string {
  // A `requires`-guarded workflow declares its 403 outcome; a
  // currentUser-referencing one binds the actor off the request scope
  // before any rendered statement mentions the bare `current_user`.
  const usesUser = workflowUsesCurrentUser(wf) || callsUserGatedOp(wf.statements, ctx);
  const forbidden = workflowIsGuarded(wf) ? ', responses={403: {"description": "Forbidden"}}' : "";
  const sig = [
    `body: ${upperFirst(wf.name)}Request`,
    ...(usesUser ? ["request: Request"] : []),
    "session: SessionDep",
  ].join(", ");
  const out: string[] = [
    `@router.post("/${snake(wf.name)}", status_code=204, operation_id="${camelId(opWorkflow(wf.name))}"${forbidden})`,
    `async def ${snake(wf.name)}_workflow(${sig}) -> Response:`,
    ...(usesUser ? ["    current_user: User = request.state.current_user"] : []),
  ];
  // Wire params → domain locals (brand ids, build VOs) once up front.
  for (const p of wf.params) {
    out.push(`    ${snake(p.name)} = ${pyWireToDomain(`body.${p.name}`, p.type, ctx)}`);
  }
  const repos = reposFor(wf);
  for (const r of repos) {
    out.push(`    ${snake(r.repoName)} = ${r.aggName}Repository(session, ${dispatcherExpr})`);
  }
  const hasEmit = collectEmits(wf.statements).length > 0;
  if (hasEmit) out.push("    workflow_events: list[DomainEvent] = []");
  for (const st of wf.statements) {
    out.push(...renderWorkflowStmt(st, "    ", undefined, ctx));
  }
  for (const save of wf.savesAtExit) {
    out.push(`    await ${snake(save.repoName)}.save(${snake(save.name)})`);
  }
  if (hasEmit) {
    out.push(`    dispatcher = ${dispatcherExpr}`);
    out.push("    for ev in workflow_events:");
    out.push("        await dispatcher.dispatch(ev)");
  }
  out.push("    return Response(status_code=204)");
  return out.join("\n");
}

export function renderWorkflowStmt(
  st: WorkflowStmtIR,
  i: string,
  rctx: PyRenderContext = { thisName: "self" },
  ctx?: EnrichedBoundedContextIR,
): string[] {
  switch (st.kind) {
    case "precondition":
      return [
        `${i}if not (${renderPyExpr(st.expr, rctx)}):`,
        `${i}    raise DomainError(${JSON.stringify(`Precondition failed: ${st.source}`)})`,
      ];
    case "requires":
      return [
        `${i}if not (${renderPyExpr(st.expr, rctx)}):`,
        `${i}    raise ForbiddenError(${JSON.stringify(`Forbidden: ${st.source}`)})`,
      ];
    case "emit": {
      const kwargs = st.fields
        .map((f) => `${snake(f.name)}=${renderPyExpr(f.value, rctx)}`)
        .join(", ");
      return [`${i}workflow_events.append(${st.eventName}(${kwargs}))`];
    }
    case "factory-let": {
      const kwargs = st.fields
        .map((f) => `${snake(f.name)}=${renderPyExpr(f.value, rctx)}`)
        .join(", ");
      return [`${i}${snake(st.name)} = ${st.aggName}.create(${kwargs})`];
    }
    case "repo-let": {
      const args = st.args.map((a) => renderPyExpr(a, rctx)).join(", ");
      return [`${i}${snake(st.name)} = await ${snake(st.repoName)}.${snake(st.method)}(${args})`];
    }
    case "repo-run": {
      const args = [
        ...st.retrievalArgs.map((a) => renderPyExpr(a, rctx)),
        ...(st.page?.offset ? [`offset=${renderPyExpr(st.page.offset, rctx)}`] : []),
        ...(st.page?.limit ? [`limit=${renderPyExpr(st.page.limit, rctx)}`] : []),
      ].join(", ");
      return [
        `${i}${snake(st.name)} = await ${snake(st.repoName)}.run_${snake(st.retrievalName)}(${args})`,
      ];
    }
    case "expr-let":
      return [`${i}${snake(st.name)} = ${renderPyExpr(st.expr, rctx)}`];
    case "op-call": {
      // A currentUser-gated op takes the actor as its trailing argument
      // (in scope: the route bound `current_user` for this workflow).
      const op = ctx ? lookupOp(ctx, st.aggName, st.op) : undefined;
      const args = [
        ...st.args.map((a) => renderPyExpr(a, rctx)),
        ...(op && operationUsesCurrentUser(op) ? ["current_user"] : []),
      ].join(", ");
      return [`${i}${snake(st.target)}.${snake(st.op)}(${args})`];
    }
    case "for-each": {
      const body = st.body.flatMap((s) => renderWorkflowStmt(s, `${i}    `, rctx, ctx));
      const saves = st.savesPerIteration.map(
        (s) => `${i}    await ${snake(s.repoName)}.save(${snake(s.name)})`,
      );
      return [
        `${i}for ${snake(st.var)} in ${renderPyExpr(st.iterable, rctx)}:`,
        ...(body.length + saves.length > 0 ? [...body, ...saves] : [`${i}    pass`]),
      ];
    }
    case "resource-call":
      // Resource adapters land with S16 — surface loudly, not silently.
      return [`${i}raise NotImplementedError("resource operations land with the extern slice")`];
  }
}
