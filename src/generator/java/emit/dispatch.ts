import { deriveEventSubscriptions } from "../../../ir/enrich/enrichments.js";
import type {
  ChannelIR,
  EnrichedBoundedContextIR,
  EventSubscriptionIR,
  ExprIR,
  ProjectionIR,
  ProjectionOnIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";
import { statementSubRegions } from "../../_trace/sourcemap.js";
import { collectUnionFindLets, renderWorkflowStmtChunks } from "../../_workflow/stmt-target.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";
import type { OpFragment } from "./entity.js";
import { projectionRowClass } from "./projection-state.js";
import { javaWorkflowStmtTarget, repoField, reposUsed } from "./workflow.js";
import { esEventLogTable, esWorkflowStateClass } from "./workflow-eventsourced.js";
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
  /** The workflows' owning-context Postgres schema — qualifies the ES saga
   *  stream in native SQL so it matches the migration DDL.  Undefined ⇒
   *  unqualified (binding-free system). */
  contextSchema?: string;
  /** Wired-but-foreign broker channels (M-T4.4 backend fan-out): stubs with
   *  their REAL delivery/retention knobs, widening the subscription
   *  derivation so a hosted reactor routes off a channel declared in a
   *  non-hosted context (mirrors the Hono/Python/.NET orchestrators). */
  extraChannels?: ChannelIR[];
  /** Event types carried by a broker-bound channel this deployable wires —
   *  their handlers DROP the local `@EventListener` (design §4 delivery
   *  uniformity: broker-bound events publish and are received through the
   *  subscription; the ChannelConsumerService invokes these methods on
   *  delivery instead of Spring's local fan-out). */
  brokerEvents?: ReadonlySet<string>;
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

/** The projection read-model row repository field name (`orderBookRowRepository`). */
function projRepoField(proj: ProjectionIR): string {
  return `${lowerFirst(proj.name)}RowRepository`;
}

/** One pure projection fold (projection.md): a @EventListener that loads-or-
 *  allocates the read-model row for the event's key (every event allocates — a
 *  projection has no route-or-drop split), writes each `:=` through the row's
 *  setter, and saves.  Pure — no emit, no aggregate saves, no child frame.
 *  The correlation `:=` (if the fold spells it) is skipped: the key is the
 *  immutable `@EmbeddedId`, already seeded by `_allocate`. */
function renderProjectionFold(
  proj: ProjectionIR,
  on: ProjectionOnIR,
  sub: EventSubscriptionIR,
  imports: Set<string>,
): string[] {
  const corr = proj.correlationField as string;
  const param = sub.param;
  // this-prop refs resolve through the row's record-style accessors
  // (`state.status()`); writes go through the JavaBean setter (spelled below).
  const renderCtx = { thisName: "state", accessorProps: true };
  // Routing key: the `by <expr>` value, else the event field name-matching the
  // correlation field (omitted-`by` rule) — an id-typed accessor, so `findById`
  // gets the `<Corr>Id` it expects.
  const keyExpr = on.correlation
    ? renderJavaExpr(on.correlation, renderCtx)
    : `${param}.${snake(corr)}()`;
  if (on.correlation) collectJavaExprImports(on.correlation, imports);

  const cls = projectionRowClass(proj);
  const repo = projRepoField(proj);
  const body: string[] = [
    `        var __key = ${keyExpr};`,
    `        var state = ${repo}.findById(__key).orElseGet(() -> ${cls}._allocate(__key));`,
  ];
  for (const stmt of on.statements) {
    if (stmt.kind !== "assign") continue;
    const segs = stmt.target.segments;
    const field = segs[segs.length - 1];
    if (field === corr) continue; // immutable @EmbeddedId key, seeded by _allocate
    collectJavaExprImports(stmt.value, imports);
    body.push(`        state.set${upperFirst(field)}(${renderJavaExpr(stmt.value, renderCtx)});`);
  }
  body.push(`        ${repo}.save(state);`);
  return [
    `    @EventListener`,
    `    public void on${upperFirst(proj.name)}On${upperFirst(sub.event)}(${sub.event} ${param}) {`,
    ...body,
    `    }`,
    ``,
  ];
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
  /** Source-map Milestone 12 — `<Ctx>Dispatcher.java` pools every reactor /
   *  event-create handler, so it never gets a whole-file region — only these
   *  fragment-only statement regions (mirrors `renderJavaWorkflows`'
   *  `opFragments` at Milestone 11).  Allocated by the caller ONLY when a
   *  recorder is present, so a no-`--sourcemap` run pays no per-statement
   *  bookkeeping cost. */
  opFragments?: OpFragment[],
): { name: string; content: string; handlers: { method: string; event: string }[] } | null {
  // Re-derive over the (possibly merged) context WITH projections — the
  // enricher-stored `ctx.eventSubscriptions` omits projection folds (it derives
  // without them), so a projection-only context would otherwise get no
  // dispatcher.  Mirrors python's `dispatchSubscriptionsOf`.
  const subs = deriveEventSubscriptions(
    [...ctx.channels, ...(dctx.extraChannels ?? [])],
    ctx.workflows,
    ctx.projections,
  );
  if (subs.length === 0) return null;

  const className = `${ctx.name}Dispatcher`;
  const imports = new Set<string>();
  const wfByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));
  const projByName = new Map(ctx.projections.map((p) => [p.name, p] as const));
  // Projections whose fold this dispatcher wires — each injects a read-model row
  // Spring Data repo (deduped, declaration order).
  const touchedProjections: ProjectionIR[] = [];

  // Event-sourced saga double-append (S5b): when an event-sourced workflow has
  // BOTH an `on` reactor and an event-`create` starter for the SAME event,
  // Spring fans the two @EventListener methods out in unspecified order — a
  // start-first-on-a-new-stream ordering double-appends.  Merge them into ONE
  // ordered @EventListener that reads the stream once and branches
  // (empty → create-logic, non-empty → on-logic), so exactly one appends
  // regardless of fan-out order.  Non-ES workflows and events without both an
  // `on` and a `create` stay two independent handlers (byte-identical).
  const mergedEsEvent = (wf: WorkflowIR, event: string): boolean =>
    !!wf.eventSourced &&
    (wf.subscriptions ?? []).some((o) => o.event === event) &&
    (wf.creates ?? []).some(
      (c) => c.triggerKind === "event" && c.eventRef === event && !!c.eventBinding,
    );

  const methods: string[] = [];
  // Handler index (method name × event type) returned to the orchestrator —
  // the ChannelConsumerService dispatches received broker envelopes through
  // exactly these methods, so the naming rules live here, not re-derived in
  // the channels emitter.  A broker-routed handler loses its @EventListener
  // line (design §4 — see DispatchCtx.brokerEvents).
  const handlers: { method: string; event: string }[] = [];
  const pushHandler = (method: string, event: string, ls: string[]): void => {
    handlers.push({ method, event });
    methods.push(
      ...(dctx.brokerEvents?.has(event) ? ls.filter((l) => l !== "    @EventListener") : ls),
    );
  };
  for (const sub of subs) {
    // Projection fold (projection.md): a pure read-model upsert, not a saga.
    // Load-or-allocate the row keyed by the correlation column, write each `:=`
    // through the row's setter, save.  No emit, no aggregate saves, no child
    // frame (enforced pure by `loom.projection-fold-impure`).
    if (sub.projection) {
      const proj = projByName.get(sub.projection);
      if (!proj) continue;
      const on = proj.handlers.find((h) => h.event === sub.event && h.param === sub.param);
      if (!on) continue;
      pushHandler(
        `on${upperFirst(proj.name)}On${upperFirst(sub.event)}`,
        sub.event,
        renderProjectionFold(proj, on, sub, imports),
      );
      if (!touchedProjections.some((p) => p.name === proj.name)) touchedProjections.push(proj);
      continue;
    }
    const wf = wfByName.get(sub.workflow);
    if (!wf?.correlationField) continue;
    if (mergedEsEvent(wf, sub.event)) {
      // Render the merged handler once, on the `create` sub; drop the `on` sub
      // (its logic is the else-branch).
      if (sub.trigger !== "create") continue;
      const createResolved = resolveHandler(wf, sub);
      const onSub = subs.find(
        (s) => s.workflow === sub.workflow && s.event === sub.event && s.trigger === "on",
      );
      const onResolved = onSub ? resolveHandler(wf, onSub) : null;
      if (!createResolved || !onSub || !onResolved) continue;
      const construct = `${ctx.name}.${wf.name}`;
      pushHandler(
        `on${upperFirst(wf.name)}${upperFirst(sub.event)}`,
        sub.event,
        renderEsMergedHandler(
          ctx,
          wf,
          sub,
          createResolved,
          onSub,
          onResolved,
          imports,
          dctx.contextSchema,
          construct,
          opFragments,
        ),
      );
      continue;
    }
    const resolved = resolveHandler(wf, sub);
    if (!resolved) continue;
    const construct = `${ctx.name}.${wf.name}`;
    pushHandler(
      handlerName(sub),
      sub.event,
      wf.eventSourced
        ? renderEsHandler(
            ctx,
            wf,
            sub,
            resolved,
            imports,
            construct,
            dctx.contextSchema,
            opFragments,
          )
        : renderHandler(ctx, wf, sub, resolved, imports, construct, opFragments),
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
    ...touchedProjections.map(
      (p) => `    private final ${projectionRowClass(p)}Repository ${projRepoField(p)};`,
    ),
  ];
  const ctorParams = [
    "ApplicationEventPublisher events",
    ...repoAggs.map((a) => `${a}Repository ${repoField(a)}`),
    ...(esPresent ? ["JdbcTemplate jdbc"] : []),
    ...stateWfs.map((wf) => `${workflowStateClass(wf)}Repository ${stateRepoField(wf)}`),
    ...touchedProjections.map((p) => `${projectionRowClass(p)}Repository ${projRepoField(p)}`),
  ].join(", ");
  const ctorAssigns = [
    "        this.events = events;",
    ...repoAggs.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
    ...(esPresent ? ["        this.jdbc = jdbc;"] : []),
    ...stateWfs.map((wf) => `        this.${stateRepoField(wf)} = ${stateRepoField(wf)};`),
    ...touchedProjections.map((p) => `        this.${projRepoField(p)} = ${projRepoField(p)};`),
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
    // Projection folds import their read-model row entity + Spring Data repo
    // (same packages as the saga state — infra-persistence / spring-data-repository).
    ...touchedProjections.flatMap((p) => [
      `import ${dctx.statePkg}.${projectionRowClass(p)};`,
      `import ${dctx.stateRepoPkg}.${projectionRowClass(p)}Repository;`,
    ]),
  ];
  // Dedup (an aggregate can be both a repo target and a factory target).
  const uniqueImports = [...new Set(importLines)].sort();

  if (methods.some((m) => m.includes("new ArrayList<"))) imports.add("java.util.ArrayList");
  if (esPresent) imports.add("org.springframework.jdbc.core.JdbcTemplate");
  // Workflow reactors open a per-dispatch child frame via RequestContext
  // .openChild(); a projection-only dispatcher (pure folds) never does, so gate
  // the import on actual use to keep a folds-only file free of a dead import.
  if (methods.some((m) => m.includes("RequestContext.openChild"))) {
    imports.add(`${dctx.basePkg}.config.RequestContext`);
  }
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
    handlers,
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
  construct: string,
  /** Source-map Milestone 12 — see `renderJavaDispatcher`'s `opFragments`. */
  opFragments?: OpFragment[],
): string[] {
  const corr = wf.correlationField as string;
  const param = sub.param;
  // The persisted correlation row exposes its fields via record-style accessors
  // (`state.attempts()`), not public fields — so own-state READS in the body
  // (e.g. the `state.attempts() + 1` RHS of a compound `attempts += 1`) must go
  // through the accessor.  Writes still use the JavaBean setter (the `assign`
  // arm spells `state.setAttempts(...)` directly).  `accessorProps` only affects
  // `this-prop` refs, so the `by <expr>` correlation key (an event-param member)
  // is unchanged.
  const renderCtx = { thisName: "state", accessorProps: true };
  // Routing key: the `by <expr>` value, else the event field name-matching the
  // correlation field (omitted-`by` rule).
  const keyExpr = resolved.correlation
    ? renderJavaExpr(resolved.correlation, renderCtx)
    : `${param}.${snake(corr)}()`;
  if (resolved.correlation) collectJavaExprImports(resolved.correlation, imports);

  const hasEmit = bodyHasEmit(resolved.statements);
  const stateClass = workflowStateClass(wf);
  const repo = stateRepoField(wf);

  // The handler body at the 8-space base; wrapped below in a child frame so the
  // base shifts to 12-space without rewriting every line.
  const body: string[] = [`        var __key = ${keyExpr};`];
  if (sub.trigger === "create") {
    body.push(
      `        var state = ${repo}.findById(__key).orElseGet(() -> ${stateClass}._allocate(__key));`,
    );
  } else {
    body.push(`        var state = ${repo}.findById(__key).orElse(null);`);
    body.push(`        if (state == null) {`);
    body.push(
      `            CatalogLog.event("event_unrouted", "warn", "workflow", "${wf.name}", "event_type", "${sub.event}", "key", __key);`,
    );
    body.push(`            return;`);
    body.push(`        }`);
  }
  if (hasEmit) body.push(`        var __events = new ArrayList<DomainEvent>();`);
  // Handler body — emit appends to __events; the spine threads the 8-space base.
  // Chunked (one lines-array per top-level statement) rather than the
  // pre-flattened `renderWorkflowStmts` — byte-identical either way, but the
  // per-chunk list lets us surface per-statement sub-regions (source-map
  // Milestone 12).
  const stmtChunks = renderWorkflowStmtChunks(
    resolved.statements,
    javaWorkflowStmtTarget(
      ctx,
      imports,
      renderCtx,
      hasEmit ? "__events" : undefined,
      collectUnionFindLets(resolved.statements),
    ),
    "        ",
  );
  body.push(...stmtChunks.flat());
  if (opFragments) {
    // `body` gets re-indented +4 below (`body.map((l) => \`    ${l}\`)`) when
    // nested inside the try frame — replay that SAME shift onto the chunk
    // texts before anchoring, mirroring the .NET transactional precedent.
    const chunkTexts = stmtChunks.map((ls) => ls.map((l) => "    " + l).join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(resolved.statements, chunkTexts, construct),
      });
    }
  }
  // Saves: persist each dirty aggregate, then re-publish its own domain events
  // (aggregate-level choreography re-entry).
  for (const s of resolved.saves) {
    body.push(`        ${repoField(s.aggName)}.save(${s.name});`);
    body.push(`        for (var __e : ${s.name}.pullEvents()) events.publishEvent(__e);`);
  }
  body.push(`        ${repo}.save(state);`);
  if (hasEmit) {
    body.push(`        for (var __e : __events) events.publishEvent(__e);`);
  }
  // A reactor is a per-dispatch boundary: run it in a child execution frame
  // (fresh scope_id, parent_id ← the dispatching request's scope) so its audit /
  // provenance rows record their call-structure position.
  return [
    `    @EventListener`,
    `    public void ${handlerName(sub)}(${sub.event} ${param}) {`,
    `        try (var __frame = RequestContext.openChild()) {`,
    ...body.map((l) => `    ${l}`),
    `        }`,
    `    }`,
    ``,
  ];
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
  construct: string,
  schema?: string,
  /** Source-map Milestone 12 — see `renderJavaDispatcher`'s `opFragments`. */
  opFragments?: OpFragment[],
): string[] {
  const corr = wf.correlationField as string;
  const param = sub.param;
  // The event-sourced fold class lives in the dispatcher's OWN package and
  // exposes package-private fields, so a same-package own-state READ
  // (`state.total`) compiles as a bare field — no accessor redirect needed
  // (unlike the cross-package mutable saga row in `renderHandler`).  Event-
  // sourced workflows can't write their own state at all, so there's no
  // compound-assign self-read here to worry about either.
  const renderCtx = { thisName: "state" };
  const keyExpr = resolved.correlation
    ? renderJavaExpr(resolved.correlation, renderCtx)
    : `${param}.${snake(corr)}()`;
  if (resolved.correlation) collectJavaExprImports(resolved.correlation, imports);

  const hasEmit = bodyHasEmit(resolved.statements);
  const cls = esWorkflowStateClass(wf);
  // The single per-context event log; this workflow's stream is the subset
  // tagged `stream_type = "<Wf>"`, so every load/append filters + stamps it.
  const table = esEventLogTable(ctx.name, schema);
  const streamType = wf.name;

  // Render the body up front (chunked, one lines-array per top-level
  // statement) so we know whether it reads the folded snapshot (a starter
  // that only emits constants never touches `state`) — folding is then a
  // pure no-op, so we skip the stream load + fold (parity with the python
  // port).  The chunk list also lets us surface per-statement sub-regions
  // (source-map Milestone 12).
  const stmtChunks = renderWorkflowStmtChunks(
    resolved.statements,
    javaWorkflowStmtTarget(
      ctx,
      imports,
      renderCtx,
      hasEmit ? "__events" : undefined,
      collectUnionFindLets(resolved.statements),
    ),
    "        ",
  );
  const bodyLines = stmtChunks.flat();
  const usesState = bodyLines.some((l) => /\bstate\b/.test(l));

  const loadFold = [
    `        var __loaded = new ArrayList<DomainEvent>();`,
    `        for (var __r : __rows) __loaded.add(${cls}._rowToEvent((String) __r.get("type"), String.valueOf(__r.get("data"))));`,
    `        var state = ${cls}._fromEvents(__key, __loaded);`,
  ];

  // The handler body at the 8-space base; wrapped below in a child frame so the
  // base shifts to 12-space without rewriting every line.
  const body: string[] = [`        var __key = ${keyExpr};`];
  // `__sid` is needed by an `on` reactor's stream load (always), the append
  // (when the body emits), and the fold load (when the body reads state).
  if (sub.trigger === "on" || hasEmit || usesState) {
    body.push(`        var __sid = String.valueOf(__key.value());`);
  }
  if (sub.trigger === "on") {
    // A continuation needs a started saga (non-empty stream); else drop + log.
    body.push(`        var __rows = jdbc.queryForList(`);
    body.push(
      `            "select type, data from ${table} where stream_type = ? and stream_id = ? order by version", "${streamType}", __sid);`,
    );
    body.push(`        if (__rows.isEmpty()) {`);
    body.push(
      `            CatalogLog.event("event_unrouted", "warn", "workflow", "${wf.name}", "event_type", "${sub.event}", "key", __key);`,
    );
    body.push(`            return;`);
    body.push(`        }`);
    if (usesState) body.push(...loadFold);
  } else if (usesState) {
    // A starter that reads state folds the (possibly empty) stream from zero.
    body.push(`        var __rows = jdbc.queryForList(`);
    body.push(
      `            "select type, data from ${table} where stream_type = ? and stream_id = ? order by version", "${streamType}", __sid);`,
    );
    body.push(...loadFold);
  }
  if (hasEmit) body.push(`        var __events = new ArrayList<DomainEvent>();`);
  body.push(...bodyLines);
  if (opFragments) {
    // `body` gets re-indented +4 below (`body.map((l) => \`    ${l}\`)`) when
    // nested inside the try frame — replay that SAME shift onto the chunk
    // texts before anchoring, mirroring the .NET transactional precedent.
    const chunkTexts = stmtChunks.map((ls) => ls.map((l) => "    " + l).join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(resolved.statements, chunkTexts, construct),
      });
    }
  }
  // Aggregate saves still re-publish their own events (choreography re-entry).
  for (const s of resolved.saves) {
    body.push(`        ${repoField(s.aggName)}.save(${s.name});`);
    body.push(`        for (var __e : ${s.name}.pullEvents()) events.publishEvent(__e);`);
  }
  // Every emit in an ES workflow has an applier (A1 discipline), so the emitted
  // events ARE the workflow's own stream — append them gap-free, then publish.
  if (hasEmit) {
    body.push(
      `        Integer __max = jdbc.queryForObject(`,
      `            "select max(version) from ${table} where stream_type = ? and stream_id = ?", Integer.class, "${streamType}", __sid);`,
      `        int __v = __max == null ? 0 : __max;`,
      `        for (var __e : __events) {`,
      `            __v++;`,
      `            jdbc.update(`,
      `                "insert into ${table} (stream_type, stream_id, version, type, data) values (?, ?, ?, ?, ?::jsonb)",`,
      `                "${streamType}", __sid, __v, __e.getClass().getSimpleName(), ${cls}._toData(__e));`,
      `        }`,
      `        for (var __e : __events) events.publishEvent(__e);`,
    );
  }
  // A reactor is a per-dispatch boundary: child execution frame (parent_id ←
  // the dispatching request's scope).
  return [
    `    @EventListener`,
    `    public void ${handlerName(sub)}(${sub.event} ${param}) {`,
    `        try (var __frame = RequestContext.openChild()) {`,
    ...body.map((l) => `    ${l}`),
    `        }`,
    `    }`,
    ``,
  ];
}

