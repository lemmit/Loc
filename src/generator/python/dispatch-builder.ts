import { deriveEventSubscriptions } from "../../ir/enrich/enrichments.js";
import type {
  EnrichedBoundedContextIR,
  EventIR,
  EventSubscriptionIR,
  ExprIR,
  ProjectionIR,
  ProjectionOnIR,
  SystemIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { durableEventTypes } from "../../ir/util/channels.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { statementSubRegions } from "../_trace/sourcemap.js";
import { renderWorkflowStmtChunks } from "../_workflow/stmt-target.js";
import type { OpFragment } from "./emit/aggregate.js";
import { renderPyExpr } from "./render-expr.js";
import { resourceImportLines } from "./resource-clients.js";
import {
  esEventRow,
  esFns,
  esWorkflowFoldBlock,
  renderApplierStmt,
} from "./workflow-eventsourced-emit.js";
import { collectUsedLetNames, pyWorkflowStmtTarget } from "./workflows-builder.js";

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
// Durable channels (`retention: log | work`) add the transactional-outbox
// tier on top: an `OutboxDispatcher` wraps the in-process one, recording
// durable events in `__loom_outbox` inside the request transaction; a
// background relay (`start_outbox_relay`, drained by `_run_outbox_relay`)
// redelivers them at-least-once through the in-process dispatcher, with
// `last_event_id` idempotent-consumer dedup on the saga rows
// (dispatch-delivery-semantics.md).  Ephemeral channels keep the
// at-most-once in-process path.
// ---------------------------------------------------------------------------

export function dispatchSubscriptionsOf(ctx: EnrichedBoundedContextIR): EventSubscriptionIR[] {
  // Re-derive over the (possibly merged) context so a reactor in one
  // hosted context can route off a channel declared in another —
  // mirrors the Hono orchestrator's merged-union derivation.
  return deriveEventSubscriptions(ctx.channels, ctx.workflows, ctx.projections);
}

export function buildPyDispatchFile(
  ctx: EnrichedBoundedContextIR,
  sys?: SystemIR,
  /** Source-map Milestone 12 — `app/dispatch.py` pools every reactor /
   *  event-create handler, so it never gets a whole-file region — only
   *  these fragment-only statement regions (mirrors `workflows_routes.py`'s
   *  `opFragments` at Milestone 11).  Allocated by the caller ONLY when a
   *  recorder is present, so a no-`--sourcemap` run pays no per-statement
   *  bookkeeping cost. */
  opFragments?: OpFragment[],
): string | null {
  const subs = dispatchSubscriptionsOf(ctx);
  if (subs.length === 0) return null;

  // Durable tier: events on a `retention: log | work` channel route
  // through `__loom_outbox` + the relay; saga rows gain `last_event_id`.
  const durableSet = durableEventTypes(ctx);
  const durableEvents = ctx.events.filter((e) => durableSet.has(e.name));
  const hasOutbox = durableEvents.length > 0;

  const out: string[] = [];
  // Saga-state load/save helpers — once per correlation-bearing workflow
  // any handler touches.  ORM-instance style: load returns the tracked
  // row (mutations flush with the request's single commit); allocate
  // adds a fresh row.
  const helperDone = new Set<string>();
  const handlerByEvent = new Map<string, string[]>();
  const handlers: string[] = [];

  const touchedProjections: ProjectionIR[] = [];
  for (const sub of subs) {
    // Projection fold (projection.md): a pure read-model fold, not a saga.
    // Load-or-allocate the row keyed by the correlation column, apply the fold
    // against `state`, flush.  Registered into the same isinstance fan-out.
    if (sub.projection) {
      const proj = ctx.projections.find((p) => p.name === sub.projection);
      if (!proj) continue;
      if (!helperDone.has(`proj:${proj.name}`)) {
        out.push(projectionStateHelper(proj), "");
        helperDone.add(`proj:${proj.name}`);
        touchedProjections.push(proj);
      }
      const on = proj.handlers.find((h) => h.event === sub.event && h.param === sub.param);
      if (!on) continue;
      const fn = `_proj_${snake(proj.name)}_${snake(sub.event)}`;
      handlers.push(projectionHandlerFn(fn, proj, on), "");
      const list = handlerByEvent.get(sub.event) ?? [];
      list.push(fn);
      handlerByEvent.set(sub.event, list);
      continue;
    }
    const wf = ctx.workflows.find((w) => w.name === sub.workflow);
    if (!wf) continue;
    if (wf.correlationField && !helperDone.has(wf.name)) {
      // Event-sourced workflows emit a fold block (state class + appliers +
      // fold/load/append/codec) instead of the mutable-row load/save helper.
      out.push(wf.eventSourced ? esWorkflowFoldBlock(wf, ctx) : stateHelpers(wf), "");
      helperDone.add(wf.name);
    }
    const resolved = resolveHandlerBody(wf, sub);
    if (!resolved) continue;
    const fn = `_${snake(sub.workflow)}_${sub.trigger}_${snake(sub.event)}`;
    const construct = `${ctx.name}.${wf.name}`;
    handlers.push(
      handlerFn(
        fn,
        wf,
        sub,
        resolved.correlation,
        resolved.statements,
        resolved.saves,
        hasOutbox,
        construct,
        opFragments,
      ),
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
    hasOutbox
      ? 'def make_dispatcher(session: AsyncSession) -> "OutboxDispatcher":'
      : "def make_dispatcher(session: AsyncSession) -> InProcessDispatcher:",
    hasOutbox
      ? "    return OutboxDispatcher(session, InProcessDispatcher(session))"
      : "    return InProcessDispatcher(session)",
  );

  const body = lines(
    ...out,
    ...handlers,
    dispatcher,
    ...(hasOutbox ? ["", "", outboxBlock(durableEvents)] : []),
  );
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
  // An event-sourced workflow's schema model is its `<Wf>EventRow` stream,
  // not a mutable `<Wf>Row` correlation row.
  const touchedWorkflows = [...helperDone]
    .map((n) => ctx.workflows.find((w) => w.name === n))
    .filter((w): w is WorkflowIR => w != null);
  const stateRows = touchedWorkflows.map((w) =>
    w.eventSourced ? esEventRow(ctx) : `${w.name}Row`,
  );
  const projRows = touchedProjections.map((p) => `${p.name}Row`);
  // Dedupe: multiple ES workflows in one context now share the single
  // per-context `<Ctx>EventRow` class, so the import must not list it twice.
  const schemaRows = [
    ...new Set([...stateRows, ...projRows, ...(hasOutbox ? ["LoomOutboxRow"] : [])]),
  ].sort();
  // The folded events of an ES workflow are constructed/dispatched in its
  // codec + isinstance fold, so import them alongside the subscribed events.
  const esEventNames = touchedWorkflows
    .filter((w) => w.eventSourced)
    .flatMap((w) => (w.appliers ?? []).map((a) => a.event));
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
    hasOutbox ? "import asyncio" : null,
    refersTo("math") ? "import math" : null,
    hasOutbox ? "from contextvars import ContextVar" : null,
    refersTo("datetime") ? "from datetime import UTC, datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("cast") ? "from typing import cast" : null,
    "",
    `from sqlalchemy import ${[
      "select",
      ...(refersTo("func") ? ["func"] : []),
      ...(hasOutbox ? ["update"] : []),
    ]
      .sort()
      .join(", ")}`,
    refersTo("insert") ? "from sqlalchemy.dialects.postgresql import insert" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    hasOutbox ? "from app.db.engine import engine" : null,
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    schemaRows.length > 0 ? `from app.db.schema import ${schemaRows.join(", ")}` : null,
    refersTo("DomainError") ? "from app.domain.errors import DomainError" : null,
    `from app.domain.events import ${[
      "DomainEvent",
      ...[...new Set([...eventNames, ...esEventNames])].sort(),
    ].join(", ")}`,
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    ...factoryAggs.map((n) => `from app.domain.${snake(n)} import ${n}`),
    ...resourceImports,
    // `in_child_context` frames workflow reactor handlers; `log` is the reactor
    // drop-log.  A projection-only dispatch file uses neither (pure folds), so
    // both are conditional to keep the import free of dead names.
    (() => {
      const names = [
        refersTo("in_child_context") ? "in_child_context" : null,
        refersTo("log") ? "log" : null,
      ].filter((x): x is string => x != null);
      return names.length > 0 ? `from app.obs.log import ${names.join(", ")}` : null;
    })(),
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

/** Projection row loader (mirrors `stateHelpers`) — selects the read-model row
 *  by its correlation key. */
function projectionStateHelper(proj: ProjectionIR): string {
  const row = `${proj.name}Row`;
  const corr = snake(proj.correlationField);
  return lines(
    `async def _load_${snake(proj.name)}(session: AsyncSession, key: str) -> ${row} | None:`,
    `    return (`,
    `        await session.execute(select(${row}).where(${row}.${corr} == key).limit(1))`,
    "    ).scalars().first()",
  );
}

/** One pure projection fold handler: load-or-allocate the row for the event's
 *  key (every handler allocates — a projection has no route-or-drop split),
 *  apply the fold assignments against `state`, flush.  Pure — no repos, no
 *  emit, no child-context frame (enforced by `loom.projection-fold-impure`). */
function projectionHandlerFn(fn: string, proj: ProjectionIR, on: ProjectionOnIR): string {
  const row = `${proj.name}Row`;
  const corr = snake(proj.correlationField);
  const param = snake(on.param);
  const keyExpr = on.correlation
    ? renderPyExpr(on.correlation, { thisName: "state" })
    : `${param}.${corr}`;
  const out: string[] = [
    `async def ${fn}(`,
    `    session: AsyncSession, _events: "InProcessDispatcher", ${param}: ${on.event}`,
    ") -> None:",
    `    __key = str(${keyExpr})`,
    `    state = await _load_${snake(proj.name)}(session, __key)`,
    "    if state is None:",
    `        state = ${row}(${corr}=__key)`,
    "        session.add(state)",
  ];
  for (const stmt of on.statements) {
    if (stmt.kind === "assign" || stmt.kind === "add" || stmt.kind === "remove") {
      out.push(renderApplierStmt(stmt, "    "));
    }
  }
  out.push("    await session.flush()");
  return lines(...out);
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
  hasOutbox: boolean,
  construct: string,
  /** Source-map Milestone 12 — see `buildPyDispatchFile`'s `opFragments`. */
  opFragments?: OpFragment[],
): string {
  if (wf.correlationField && wf.eventSourced) {
    return esHandlerFn(
      fn,
      wf,
      sub,
      correlation,
      statements,
      saves,
      hasOutbox,
      construct,
      opFragments,
    );
  }
  const param = snake(sub.param);
  // A reactor is a per-dispatch boundary: run it in a child execution-context
  // frame (fresh scope_id, parent_id ← the dispatching request's scope) so its
  // audit / provenance rows record their call-structure position.
  const out: string[] = [
    "@in_child_context",
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
    // Idempotent-consumer dedup (dispatch-delivery-semantics.md §3): the
    // relay redelivers at-least-once, so a row already stamped with this
    // event id is a no-op; otherwise claim it before running the body.
    if (hasOutbox) {
      out.push("    __eid = _current_event_id.get()");
      out.push("    if __eid is not None:");
      out.push("        if state.last_event_id == __eid:");
      out.push("            return");
      out.push("        state.last_event_id = __eid");
    }
  }
  for (const r of reposIn(statements, saves)) {
    out.push(`    ${snake(r.repoName)} = ${r.aggName}Repository(session, events)`);
  }
  const hasEmit = statements.some((st) => st.kind === "emit");
  if (hasEmit) out.push("    workflow_events: list[DomainEvent] = []");
  // Chunked (one lines-array per top-level statement) rather than the
  // pre-flattened `renderWorkflowStmts` — byte-identical either way, but the
  // per-chunk list lets us surface per-statement sub-regions to the caller
  // (source-map Milestone 12, mirrors `workflowRoute`'s `stmtChunks`).  No
  // re-indent transform sits between here and the final file, so the chunk
  // texts collected here are already the exact text that lands in
  // `app/dispatch.py`.
  const stmtChunks = renderWorkflowStmtChunks(
    statements,
    pyWorkflowStmtTarget(rctx, undefined, collectUsedLetNames(statements)),
    "    ",
  );
  out.push(...stmtChunks.flat());
  if (opFragments) {
    const chunkTexts = stmtChunks.map((ls) => ls.join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(statements, chunkTexts, construct),
      });
    }
  }
  for (const save of saves) {
    out.push(`    await ${snake(save.repoName)}.save(${snake(save.name)})`);
  }
  if (persisted) out.push("    await session.flush()");
  if (hasEmit) {
    out.push("    for ev in workflow_events:");
    // A handler's own emit is a fresh event, never an outbox redelivery —
    // dispatch it with the relayed id cleared so chained handlers don't
    // dedup against it (`_dispatch_chained` resets `_current_event_id`).
    out.push(
      hasOutbox
        ? "        await _dispatch_chained(events, ev)"
        : "        await events.dispatch(ev)",
    );
  }
  if (out[out.length - 1] === ") -> None:") out.push("    return None");
  return out.join("\n");
}

/** The event-sourced handler (workflow-and-applier.md A2-S5b): fold the
 *  `<wf>_events` stream into `state` on load, run the emit-only body against
 *  that folded snapshot, append the workflow's own events gap-free, then
 *  re-publish for choreography.  The saga analogue of the aggregate event
 *  store — there is no mutable correlation row. */
function esHandlerFn(
  fn: string,
  wf: WorkflowIR,
  sub: EventSubscriptionIR,
  correlation: ExprIR | undefined,
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
  hasOutbox: boolean,
  construct: string,
  /** Source-map Milestone 12 — see `buildPyDispatchFile`'s `opFragments`. */
  opFragments?: OpFragment[],
): string {
  const param = snake(sub.param);
  const corr = wf.correlationField as string;
  const fns = esFns(wf);
  const rctx = { thisName: "state" } as const;
  const keyExpr = correlation ? renderPyExpr(correlation, rctx) : `${param}.${snake(corr)}`;
  // Render the body up front (chunked, one lines-array per top-level
  // statement) so we know whether it reads the folded snapshot (a starter
  // that only emits constants never touches `state`) — folding is a pure
  // no-op then, so we skip the unused binding (ruff F841).  The chunk list
  // also lets us surface per-statement sub-regions (source-map Milestone 12).
  const stmtChunks = renderWorkflowStmtChunks(
    statements,
    pyWorkflowStmtTarget(rctx, undefined, collectUsedLetNames(statements)),
    "    ",
  );
  const bodyLines = stmtChunks.flat();
  const usesState = bodyLines.some((l) => /\bstate\b/.test(l));
  // A `create` starter that shares its event with an `on` reactor on the same
  // workflow (S5b) must no-op when the stream ALREADY exists — the inverse of
  // the `on` emptiness guard — so the event folds once, not twice.  A starter
  // with no paired `on` stays byte-identical.
  const guardStreamExists =
    sub.trigger === "create" && (wf.subscriptions ?? []).some((o) => o.event === sub.event);
  const out: string[] = [
    "@in_child_context",
    `async def ${fn}(`,
    `    session: AsyncSession, events: "InProcessDispatcher", ${param}: ${sub.event}`,
    ") -> None:",
    `    __key = str(${keyExpr})`,
  ];
  // `__events` is needed by an `on` reactor's empty-stream check (always), a
  // guarded starter's stream-exists check (always), and the fold (only when the
  // body reads state) — skip the load otherwise.
  if (sub.trigger === "on" || guardStreamExists || usesState) {
    out.push(`    __events = await ${fns.load}(session, __key)`);
  }
  if (sub.trigger === "on") {
    // A continuation needs a started saga (non-empty stream); else drop + log.
    out.push("    if not __events:");
    out.push(
      `        log("warn", "event_unrouted", workflow=${JSON.stringify(wf.name)}, event_type=${JSON.stringify(sub.event)}, key=__key)`,
    );
    out.push("        return");
  } else if (guardStreamExists) {
    // Inverse of the `on` guard: a non-empty stream means the paired `on`
    // reactor already handles this event — the starter must not re-append.
    out.push("    if __events:");
    out.push(
      `        log("warn", "event_unrouted", workflow=${JSON.stringify(wf.name)}, event_type=${JSON.stringify(sub.event)}, key=__key)`,
    );
    out.push("        return");
  }
  if (usesState) out.push(`    state = ${fns.fold}(__key, __events)`);
  for (const r of reposIn(statements, saves)) {
    out.push(`    ${snake(r.repoName)} = ${r.aggName}Repository(session, events)`);
  }
  const hasEmit = statements.some((st) => st.kind === "emit");
  if (hasEmit) out.push("    workflow_events: list[DomainEvent] = []");
  out.push(...bodyLines);
  if (opFragments) {
    const chunkTexts = stmtChunks.map((ls) => ls.join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(statements, chunkTexts, construct),
      });
    }
  }
  for (const save of saves) {
    out.push(`    await ${snake(save.repoName)}.save(${snake(save.name)})`);
  }
  // Every emit in an ES workflow has an applier (A1 discipline), so the
  // emitted events ARE the workflow's own stream — append them gap-free.
  if (hasEmit) out.push(`    await ${fns.append}(session, __key, workflow_events)`);
  out.push("    await session.flush()");
  if (hasEmit) {
    out.push("    for ev in workflow_events:");
    out.push(
      hasOutbox
        ? "        await _dispatch_chained(events, ev)"
        : "        await events.dispatch(ev)",
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Durable-channel outbox tier (`retention: log | work`).
// ---------------------------------------------------------------------------

/** The `OutboxDispatcher` wrapper + payload (de)serialisers + the polling
 *  relay.  `make_dispatcher` returns the wrapper, so durable events drained
 *  from an aggregate land in `__loom_outbox` inside the request
 *  transaction; the relay redelivers them through the in-process
 *  dispatcher at-least-once, ordered by `occurred_at`, dead-lettering
 *  after `max_attempts`. */
function outboxBlock(durableEvents: EventIR[]): string {
  const toArms = durableEvents.flatMap((ev, i) => [
    `    ${i === 0 ? "if" : "elif"} isinstance(event, ${ev.name}):`,
    `        return {${ev.fields.map((f) => `"${f.name}": ${toPayload(`event.${snake(f.name)}`, f.type)}`).join(", ")}}`,
  ]);
  const fromArms = durableEvents.flatMap((ev, i) => [
    `    ${i === 0 ? "if" : "elif"} event_type == "${ev.name}":`,
    `        return ${ev.name}(${ev.fields.map((f) => `${snake(f.name)}=${fromPayload(f.name, f.type)}`).join(", ")})`,
  ]);
  return lines(
    `_DURABLE_EVENT_TYPES: frozenset[str] = frozenset({${durableEvents.map((e) => `"${e.name}"`).join(", ")}})`,
    "",
    `_current_event_id: ContextVar[str | None] = ContextVar("loom_outbox_event_id", default=None)`,
    "",
    "",
    "class OutboxDispatcher:",
    `    """Durable tier (dispatch-delivery-semantics.md): events on a`,
    "    `retention: log | work` channel are recorded in __loom_outbox inside",
    "    the request transaction; the relay delivers them at-least-once.",
    "    Ephemeral events dispatch in-process (at-most-once).",
    `    """`,
    "",
    "    def __init__(self, session: AsyncSession, inner: InProcessDispatcher) -> None:",
    "        self._session = session",
    "        self._inner = inner",
    "",
    "    async def dispatch(self, event: DomainEvent) -> None:",
    "        if event.type in _DURABLE_EVENT_TYPES:",
    "            self._session.add(LoomOutboxRow(type=event.type, payload=_event_to_payload(event)))",
    "            return",
    "        await self._inner.dispatch(event)",
    "",
    "",
    "async def _dispatch_chained(events: InProcessDispatcher, event: DomainEvent) -> None:",
    `    """Re-emit a handler's own event with the redelivery id cleared — a`,
    "    fresh emit is never an outbox redelivery, so chained handlers must",
    "    not dedup it against the relayed event's id.",
    `    """`,
    "    token = _current_event_id.set(None)",
    "    try:",
    "        await events.dispatch(event)",
    "    finally:",
    "        _current_event_id.reset(token)",
    "",
    "",
    "def _event_to_payload(event: DomainEvent) -> dict[str, object]:",
    ...toArms,
    `    raise ValueError(f"unknown durable event: {type(event).__name__}")`,
    "",
    "",
    "def _event_from_payload(event_type: str, payload: dict[str, object]) -> DomainEvent:",
    ...fromArms,
    `    raise ValueError(f"unknown durable event type: {event_type}")`,
    "",
    "",
    "async def _drain_outbox(max_attempts: int, batch_size: int) -> None:",
    "    async with AsyncSession(engine) as session:",
    "        rows = (",
    "            await session.execute(",
    "                select(LoomOutboxRow)",
    "                .where(LoomOutboxRow.dispatched_at.is_(None))",
    "                .where(LoomOutboxRow.attempts < max_attempts)",
    "                .order_by(LoomOutboxRow.occurred_at.asc())",
    "                .limit(batch_size)",
    "            )",
    "        ).scalars().all()",
    "        pending = [",
    "            (str(r.id), r.type, cast(dict[str, object], r.payload), r.attempts) for r in rows",
    "        ]",
    "    for event_id, event_type, payload, attempts in pending:",
    "        token = _current_event_id.set(event_id)",
    "        try:",
    "            async with AsyncSession(engine) as session:",
    "                await InProcessDispatcher(session).dispatch(",
    "                    _event_from_payload(event_type, payload)",
    "                )",
    "                await session.execute(",
    "                    update(LoomOutboxRow)",
    "                    .where(LoomOutboxRow.id == event_id)",
    "                    .values(dispatched_at=datetime.now(UTC))",
    "                )",
    "                await session.commit()",
    "        except Exception as exc:  # noqa: BLE001 — relay isolates one row's failure",
    "            next_attempts = attempts + 1",
    "            async with AsyncSession(engine) as fail_session:",
    "                await fail_session.execute(",
    "                    update(LoomOutboxRow)",
    "                    .where(LoomOutboxRow.id == event_id)",
    "                    .values(attempts=next_attempts)",
    "                )",
    "                await fail_session.commit()",
    "            if next_attempts >= max_attempts:",
    `                log("warn", "event_dead_lettered", type=event_type, attempts=next_attempts, error=str(exc))`,
    "        finally:",
    "            _current_event_id.reset(token)",
    "",
    "",
    "async def _run_outbox_relay(",
    "    interval: float = 0.5, max_attempts: int = 5, batch_size: int = 50",
    ") -> None:",
    `    """Background relay: drains undispatched __loom_outbox rows in`,
    "    occurred_at order through the in-process dispatcher (at-least-once).",
    `    """`,
    "    while True:",
    "        try:",
    "            await _drain_outbox(max_attempts, batch_size)",
    "        except Exception as exc:  # noqa: BLE001 — keep the relay alive",
    `            log("warn", "outbox_relay_error", error=str(exc))`,
    "        await asyncio.sleep(interval)",
    "",
    "",
    `def start_outbox_relay() -> "asyncio.Task[None]":`,
    "    return asyncio.create_task(_run_outbox_relay())",
  );
}

/** Domain-event field → its JSON-safe payload value (DSL-keyed, mirrors
 *  the event-sourcing store's `_event_to_data`). */
function toPayload(expr: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "primitive" && inner.name === "datetime") return `${expr}.isoformat()`;
  if (inner.kind === "primitive" && inner.name === "money") return `str(${expr})`;
  return expr;
}

/** Payload value → typed domain-event field (mirror of `toPayload`). */
function fromPayload(name: string, t: TypeIR): string {
  const access = `payload["${name}"]`;
  const inner = t.kind === "optional" ? t.inner : t;
  switch (inner.kind) {
    case "primitive":
      switch (inner.name) {
        case "int":
        case "long":
          return `cast(int, ${access})`;
        case "decimal":
          return `float(cast("int | float", ${access}))`;
        case "money":
          return `Decimal(cast(str, ${access}))`;
        case "bool":
          return `cast(bool, ${access})`;
        case "datetime":
          return `datetime.fromisoformat(cast(str, ${access}))`;
        default:
          return `cast(str, ${access})`;
      }
    case "id":
      return `${inner.targetName}Id(cast(str, ${access}))`;
    case "enum":
      return `${inner.name}(cast(str, ${access}))`;
    default:
      return `cast(str, ${access})`;
  }
}
