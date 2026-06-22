import type {
  EnrichedBoundedContextIR,
  EventSubscriptionIR,
  ExprIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";
import { renderWorkflowStmts } from "../../_workflow/stmt-target.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";
import { javaWorkflowStmtTarget, repoField, reposUsed } from "./workflow.js";
import { esWorkflowStateClass, esWorkflowStreamTable } from "./workflow-eventsourced.js";
import { workflowStateClass } from "./workflow-state.js";

// ---------------------------------------------------------------------------
// In-process saga dispatcher (Java / Spring) — `<Ctx>Dispatcher`, a
// @Component whose @EventListener methods react to channel-carried domain
// events.  The Java counterpart of python's `dispatch-builder` / hono's
// `createInProcessDispatcher`: each aggregate service publishes drained
// domain events through Spring's ApplicationEventPublisher (service.ts,
// gated on `eventSubscriptions`), so they fan out synchronously, in the
// request transaction, to the subscribed workflow handlers.
//
// Per subscription:
//   - event-triggered `create(e) by …`  → load-or-allocate the saga row
//     (`<Wf>StateRepository.findById(key).orElseGet(_allocate)`),
//   - `on(e) by …` reactor                → route-or-drop (`orElse(null)`,
//     else log `event_unrouted` + return).
// The handler body runs through the shared workflow statement spine (op-calls,
// repo-lets, factory-lets); aggregate saves re-publish their own events and
// workflow-level `emit`s are re-published after the saves — so choreography
// chains re-enter the dispatcher (a starter's `emit` reaches its `on` reactor).
// ---------------------------------------------------------------------------

export interface DispatchCtx {
  basePkg: string;
  /** Dispatcher package (application.workflows). */
  pkg: string;
  entityPkgOf: (aggName: string) => string;
  repoPkgOf: (aggName: string) => string;
  /** Saga-state entity package (infrastructure.persistence). */
  statePkg: string;
  /** Saga-state Spring Data repository package (infrastructure.repositories). */
  stateRepoPkg: string;
}

interface ResolvedHandler {
  correlation?: ExprIR;
  statements: WorkflowStmtIR[];
  saves: { name: string; aggName: string; repoName: string }[];
}

/** The saga-state repository field name (`orderFulfillmentStateRepository`). */
function stateRepoField(wf: WorkflowIR): string {
  return `${lowerFirst(wf.name)}StateRepository`;
}

/** The handler body + correlation for one subscription (mirrors python's
 *  `resolveHandlerBody`): an `on` reactor or an event-triggered `create`. */
function resolveHandler(wf: WorkflowIR, sub: EventSubscriptionIR): ResolvedHandler | null {
  if (sub.trigger === "on") {
    const on = (wf.subscriptions ?? []).find((o) => o.event === sub.event && o.param === sub.param);
    return on
      ? { correlation: on.correlation, statements: on.statements, saves: on.savesAtExit }
      : null;
  }
  const cr = (wf.creates ?? []).find(
    (c) => c.eventRef === sub.event && c.eventBinding === sub.param,
  );
  return cr
    ? { correlation: cr.correlation, statements: cr.statements, saves: cr.savesAtExit }
    : null;
}

/** Deterministic @EventListener method name — `on<Wf>Start<Event>` for an
 *  event-triggered create, `on<Wf>On<Event>` for an `on` reactor. */
function handlerName(sub: EventSubscriptionIR): string {
  const mid = sub.trigger === "create" ? "Start" : "On";
  return `on${upperFirst(sub.workflow)}${mid}${upperFirst(sub.event)}`;
}

/** Factory-let aggregate names in a statement list (need `<Agg>` imported for
 *  `<Agg>.create(...)`). */
function factoryAggsIn(statements: WorkflowStmtIR[]): string[] {
  const out: string[] = [];
  const visit = (ss: WorkflowStmtIR[]): void => {
    for (const s of ss) {
      if (s.kind === "factory-let") out.push(s.aggName);
      if (s.kind === "for-each") visit(s.body);
    }
  };
  visit(statements);
  return out;
}

export function renderJavaDispatcher(
  ctx: EnrichedBoundedContextIR,
  dctx: DispatchCtx,
): { name: string; content: string } | null {
  const subs = ctx.eventSubscriptions ?? [];
  if (subs.length === 0) return null;

  const className = `${ctx.name}Dispatcher`;
  const imports = new Set<string>();
  const wfByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));

  const methods: string[] = [];
  for (const sub of subs) {
    const wf = wfByName.get(sub.workflow);
    if (!wf?.correlationField) continue;
    const resolved = resolveHandler(wf, sub);
    if (!resolved) continue;
    methods.push(
      ...(wf.eventSourced
        ? renderEsHandler(ctx, wf, sub, resolved, imports)
        : renderHandler(ctx, wf, sub, resolved, imports)),
    );
  }
  if (methods.length === 0) return null;

  // Injected collaborators: every aggregate repo the handler bodies touch +
  // one saga-state repo per subscribed correlation workflow.
  const subscribedWfs = [
    ...new Set(subs.map((s) => s.workflow).filter((n) => wfByName.get(n)?.correlationField)),
  ]
    .map((n) => wfByName.get(n)!)
    .sort((a, b) => a.name.localeCompare(b.name));
  // State-based sagas inject a Spring Data state repo; event-sourced workflows
  // fold their `<wf>_events` stream over a shared JdbcTemplate instead.
  const stateWfs = subscribedWfs.filter((wf) => !wf.eventSourced);
  const esPresent = subscribedWfs.some((wf) => wf.eventSourced);
  const repoAggs = [...new Set(subscribedWfs.flatMap((wf) => reposUsed(wf, ctx)))].sort();
  const factoryAggs = [
    ...new Set(
      subscribedWfs.flatMap((wf) =>
        [
          ...(wf.creates ?? []).flatMap((c) => c.statements),
          ...(wf.subscriptions ?? []).flatMap((o) => o.statements),
        ].flatMap((s) => factoryAggsIn([s])),
      ),
    ),
  ].sort();

  const fields = [
    `    private final ApplicationEventPublisher events;`,
    ...repoAggs.map((a) => `    private final ${a}Repository ${repoField(a)};`),
    ...(esPresent ? [`    private final JdbcTemplate jdbc;`] : []),
    ...stateWfs.map(
      (wf) => `    private final ${workflowStateClass(wf)}Repository ${stateRepoField(wf)};`,
    ),
  ];
  const ctorParams = [
    "ApplicationEventPublisher events",
    ...repoAggs.map((a) => `${a}Repository ${repoField(a)}`),
    ...(esPresent ? ["JdbcTemplate jdbc"] : []),
    ...stateWfs.map((wf) => `${workflowStateClass(wf)}Repository ${stateRepoField(wf)}`),
  ].join(", ");
  const ctorAssigns = [
    "        this.events = events;",
    ...repoAggs.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
    ...(esPresent ? ["        this.jdbc = jdbc;"] : []),
    ...stateWfs.map((wf) => `        this.${stateRepoField(wf)} = ${stateRepoField(wf)};`),
  ];

  // Cross-package imports (entities for factory-lets, repos, saga entities +
  // repos).  Domain ids/enums/vos/events ride wildcards.
  const importLines = [
    ...repoAggs.flatMap((a) => {
      const ep = dctx.entityPkgOf(a);
      const rp = dctx.repoPkgOf(a);
      return [
        ep !== dctx.pkg ? `import ${ep}.${a};` : null,
        rp !== dctx.pkg ? `import ${rp}.${a}Repository;` : null,
      ].filter((l): l is string => l !== null);
    }),
    ...factoryAggs
      .map((a) => dctx.entityPkgOf(a))
      .flatMap((ep, i) => (ep !== dctx.pkg ? [`import ${ep}.${factoryAggs[i]};`] : [])),
    // State-based sagas import their JPA state entity + Spring Data repo; an
    // event-sourced workflow's fold class lives in this same package (no import).
    ...stateWfs.flatMap((wf) => [
      `import ${dctx.statePkg}.${workflowStateClass(wf)};`,
      `import ${dctx.stateRepoPkg}.${workflowStateClass(wf)}Repository;`,
    ]),
  ];
  // Dedup (an aggregate can be both a repo target and a factory target).
  const uniqueImports = [...new Set(importLines)].sort();

  if (methods.some((m) => m.includes("new ArrayList<"))) imports.add("java.util.ArrayList");
  if (esPresent) imports.add("org.springframework.jdbc.core.JdbcTemplate");
  // Handler bodies can guard with `precondition` / `requires`, which throw the
  // domain.common exceptions — import them when a body uses one (the stmt target
  // emits the `throw` but leaves the import to the host).
  if (methods.some((m) => m.includes("DomainException"))) {
    imports.add(`${dctx.basePkg}.domain.common.DomainException`);
  }
  if (methods.some((m) => m.includes("ForbiddenException"))) {
    imports.add(`${dctx.basePkg}.domain.common.ForbiddenException`);
  }

  return {
    name: `${className}.java`,
    content: lines(
      `package ${dctx.pkg};`,
      ``,
      ...[...imports].sort().map((i) => `import ${i};`),
      imports.size > 0 ? `` : null,
      `import org.springframework.context.ApplicationEventPublisher;`,
      `import org.springframework.context.event.EventListener;`,
      `import org.springframework.stereotype.Component;`,
      `import org.springframework.transaction.annotation.Transactional;`,
      ``,
      ...uniqueImports,
      uniqueImports.length > 0 ? `` : null,
      `import ${dctx.basePkg}.domain.enums.*;`,
      `import ${dctx.basePkg}.domain.events.*;`,
      `import ${dctx.basePkg}.domain.ids.*;`,
      `import ${dctx.basePkg}.domain.valueobjects.*;`,
      `import ${dctx.basePkg}.config.CatalogLog;`,
      ``,
      `@Component`,
      `@Transactional`,
      `public class ${className} {`,
      ...fields,
      ``,
      `    public ${className}(${ctorParams}) {`,
      ...ctorAssigns,
      `    }`,
      ``,
      ...methods,
      `}`,
      ``,
    ),
  };
}

