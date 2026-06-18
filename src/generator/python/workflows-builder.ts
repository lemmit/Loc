import {
  type BoundedContextIR,
  type EnrichedBoundedContextIR,
  type OperationIR,
  operationUsesCurrentUser,
  type SystemIR,
  type WireField,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowIsGuarded,
  workflowUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import {
  camelId,
  opWorkflow,
  opWorkflowInstanceById,
  opWorkflowInstances,
} from "../../ir/util/openapi-ids.js";
import { resolveWorkflowIsolation } from "../../ir/util/resolve-datasource.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import { renderWorkflowStmts, type WorkflowStmtTarget } from "../_workflow/stmt-target.js";
import { responsePyType } from "./emit/http-models.js";
import { type PyRenderContext, renderPyExpr } from "./render-expr.js";
import { resourceImportLines } from "./resource-clients.js";
import { errorResponsesKwarg, pyWireToDomain, requestFieldDecl } from "./routes-builder.js";

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

function emitsCommandRoute(wf: WorkflowIR): boolean {
  const facade =
    wf.creates.find((c) => c.name === null && c.triggerKind === "command") ?? wf.creates[0];
  return !facade || facade.triggerKind === "command";
}

export function commandWorkflowsOf(ctx: EnrichedBoundedContextIR): WorkflowIR[] {
  return ctx.workflows.filter(emitsCommandRoute);
}

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
    ...wfs.map((wf) => workflowRoute(wf, ctx, dispatcherExpr, sys)),
    ...obsWfs.map((wf) => instanceRoutes(wf)),
  ];
  const routes = routeBlocks.join("\n\n\n");
  const body = `${models}${instanceModels}router = APIRouter(prefix="/workflows", tags=["workflows"])\n\n\n${routes}`;

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
    `from pydantic import ${["BaseModel", refersTo("RootModel") ? "RootModel" : null].filter(Boolean).join(", ")}`,
    refersTo("select") ? "from sqlalchemy import select" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    anyUser ? "from app.auth.user import User" : null,
    "from app.db.engine import get_session",
    ...resourceImports,
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    obsWfs.length > 0
      ? `from app.db.schema import ${obsWfs
          .map((wf) => `${wf.name}Row`)
          .sort()
          .join(", ")}`
      : null,
    refersTo("iso") ? "from app.db.wire import iso" : null,
    hasDispatch ? "from app.dispatch import make_dispatcher" : null,
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

function workflowRoute(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  dispatcherExpr: string,
  sys?: SystemIR,
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
    `async def ${snake(wf.name)}_workflow(${sig}) -> Response:`,
    ...(usesUser ? ["    current_user: User = request.state.current_user"] : []),
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
  const repos = reposFor(wf);
  for (const r of repos) {
    out.push(`    ${snake(r.repoName)} = ${r.aggName}Repository(session, ${dispatcherExpr})`);
  }
  const hasEmit = collectEmits(wf.statements).length > 0;
  if (hasEmit) out.push("    workflow_events: list[DomainEvent] = []");
  out.push(...renderWorkflowStmts(wf.statements, pyWorkflowStmtTarget(undefined, ctx), "    "));
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
  const list = lines(
    `@router.get("/${slug}/instances", response_model=${T}InstanceListResponse, operation_id="${camelId(opWorkflowInstances(wf.name))}")`,
    `async def ${slug}_instances(session: SessionDep) -> list[dict[str, object]]:`,
    `    rows = (await session.execute(select(${row}))).scalars().all()`,
    `    return [{${proj("row")}} for row in rows]`,
  );
  const byId = lines(
    `@router.get("/${slug}/instances/{id}", response_model=${T}InstanceResponse, operation_id="${camelId(opWorkflowInstanceById(wf.name))}"${errorResponsesKwarg("getById")})`,
    `async def ${slug}_instance(id: str, session: SessionDep) -> dict[str, object]:`,
    `    row = await session.get(${row}, id)`,
    "    if row is None:",
    `        raise AggregateNotFoundError("not_found")`,
    `    return {${proj("row")}}`,
  );
  return [list, byId].join("\n\n\n");
}

/** One saga-row field projected to its wire value.  Mirrors the aggregate
 *  `wireValue`: datetimes ISO-encode, everything else (id / enum stored as its
 *  value text / scalar) passes through the column verbatim. */
function instanceFieldValue(rowVar: string, f: WireField): string {
  const attr = `${rowVar}.${snake(f.name)}`;
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "primitive" && t.name === "datetime") {
    return f.optional || f.type.kind === "optional"
      ? `(None if ${attr} is None else iso(${attr}))`
      : `iso(${attr})`;
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
): WorkflowStmtTarget {
  return {
    indentUnit: "    ",
    precondition: (st, i) => [
      `${i}if not (${renderPyExpr(st.expr, rctx)}):`,
      `${i}    raise DomainError(${JSON.stringify(`Precondition failed: ${st.source}`)})`,
    ],
    requires: (st, i) => [
      `${i}if not (${renderPyExpr(st.expr, rctx)}):`,
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
      return [
        `${i}${snake(st.name)} = await ${snake(st.repoName)}.run_${snake(st.retrievalName)}(${args})`,
      ];
    },
    exprLet: (st, i) => [`${i}${snake(st.name)} = ${renderPyExpr(st.expr, rctx)}`],
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
  };
}
