import { deriveEventSubscriptions } from "../../ir/enrich/enrichments.js";
import type {
  EnrichedBoundedContextIR,
  EventSubscriptionIR,
  ExprIR,
  SystemIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { renderWorkflowStmts } from "../_workflow/stmt-target.js";
import { renderPyExpr } from "./render-expr.js";
import { resourceImportLines } from "./resource-clients.js";
import { pyWorkflowStmtTarget } from "./workflows-builder.js";

// ---------------------------------------------------------------------------
// In-process event dispatch — `app/dispatch.py` (channels.md, the
// workflow-and-applier saga slice).  Emitted only when a channel in the
// deployable carries a subscribed event; channel-less projects keep the
// Noop dispatcher (byte-identical).
//
//   - One async handler per (workflow, trigger, event) subscription.
//     Correlation is persisted: a `create(e) by …` starter
//     loads-or-allocates its saga-state row (keyed by the correlation
//     field); an `on(e) by …` reactor routes to the existing row or
//     drops + logs `event_unrouted`.
//   - `InProcessDispatcher` isinstance-fans each event out to its
//     handlers, passing itself so a handler's own emits re-enter
//     (choreography chains run).
//   - `make_dispatcher(session)` is what routes/workflows/views
//     construct repositories with instead of the Noop.
//
// Durable channels (`retention: log | work` → the transactional-outbox
// tier) are a follow-up; this is the in-process tier.
// ---------------------------------------------------------------------------

export function dispatchSubscriptionsOf(ctx: EnrichedBoundedContextIR): EventSubscriptionIR[] {
  // Re-derive over the (possibly merged) context so a reactor in one
  // hosted context can route off a channel declared in another —
  // mirrors the Hono orchestrator's merged-union derivation.
  return deriveEventSubscriptions(ctx.channels, ctx.workflows);
}

export function buildPyDispatchFile(ctx: EnrichedBoundedContextIR, sys?: SystemIR): string | null {
  const subs = dispatchSubscriptionsOf(ctx);
  if (subs.length === 0) return null;

  const out: string[] = [];
  // Saga-state load/save helpers — once per correlation-bearing workflow
  // any handler touches.  ORM-instance style: load returns the tracked
  // row (mutations flush with the request's single commit); allocate
  // adds a fresh row.
  const helperDone = new Set<string>();
  const handlerByEvent = new Map<string, string[]>();
  const handlers: string[] = [];

  for (const sub of subs) {
    const wf = ctx.workflows.find((w) => w.name === sub.workflow);
    if (!wf) continue;
    if (wf.correlationField && !helperDone.has(wf.name)) {
      out.push(stateHelpers(wf), "");
      helperDone.add(wf.name);
    }
    const resolved = resolveHandlerBody(wf, sub);
    if (!resolved) continue;
    const fn = `_${snake(sub.workflow)}_${sub.trigger}_${snake(sub.event)}`;
    handlers.push(
      handlerFn(fn, wf, sub, resolved.correlation, resolved.statements, resolved.saves),
      "",
    );
    const list = handlerByEvent.get(sub.event) ?? [];
    list.push(fn);
    handlerByEvent.set(sub.event, list);
  }

  const dispatcher = lines(
    "class InProcessDispatcher:",
    '    """Routes each emitted event to its subscribed workflow handlers;',
    "    a handler's own emits re-enter, so choreography chains run.",
    '    """',
    "",
    "    def __init__(self, session: AsyncSession) -> None:",
    "        self._session = session",
    "",
    "    async def dispatch(self, event: DomainEvent) -> None:",
    ...[...handlerByEvent.entries()].flatMap(([event, fns], i) => [
      `        ${i === 0 ? "if" : "elif"} isinstance(event, ${event}):`,
      ...fns.map((fn) => `            await ${fn}(self._session, self, event)`),
    ]),
    "",
    "",
    "def make_dispatcher(session: AsyncSession) -> InProcessDispatcher:",
    "    return InProcessDispatcher(session)",
  );

  const body = lines(...out, ...handlers, dispatcher);
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const eventNames = [...new Set(subs.map((s) => s.event))].sort();
  const repoAggs = [
    ...new Set(
      subs.flatMap((sub) => {
        const wf = ctx.workflows.find((w) => w.name === sub.workflow);
        const r = wf ? resolveHandlerBody(wf, sub) : null;
        return r ? reposIn(r.statements, r.saves).map((x) => x.aggName) : [];
      }),
    ),
  ].sort();
  // `let x = Agg.create({...})` constructs the domain class directly.
  const factoryAggs = [
    ...new Set(
      subs.flatMap((sub) => {
        const wf = ctx.workflows.find((w) => w.name === sub.workflow);
        const r = wf ? resolveHandlerBody(wf, sub) : null;
        return r ? factoryAggsIn(r.statements) : [];
      }),
    ),
  ].sort();
  const handlerStmts = subs.flatMap((sub) => {
    const wf = ctx.workflows.find((w) => w.name === sub.workflow);
    const r = wf ? resolveHandlerBody(wf, sub) : null;
    return r ? r.statements : [];
  });
  const resourceImports = sys ? resourceImportLines(sys, handlerStmts) : [];
  const stateRows = [...helperDone].map((n) => `${n}Row`).sort();
  const idNames = ctx.aggregates
    .map((a) => `${a.name}Id`)
    .filter((n) => refersTo(n))
    .sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();

  return lines(
    `"""In-process event dispatch (channels.md).  Auto-generated."""`,
    "",
    refersTo("datetime") ? "from datetime import UTC, datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    "",
    "from sqlalchemy import select",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    stateRows.length > 0 ? `from app.db.schema import ${stateRows.join(", ")}` : null,
    refersTo("DomainError") ? "from app.domain.errors import DomainError" : null,
    `from app.domain.events import ${["DomainEvent", ...eventNames].join(", ")}`,
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    ...factoryAggs.map((n) => `from app.domain.${snake(n)} import ${n}`),
    ...resourceImports,
    refersTo("log") ? "from app.obs.log import log" : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    "",
    body,
    "",
  );
}

function resolveHandlerBody(
  wf: WorkflowIR,
  sub: EventSubscriptionIR,
): {
  correlation: ExprIR | undefined;
  statements: WorkflowStmtIR[];
  saves: { name: string; aggName: string; repoName: string }[];
} | null {
  if (sub.trigger === "on") {
    const on = (wf.subscriptions ?? []).find((o) => o.event === sub.event && o.param === sub.param);
    return on
      ? { correlation: on.correlation, statements: on.statements, saves: on.savesAtExit }
      : null;
  }
  const cr = wf.creates.find((c) => c.eventRef === sub.event && c.eventBinding === sub.param);
  return cr
    ? { correlation: cr.correlation, statements: cr.statements, saves: cr.savesAtExit }
    : null;
}

function reposIn(
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
): { repoName: string; aggName: string }[] {
  const out = new Map<string, { repoName: string; aggName: string }>();
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
  visit(statements);
  for (const s of saves) out.set(s.repoName, { repoName: s.repoName, aggName: s.aggName });
  return [...out.values()];
}

function factoryAggsIn(statements: WorkflowStmtIR[]): string[] {
  const out: string[] = [];
  const visit = (sts: WorkflowStmtIR[]): void => {
    for (const st of sts) {
      if (st.kind === "factory-let") out.push(st.aggName);
      if (st.kind === "for-each") visit(st.body);
    }
  };
  visit(statements);
  return out;
}

function stateHelpers(wf: WorkflowIR): string {
  const row = `${wf.name}Row`;
  const corr = snake(wf.correlationField as string);
  return lines(
    `async def _load_${snake(wf.name)}(session: AsyncSession, key: str) -> ${row} | None:`,
    `    return (`,
    `        await session.execute(select(${row}).where(${row}.${corr} == key).limit(1))`,
    "    ).scalars().first()",
  );
}

/** Allocation kwargs for a fresh instance: the correlation key plus a
 *  typed zero for each required non-key saga field. */
function allocateKwargs(wf: WorkflowIR): string {
  const corr = wf.correlationField as string;
  const parts = [`${snake(corr)}=__key`];
  for (const f of wf.stateFields ?? []) {
    if (f.name === corr || f.optional) continue;
    parts.push(`${snake(f.name)}=${zeroFor(f)}`);
  }
  return parts.join(", ");
}

function zeroFor(f: WorkflowIR["stateFields"] extends (infer T)[] | undefined ? T : never): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "0";
      case "decimal":
        return "0.0";
      case "money":
        return 'Decimal("0")';
      case "bool":
        return "False";
      case "datetime":
        return "datetime.now(UTC)";
      default:
        return '""';
    }
  }
  if (t.kind === "array") return "[]";
  return '""';
}