/** One branch of a merged event-sourced saga handler (S5b): the emit-sink
 *  decl, the body rendered against the shared folded `state`, aggregate saves,
 *  and the gap-free own-event append + re-publish.  The stream load + fold are
 *  shared across the two branches, so they are NOT emitted here.  `aliasEvent`
 *  binds this branch's event param to the merged method param when the two
 *  triggers named it differently. */
function esMergedBranchLines(
  ctx: EnrichedBoundedContextIR,
  wf: WorkflowIR,
  resolved: ResolvedHandler,
  imports: Set<string>,
  methodParam: string,
  branchParam: string,
  schema: string | undefined,
  construct: string,
  /** Source-map Milestone 12 — this branch's own `OpFragment`, pushed here so
   *  the merged handler (create + on) records TWO fragments, one per branch.
   *  This branch's lines get re-indented TWICE before landing in the final
   *  file: once by the caller's if/else wrap (`renderEsMergedHandler`, +4)
   *  and once by that function's own try-frame wrap (+4) — replay BOTH (+8
   *  total) onto the chunk texts before anchoring, mirroring the .NET
   *  merged-branch precedent (doubled here because Java also wraps in a try
   *  frame). */
  opFragments?: OpFragment[],
): { lines: string[]; usesState: boolean } {
  const cls = esWorkflowStateClass(wf);
  const table = esEventLogTable(ctx.name, schema);
  const streamType = wf.name;
  const hasEmit = bodyHasEmit(resolved.statements);
  const stmtChunks = renderWorkflowStmtChunks(
    resolved.statements,
    javaWorkflowStmtTarget(
      ctx,
      imports,
      { thisName: "state" },
      hasEmit ? "__events" : undefined,
      collectUnionFindLets(resolved.statements),
    ),
    "        ",
  );
  const bodyLines = stmtChunks.flat();
  const usesState = bodyLines.some((l) => /\bstate\b/.test(l));
  if (opFragments) {
    const chunkTexts = stmtChunks.map((ls) => ls.map((l) => "        " + l).join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(resolved.statements, chunkTexts, construct),
      });
    }
  }
  const out: string[] = [];
  // The two triggers may name their event binding differently; alias so this
  // branch's body references resolve against the single merged method param.
  if (branchParam !== methodParam) {
    out.push(`        var ${branchParam} = ${methodParam};`);
  }
  if (hasEmit) out.push(`        var __events = new ArrayList<DomainEvent>();`);
  out.push(...bodyLines);
  for (const s of resolved.saves) {
    out.push(`        ${repoField(s.aggName)}.save(${s.name});`);
    out.push(`        for (var __e : ${s.name}.pullEvents()) events.publishEvent(__e);`);
  }
  if (hasEmit) {
    out.push(
      `        Integer __max = jdbc.queryForObject(`,
      `            "select max(version) from ${table} where stream_type = ? and stream_id = ?", Integer.class, "${streamType}", __sid);`,
      `        int __v = __max == null ? 0 : __max;`,
      `        for (var __e : __events) {`,
      `            __v++;`,
      `            jdbc.update(`,
      `                "insert into ${table} (stream_type, stream_id, version, type, data) values (?, ?, ?, ?, ?::jsonb)",`,
      `                "${streamType}", __sid, __v, __e.getClass().getSimpleName(), ${cls}._toData(__e));`,
      `        }`,
      `        for (var __e : __events) events.publishEvent(__e);`,
    );
  }
  return { lines: out, usesState };
}