function renderHandler(
  ctx: EnrichedBoundedContextIR,
  wf: WorkflowIR,
  sub: EventSubscriptionIR,
  resolved: ResolvedHandler,
  imports: Set<string>,
): string[] {
  const corr = wf.correlationField as string;
  const param = sub.param;
  const renderCtx = { thisName: "state" };
  // Routing key: the `by <expr>` value, else the event field name-matching the
  // correlation field (omitted-`by` rule).
  const keyExpr = resolved.correlation
    ? renderJavaExpr(resolved.correlation, renderCtx)
    : `${param}.${snake(corr)}()`;
  if (resolved.correlation) collectJavaExprImports(resolved.correlation, imports);

  const hasEmit = bodyHasEmit(resolved.statements);
  const stateClass = workflowStateClass(wf);
  const repo = stateRepoField(wf);

  const out: string[] = [
    `    @EventListener`,
    `    public void ${handlerName(sub)}(${sub.event} ${param}) {`,
    `        var __key = ${keyExpr};`,
  ];
  if (sub.trigger === "create") {
    out.push(
      `        var state = ${repo}.findById(__key).orElseGet(() -> ${stateClass}._allocate(__key));`,
    );
  } else {
    out.push(`        var state = ${repo}.findById(__key).orElse(null);`);
    out.push(`        if (state == null) {`);
    out.push(
      `            CatalogLog.event("event_unrouted", "warn", "workflow", "${wf.name}", "event_type", "${sub.event}", "key", __key);`,
    );
    out.push(`            return;`);
    out.push(`        }`);
  }
  if (hasEmit) out.push(`        var __events = new ArrayList<DomainEvent>();`);
  // Handler body — emit appends to __events; the spine threads the 8-space base.
  out.push(
    ...renderWorkflowStmts(
      resolved.statements,
      javaWorkflowStmtTarget(ctx, imports, renderCtx, hasEmit ? "__events" : undefined),
      "        ",
    ),
  );
  // Saves: persist each dirty aggregate, then re-publish its own domain events
  // (aggregate-level choreography re-entry).
  for (const s of resolved.saves) {
    out.push(`        ${repoField(s.aggName)}.save(${s.name});`);
    out.push(`        for (var __e : ${s.name}.pullEvents()) events.publishEvent(__e);`);
  }
  out.push(`        ${repo}.save(state);`);
  if (hasEmit) {
    out.push(`        for (var __e : __events) events.publishEvent(__e);`);
  }
  out.push(`    }`, ``);
  return out;
}