function handlerFn(
  fn: string,
  wf: WorkflowIR,
  sub: EventSubscriptionIR,
  correlation: ExprIR | undefined,
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
): string {
  const param = snake(sub.param);
  const out: string[] = [
    `async def ${fn}(`,
    `    session: AsyncSession, events: "InProcessDispatcher", ${param}: ${sub.event}`,
    ") -> None:",
  ];
  const persisted = !!wf.correlationField;
  // Persisted handlers render `this.<stateField>` against the tracked row.
  const rctx = persisted ? { thisName: "state" } : { thisName: "self" };
  if (persisted) {
    const corr = wf.correlationField as string;
    const keyExpr = correlation ? renderPyExpr(correlation, rctx) : `${param}.${snake(corr)}`;
    out.push(`    __key = str(${keyExpr})`);
    if (sub.trigger === "create") {
      // Load-or-allocate: a starter creates the instance if its key is new.
      out.push(`    state = await _load_${snake(wf.name)}(session, __key)`);
      out.push("    if state is None:");
      out.push(`        state = ${wf.name}Row(${allocateKwargs(wf)})`);
      out.push("        session.add(state)");
    } else {
      // Route-to-existing, else drop + log.
      out.push(`    state = await _load_${snake(wf.name)}(session, __key)`);
      out.push("    if state is None:");
      out.push(
        `        log("warn", "event_unrouted", workflow=${JSON.stringify(wf.name)}, event_type=${JSON.stringify(sub.event)}, key=__key)`,
      );
      out.push("        return");
    }
  }
  for (const r of reposIn(statements, saves)) {
    out.push(`    ${snake(r.repoName)} = ${r.aggName}Repository(session, events)`);
  }
  const hasEmit = statements.some((st) => st.kind === "emit");
  if (hasEmit) out.push("    workflow_events: list[DomainEvent] = []");
  out.push(...renderWorkflowStmts(statements, pyWorkflowStmtTarget(rctx), "    "));
  for (const save of saves) {
    out.push(`    await ${snake(save.repoName)}.save(${snake(save.name)})`);
  }
  if (persisted) out.push("    await session.flush()");
  if (hasEmit) {
    out.push("    for ev in workflow_events:");
    out.push("        await events.dispatch(ev)");
  }
  if (out[out.length - 1] === ") -> None:") out.push("    return None");
  return out.join("\n");
}
