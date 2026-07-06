import { createInputFields, createOmissionValue } from "../../ir/enrich/wire-projection.js";
import {
  type AggregateIR,
  type EnrichedBoundedContextIR,
  type EventSubscriptionIR,
  type ExprIR,
  operationUsesCurrentUser,
  type SystemIR,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowIsGuarded,
  workflowUsesCurrentUser,
} from "../../ir/types/loom-ir.js";

/** The resolved body of one subscription (the `on` reactor or event-`create`
 *  starter): its statements, aggregate saves, and correlation routing expr. */
type ResolvedWorkflowBody = {
  statements: WorkflowStmtIR[];
  saves: { name: string; aggName: string; repoName: string }[];
  correlation: ExprIR | undefined;
};

import { durableEventTypes } from "../../ir/util/channels.js";
import { readPortsForOperation } from "../../ir/util/domain-service-read-ports.js";
import { errorStatuses } from "../../ir/util/openapi-errors.js";
import {
  camelId,
  opWorkflow,
  opWorkflowInstanceById,
  opWorkflowInstances,
} from "../../ir/util/openapi-ids.js";
import { collectReachableTypes } from "../../ir/util/reachable-types.js";
import { resolveWorkflowIsolation } from "../../ir/util/resolve-datasource.js";
import { walkWorkflowStmtExprsDeep } from "../../ir/util/walk.js";
import { workflowCorrIdValueType } from "../../ir/util/workflow-instances.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { renderDotnetLogCall } from "../_obs/render-dotnet.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { statementSubRegions } from "../_trace/sourcemap.js";
import { renderWorkflowStmtChunks, type WorkflowStmtTarget } from "../_workflow/stmt-target.js";
import { dotnetResourceAdapterFor, resourceClassName } from "./adapters/resource-clients.js";
import {
  collectWireUsings,
  csIdValueClrType,
  domainToRequestExpr,
  dtoParam,
  projectEntityExpr,
  projectToResponse,
  wireToCommandArgument,
  wireType,
} from "./dto-mapping.js";
import { bypassedFilterNames } from "./emit/efcore.js";
import type { OpFragment } from "./emit/entity.js";
import type { CsRenderContext } from "./render-expr.js";
import { collectCsExprUsings, renderCsExpr, renderCsType } from "./render-expr.js";
import { esCorrIdClass, esEventDbSet, esEventRecordClass } from "./workflow-eventsourced-emit.js";
import {
  workflowAllocateInitializer,
  workflowStateClass,
  workflowStateDbSet,
} from "./workflow-state-emit.js";

// ---------------------------------------------------------------------------
// .NET workflow emission.
//
// For each `workflow X(params) [transactional] { body }` declared in the
// context, this emits:
//
//   Application/Workflows/<X>Request.cs    — wire-shape DTO
//   Application/Workflows/<X>Command.cs    — domain-typed Mediator command
//   Application/Workflows/<X>Handler.cs    — Mediator handler that
//     orchestrates the workflow body, runs saves (in a DB transaction
//     when `transactional`), and dispatches workflow-level events
//     after saves complete (after commit when transactional).
//
// Plus one shared Api/<Context>WorkflowsController.cs that maps each
// workflow Request → Command via wireToCommandArgument and dispatches
// through ISender.
// ---------------------------------------------------------------------------

const INDENT = "        ";

/** resourceName → static C# helper class, for every resource whose
 *  sourceType has a .NET ResourceAdapter (Phase 4c).  Routes resource-op
 *  call sites + drives the `Resources/*.cs` emission and NuGet deps. */
function buildResourceClasses(sys: SystemIR | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!sys) return out;
  const storeType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const r of sys.dataSources) {
    const sourceType = storeType.get(r.storageName);
    if (sourceType && dotnetResourceAdapterFor(sourceType)) {
      out.set(r.name, resourceClassName(sourceType));
    }
  }
  return out;
}

/** Every resource-op call in a workflow (bare or let-bound). */
function workflowResourceOps(wf: WorkflowIR): { resourceName: string }[] {
  const out: { resourceName: string }[] = [];
  for (const st of wf.statements) {
    const call =
      st.kind === "resource-call" ? st.call : st.kind === "expr-let" ? st.expr : undefined;
    if (call?.kind === "call" && call.callKind === "resource-op" && call.resourceOp) {
      out.push({ resourceName: call.resourceOp.resourceName });
    }
  }
  return out;
}

function workflowUsesResourceOp(wf: WorkflowIR): boolean {
  return workflowResourceOps(wf).length > 0;
}

export function emitWorkflows(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string; sys?: SystemIR; sourcemap?: SourceMapRecorder },
): void {
  if (ctx.workflows.length === 0) return;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const sourcemap = options?.sourcemap;

  // Only command-triggered workflows get the HTTP command path (Request /
  // Command / Handler + a controller POST).  An event-triggered-only workflow
  // (a pure reactor / event-create saga) has no command surface — its bodies
  // run via the in-process dispatcher's INotificationHandlers — so emitting an
  // HTTP route with an event-typed Request DTO would be bogus (and wouldn't
  // compile: an event carries no `<Event>Response` wire DTO).
  const commandWfs = ctx.workflows.filter(emitsCommandRoute);
  for (const wf of commandWfs) {
    const usage = analyseWorkflow(wf, aggsByName);
    const construct = `${ctx.name}.${wf.name}`;
    const requestPath = `Application/Workflows/${upperFirst(wf.name)}Request.cs`;
    const requestContent = renderRequestDto(wf, ctx, ns);
    out.set(requestPath, requestContent);
    sourcemap?.file(requestPath, requestContent, wf.origin, construct);
    const commandPath = `Application/Workflows/${upperFirst(wf.name)}Command.cs`;
    const commandContent = renderCommand(wf, ns);
    out.set(commandPath, commandContent);
    sourcemap?.file(commandPath, commandContent, wf.origin, construct);
    const handlerPath = `Application/Workflows/${upperFirst(wf.name)}Handler.cs`;
    // Only collected when a recorder is actually threaded in — a
    // no-sourcemap run pays no per-statement bookkeeping cost.
    const opFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
    const handlerContent = renderHandler(wf, usage, ns, ctx, options?.sys, opFragments);
    out.set(handlerPath, handlerContent);
    sourcemap?.file(handlerPath, handlerContent, wf.origin, construct);
    // Statement-granular sub-regions (source-map Milestone 11) — layered onto
    // the whole-file region just recorded above, anchored by exact-text
    // search against this SAME final content.
    if (sourcemap && opFragments) {
      for (const frag of opFragments) {
        sourcemap.fragment(handlerPath, handlerContent, frag.fragmentText, frag.subRegions);
      }
    }
  }
  if (commandWfs.length > 0) {
    out.set(
      `Api/${ctx.name}WorkflowsController.cs`,
      renderController(ctx, ns, commandWfs, options?.routePrefix),
    );
    // A command-workflow whose param is a value object surfaces a
    // `<Vo>Request` in its Request DTO (`record FooRequest(MoneyRequest …)`).
    // The per-aggregate request emitter only emits `<Vo>Request` for VOs
    // reachable from an AGGREGATE's surface (`valueObjectsUsedBy`) — a VO that
    // appears only as a workflow param has no such emission, so the Request
    // DTO references an undefined `MoneyRequest` (CS0246).  Emit the VO request
    // records the workflow params need into the `Application.Workflows`
    // namespace (the Request DTOs' own namespace, so they resolve unqualified),
    // mirroring the aggregate-create `<Vo>Request` shape.
    const voRequests = renderWorkflowValueObjectRequests(commandWfs, ctx, ns);
    if (voRequests) out.set("Application/Workflows/WorkflowRequests.cs", voRequests);
  }
}

/** Emit the `<Vo>Request` records that this context's command-workflows'
 *  value-object params reference (transitively through nested VOs), into the
 *  shared `Application.Workflows` namespace.  Mirrors the per-aggregate VO
 *  request shape (`cqrs/dtos.ts`) but keyed off workflow params rather than an
 *  aggregate surface.  Returns `undefined` when no workflow param is a VO. */