/** The event-sourced handler (workflow-and-applier.md A2-S5b): fold the
 *  `<wf>_events` stream into `state` on load, run the emit-only body against
 *  that folded snapshot, append the workflow's own events gap-free, then
 *  re-publish for choreography.  The saga analogue of the aggregate event store
 *  — there is no mutable correlation row, only the JdbcTemplate-backed stream. */
function renderEsHandler(
  ctx: EnrichedBoundedContextIR,
  wf: WorkflowIR,
  sub: EventSubscriptionIR,
  resolved: ResolvedHandler,
  imports: Set<string>,
): string[] {
  const corr = wf.correlationField as string;
  const param = sub.param;
  const renderCtx = { thisName: "state" };
  const keyExpr = resolved.correlation
    ? renderJavaExpr(resolved.correlation, renderCtx)
    : `${param}.${snake(corr)}()`;
  if (resolved.correlation) collectJavaExprImports(resolved.correlation, imports);

  const hasEmit = bodyHasEmit(resolved.statements);
  const cls = esWorkflowStateClass(wf);
  const table = esWorkflowStreamTable(wf);

  // Render the body up front so we know whether it reads the folded snapshot (a
  // starter that only emits constants never touches `state`) — folding is then a
  // pure no-op, so we skip the stream load + fold (parity with the python port).
  const bodyLines = renderWorkflowStmts(
    resolved.statements,
    javaWorkflowStmtTarget(ctx, imports, renderCtx, hasEmit ? "__events" : undefined),
    "        ",
  );
  const usesState = bodyLines.some((l) => /\bstate\b/.test(l));

  const loadFold = [
    `        var __loaded = new ArrayList<DomainEvent>();`,
    `        for (var __r : __rows) __loaded.add(${cls}._rowToEvent((String) __r.get("type"), String.valueOf(__r.get("data"))));`,
    `        var state = ${cls}._fromEvents(__key, __loaded);`,
  ];

  const out: string[] = [
    `    @EventListener`,
    `    public void ${handlerName(sub)}(${sub.event} ${param}) {`,
    `        var __key = ${keyExpr};`,
  ];
  // `__sid` is needed by an `on` reactor's stream load (always), the append
  // (when the body emits), and the fold load (when the body reads state).
  if (sub.trigger === "on" || hasEmit || usesState) {
    out.push(`        var __sid = String.valueOf(__key.value());`);
  }
  if (sub.trigger === "on") {
    // A continuation needs a started saga (non-empty stream); else drop + log.
    out.push(`        var __rows = jdbc.queryForList(`);
    out.push(
      `            "select type, data from ${table} where stream_id = ? order by version", __sid);`,
    );
    out.push(`        if (__rows.isEmpty()) {`);
    out.push(
      `            CatalogLog.event("event_unrouted", "warn", "workflow", "${wf.name}", "event_type", "${sub.event}", "key", __key);`,
    );
    out.push(`            return;`);
    out.push(`        }`);
    if (usesState) out.push(...loadFold);
  } else if (usesState) {
    // A starter that reads state folds the (possibly empty) stream from zero.
    out.push(`        var __rows = jdbc.queryForList(`);
    out.push(
      `            "select type, data from ${table} where stream_id = ? order by version", __sid);`,
    );
    out.push(...loadFold);
  }
  if (hasEmit) out.push(`        var __events = new ArrayList<DomainEvent>();`);
  out.push(...bodyLines);
  // Aggregate saves still re-publish their own events (choreography re-entry).
  for (const s of resolved.saves) {
    out.push(`        ${repoField(s.aggName)}.save(${s.name});`);
    out.push(`        for (var __e : ${s.name}.pullEvents()) events.publishEvent(__e);`);
  }
  // Every emit in an ES workflow has an applier (A1 discipline), so the emitted
  // events ARE the workflow's own stream — append them gap-free, then publish.
  if (hasEmit) {
    out.push(
      `        Integer __max = jdbc.queryForObject(`,
      `            "select max(version) from ${table} where stream_id = ?", Integer.class, __sid);`,
      `        int __v = __max == null ? 0 : __max;`,
      `        for (var __e : __events) {`,
      `            __v++;`,
      `            jdbc.update(`,
      `                "insert into ${table} (stream_id, version, type, data) values (?, ?, ?, ?::jsonb)",`,
      `                __sid, __v, __e.getClass().getSimpleName(), ${cls}._toData(__e));`,
      `        }`,
      `        for (var __e : __events) events.publishEvent(__e);`,
    );
  }
  out.push(`    }`, ``);
  return out;
}

function bodyHasEmit(statements: WorkflowStmtIR[]): boolean {
  return statements.some(
    (s) => s.kind === "emit" || (s.kind === "for-each" && bodyHasEmit(s.body)),
  );
}