/** The merged event-sourced saga handler (S5b): one ordered @EventListener that
 *  reads the `<wf>_events` stream ONCE and branches — empty stream → the
 *  `create` starter body, non-empty → the `on` reactor body — so exactly one of
 *  the two appends regardless of Spring's fan-out order.  Replaces the two
 *  independent `on…`/`start…` listeners that otherwise double-append. */
function renderEsMergedHandler(
  ctx: EnrichedBoundedContextIR,
  wf: WorkflowIR,
  createSub: EventSubscriptionIR,
  createResolved: ResolvedHandler,
  onSub: EventSubscriptionIR,
  onResolved: ResolvedHandler,
  imports: Set<string>,
  schema: string | undefined,
  construct: string,
  /** Source-map Milestone 12 — forwarded to `esMergedBranchLines` for BOTH
   *  branches, so a merged handler records two `OpFragment`s (create + on). */
  opFragments?: OpFragment[],
): string[] {
  const corr = wf.correlationField as string;
  const param = createSub.param;
  const cls = esWorkflowStateClass(wf);
  const table = esEventLogTable(ctx.name, schema);
  const streamType = wf.name;
  const renderCtx = { thisName: "state" };
  const keyExpr = createResolved.correlation
    ? renderJavaExpr(createResolved.correlation, renderCtx)
    : `${param}.${snake(corr)}()`;
  if (createResolved.correlation) collectJavaExprImports(createResolved.correlation, imports);

  const createBranch = esMergedBranchLines(
    ctx,
    wf,
    createResolved,
    imports,
    param,
    param,
    schema,
    construct,
    opFragments,
  );
  const onBranch = esMergedBranchLines(
    ctx,
    wf,
    onResolved,
    imports,
    param,
    onSub.param,
    schema,
    construct,
    opFragments,
  );
  const usesState = createBranch.usesState || onBranch.usesState;

  const body: string[] = [
    `        var __key = ${keyExpr};`,
    `        var __sid = String.valueOf(__key.value());`,
    `        var __rows = jdbc.queryForList(`,
    `            "select type, data from ${table} where stream_type = ? and stream_id = ? order by version", "${streamType}", __sid);`,
  ];
  if (usesState) {
    // Fold once; both branches read the same folded snapshot.  An empty stream
    // folds from zero (the create branch), a non-empty one replays it (on).
    body.push(
      `        var __loaded = new ArrayList<DomainEvent>();`,
      `        for (var __r : __rows) __loaded.add(${cls}._rowToEvent((String) __r.get("type"), String.valueOf(__r.get("data"))));`,
      `        var state = ${cls}._fromEvents(__key, __loaded);`,
    );
  }
  body.push(`        if (__rows.isEmpty()) {`);
  body.push(...createBranch.lines.map((l) => `    ${l}`));
  body.push(`        } else {`);
  body.push(...onBranch.lines.map((l) => `    ${l}`));
  body.push(`        }`);

  return [
    `    @EventListener`,
    `    public void on${upperFirst(wf.name)}${upperFirst(createSub.event)}(${createSub.event} ${param}) {`,
    `        try (var __frame = RequestContext.openChild()) {`,
    ...body.map((l) => `    ${l}`),
    `        }`,
    `    }`,
    ``,
  ];
}

function bodyHasEmit(statements: WorkflowStmtIR[]): boolean {
  return statements.some(
    (s) => s.kind === "emit" || (s.kind === "for-each" && bodyHasEmit(s.body)),
  );
}