function renderWorkflowValueObjectRequests(
  commandWfs: readonly WorkflowIR[],
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string | undefined {
  const seeds = function* (): Generator<import("../../ir/types/loom-ir.js").TypeIR> {
    for (const wf of commandWfs) for (const p of wf.params) yield p.type;
  };
  const { valueObjects } = collectReachableTypes(seeds(), ctx.valueObjects);
  if (valueObjects.size === 0) return undefined;
  const recs = ctx.valueObjects
    .filter((v) => valueObjects.has(v.name))
    .map((vo) => {
      const params = vo.fields
        .map((f) => dtoParam(wireType(f.type, ctx, "request"), upperFirst(f.name), "request"))
        .join(", ");
      return `public sealed record ${vo.name}Request(${params});\n`;
    })
    .join("\n");
  return `// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Workflows;

${recs}`;
}

/** A workflow exposes an HTTP command POST when its facade (the primary
 *  unnamed create) is command-triggered.  A workflow whose only create is
 *  event-triggered (`create(e: Event)`) — i.e. a reactor / saga started by an
 *  event, never by an HTTP call — has no command surface. */
function emitsCommandRoute(wf: WorkflowIR): boolean {
  const facade =
    wf.creates.find((c) => c.name === null && c.triggerKind === "command") ?? wf.creates[0];
  return !facade || facade.triggerKind === "command";
}

// ---------------------------------------------------------------------------
// In-process event dispatch — reactor / event-create notification handlers.
//
// Mirrors the Hono in-process dispatch (#970): each channel-routed
// subscription (an `on(e: Event)` reactor or an event-triggered
// `create(e: Event)` starter) becomes a Mediator
// `INotificationHandler<TEvent>`.  The in-process dispatcher
// (Infrastructure/Events/InProcessDomainEventDispatcher.cs) publishes every
// emitted domain event as a notification, so each reactor / starter handler
// for that event type runs — and a handler's own `emit` re-enters the
// dispatcher, so choreography chains (OrderPlaced → ShipmentRequested → …)
// fan out.
//
// Correlation is persisted when the workflow declares a correlation field: the
// handler injects the AppDbContext, routes the event to a saga-state row keyed
// by that field (load-or-allocate for `create`, route-or-drop+log for `on`),
// renders the body with `this.<stateField>` reading the loaded row, and saves
// it at exit.  A workflow with no correlation field runs statelessly (a fresh
// handler per event).  See workflow-state-emit.ts for the row's POCO + EF
// configuration.
// ---------------------------------------------------------------------------

export function emitDispatchHandlers(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  sys: SystemIR | undefined,
  /** Source-map recorder (Milestone 12) — threaded ONLY from the system-mode
   *  `dotnet/index.ts` entry point; the legacy single-context path stays
   *  unmapped by design (undefined here), so its output is untouched.  Each
   *  dispatch-handler file is per-subscription and single-workflow-attributable,
   *  so it gets a whole-file region (like `emitWorkflows`) PLUS statement
   *  sub-regions layered on top. */
  sourcemap?: SourceMapRecorder,
): void {
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  // Event-sourced saga double-append (S5b): when an event-sourced workflow has
  // BOTH an `on` reactor and an event-`create` starter for the SAME event, the
  // two `INotificationHandler` classes fan out in unspecified Mediator order —
  // a start-first-on-a-new-stream ordering double-appends.  Merge them into ONE
  // handler that reads the stream once and branches (empty → create-logic,
  // non-empty → on-logic).  Non-ES workflows and events without both an `on` and
  // a `create` stay two independent handlers (byte-identical).
  const isMergedEsEvent = (wf: WorkflowIR, event: string): boolean =>
    !!wf.eventSourced &&
    (wf.subscriptions ?? []).some((o) => o.event === event) &&
    wf.creates.some((c) => c.triggerKind === "event" && c.eventRef === event && !!c.eventBinding);

  const resolveSub = (
    wf: WorkflowIR,
    sub: EventSubscriptionIR,
  ): {
    statements: WorkflowStmtIR[];
    saves: { name: string; aggName: string; repoName: string }[];
    correlation: ExprIR | undefined;
  } | null => {
    if (sub.trigger === "on") {
      const on = (wf.subscriptions ?? []).find(
        (o) => o.event === sub.event && o.param === sub.param,
      );
      return on
        ? { statements: on.statements, saves: on.savesAtExit, correlation: on.correlation }
        : null;
    }
    const cr = wf.creates.find((c) => c.eventRef === sub.event && c.eventBinding === sub.param);
    return cr
      ? { statements: cr.statements, saves: cr.savesAtExit, correlation: cr.correlation }
      : null;
  };

  for (const sub of ctx.eventSubscriptions) {
    const wf = ctx.workflows.find((w) => w.name === sub.workflow);
    if (!wf) continue;
    if (isMergedEsEvent(wf, sub.event)) {
      // Render the merged handler once (on the `create` sub); drop the `on` sub
      // (its logic is the else-branch).
      if (sub.trigger !== "create") continue;
      const createResolved = resolveSub(wf, sub);
      const onSub = ctx.eventSubscriptions.find(
        (s) => s.workflow === sub.workflow && s.event === sub.event && s.trigger === "on",
      );
      const onResolved = onSub ? resolveSub(wf, onSub) : null;
      if (!createResolved || !onSub || !onResolved) continue;
      const className = `${upperFirst(wf.name)}On${upperFirst(sub.event)}Handler`;
      const construct = `${ctx.name}.${wf.name}`;
      const path = `Application/Workflows/${className}.cs`;
      // Only collected when a recorder is actually threaded in — a
      // no-sourcemap run pays no per-statement bookkeeping cost.
      const opFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
      const content = renderMergedEventSourcedHandler(
        className,
        wf,
        sub.event,
        sub,
        createResolved,
        onSub,
        onResolved,
        aggsByName,
        ns,
        ctx,
        sys,
        construct,
        opFragments,
      );
      out.set(path, content);
      sourcemap?.file(path, content, wf.origin, construct);
      if (sourcemap && opFragments) {
        for (const frag of opFragments)
          sourcemap.fragment(path, content, frag.fragmentText, frag.subRegions);
      }
      continue;
    }
    const resolved = resolveSub(wf, sub);
    if (!resolved) continue;
    const className = `${upperFirst(wf.name)}${sub.trigger === "on" ? "On" : "Start"}${upperFirst(sub.event)}Handler`;
    const construct = `${ctx.name}.${wf.name}`;
    const path = `Application/Workflows/${className}.cs`;
    const opFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
    const content = renderEventReactorHandler(
      className,
      wf,
      sub.trigger,
      sub.event,
      sub.param,
      resolved.correlation,
      resolved.statements,
      resolved.saves,
      aggsByName,
      ns,
      ctx,
      sys,
      construct,
      opFragments,
    );
    out.set(path, content);
    sourcemap?.file(path, content, wf.origin, construct);
    if (sourcemap && opFragments) {
      for (const frag of opFragments)
        sourcemap.fragment(path, content, frag.fragmentText, frag.subRegions);
    }
  }
}

/** Repos / emit / externs used by a handler body — the analyseWorkflow
 *  derivation, but over a bare statement list + its saves (reactors and
 *  event-creates carry `statements` + `savesAtExit`, not a whole WorkflowIR). */
function analyseStmts(
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
  aggsByName: Map<string, AggregateIR>,
): WorkflowUsage {
  const repos = new Map<string, string>();
  const externs = new Map<string, { aggName: string; opName: string }>();
  let hasEmit = false;
  for (const save of saves) repos.set(save.repoName, save.aggName);
  const walk = (stmts: WorkflowStmtIR[]): void => {
    for (const st of stmts) {
      if (st.kind === "repo-let" || st.kind === "repo-run") {
        repos.set(st.repoName, st.aggName);
      } else if (st.kind === "emit") {
        hasEmit = true;
      } else if (st.kind === "for-each") {
        for (const sv of st.savesPerIteration) repos.set(sv.repoName, sv.aggName);
        walk(st.body);
      } else if (st.kind === "if-let") {
        repos.set(st.repoName, st.aggName);
        for (const sv of st.savesInThen) repos.set(sv.repoName, sv.aggName);
        for (const sv of st.savesInElse) repos.set(sv.repoName, sv.aggName);
        walk(st.thenBody);
        walk(st.elseBody ?? []);
      } else if (st.kind === "op-call") {
        const agg = aggsByName.get(st.aggName);
        const op = agg?.operations.find((o) => o.name === st.op);
        if (op?.extern)
          externs.set(`${st.aggName}.${st.op}`, { aggName: st.aggName, opName: st.op });
      }
    }
  };
  walk(statements);
  return { repos, hasEmit, externs };
}

/** One `INotificationHandler<TEvent>` for a reactor / event-create.  The
 *  inbound event instance binds directly as the handler's `notification`
 *  argument (already domain-typed in-process — no wire→domain conversion,
 *  unlike the HTTP command path); repos are DI-injected, the re-entrant
 *  `IDomainEventDispatcher` carries a body `emit` back to its own subscribers,
 *  and let-bound / loaded aggregates are saved at exit.
 *
 *  When the workflow declares a correlation field the handler is **persisted**:
 *  it injects the `AppDbContext`, routes the event to a saga-instance row keyed
 *  by the correlation field, and renders the body with `this.<stateField>`
 *  reading/writing that row (the `thisName: "state"` seam).  A `create` starter
 *  loads-or-allocates (seeding the key + typed defaults); an `on` reactor routes
 *  to the existing row, or — when none exists — drops the event and logs
 *  `event_unrouted` (channels.md drop+log policy).  The row is saved at exit. */
function renderEventReactorHandler(
  className: string,
  wf: WorkflowIR,
  trigger: "on" | "create",
  eventName: string,
  paramName: string,
  correlation: ExprIR | undefined,
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
  aggsByName: Map<string, AggregateIR>,
  ns: string,
  ctx: EnrichedBoundedContextIR,
  sys: SystemIR | undefined,
  construct: string,
  /** Source-map Milestone 12 — when passed, pushes ONE `OpFragment` covering
   *  this handler's whole reactor-body chunk list (mirrors `renderHandler`'s
   *  `opFragments`, no re-indent here — the body renders flush, unlike the
   *  transactional command-handler tab-in). */
  opFragments?: OpFragment[],
): string {
  const usage = analyseStmts(statements, saves, aggsByName);
  const usings = new Set<string>();
  const persisted = !!wf.correlationField;
  // An `eventSourced` workflow folds its `<wf>_events` stream into `state`
  // rather than loading a mutable row (workflow-and-applier.md A2-S5b).
  const eventSourced = !!wf.eventSourced;
  // A persisted handler renders `this.<stateField>` against the loaded row.
  const thisName = persisted ? "state" : "this";

  // Field declarations + ctor for injected dependencies (mirrors renderHandler).
  const fields: string[] = [];
  const ctorParamPairs: string[] = [];
  const ctorAssigns: string[] = [];
  for (const [repoName, aggName] of usage.repos.entries()) {
    const fieldName = `_${repoName.charAt(0).toLowerCase() + repoName.slice(1)}`;
    fields.push(`    private readonly I${aggName}Repository ${fieldName};`);
    ctorParamPairs.push(`I${aggName}Repository ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  if (usage.hasEmit) {
    fields.push("    private readonly IDomainEventDispatcher _events;");
    ctorParamPairs.push("IDomainEventDispatcher events");
    ctorAssigns.push("_events = events");
  }
  for (const ext of usage.externs.values()) {
    const ifaceName = `I${upperFirst(ext.opName)}${ext.aggName}Handler`;
    const fieldName = `_${ext.opName}${ext.aggName}Handler`;
    fields.push(`    private readonly ${ifaceName} ${fieldName};`);
    ctorParamPairs.push(`${ifaceName} ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  // Audited op-calls inside a reactor stage AuditRecords too — a reactor calls
  // ops inline (like the command handler), so without this an audited change
  // made in response to an event would be invisible to the audit log.  Same
  // shape as renderHandler; provenance needs nothing (it flushes in SaveAsync).
  // The reactor is an INotificationHandler dispatched through the Mediator
  // pipeline, so ExecutionContextBehavior has already opened its frame — the
  // staged row's correlation / scope / parent ids resolve from RequestContext.
  const auditAggs = new Set<string>();
  const collectAuditAggs = (sts: WorkflowStmtIR[]): void => {
    for (const s of sts) {
      if (s.kind === "op-call") {
        const o = ctx.aggregates
          .find((a) => a.name === s.aggName)
          ?.operations.find((x) => x.name === s.op);
        if (o?.audited && !o.extern) auditAggs.add(s.aggName);
      } else if (s.kind === "for-each") collectAuditAggs(s.body);
    }
  };
  collectAuditAggs(statements);
  const auditsOps = auditAggs.size > 0;
  if (auditsOps) {
    fields.push("    private readonly IAuditWriter _audit;");
    ctorParamPairs.push("IAuditWriter audit");
    ctorAssigns.push("_audit = audit");
    // `${ns}.Domain.Common` (RequestContext) is in the hardcoded preamble; adding
    // it here would duplicate the directive (CS0105 → error under /warnaserror).
    usings.add(`${ns}.Application.Common`);
    usings.add(`${ns}.Infrastructure.Persistence`);
    for (const aggName of auditAggs) usings.add(`${ns}.Application.${plural(aggName)}.Responses`);
  }
  // The saga state lives in the AppDbContext; the `on` drop path logs via
  // ILogger.  An event-sourced workflow reads its `<wf>_events` stream
  // (Persistence.Events) and folds via the `<Wf>State` class (this handler's
  // own Application.Workflows namespace); a state-based saga reads its row POCO
  // (Persistence.Workflows).
  if (persisted) {
    // `global::`-anchor the AppDbContext reference: a deployable named `api`
    // makes `ns === "Api"`, and a bare `Api.Infrastructure...` inside
    // `Api.Application.Workflows` mis-resolves the leading `Api` (CS0234).
    // Mirrors the same fix on the migrations DbContext attribute (emit/migrations.ts).
    fields.push(`    private readonly global::${ns}.Infrastructure.Persistence.AppDbContext _db;`);
    ctorParamPairs.push(`global::${ns}.Infrastructure.Persistence.AppDbContext db`);
    ctorAssigns.push("_db = db");
    usings.add("Microsoft.EntityFrameworkCore");
    usings.add(`${ns}.Infrastructure.Persistence.${eventSourced ? "Events" : "Workflows"}`);
    if (eventSourced) {
      // Stream fold/append uses System.Linq (`Select`/`ToList`) + DateTime.
      usings.add("System");
      usings.add("System.Linq");
    }
    if (trigger === "on") {
      fields.push(`    private readonly ILogger<${className}> _log;`);
      ctorParamPairs.push(`ILogger<${className}> log`);
      ctorAssigns.push("_log = log");
      usings.add("Microsoft.Extensions.Logging");
    }
  }

  // Statement rendering.  The bound event param resolves to `notification`;
  // `this.<stateField>` resolves to the loaded `state` row (persisted only).
  const stmtLines: string[] = [];
  if (usage.hasEmit) stmtLines.push("        var _workflowEvents = new List<IDomainEvent>();");
  const resourceClasses = buildResourceClasses(sys);
  const usesResourceOp = statements.some((st) => {
    const call =
      st.kind === "resource-call" ? st.call : st.kind === "expr-let" ? st.expr : undefined;
    return call?.kind === "call" && call.callKind === "resource-op";
  });
  if (resourceClasses.size > 0 && usesResourceOp) usings.add(`${ns}.Resources`);
  const renderArg = (e: ExprIR): string => {
    collectCsExprUsings(e, usings, ns);
    return renderExprWithEventParam(e, paramName, resourceClasses, thisName);
  };
  // Correlation routing: load-or-allocate (create) / route-or-drop+log (on).
  if (persisted) {
    const corr = wf.correlationField as string;
    const corrPascal = upperFirst(corr);
    // The routing key: the `by <expr>` value, else the event field that
    // name-matches the correlation field (the omitted-`by` rule).
    const keyExpr = correlation
      ? renderExprWithEventParam(correlation, paramName, resourceClasses)
      : `notification.${corrPascal}`;
    stmtLines.push(`        var __key = ${keyExpr};`);
    if (eventSourced) {
      // Fold the `<wf>_events` stream into `state`.  A `create` starter folds
      // from-zero (empty stream → seeded defaults); an `on` reactor requires a
      // started saga (non-empty stream) and otherwise drops + logs.
      const dbSet = esEventDbSet(wf);
      const stateCls = workflowStateClass(wf);
      stmtLines.push("        var __sid = __key.Value.ToString();");
      stmtLines.push(
        `        var __rows = await _db.${dbSet}.Where(e => e.StreamId == __sid).OrderBy(e => e.Version).ToListAsync(cancellationToken);`,
      );
      if (trigger === "on") {
        stmtLines.push("        if (__rows.Count == 0)");
        stmtLines.push("        {");
        stmtLines.push(
          `            ${renderDotnetLogCall("eventUnrouted", [
            { name: "workflow", valueExpr: JSON.stringify(wf.name) },
            { name: "event_type", valueExpr: JSON.stringify(eventName) },
            { name: "key", valueExpr: "__key" },
          ])}`,
        );
        stmtLines.push("            return;");
        stmtLines.push("        }");
      }
      stmtLines.push(
        `        var state = ${stateCls}._FromEvents(__key, __rows.Select(${stateCls}.RowToEvent).ToList());`,
      );
    } else {
      const dbSet = workflowStateDbSet(wf);
      stmtLines.push(
        `        var state = await _db.${dbSet}.FirstOrDefaultAsync(x => x.${corrPascal} == __key, cancellationToken);`,
      );
      if (trigger === "create") {
        // A starter creates the instance if its key is new.
        stmtLines.push("        if (state is null)");
        stmtLines.push("        {");
        stmtLines.push(`            state = ${workflowAllocateInitializer(wf, "__key")};`);
        stmtLines.push(`            _db.${dbSet}.Add(state);`);
        stmtLines.push("        }");
      } else {
        // A continuation needs a started instance; otherwise drop + log.
        stmtLines.push("        if (state is null)");
        stmtLines.push("        {");
        stmtLines.push(
          `            ${renderDotnetLogCall("eventUnrouted", [
            { name: "workflow", valueExpr: JSON.stringify(wf.name) },
            { name: "event_type", valueExpr: JSON.stringify(eventName) },
            { name: "key", valueExpr: "__key" },
          ])}`,
        );
        stmtLines.push("            return;");
        stmtLines.push("        }");
      }
      if (durableEventTypes(ctx).size > 0) {
        // Idempotent-consumer marker (dispatch-delivery-semantics.md §3):
        // the relay rides the outbox row id on OutboxDelivery.CurrentEventId;
        // a repeat of the recorded id is a no-op (at-least-once →
        // effectively-once).  Inline (ephemeral) dispatch carries null.
        stmtLines.push("        var __eventId = OutboxDelivery.CurrentEventId;");
        stmtLines.push("        if (__eventId is not null && state.LastEventId == __eventId)");
        stmtLines.push("        {");
        stmtLines.push("            return; // already processed — at-least-once redelivery");
        stmtLines.push("        }");
      }
    }
  }
  // Reactor / event-create bodies always dereference their loads → guard all.
  // Chunked (one lines-array per top-level statement) rather than the
  // pre-flattened `renderWorkflowStmts` — byte-identical either way, but the
  // per-chunk list lets us surface per-statement sub-regions to the caller
  // (source-map Milestone 12; mirrors `renderHandler`'s `stmtChunks`).
  const stmtChunks = renderWorkflowStmtChunks(
    statements,
    csWorkflowStmtTarget(ctx, renderArg, true, auditsOps),
    INDENT,
  );
  stmtLines.push(...stmtChunks.flat());
  if (opFragments) {
    // No re-indent on this path — the reactor body renders flush at INDENT,
    // unlike the transactional command handler's tab-in (renderHandler).
    const chunkTexts = stmtChunks.map((ls) => ls.join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(statements, chunkTexts, construct),
      });
    }
  }
  for (const save of saves) {
    const fieldName = `_${save.repoName.charAt(0).toLowerCase() + save.repoName.slice(1)}`;
    stmtLines.push(`        await ${fieldName}.SaveAsync(${save.name}, cancellationToken);`);
  }
  if (persisted && eventSourced) {
    // Append the workflow's own (folded) emitted events to its stream,
    // gap-free, then SaveChanges.  Every emit in an event-sourced workflow has
    // an applier (the A1 discipline), so all `_workflowEvents` are own-events;
    // they are also re-published below for choreography.
    if (usage.hasEmit) {
      const dbSet = esEventDbSet(wf);
      const recordCls = esEventRecordClass(wf);
      const stateCls = workflowStateClass(wf);
      stmtLines.push(
        `        var __version = await _db.${dbSet}.Where(e => e.StreamId == __sid).Select(e => (int?)e.Version).MaxAsync(cancellationToken) ?? 0;`,
      );
      stmtLines.push("        foreach (var __ev in _workflowEvents)");
      stmtLines.push("        {");
      stmtLines.push("            __version++;");
      stmtLines.push(`            _db.${dbSet}.Add(new ${recordCls}`);
      stmtLines.push("            {");
      stmtLines.push("                StreamId = __sid,");
      stmtLines.push("                Version = __version,");
      stmtLines.push("                Type = __ev.GetType().Name,");
      stmtLines.push(`                Data = ${stateCls}.ToData(__ev),`);
      stmtLines.push("                OccurredAt = DateTime.UtcNow,");
      stmtLines.push("            });");
      stmtLines.push("        }");
      stmtLines.push("        await _db.SaveChangesAsync(cancellationToken);");
    }
  } else if (persisted) {
    // Persist the saga row (a new allocation, or a `this.<stateField>` mutation).
    if (durableEventTypes(ctx).size > 0) {
      stmtLines.push("        if (__eventId is not null) state.LastEventId = __eventId;");
    }
    stmtLines.push("        await _db.SaveChangesAsync(cancellationToken);");
  }

  let body = stmtLines.join("\n") + "\n";
  if (usage.hasEmit) {
    body +=
      `        foreach (var ev in _workflowEvents)\n` +
      `            await _events.DispatchAsync(ev, cancellationToken);\n`;
  }
  // CS1998 (async method without await) is fatal under /warnaserror.  Saves,
  // the persisted load, and emit-dispatch all `await`, so a body normally has
  // one; guard the rare pure-compute reactor by dropping `async`.
  const isAsync = /\bawait\b/.test(body);
  if (!isAsync) body += "        return ValueTask.CompletedTask;\n";

  const ctor =
    ctorParamPairs.length === 0
      ? `    public ${className}() { }`
      : `    public ${className}(${ctorParamPairs.join(", ")})\n    {\n        ${ctorAssigns.join("; ")};\n    }`;

  const aggsTouched = new Set<string>([
    ...usage.repos.values(),
    ...[...usage.externs.values()].map((e) => e.aggName),
  ]);
  const aggUsings = [
    ...new Set([...aggsTouched].map((agg) => `using ${ns}.Domain.${plural(agg)};`)),
  ];
  const externUsings = [
    ...new Set(
      [...usage.externs.values()].flatMap((e) => [
        `using ${ns}.Application.${plural(e.aggName)}.Handlers;`,
        `using ${ns}.Application.${plural(e.aggName)}.Requests;`,
      ]),
    ),
  ];
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;${extraUsings.length > 0 ? "\n" + extraUsings.join("\n") : ""}
using Mediator;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${aggUsings.join("\n")}${externUsings.length > 0 ? "\n" + externUsings.join("\n") : ""}

namespace ${ns}.Application.Workflows;

public sealed class ${className} : INotificationHandler<${eventName}>
{
${fields.join("\n")}
${ctor}

    public ${isAsync ? "async " : ""}ValueTask Handle(${eventName} notification, CancellationToken cancellationToken)
    {
${body}    }
}
`;
}

/** The append + re-publish tail for ONE branch of a merged event-sourced saga
 *  handler: the emit-list decl, the body against the shared folded `state`, the
 *  aggregate saves, then the gap-free own-event stream append + SaveChanges +
 *  re-dispatch.  Stream load + fold are shared across branches, so they are NOT
 *  emitted here.  Rendered at the 8-space base; the caller indents each branch
 *  a further level inside its `if`/`else` block. */
function renderCsEsBranch(
  wf: WorkflowIR,
  resolved: ResolvedWorkflowBody,
  paramName: string,
  aggsByName: Map<string, AggregateIR>,
  ctx: EnrichedBoundedContextIR,
  sys: SystemIR | undefined,
  usings: Set<string>,
  ns: string,
  auditsOps: boolean,
  construct: string,
  /** Source-map Milestone 12 — this branch's own `OpFragment`, pushed here so
   *  the merged handler (create + on) records TWO fragments, one per branch.
   *  The caller (`renderMergedEventSourcedHandler`) nests this branch's WHOLE
   *  returned `lines` one level (+4 spaces, uniform per-line map) inside its
   *  `if`/`else` — so the fragment text/sub-regions must replay that SAME +4
   *  re-indent onto the statement chunks before anchoring, mirroring the
   *  `renderHandler` transactional precedent. */
  opFragments?: OpFragment[],
): string[] {
  const usage = analyseStmts(resolved.statements, resolved.saves, aggsByName);
  const resourceClasses = buildResourceClasses(sys);
  const renderArg = (e: ExprIR): string => {
    collectCsExprUsings(e, usings, ns);
    return renderExprWithEventParam(e, paramName, resourceClasses, "state");
  };
  const lines: string[] = [];
  if (usage.hasEmit) lines.push("        var _workflowEvents = new List<IDomainEvent>();");
  const stmtChunks = renderWorkflowStmtChunks(
    resolved.statements,
    csWorkflowStmtTarget(ctx, renderArg, true, auditsOps),
    INDENT,
  );
  lines.push(...stmtChunks.flat());
  if (opFragments) {
    // Replay the +4 re-indent the caller applies when nesting this branch
    // inside the if/else (renderMergedEventSourcedHandler's `if (__rows.Count
    // == 0)` / `else` blocks) so the fragment anchors the FINAL text.
    const chunkTexts = stmtChunks.map((ls) => ls.map((l) => "    " + l).join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(resolved.statements, chunkTexts, construct),
      });
    }
  }
  for (const save of resolved.saves) {
    const fieldName = `_${save.repoName.charAt(0).toLowerCase() + save.repoName.slice(1)}`;
    lines.push(`        await ${fieldName}.SaveAsync(${save.name}, cancellationToken);`);
  }
  if (usage.hasEmit) {
    const dbSet = esEventDbSet(wf);
    const recordCls = esEventRecordClass(wf);
    const stateCls = workflowStateClass(wf);
    lines.push(
      `        var __version = await _db.${dbSet}.Where(e => e.StreamId == __sid).Select(e => (int?)e.Version).MaxAsync(cancellationToken) ?? 0;`,
      "        foreach (var __ev in _workflowEvents)",
      "        {",
      "            __version++;",
      `            _db.${dbSet}.Add(new ${recordCls}`,
      "            {",
      "                StreamId = __sid,",
      "                Version = __version,",
      "                Type = __ev.GetType().Name,",
      `                Data = ${stateCls}.ToData(__ev),`,
      "                OccurredAt = DateTime.UtcNow,",
      "            });",
      "        }",
      "        await _db.SaveChangesAsync(cancellationToken);",
      "        foreach (var ev in _workflowEvents)",
      "            await _events.DispatchAsync(ev, cancellationToken);",
    );
  }
  return lines;
}

/** The merged event-sourced saga handler (S5b): one `INotificationHandler` that
 *  reads the `<wf>_events` stream ONCE and branches — empty stream → the
 *  `create` starter body, non-empty → the `on` reactor body — so exactly one of
 *  the two appends regardless of Mediator's notification fan-out order.
 *  Replaces the two independent `On…`/`Start…` handler classes that otherwise
 *  double-append.  Emitted only for an event with BOTH an `on` and an
 *  event-`create` on the same event-sourced workflow. */
function renderMergedEventSourcedHandler(
  className: string,
  wf: WorkflowIR,
  eventName: string,
  createSub: EventSubscriptionIR,
  createResolved: ResolvedWorkflowBody,
  onSub: EventSubscriptionIR,
  onResolved: ResolvedWorkflowBody,
  aggsByName: Map<string, AggregateIR>,
  ns: string,
  ctx: EnrichedBoundedContextIR,
  sys: SystemIR | undefined,
  construct: string,
  /** Source-map Milestone 12 — forwarded to `renderCsEsBranch` for BOTH
   *  branches, so a merged handler records two `OpFragment`s (create + on),
   *  each anchored at its own nested position in the final `if`/`else`. */
  opFragments?: OpFragment[],
): string {
  const mergedStatements = [...createResolved.statements, ...onResolved.statements];
  const mergedSaves = [...createResolved.saves, ...onResolved.saves];
  const usage = analyseStmts(mergedStatements, mergedSaves, aggsByName);
  const usings = new Set<string>();

  // Field declarations + ctor for injected dependencies (union of both branches).
  const fields: string[] = [];
  const ctorParamPairs: string[] = [];
  const ctorAssigns: string[] = [];
  for (const [repoName, aggName] of usage.repos.entries()) {
    const fieldName = `_${repoName.charAt(0).toLowerCase() + repoName.slice(1)}`;
    fields.push(`    private readonly I${aggName}Repository ${fieldName};`);
    ctorParamPairs.push(`I${aggName}Repository ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  if (usage.hasEmit) {
    fields.push("    private readonly IDomainEventDispatcher _events;");
    ctorParamPairs.push("IDomainEventDispatcher events");
    ctorAssigns.push("_events = events");
  }
  for (const ext of usage.externs.values()) {
    const ifaceName = `I${upperFirst(ext.opName)}${ext.aggName}Handler`;
    const fieldName = `_${ext.opName}${ext.aggName}Handler`;
    fields.push(`    private readonly ${ifaceName} ${fieldName};`);
    ctorParamPairs.push(`${ifaceName} ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  const auditAggs = new Set<string>();
  const collectAuditAggs = (sts: WorkflowStmtIR[]): void => {
    for (const s of sts) {
      if (s.kind === "op-call") {
        const o = ctx.aggregates
          .find((a) => a.name === s.aggName)
          ?.operations.find((x) => x.name === s.op);
        if (o?.audited && !o.extern) auditAggs.add(s.aggName);
      } else if (s.kind === "for-each") collectAuditAggs(s.body);
    }
  };
  collectAuditAggs(mergedStatements);
  const auditsOps = auditAggs.size > 0;
  if (auditsOps) {
    fields.push("    private readonly IAuditWriter _audit;");
    ctorParamPairs.push("IAuditWriter audit");
    ctorAssigns.push("_audit = audit");
    usings.add(`${ns}.Application.Common`);
    usings.add(`${ns}.Infrastructure.Persistence`);
    for (const aggName of auditAggs) usings.add(`${ns}.Application.${plural(aggName)}.Responses`);
  }
  fields.push(`    private readonly global::${ns}.Infrastructure.Persistence.AppDbContext _db;`);
  ctorParamPairs.push(`global::${ns}.Infrastructure.Persistence.AppDbContext db`);
  ctorAssigns.push("_db = db");
  usings.add("Microsoft.EntityFrameworkCore");
  usings.add(`${ns}.Infrastructure.Persistence.Events`);
  usings.add("System");
  usings.add("System.Linq");

  const resourceClasses = buildResourceClasses(sys);
  const usesResourceOp = mergedStatements.some((st) => {
    const call =
      st.kind === "resource-call" ? st.call : st.kind === "expr-let" ? st.expr : undefined;
    return call?.kind === "call" && call.callKind === "resource-op";
  });
  if (resourceClasses.size > 0 && usesResourceOp) usings.add(`${ns}.Resources`);

  const corr = wf.correlationField as string;
  const corrPascal = upperFirst(corr);
  const keyExpr = createResolved.correlation
    ? renderExprWithEventParam(createResolved.correlation, createSub.param, resourceClasses)
    : `notification.${corrPascal}`;
  if (createResolved.correlation) collectCsExprUsings(createResolved.correlation, usings, ns);
  const dbSet = esEventDbSet(wf);
  const stateCls = workflowStateClass(wf);

  const createBranch = renderCsEsBranch(
    wf,
    createResolved,
    createSub.param,
    aggsByName,
    ctx,
    sys,
    usings,
    ns,
    auditsOps,
    construct,
    opFragments,
  );
  const onBranch = renderCsEsBranch(
    wf,
    onResolved,
    onSub.param,
    aggsByName,
    ctx,
    sys,
    usings,
    ns,
    auditsOps,
    construct,
    opFragments,
  );

  const bodyLines: string[] = [
    `        var __key = ${keyExpr};`,
    "        var __sid = __key.Value.ToString();",
    `        var __rows = await _db.${dbSet}.Where(e => e.StreamId == __sid).OrderBy(e => e.Version).ToListAsync(cancellationToken);`,
    `        var state = ${stateCls}._FromEvents(__key, __rows.Select(${stateCls}.RowToEvent).ToList());`,
    "        if (__rows.Count == 0)",
    "        {",
    ...createBranch.map((l) => `    ${l}`),
    "        }",
    "        else",
    "        {",
    ...onBranch.map((l) => `    ${l}`),
    "        }",
  ];
  const body = bodyLines.join("\n") + "\n";

  const ctor =
    ctorParamPairs.length === 0
      ? `    public ${className}() { }`
      : `    public ${className}(${ctorParamPairs.join(", ")})\n    {\n        ${ctorAssigns.join("; ")};\n    }`;

  const aggsTouched = new Set<string>([
    ...usage.repos.values(),
    ...[...usage.externs.values()].map((e) => e.aggName),
  ]);
  const aggUsings = [
    ...new Set([...aggsTouched].map((agg) => `using ${ns}.Domain.${plural(agg)};`)),
  ];
  const externUsings = [
    ...new Set(
      [...usage.externs.values()].flatMap((e) => [
        `using ${ns}.Application.${plural(e.aggName)}.Handlers;`,
        `using ${ns}.Application.${plural(e.aggName)}.Requests;`,
      ]),
    ),
  ];
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;${extraUsings.length > 0 ? "\n" + extraUsings.join("\n") : ""}
using Mediator;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${aggUsings.join("\n")}${externUsings.length > 0 ? "\n" + externUsings.join("\n") : ""}

namespace ${ns}.Application.Workflows;

public sealed class ${className} : INotificationHandler<${eventName}>
{
${fields.join("\n")}
${ctor}

    public async ValueTask Handle(${eventName} notification, CancellationToken cancellationToken)
    {
${body}    }
}
`;
}

// ---------------------------------------------------------------------------
// Analysis — collect repos to inject + whether the workflow emits.
// ---------------------------------------------------------------------------

interface WorkflowUsage {
  /** repoName -> aggName, for DI. */
  repos: Map<string, string>;
  /** True when at least one `emit` statement appears. */
  hasEmit: boolean;
  /** Extern op-calls that need an `IXAggHandler` injected.  Keyed
   *  by `<aggName>.<opName>` so duplicate calls share one
   *  injection. */
  externs: Map<string, { aggName: string; opName: string }>;
}

function analyseWorkflow(wf: WorkflowIR, aggsByName: Map<string, AggregateIR>): WorkflowUsage {
  const repos = new Map<string, string>();
  const externs = new Map<string, { aggName: string; opName: string }>();
  let hasEmit = false;
  for (const save of wf.savesAtExit) {
    repos.set(save.repoName, save.aggName);
  }
  const walk = (stmts: WorkflowStmtIR[]): void => {
    for (const st of stmts) {
      if (st.kind === "repo-let" || st.kind === "repo-run") {
        repos.set(st.repoName, st.aggName);
      } else if (st.kind === "emit") {
        hasEmit = true;
      } else if (st.kind === "for-each") {
        for (const sv of st.savesPerIteration) repos.set(sv.repoName, sv.aggName);
        walk(st.body);
      } else if (st.kind === "if-let") {
        // The if-let single-row lookup dereferences its repo (`Run…Async`) and
        // saves per branch — register the repo + its branch saves and recurse
        // both branches, else the handler references `_<repo>` without
        // injecting it (CS0103). Mirrors `collectReadingServices`.
        repos.set(st.repoName, st.aggName);
        for (const sv of st.savesInThen) repos.set(sv.repoName, sv.aggName);
        for (const sv of st.savesInElse) repos.set(sv.repoName, sv.aggName);
        walk(st.thenBody);
        walk(st.elseBody ?? []);
      } else if (st.kind === "op-call") {
        const agg = aggsByName.get(st.aggName);
        const op = agg?.operations.find((o) => o.name === st.op);
        if (op?.extern) {
          const key = `${st.aggName}.${st.op}`;
          externs.set(key, { aggName: st.aggName, opName: st.op });
        }
      }
    }
  };
  walk(wf.statements);
  return { repos, hasEmit, externs };
}

// ---------------------------------------------------------------------------
// Request DTO — wire-shape parameter record.
// ---------------------------------------------------------------------------

function renderRequestDto(wf: WorkflowIR, ctx: EnrichedBoundedContextIR, ns: string): string {
  const params = wf.params
    .map((p) => dtoParam(wireType(p.type, ctx, "request"), upperFirst(p.name), "request"))
    .join(", ");
  return `// Auto-generated.
using System.ComponentModel.DataAnnotations;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Workflows;

public sealed record ${upperFirst(wf.name)}Request(${params});
`;
}

// ---------------------------------------------------------------------------
// Mediator command — domain-typed parameter record.
// ---------------------------------------------------------------------------

function renderCommand(wf: WorkflowIR, ns: string): string {
  const params = wf.params.map((p) => `${renderCsType(p.type)} ${upperFirst(p.name)}`).join(", ");
  return `// Auto-generated.
using Mediator;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Workflows;

public sealed record ${upperFirst(wf.name)}Command(${params}) : ICommand;
`;
}

// ---------------------------------------------------------------------------
// Handler — orchestrates the workflow body.
// ---------------------------------------------------------------------------

function renderHandler(
  wf: WorkflowIR,
  usage: WorkflowUsage,
  ns: string,
  ctx: EnrichedBoundedContextIR,
  sys: SystemIR | undefined,
  /** Source-map Milestone 11 (workflow-body statement regions) — when passed,
   *  pushes ONE `OpFragment` covering this handler's whole workflow-body
   *  chunk list.  Allocated by the caller ONLY when a recorder is present
   *  (`emitWorkflows`), so a no-`--sourcemap` run pays no per-statement
   *  bookkeeping cost. */
  opFragments?: OpFragment[],
): string {
  const cmdName = `${upperFirst(wf.name)}Command`;
  const handlerName = `${upperFirst(wf.name)}Handler`;
  const usesUser = workflowUsesCurrentUser(wf);
  // Effective isolation: workflow's `transactional(<level>)` wins; else
  // the state-kind dataSource for this context's `isolationLevel:`; else
  // undefined (connection default applies at runtime).
  const effectiveIsolation = sys ? resolveWorkflowIsolation(wf, ctx, sys) : wf.isolation;
  // Workflow handler emits domain-logic statements via renderCsExpr and
  // (when transactional with an explicit isolation level) an
  // IsolationLevel.X enum literal.  Both surfaces may reach namespaces
  // outside the SDK's implicit-usings set — collect them per file.
  const usings = new Set<string>();
  if (wf.transactional && effectiveIsolation) usings.add("System.Data");
  // BeginTransactionAsync(IsolationLevel, CancellationToken) lives on
  // RelationalDatabaseFacadeExtensions, so transactional handlers need
  // the EntityFrameworkCore namespace for the 2-arg overload.
  if (wf.transactional) usings.add("Microsoft.EntityFrameworkCore");
  if (usesUser) usings.add(`${ns}.Auth`);
  // Field declarations for injected dependencies.
  const repoEntries = [...usage.repos.entries()];
  const fields: string[] = [];
  const ctorParamPairs: string[] = [];
  const ctorAssigns: string[] = [];
  for (const [repoName, aggName] of repoEntries) {
    const fieldName = `_${repoName.charAt(0).toLowerCase() + repoName.slice(1)}`;
    fields.push(`    private readonly I${aggName}Repository ${fieldName};`);
    ctorParamPairs.push(`I${aggName}Repository ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  if (usage.hasEmit) {
    fields.push("    private readonly IDomainEventDispatcher _events;");
    ctorParamPairs.push("IDomainEventDispatcher events");
    ctorAssigns.push("_events = events");
  }
  if (wf.transactional) {
    // `global::`-anchor the AppDbContext reference: a deployable named `api`
    // makes `ns === "Api"`, and a bare `Api.Infrastructure...` inside
    // `Api.Application.Workflows` mis-resolves the leading `Api` against the
    // enclosing `Api.Application` namespace (CS0234 — "does not exist in the
    // namespace 'Api.Api'").  Mirrors the persisted-saga handler + the
    // migrations DbContext attribute (emit/migrations.ts).
    fields.push(`    private readonly global::${ns}.Infrastructure.Persistence.AppDbContext _db;`);
    ctorParamPairs.push(`global::${ns}.Infrastructure.Persistence.AppDbContext db`);
    ctorAssigns.push("_db = db");
  }
  if (usesUser) {
    fields.push("    private readonly ICurrentUserAccessor _currentUser;");
    ctorParamPairs.push("ICurrentUserAccessor currentUser");
    ctorAssigns.push("_currentUser = currentUser");
  }
  // Workflow lifecycle narrative (workflow_started / workflow_completed) — the
  // command handler always logs both, so inject the catalog logger
  // (`renderDotnetLogCall` assumes a `_log` ILogger field).  Shared catalog
  // identity (field `workflow`) across every backend.
  fields.push(`    private readonly ILogger<${handlerName}> _log;`);
  ctorParamPairs.push(`ILogger<${handlerName}> log`);
  ctorAssigns.push("_log = log");
  usings.add("Microsoft.Extensions.Logging");
  // Extern op-call DI: each unique extern target needs its
  // user-supplied IXAggHandler injected.  Field name follows the
  // op+agg convention (`_confirmOrderHandler`).
  for (const ext of usage.externs.values()) {
    const ifaceName = `I${upperFirst(ext.opName)}${ext.aggName}Handler`;
    const fieldName = `_${ext.opName}${ext.aggName}Handler`;
    fields.push(`    private readonly ${ifaceName} ${fieldName};`);
    ctorParamPairs.push(`${ifaceName} ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }
  // Audited op-calls inside the workflow stage AuditRecords via IAuditWriter —
  // the per-operation handler's audit path, which a workflow's inline op-calls
  // would otherwise skip (audit-completeness gap, the sibling of the Hono one).
  // Inject the writer + the usings the staged record and its before/after wire
  // projection (`new <Agg>Response(...)`) need, when any audited op-call is
  // present.  Provenance needs nothing here — it already flushes inside SaveAsync.
  const auditAggs = new Set<string>();
  const collectAuditAggs = (sts: WorkflowStmtIR[]): void => {
    for (const s of sts) {
      if (s.kind === "op-call") {
        const o = ctx.aggregates
          .find((a) => a.name === s.aggName)
          ?.operations.find((x) => x.name === s.op);
        if (o?.audited && !o.extern) auditAggs.add(s.aggName);
      } else if (s.kind === "for-each") collectAuditAggs(s.body);
    }
  };
  collectAuditAggs(wf.statements);
  const auditsOps = auditAggs.size > 0;
  if (auditsOps) {
    fields.push("    private readonly IAuditWriter _audit;");
    ctorParamPairs.push("IAuditWriter audit");
    ctorAssigns.push("_audit = audit");
    // `${ns}.Domain.Common` (RequestContext) is already in the hardcoded
    // preamble below, so adding it here would duplicate the directive (CS0105
    // → error under /warnaserror).  Only the non-preamble usings are added.
    usings.add(`${ns}.Application.Common`);
    usings.add(`${ns}.Infrastructure.Persistence`);
    for (const aggName of auditAggs) usings.add(`${ns}.Application.${plural(aggName)}.Responses`);
  }

  // Reading-tier domain-service calls (domain-services.md rev. 4, Slice 1): a
  // `reading` service is a DI'd `sealed class`, so the orchestrating workflow
  // INJECTS it (`_registration`) and calls through the instance —
  // `await _registration.IsEmailAvailableAsync(...)` — rather than the static
  // `Registration.IsEmailAvailable(...)` a pure service emits.  The container
  // threads the service's own read-repository, so the workflow injects only the
  // service, NOT that repo (the .NET divergence from the TS read-port arg).
  const readingServices = collectReadingServices(wf, ctx);
  for (const svcName of readingServices) {
    fields.push(`    private readonly ${upperFirst(svcName)} _${lowerFirst(svcName)};`);
    ctorParamPairs.push(`${upperFirst(svcName)} ${lowerFirst(svcName)}`);
    ctorAssigns.push(`_${lowerFirst(svcName)} = ${lowerFirst(svcName)}`);
  }
  if (readingServices.size > 0) usings.add(`${ns}.Domain.Services`);
  const readingCall = workflowReadingServiceCallResolver(ctx);

  // Statement rendering.
  const stmtLines: string[] = [];
  if (usage.hasEmit) {
    stmtLines.push("        var _workflowEvents = new List<IDomainEvent>();");
  }
  if (usesUser) {
    // Materialise `currentUser` so the rendered `renderCsExpr` output
    // (which emits the literal token `currentUser`) resolves against
    // the request-scoped accessor.
    stmtLines.push("        var currentUser = _currentUser.User;");
  }
  // Workflow params resolve to bare-identifier `name` refs in the ExprIR, but
  // in a command handler they must print as `cmd.<PascalName>`.
  // renderExprWithCmdParams rewrites those refs at render time, keyed by the
  // workflow's param-name set.
  const paramNames = new Set(wf.params.map((p) => p.name));
  // Resource-op routing (Phase 4c): resourceName → static helper class,
  // built from the system's resources + storages.  Empty when the
  // deployable wires no consumable resources.
  const resourceClasses = buildResourceClasses(sys);
  if (resourceClasses.size > 0 && workflowUsesResourceOp(wf)) usings.add(`${ns}.Resources`);
  const renderArg = (e: import("../../ir/types/loom-ir.js").ExprIR): string => {
    // Collect the rendered expression's non-implicit namespaces adjacent
    // to rendering (`renderArg` is the single choke point for every
    // workflow expression the handler emits) instead of threading a Set
    // through the renderer.  The cmd-param rewrite only renames refs, so
    // the `matches` shape collectCsExprUsings keys off is unchanged.
    collectCsExprUsings(e, usings, ns);
    return renderExprWithCmdParams(e, paramNames, resourceClasses, readingCall);
  };

  // Guard exactly the getById loads this command handler later dereferences
  // (op-call targets); loads only read to seed a `create` stay unguarded.
  const dereffedLoads = collectDereferencedLoads(wf.statements);
  // Chunked (one lines-array per top-level statement) rather than the
  // pre-flattened `renderWorkflowStmts` — byte-identical either way
  // (`renderWorkflowStmts` IS `chunks.flat()` by construction), but the
  // per-chunk list lets us surface per-statement sub-regions to the caller
  // that owns the recorder + this file's final content (source-map
  // Milestone 11).
  const stmtChunks = renderWorkflowStmtChunks(
    wf.statements,
    csWorkflowStmtTarget(ctx, renderArg, dereffedLoads, auditsOps),
    INDENT,
  );
  stmtLines.push(...stmtChunks.flat());
  if (opFragments) {
    // CAREFUL: the transactional path below re-indents the WHOLE `stmtLines`
    // array by 4 spaces (a uniform, per-line map) before it lands in `body` —
    // the fragment text/sub-regions must reflect that FINAL text, so apply
    // the identical re-indent to each chunk here rather than to the
    // already-rendered (pre-transform) chunks.  A per-line map distributes
    // over any sub-array, so re-indenting just the statement chunks is
    // equivalent to re-indenting them as part of the larger `stmtLines`.
    const finalChunks = wf.transactional
      ? stmtChunks.map((ls) => ls.map((l) => "    " + l))
      : stmtChunks;
    const chunkTexts = finalChunks.map((ls) => ls.join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(wf.statements, chunkTexts, `${ctx.name}.${wf.name}`),
      });
    }
  }
  // Saves.
  for (const save of wf.savesAtExit) {
    const fieldName = `_${save.repoName.charAt(0).toLowerCase() + save.repoName.slice(1)}`;
    stmtLines.push(`        await ${fieldName}.SaveAsync(${save.name}, cancellationToken);`);
  }

  // `workflow_started` at handler entry (before any tx begins); `workflow_completed`
  // on the success tail (after emits dispatch, before returning Unit) — a thrown
  // guard / domain error short-circuits past it.
  const startedLog = `        ${renderDotnetLogCall("workflowStarted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
  ])}\n`;
  const completedLog = `        ${renderDotnetLogCall("workflowCompleted", [
    { name: "workflow", valueExpr: JSON.stringify(wf.name) },
  ])}\n`;

  let body: string = startedLog;
  if (wf.transactional) {
    const beginCall = effectiveIsolation
      ? `_db.Database.BeginTransactionAsync(IsolationLevel.${csIsolationLevel(effectiveIsolation)}, cancellationToken)`
      : `_db.Database.BeginTransactionAsync(cancellationToken)`;
    body +=
      `        await using var tx = await ${beginCall};\n` +
      `        try\n` +
      `        {\n` +
      stmtLines.map((l) => "    " + l).join("\n") +
      "\n" +
      `            await tx.CommitAsync(cancellationToken);\n` +
      `        }\n` +
      `        catch\n` +
      `        {\n` +
      `            await tx.RollbackAsync(cancellationToken);\n` +
      `            throw;\n` +
      `        }\n`;
  } else {
    body += stmtLines.join("\n") + "\n";
  }
  if (usage.hasEmit) {
    body +=
      `        foreach (var ev in _workflowEvents)\n` +
      `            await _events.DispatchAsync(ev, cancellationToken);\n`;
  }
  body += completedLog;
  body += "        return Unit.Value;\n";

  const ctor =
    ctorParamPairs.length === 0
      ? `    public ${handlerName}() { }`
      : `    public ${handlerName}(${ctorParamPairs.join(", ")})\n    {\n        ${ctorAssigns.join("; ")};\n    }`;

  // Per-aggregate namespace imports.  Repos/aggregate types live
  // in `Domain.<Plural>`; extern handler interfaces + their request
  // DTOs live in `Application.<Plural>.{Handlers,Requests}`.
  const aggsTouched = new Set<string>([
    ...usage.repos.values(),
    ...[...usage.externs.values()].map((e) => e.aggName),
  ]);
  const aggUsings = [
    ...new Set([...aggsTouched].map((agg) => `using ${ns}.Domain.${plural(agg)};`)),
  ];
  const externUsings = [
    ...new Set(
      [...usage.externs.values()].flatMap((e) => [
        `using ${ns}.Application.${plural(e.aggName)}.Handlers;`,
        `using ${ns}.Application.${plural(e.aggName)}.Requests;`,
      ]),
    ),
  ];
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;${extraUsings.length > 0 ? "\n" + extraUsings.join("\n") : ""}
using Mediator;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${aggUsings.join("\n")}${externUsings.length > 0 ? "\n" + externUsings.join("\n") : ""}

namespace ${ns}.Application.Workflows;

public sealed class ${handlerName} : ICommandHandler<${cmdName}, Unit>
{
${fields.join("\n")}
${ctor}

    public async ValueTask<Unit> Handle(${cmdName} command, CancellationToken cancellationToken)
    {
${body}    }
}
`;
}

/** Maps DSL isolation levels to System.Data.IsolationLevel members. */
function csIsolationLevel(level: import("../../ir/types/loom-ir.js").IsolationLevel): string {
  switch (level) {
    case "readUncommitted":
      return "ReadUncommitted";
    case "readCommitted":
      return "ReadCommitted";
    case "repeatableRead":
      return "RepeatableRead";
    case "serializable":
      return "Serializable";
  }
}

/** Render the omission value of a create-input field the workflow `create`
 * left unset, into the C# the named-arg `Create(...)` call passes for it:
 * a `= default`'s literal (via the workflow expr renderer), a bare bool's
 * `false`, or an optional's `null`. */
function renderCsOmission(
  v: ReturnType<typeof createOmissionValue>,
  renderArg: (e: import("../../ir/types/loom-ir.js").ExprIR) => string,
): string {
  switch (v.kind) {
    case "default":
      return renderArg(v.expr);
    case "false":
      return "false";
    case "null":
      return "null";
  }
}

/**
 * Walk a workflow body (recursing into `for-each` bodies) and collect the
 * names that are dereferenced — every `op-call` target, every aggregate arg
 * to a domain-service call, and every name whose MEMBERS are read inside any
 * body expression (`loaded.dataKey + "." + seg` in an op-call arg or
 * factory-let seed).  A `getById` load bound to such a name is load-or-throw:
 * the deref (`b.Promote(...)`, `loaded.DataKey`) would be a CS8602 under
 * nullable-reference types unless the `Task<T?>` result is guarded.  Loads
 * that are never dereferenced (e.g. a load passed whole into a `create`
 * field) stay unguarded and byte-identical.
 */
function collectDereferencedLoads(stmts: readonly WorkflowStmtIR[]): Set<string> {
  const names = new Set<string>();
  for (const st of stmts) {
    if (st.kind === "op-call") names.add(st.target);
    else if (st.kind === "domain-service-call") {
      // A `mutating`/`reading` service call dereferences every aggregate ARG it
      // is passed (the service operates on them), so a `getById` load passed
      // into one is load-or-throw — guard it, or the non-null `Account` param
      // is a CS8604 under nullable-reference types (domain-services.md rev. 4).
      const args = st.call.kind === "call" ? st.call.args : [];
      for (const a of args) {
        if (a.kind === "ref") names.add(a.name);
      }
    } else if (st.kind === "for-each") {
      for (const n of collectDereferencedLoads(st.body)) names.add(n);
    }
    // Member/method reads on a plain ref anywhere in the statement's
    // expressions (op-call args, emit/factory-let field seeds, preconditions…)
    // dereference that name — `loaded.DataKey` on an unguarded `Task<T?>`
    // result is the same CS8602 an op-call deref is.  The walk descends into
    // nested `for-each`/`if-let` bodies, so top-level statements suffice.
    walkWorkflowStmtExprsDeep(st, (e) => {
      if ((e.kind === "member" || e.kind === "method-call") && e.receiver.kind === "ref") {
        names.add(e.receiver.name);
      }
    });
  }
  return names;
}

// The .NET leaf table for the shared workflow statement spine
// (`_workflow/stmt-target.ts`). Built per render call so it captures the
// driver's `renderArg` closure (cmd-param vs event-param substitution differ
// between the handler and the reactor) and its `guardLoads` policy. The
// dispatch + `for-each` recursion live in the spine; the base indent
// (`INDENT`, 8 spaces) is threaded by the driver and `for-each` bodies step
// +`indentUnit` (4 spaces), reproducing the prior hand-indentation exactly.
function csWorkflowStmtTarget(
  ctx: EnrichedBoundedContextIR,
  renderArg: (e: ExprIR) => string,
  guardLoads: boolean | ReadonlySet<string> = false,
  /** When true (the command-handler path), an inline `audited` op-call stages
   *  an AuditRecord via the handler's injected `_audit`; the reactor path
   *  leaves it false (no audit writer injected there). */
  audit = false,
): WorkflowStmtTarget {
  // Unique suffix per in-body audit capture so multiple audited op-calls don't
  // collide on the before/after temp-var names.
  let auditSeq = 0;
  return {
    indentUnit: "    ",
    precondition: (st, indent) => {
      const expr = renderArg(st.expr);
      return [
        `${indent}if (!(${expr})) throw new DomainException(${JSON.stringify(`Precondition failed: ${st.source}`)});`,
      ];
    },
    requires: (st, indent) => {
      const expr = renderArg(st.expr);
      return [
        `${indent}if (!(${expr})) throw new ForbiddenException(${JSON.stringify(`Forbidden: ${st.source}`)});`,
      ];
    },
    emit: (st, indent) => {
      const args = st.fields.map((f) => `${upperFirst(f.name)}: ${renderArg(f.value)}`).join(", ");
      return [`${indent}_workflowEvents.Add(new ${st.eventName}(${args}));`];
    },
    factoryLet: (st, indent) => {
      // The Create(...) factory's parameters are emitted in camelCase
      // (matching the source field name), so the named-arg call site
      // must use the same casing — PascalCase here would fail with
      // CS1739 "best overload does not have a parameter named X".
      const provided = st.fields.map((f) => `${f.name}: ${renderArg(f.value)}`);
      // The .NET Create(...) factory declares *every* canonical create
      // input as a required parameter (no C# default — optionals would
      // have to trail the required params, which the wire-shape ordering
      // doesn't guarantee). A workflow `create` names only a subset, so
      // every create input the DSL omitted must be supplied explicitly
      // with its omission value (an optional → null, a `= default` → the
      // default literal, a bare bool → false) or the call fails to compile
      // with CS7036. Named args keep this order-free.
      const named = new Set(st.fields.map((f) => f.name));
      const agg = ctx.aggregates.find((a) => a.name === st.aggName);
      const omitted = (agg ? createInputFields(agg) : [])
        .filter((f) => !named.has(f.name))
        .map((f) => `${f.name}: ${renderCsOmission(createOmissionValue(f), renderArg)}`);
      const args = [...provided, ...omitted].join(", ");
      // C# doesn't support reordering positional args; using named
      // args lets the user write fields in any order in the .ddd source.
      return [`${indent}var ${st.name} = ${st.aggName}.Create(${args});`];
    },
    repoLet: (st, indent) => {
      const fieldName = `_${st.repoName.charAt(0).toLowerCase() + st.repoName.slice(1)}`;
      const argList = st.args.map(renderArg).join(", ");
      const callArgs = argList.length > 0 ? `${argList}, cancellationToken` : `cancellationToken`;
      // `getById` is the built-in load, emitted on the repo as `GetByIdAsync`.
      // A user find (`locate`, `byHandle`) is emitted WITHOUT an `Async` suffix
      // (matching the CQRS query handler's `_repo.<Find>(...)` call convention),
      // so don't append one or the method won't resolve (CS1061).
      const methodName = st.method === "getById" ? "GetByIdAsync" : upperFirst(st.method);
      const call = `await ${fieldName}.${methodName}(${callArgs})`;
      // `getById` is load-or-throw (Hono's returns non-null; the .NET
      // op-command handler guards the same way).  Guard the `Task<T?>` result
      // with `?? throw` whenever the loaded aggregate is dereferenced — a
      // reactor / event-create body always does (`guardLoads === true`), and a
      // command-handler workflow does when the load is an `op-call` target
      // (`b.Promote(...)`; `guardLoads` carries that name set).  Loads that are
      // never dereferenced (e.g. `placeOrder`'s `customer`) stay unguarded and
      // byte-identical.  Without the guard the deref is a CS8602 under
      // /warnaserror.
      const guardsLoad = typeof guardLoads === "boolean" ? guardLoads : guardLoads.has(st.name);
      if (guardsLoad && st.method === "getById") {
        return [
          `${indent}var ${st.name} = ${call}`,
          `${indent}    ?? throw new AggregateNotFoundException($"${st.aggName} {${argList}} not found");`,
        ];
      }
      return [`${indent}var ${st.name} = ${call};`];
    },
    opCall: (st, indent) => {
      const argList = st.args.map(renderArg).join(", ");
      const op = ctx.aggregates
        .find((a) => a.name === st.aggName)
        ?.operations.find((o) => o.name === st.op);
      if (op?.extern) {
        const reqName = `${upperFirst(st.op)}${st.aggName}Request`;
        const handlerField = `_${st.op}${st.aggName}Handler`;
        // Construct the wire-typed request from the workflow's
        // domain-typed args.  Each arg renders via the regular
        // expression renderer (with cmd-param substitution), then
        // wraps in `domainToRequestExpr` so X id.Value, enum
        // .ToString(), VO → <VO>Request etc. all line up.
        const requestArgs = op.params
          .map((p, i) => domainToRequestExpr(renderArg(st.args[i]!), p.type, ctx))
          .join(", ");
        return [
          `${indent}${st.target}.Check${upperFirst(st.op)}(${argList});`,
          `${indent}var __${st.op}Request = new ${reqName}(${requestArgs});`,
          `${indent}await ${handlerField}.HandleAsync(${st.target}, __${st.op}Request, cancellationToken);`,
          `${indent}${st.target}.AssertInvariants();`,
        ];
      }
      // Operations that reference `currentUser` pick up a trailing
      // `User currentUser` parameter on the aggregate method — pass
      // the workflow handler's local `currentUser` through.
      const callArgs =
        op && operationUsesCurrentUser(op)
          ? argList.length > 0
            ? `${argList}, currentUser`
            : "currentUser"
          : argList;
      const callLine = `${indent}${st.target}.${upperFirst(st.op)}(${callArgs});`;
      // Audited op invoked inline → stage an AuditRecord bracketing the call
      // with before/after wire snapshots, mirroring the per-operation command
      // handler.  The handler runs inside the Mediator dispatch's child frame,
      // so the row's scope / parent ids are already set; `_audit.Stage` adds it
      // to the scoped AppDbContext, flushed by the aggregate's SaveAsync.
      const agg = ctx.aggregates.find((a) => a.name === st.aggName);
      if (audit && op?.audited && agg) {
        const n = auditSeq++;
        const before = `__wfAuditBefore${n}`;
        const after = `__wfAuditAfter${n}`;
        return [
          `${indent}var ${before} = System.Text.Json.JsonSerializer.Serialize(${projectEntityExpr(st.target, agg, ctx)});`,
          callLine,
          `${indent}var ${after} = System.Text.Json.JsonSerializer.Serialize(${projectEntityExpr(st.target, agg, ctx)});`,
          `${indent}_audit.Stage(new AuditRecord`,
          `${indent}{`,
          `${indent}    AuditId = Guid.NewGuid().ToString(),`,
          `${indent}    OperationId = ${JSON.stringify(`${st.op}${st.aggName}`)},`,
          `${indent}    Action = ${JSON.stringify(st.op)},`,
          `${indent}    TargetType = ${JSON.stringify(st.aggName)},`,
          `${indent}    TargetId = ${st.target}.Id.Value.ToString(),`,
          `${indent}    Actor = RequestContext.Current?.PrincipalJson(),`,
          `${indent}    Before = ${before},`,
          `${indent}    After = ${after},`,
          `${indent}    At = DateTime.UtcNow,`,
          `${indent}    Status = "ok",`,
          `${indent}    CorrelationId = RequestContext.Current?.CorrelationId,`,
          `${indent}    ScopeId = RequestContext.Current?.ScopeId,`,
          `${indent}    ParentId = RequestContext.Current?.ParentId,`,
          `${indent}});`,
        ];
      }
      return [callLine];
    },
    exprLet: (st, indent) => {
      // `let x = files.get(k)` — a resource-op RHS is an async helper, so
      // await it; ordinary expr-lets render unchanged.
      const isResourceOp = st.expr.kind === "call" && st.expr.callKind === "resource-op";
      const exprText = renderArg(st.expr);
      return [`${indent}var ${st.name} = ${isResourceOp ? "await " : ""}${exprText};`];
    },
    // `field := value` — own-state mutation.  Render the LHS through `renderArg`
    // as a synthetic `this-prop` ref so it picks up the same `state.`/`this.` +
    // PascalCase mapping the read side uses (`state.Attempts`); the loaded row
    // is persisted by the handler's SaveAsync at exit.
    assign: (st, indent) => {
      const lhs = renderArg({
        kind: "ref",
        name: st.target.segments[0]!,
        refKind: "this-prop",
        type: st.targetType,
      });
      return [`${indent}${lhs} = ${renderArg(st.value)};`];
    },
    repoRun: (st, indent) => {
      // `Repo.run(<Retrieval>(args), page?)` → the generated
      // `Run<Name>Async(args, page?, cancellationToken)` repository method.
      const fieldName = `_${st.repoName.charAt(0).toLowerCase() + st.repoName.slice(1)}`;
      const args = st.retrievalArgs.map(renderArg);
      if (st.page) {
        const off = st.page.offset ? renderArg(st.page.offset) : "null";
        const lim = st.page.limit ? renderArg(st.page.limit) : "null";
        args.push(`(${off}, ${lim})`);
      }
      // Inline `ignoring` clause (named-filter-bypass.md §11) → named retrieval-
      // method args.  `ignoring *` → `ignoreAllFilters: true`; `ignoring <Cap>`
      // → `ignoreFilters: ["Name1", …]` (the EF filter names the bypassed
      // capabilities contributed on the target aggregate).
      const bypassArgs: string[] = [];
      if (st.bypassAll) {
        bypassArgs.push("ignoreAllFilters: true");
      } else if ((st.bypassCaps?.length ?? 0) > 0) {
        const target = ctx.aggregates.find((a) => a.name === st.aggName);
        const names = target ? bypassedFilterNames(target, { bypassCaps: st.bypassCaps }) : [];
        if (names.length > 0) {
          bypassArgs.push(`ignoreFilters: [${names.map((n) => JSON.stringify(n)).join(", ")}]`);
        }
      }
      // `cancellationToken` is passed NAMED: the run method has an optional
      // `page` param before it (and the optional `ignore*` params after), so a
      // positional token would bind to `page`.  Named, it skips the defaults.
      const callArgs = [...args, ...bypassArgs, "cancellationToken: cancellationToken"].join(", ");
      return [
        `${indent}var ${st.name} = await ${fieldName}.Run${upperFirst(st.retrievalName)}Async(${callArgs});`,
      ];
    },
    forEach: (st, indent, body) => {
      // `for o in xs { … }` → C# `foreach`; the spine renders the body at
      // `indent + indentUnit`, then each iteration's dirty bindings save
      // inside the loop (the aggregate's events drain through SaveAsync).
      const saveLines = st.savesPerIteration.map((sv) => {
        const fieldName = `_${sv.repoName.charAt(0).toLowerCase() + sv.repoName.slice(1)}`;
        return `${indent}    await ${fieldName}.SaveAsync(${sv.name}, cancellationToken);`;
      });
      return [
        `${indent}foreach (var ${st.var} in ${renderArg(st.iterable)})`,
        `${indent}{`,
        ...body,
        ...saveLines,
        `${indent}}`,
      ];
    },
    ifLet: (st, indent, thenLines, elseLines) => {
      // `if let o = Repo.find(<Criterion>) { … } else { … }` → run the shared
      // `findAllBy<Criterion>` retrieval with `limit: 1`, take the first row
      // (or `null`), and branch.  `is not null` narrows `o` in the then-branch;
      // each branch's dirty bindings save inside it.
      const fieldName = `_${st.repoName.charAt(0).toLowerCase() + st.repoName.slice(1)}`;
      const args = st.retrievalArgs.map(renderArg);
      args.push("(null, 1)"); // page: limit 1, no offset — single result
      // Named `cancellationToken` — it now follows the optional `ignore*` params.
      const callArgs = [...args, "cancellationToken: cancellationToken"].join(", ");
      const hits = `__${st.var}Hits`;
      const inner = `${indent}    `;
      const saveLine = (sv: { repoName: string; name: string }): string => {
        const f = `_${sv.repoName.charAt(0).toLowerCase() + sv.repoName.slice(1)}`;
        return `${inner}await ${f}.SaveAsync(${sv.name}, cancellationToken);`;
      };
      const thenSaves = st.savesInThen.map(saveLine);
      const elseSaves = st.savesInElse.map(saveLine);
      const out = [
        `${indent}var ${hits} = await ${fieldName}.Run${upperFirst(st.retrievalName)}Async(${callArgs});`,
        `${indent}var ${st.var} = ${hits}.Count > 0 ? ${hits}[0] : null;`,
        `${indent}if (${st.var} is not null)`,
        `${indent}{`,
        ...thenLines,
        ...thenSaves,
      ];
      if (elseLines.length > 0 || elseSaves.length > 0) {
        out.push(
          `${indent}}`,
          `${indent}else`,
          `${indent}{`,
          ...elseLines,
          ...elseSaves,
          `${indent}}`,
        );
      } else {
        out.push(`${indent}}`);
      }
      return out;
    },
    // 4c: bare resource-op statement (`files.put(k, v)`) → awaited async
    // helper call.
    resourceCall: (st, indent) => [`${indent}await ${renderArg(st.call)};`],
    // Bare `Transfer.Run(src, dst, amount)` domain-service call
    // (domain-services.md rev. 4, the `mutating` tier).  `renderArg` emits the
    // static call (pure/mutating) or `(await _svc.OpAsync(...))` (reading) — the
    // await wrapping is internal, so no `await` prefix here (mutating is a
    // synchronous static call).  The mutated args are EF-tracked entities →
    // they flush at the orchestrator's single `await db.SaveChangesAsync()`.
    domainServiceCall: (st, indent) => [`${indent}${renderArg(st.call)};`],
  };
}

/** Structural ExprIR rewrite: applies `onRef` to every leaf `ref` node
 *  (returning a replacement, or `undefined` to leave it unchanged) and
 *  recurses through every compound node.  Shared by the command-param and
 *  event-param workflow renderers — both want to rename a particular class of
 *  `refKind: "param"` ref before handing the tree to `renderCsExpr`. */
function rewriteExprRefs(
  e: ExprIR,
  onRef: (r: ExprIR & { kind: "ref" }) => ExprIR | undefined,
): ExprIR {
  const rec = (e: ExprIR): ExprIR => {
    if (e.kind === "ref") return onRef(e) ?? e;
    if (e.kind === "member") return { ...e, receiver: rec(e.receiver) };
    if (e.kind === "method-call") {
      return { ...e, receiver: rec(e.receiver), args: e.args.map(rec) };
    }
    if (e.kind === "call") return { ...e, args: e.args.map(rec) };
    if (e.kind === "lambda") {
      // Lambda body is optional (block-body lambdas land for page event
      // handlers).  .NET workflow lowering doesn't see block bodies — those
      // are React-emitter territory — but stay total: pass through unchanged
      // when block is set.
      if (e.body) return { ...e, body: rec(e.body) };
      return e;
    }
    if (e.kind === "binary") return { ...e, left: rec(e.left), right: rec(e.right) };
    if (e.kind === "unary") return { ...e, operand: rec(e.operand) };
    if (e.kind === "ternary") {
      return {
        ...e,
        cond: rec(e.cond),
        // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then` across the IR
        then: rec(e.then),
        otherwise: rec(e.otherwise),
      };
    }
    if (e.kind === "paren") return { ...e, inner: rec(e.inner) };
    if (e.kind === "new") {
      return { ...e, fields: e.fields.map((f) => ({ name: f.name, value: rec(f.value) })) };
    }
    if (e.kind === "object") {
      return { ...e, fields: e.fields.map((f) => ({ name: f.name, value: rec(f.value) })) };
    }
    return e;
  };
  return rec(e);
}

// Render an ExprIR, but rewrite param refs to `command.PascalName`.
function renderExprWithCmdParams(
  e: ExprIR,
  paramNames: Set<string>,
  resourceClasses?: Map<string, string>,
  /** Reading-tier domain-service call resolver (domain-services.md rev. 4):
   *  routes a `reading` service call through its injected `_<service>` field +
   *  async method; undefined (or returning undefined) leaves a PURE call as the
   *  static `Service.Op(...)` (byte-identical). */
  domainServiceReadingCall?: CsRenderContext["domainServiceReadingCall"],
): string {
  const rewritten = rewriteExprRefs(e, (r) =>
    r.refKind === "param" && paramNames.has(r.name)
      ? { ...r, name: `command.${upperFirst(r.name)}`, refKind: "let" }
      : undefined,
  );
  return renderCsExpr(rewritten, { thisName: "this", resourceClasses, domainServiceReadingCall });
}

/** The distinct `reading`-tier domain SERVICES a workflow body calls
 *  (domain-services.md rev. 4, Slice 1) — the services the handler must inject.
 *  A service is `reading` when a called operation consumes at least one
 *  read-port; a PURE-only service is excluded (its calls stay the static shape,
 *  needing no injection).  De-duplicated by service name. */
function collectReadingServices(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): Set<string> {
  const out = new Set<string>();
  const visit = (e: ExprIR): void => {
    if (e.kind === "call" && e.callKind === "domain-service" && e.serviceRef) {
      const svc = ctx.domainServices?.find((s) => s.name === e.serviceRef!.service);
      const op = svc?.operations.find((o) => o.name === e.serviceRef!.op);
      if (op && readPortsForOperation(op).length > 0) out.add(e.serviceRef.service);
    }
    for (const c of exprChildrenForServiceScan(e)) visit(c);
  };
  const walk = (stmts: readonly WorkflowStmtIR[]): void => {
    for (const st of stmts) {
      for (const e of workflowStmtExprsForServiceScan(st)) visit(e);
      if (st.kind === "for-each") walk(st.body);
      else if (st.kind === "if-let") {
        walk(st.thenBody);
        walk(st.elseBody ?? []);
      }
    }
  };
  walk(wf.statements);
  return out;
}

/** Resolver handed to the workflow render context: maps a `reading`-tier
 *  `<service>.<op>` call to its injected receiver (`_<service>`) + async method
 *  (`<Op>Async`).  Returns undefined for a PURE op, so the `domain-service`
 *  render arm keeps the static `Service.Op(...)` shape (byte-identical). */
function workflowReadingServiceCallResolver(
  ctx: EnrichedBoundedContextIR,
): NonNullable<CsRenderContext["domainServiceReadingCall"]> {
  return (service, op) => {
    const svc = ctx.domainServices?.find((s) => s.name === service);
    const operation = svc?.operations.find((o) => o.name === op);
    if (!operation || readPortsForOperation(operation).length === 0) return undefined;
    return { receiver: `_${lowerFirst(service)}`, method: `${upperFirst(op)}Async` };
  };
}

/** The expressions a workflow statement directly carries — for the reading-service
 *  scan (the per-kind nesting is handled by `collectReadingServices`'s spine). */
function workflowStmtExprsForServiceScan(st: WorkflowStmtIR): ExprIR[] {
  switch (st.kind) {
    case "expr-let":
    case "precondition":
    case "requires":
      return [st.expr];
    case "resource-call":
      return [st.call];
    case "op-call":
    case "repo-let":
      return st.args;
    case "factory-let":
    case "emit":
      return st.fields.map((f) => f.value);
    case "for-each":
      return [st.iterable];
    case "if-let":
      return st.retrievalArgs;
    default:
      return [];
  }
}

/** Direct sub-expressions of an ExprIR (for the reading-service call scan). */
function exprChildrenForServiceScan(e: ExprIR): ExprIR[] {
  switch (e.kind) {
    case "method-call":
      return [e.receiver, ...e.args];
    case "member":
      return [e.receiver];
    case "binary":
      return [e.left, e.right];
    case "ternary":
      return [e.cond, e.then, e.otherwise];
    case "unary":
      return [e.operand];
    case "paren":
      return [e.inner];
    case "call":
      return e.args;
    case "new":
    case "object":
      return e.fields.map((f) => f.value);
    case "lambda":
      return e.body ? [e.body] : [];
    default:
      return [];
  }
}

// Render an ExprIR for an in-process event handler: rewrite the single bound
// event param (`s` in `on(s: ShipmentRequested)`) to the Mediator handler's
// `notification` argument.  Other refs (let-bindings, aggregate locals) pass
// through unchanged.
function renderExprWithEventParam(
  e: ExprIR,
  eventParam: string,
  resourceClasses?: Map<string, string>,
  thisName = "this",
): string {
  const rewritten = rewriteExprRefs(e, (r) =>
    r.refKind === "param" && r.name === eventParam
      ? { ...r, name: "notification", refKind: "let" }
      : undefined,
  );
  return renderCsExpr(rewritten, { thisName, resourceClasses });
}

// ---------------------------------------------------------------------------
// Controller — one class per context exposing every workflow as a POST.
// ---------------------------------------------------------------------------

function renderController(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  workflows: WorkflowIR[],
  routePrefix?: string,
): string {
  const className = `${ctx.name}WorkflowsController`;
  const route = `${routePrefix ?? ""}workflows`;
  // Tracks namespaces the wire→domain coercion reaches into beyond the
  // SDK's implicit-usings set (e.g. System.Globalization when a
  // workflow has a datetime param).
  const usings = new Set<string>();
  const blocks: string[] = [];
  for (const wf of workflows) {
    for (const p of wf.params) collectWireUsings(p.type, ctx, usings);
    const cmdArgs = wf.params
      .map((p) => wireToCommandArgument(`request.${upperFirst(p.name)}`, p.type, ctx))
      .join(",\n            ");
    // Error responses from the shared matrix: 400 always, + 403 when the
    // workflow has a `requires` guard (denies with ForbiddenException).
    const errorAttrs = errorStatuses("workflow", workflowIsGuarded(wf))
      .map((s) => `    [ProducesResponseType(typeof(ProblemDetails), ${s})]\n`)
      .join("");
    blocks.push(
      `    [HttpPost("${snake(wf.name)}")]\n` +
        // Explicit success (NoContent → 204) so the added error
        // [ProducesResponseType] doesn't suppress Swashbuckle's 2xx inference.
        `    [ProducesResponseType(204)]\n` +
        errorAttrs +
        `    public async Task<IActionResult> ${upperFirst(camelId(opWorkflow(wf.name)))}([FromBody] ${upperFirst(wf.name)}Request request)\n` +
        `    {\n` +
        `        var cmd = new ${upperFirst(wf.name)}Command(\n            ${cmdArgs});\n` +
        `        await _mediator.Send(cmd);\n` +
        `        return NoContent();\n` +
        `    }\n`,
    );
  }
  void csIdValueClrType;
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return `// Auto-generated.
using System.Threading.Tasks;${extraUsings.length > 0 ? "\n" + extraUsings.join("\n") : ""}
using Mediator;
using Microsoft.AspNetCore.Mvc;
using ${ns}.Application.Workflows;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Api;

[ApiController]
[Route("${route}")]
public sealed class ${className} : ControllerBase
{
    private readonly IMediator _mediator;
    public ${className}(IMediator mediator) => _mediator = mediator;

${blocks.join("\n")}
}
`;
}

// ---------------------------------------------------------------------------
// Read-only instance endpoints (workflow-instance-visibility.md).
//
// For every observable workflow (a correlation-state row + enriched
// `instanceWireShape`), emit an instance Response DTO and a controller exposing
// GET list + GET by-id over the saga-state table — the read-side analogue of an
// aggregate's GET list / GET-by-id, mirroring the Hono instance routes.  Driven
// off `instanceWireShape` independently of the command controller, so an
// event-triggered-only saga still gets observed.
// ---------------------------------------------------------------------------

export function emitWorkflowInstanceReads(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string },
): void {
  const observable = ctx.workflows.filter((wf) => !!wf.instanceWireShape);
  if (observable.length === 0) return;
  for (const wf of observable) {
    out.set(
      `Application/Workflows/${upperFirst(wf.name)}InstanceResponse.cs`,
      renderInstanceResponseDto(wf, ctx, ns),
    );
  }
  out.set(
    `Api/${ctx.name}WorkflowInstancesController.cs`,
    renderInstancesController(ctx, ns, observable, options?.routePrefix),
  );
}

/** The instance Response DTO — `instanceWireShape` projected to wire types,
 *  the workflow-instance analogue of an aggregate's `<Agg>Response`. */
function renderInstanceResponseDto(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  // dtoParam marks non-nullable components `[property: Required]` so the
  // OpenAPI required-set matches Hono/Python (which require every
  // non-optional instance field) — see dto-mapping.ts.
  const params = (wf.instanceWireShape ?? [])
    .map((f) => dtoParam(wireType(f.type, ctx, "response"), upperFirst(f.name), "response"))
    .join(", ");
  return `// Auto-generated.
using System;
using System.ComponentModel.DataAnnotations;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Workflows;

public sealed record ${upperFirst(wf.name)}InstanceResponse(${params});
`;
}

/** One controller per context exposing every observable workflow's instances
 *  as `GET workflows/<snake>/instances` + `.../instances/{id}`, reading the
 *  EF-mapped saga-state DbSet and projecting each row through
 *  `projectToResponse` (id → `.Value`, enum/datetime/etc. handled). */
function renderInstancesController(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  workflows: WorkflowIR[],
  routePrefix?: string,
): string {
  const className = `${ctx.name}WorkflowInstancesController`;
  const route = `${routePrefix ?? ""}workflows`;
  const usings = new Set<string>();
  const blocks: string[] = [];
  for (const wf of workflows) {
    const slug = snake(wf.name);
    const T = upperFirst(wf.name);
    const dbSet = workflowStateDbSet(wf);
    const shape = wf.instanceWireShape ?? [];
    for (const f of shape) collectWireUsings(f.type, ctx, usings);
    const corr = shape.find((f) => f.source === "id");
    const corrName = upperFirst(wf.correlationField as string);
    const targetName = corr && corr.type.kind === "id" ? corr.type.targetName : "";
    const proj = (rowVar: string): string =>
      shape
        .map((f) => projectToResponse(`${rowVar}.${upperFirst(f.name)}`, f.type, ctx))
        .join(", ");
    // The read body diverges on `wf.eventSourced`: a state-based saga selects
    // the `<Wf>State` EF DbSet directly, while an event-sourced workflow folds
    // the per-correlation `<wf>_events` stream — LIST loads every event row,
    // groups by StreamId, and folds each through `_FromEvents` (mirroring the
    // ES-aggregate `_LoadAll` group-fold); byId loads one stream + folds it.
    // The `instanceWireShape` projection, operationIds, and route paths are
    // identical to the state path, so cross-backend OpenAPI parity holds.
    let listBody: string;
    let byIdBody: string;
    // The `{id}` param binds the correlation id's CLR value type (Guid / int /
    // long / string), so Swashbuckle emits the matching param schema — parity
    // with Hono / Java / Python / Phoenix by construction
    // (docs/plans/non-guid-id-http-params.md).
    const corrClr = csIdValueClrType(workflowCorrIdValueType(wf));
    if (wf.eventSourced) {
      const eventSet = esEventDbSet(wf);
      const stateCls = workflowStateClass(wf);
      const corrId = esCorrIdClass(wf);
      listBody =
        `        var __rows = await _db.${eventSet}.AsNoTracking().OrderBy(e => e.StreamId).ThenBy(e => e.Version).ToListAsync();\n` +
        `        var rows = __rows.GroupBy(e => e.StreamId).Select(g => ${stateCls}._FromEvents(new ${corrId}(${csIdFromString("g.Key", corrClr)}), g.Select(${stateCls}.RowToEvent).ToList()));\n` +
        `        return Ok(rows.Select(x => new ${T}InstanceResponse(${proj("x")})));\n`;
      byIdBody =
        `        var __sid = id.ToString();\n` +
        `        var __rows = await _db.${eventSet}.AsNoTracking().Where(e => e.StreamId == __sid).OrderBy(e => e.Version).ToListAsync();\n` +
        `        if (__rows.Count == 0) return NotFound();\n` +
        `        var x = ${stateCls}._FromEvents(new ${corrId}(id), __rows.Select(${stateCls}.RowToEvent).ToList());\n` +
        `        return Ok(new ${T}InstanceResponse(${proj("x")}));\n`;
    } else {
      listBody =
        `        var rows = await _db.${dbSet}.AsNoTracking().ToListAsync();\n` +
        `        return Ok(rows.Select(x => new ${T}InstanceResponse(${proj("x")})));\n`;
      byIdBody =
        `        var __key = new ${targetName}Id(id);\n` +
        `        var x = await _db.${dbSet}.AsNoTracking().FirstOrDefaultAsync(r => r.${corrName} == __key);\n` +
        `        if (x is null) return NotFound();\n` +
        `        return Ok(new ${T}InstanceResponse(${proj("x")}));\n`;
    }
    blocks.push(
      `    [HttpGet("${slug}/instances")]\n` +
        `    [ProducesResponseType(typeof(IEnumerable<${T}InstanceResponse>), 200)]\n` +
        `    public async Task<IActionResult> ${upperFirst(camelId(opWorkflowInstances(wf.name)))}()\n` +
        `    {\n` +
        listBody +
        `    }\n` +
        `    [HttpGet("${slug}/instances/{id}")]\n` +
        `    [ProducesResponseType(typeof(${T}InstanceResponse), 200)]\n` +
        `    [ProducesResponseType(typeof(ProblemDetails), 404)]\n` +
        `    public async Task<IActionResult> ${upperFirst(camelId(opWorkflowInstanceById(wf.name)))}(${corrClr} id)\n` +
        `    {\n` +
        byIdBody +
        `    }\n`,
    );
  }
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;${extraUsings.length > 0 ? "\n" + extraUsings.join("\n") : ""}
using ${ns}.Application.Workflows;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Api;

[ApiController]
[Route("${route}")]
public sealed class ${className} : ControllerBase
{
    private readonly AppDbContext _db;
    public ${className}(AppDbContext db) => _db = db;

${blocks.join("\n")}
}
`;
}

/** Convert a StreamId `string` back to the correlation id's CLR value type so
 *  a folded ES instance can wrap it in `new <Corr>Id(...)` — the StreamId
 *  column stores the id value's string form. */
function csIdFromString(expr: string, clr: string): string {
  switch (clr) {
    case "Guid":
      return `Guid.Parse(${expr})`;
    case "int":
      return `int.Parse(${expr})`;
    case "long":
      return `long.Parse(${expr})`;
    default:
      return expr;
  }
}
