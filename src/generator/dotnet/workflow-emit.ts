import { createInputFields, createOmissionValue } from "../../ir/enrich/wire-projection.js";
import {
  type AggregateIR,
  type EnrichedBoundedContextIR,
  type ExprIR,
  operationUsesCurrentUser,
  type SystemIR,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowIsGuarded,
  workflowUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import { errorStatuses } from "../../ir/util/openapi-errors.js";
import { camelId, opWorkflow } from "../../ir/util/openapi-ids.js";
import { resolveWorkflowIsolation } from "../../ir/util/resolve-datasource.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { renderDotnetLogCall } from "../_obs/render-dotnet.js";
import { dotnetResourceAdapterFor, resourceClassName } from "./adapters/resource-clients.js";
import {
  collectWireUsings,
  csIdValueClrType,
  domainToRequestExpr,
  dtoParam,
  wireToCommandArgument,
  wireType,
} from "./dto-mapping.js";
import { collectCsExprUsings, renderCsExpr, renderCsType } from "./render-expr.js";
import { workflowAllocateInitializer, workflowStateDbSet } from "./workflow-state-emit.js";

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
  options?: { routePrefix?: string; sys?: SystemIR },
): void {
  if (ctx.workflows.length === 0) return;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));

  // Only command-triggered workflows get the HTTP command path (Request /
  // Command / Handler + a controller POST).  An event-triggered-only workflow
  // (a pure reactor / event-create saga) has no command surface — its bodies
  // run via the in-process dispatcher's INotificationHandlers — so emitting an
  // HTTP route with an event-typed Request DTO would be bogus (and wouldn't
  // compile: an event carries no `<Event>Response` wire DTO).
  const commandWfs = ctx.workflows.filter(emitsCommandRoute);
  for (const wf of commandWfs) {
    const usage = analyseWorkflow(wf, aggsByName);
    out.set(
      `Application/Workflows/${upperFirst(wf.name)}Request.cs`,
      renderRequestDto(wf, ctx, ns),
    );
    out.set(`Application/Workflows/${upperFirst(wf.name)}Command.cs`, renderCommand(wf, ns));
    out.set(
      `Application/Workflows/${upperFirst(wf.name)}Handler.cs`,
      renderHandler(wf, usage, ns, ctx, options?.sys),
    );
  }
  if (commandWfs.length > 0) {
    out.set(
      `Api/${ctx.name}WorkflowsController.cs`,
      renderController(ctx, ns, commandWfs, options?.routePrefix),
    );
  }
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
): void {
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  for (const sub of ctx.eventSubscriptions) {
    const wf = ctx.workflows.find((w) => w.name === sub.workflow);
    if (!wf) continue;
    let statements: WorkflowStmtIR[];
    let saves: { name: string; aggName: string; repoName: string }[];
    let correlation: ExprIR | undefined;
    if (sub.trigger === "on") {
      const on = (wf.subscriptions ?? []).find(
        (o) => o.event === sub.event && o.param === sub.param,
      );
      if (!on) continue;
      statements = on.statements;
      saves = on.savesAtExit;
      correlation = on.correlation;
    } else {
      const cr = wf.creates.find((c) => c.eventRef === sub.event && c.eventBinding === sub.param);
      if (!cr) continue;
      statements = cr.statements;
      saves = cr.savesAtExit;
      correlation = cr.correlation;
    }
    const className = `${upperFirst(wf.name)}${sub.trigger === "on" ? "On" : "Start"}${upperFirst(sub.event)}Handler`;
    out.set(
      `Application/Workflows/${className}.cs`,
      renderEventReactorHandler(
        className,
        wf,
        sub.trigger,
        sub.event,
        sub.param,
        correlation,
        statements,
        saves,
        aggsByName,
        ns,
        ctx,
        sys,
      ),
    );
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
): string {
  const usage = analyseStmts(statements, saves, aggsByName);
  const usings = new Set<string>();
  const persisted = !!wf.correlationField;
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
  // The saga row lives in the AppDbContext; the `on` drop path logs via ILogger.
  if (persisted) {
    fields.push(`    private readonly ${ns}.Infrastructure.Persistence.AppDbContext _db;`);
    ctorParamPairs.push(`${ns}.Infrastructure.Persistence.AppDbContext db`);
    ctorAssigns.push("_db = db");
    usings.add("Microsoft.EntityFrameworkCore");
    usings.add(`${ns}.Infrastructure.Persistence.Workflows`);
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
    collectCsExprUsings(e, usings);
    return renderExprWithEventParam(e, paramName, resourceClasses, thisName);
  };
  // Correlation routing: load-or-allocate (create) / route-or-drop+log (on).
  if (persisted) {
    const corr = wf.correlationField as string;
    const dbSet = workflowStateDbSet(wf);
    const corrPascal = upperFirst(corr);
    // The routing key: the `by <expr>` value, else the event field that
    // name-matches the correlation field (the omitted-`by` rule).
    const keyExpr = correlation
      ? renderExprWithEventParam(correlation, paramName, resourceClasses)
      : `notification.${corrPascal}`;
    stmtLines.push(`        var __key = ${keyExpr};`);
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
  }
  for (const st of statements) {
    stmtLines.push(...renderStatement(st, renderArg, ctx, usage, /* guardLoads */ true));
  }
  for (const save of saves) {
    const fieldName = `_${save.repoName.charAt(0).toLowerCase() + save.repoName.slice(1)}`;
    stmtLines.push(`        await ${fieldName}.SaveAsync(${save.name}, cancellationToken);`);
  }
  // Persist the saga row (a new allocation, or a `this.<stateField>` mutation).
  if (persisted) stmtLines.push("        await _db.SaveChangesAsync(cancellationToken);");

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
    fields.push(`    private readonly ${ns}.Infrastructure.Persistence.AppDbContext _db;`);
    ctorParamPairs.push(`${ns}.Infrastructure.Persistence.AppDbContext db`);
    ctorAssigns.push("_db = db");
  }
  if (usesUser) {
    fields.push("    private readonly ICurrentUserAccessor _currentUser;");
    ctorParamPairs.push("ICurrentUserAccessor currentUser");
    ctorAssigns.push("_currentUser = currentUser");
  }
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
    collectCsExprUsings(e, usings);
    return renderExprWithCmdParams(e, paramNames, resourceClasses);
  };

  for (const st of wf.statements) {
    stmtLines.push(...renderStatement(st, renderArg, ctx, usage));
  }
  // Saves.
  for (const save of wf.savesAtExit) {
    const fieldName = `_${save.repoName.charAt(0).toLowerCase() + save.repoName.slice(1)}`;
    stmtLines.push(`        await ${fieldName}.SaveAsync(${save.name}, cancellationToken);`);
  }

  let body: string;
  if (wf.transactional) {
    const beginCall = effectiveIsolation
      ? `_db.Database.BeginTransactionAsync(IsolationLevel.${csIsolationLevel(effectiveIsolation)}, cancellationToken)`
      : `_db.Database.BeginTransactionAsync(cancellationToken)`;
    body =
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
    body = stmtLines.join("\n") + "\n";
  }
  if (usage.hasEmit) {
    body +=
      `        foreach (var ev in _workflowEvents)\n` +
      `            await _events.DispatchAsync(ev, cancellationToken);\n`;
  }
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

function renderStatement(
  st: WorkflowStmtIR,
  renderArg: (e: import("../../ir/types/loom-ir.js").ExprIR) => string,
  ctx: EnrichedBoundedContextIR,
  usage: WorkflowUsage,
  guardLoads = false,
): string[] {
  void usage;
  switch (st.kind) {
    case "precondition": {
      const expr = renderArg(st.expr);
      return [
        `${INDENT}if (!(${expr})) throw new DomainException(${JSON.stringify(`Precondition failed: ${st.source}`)});`,
      ];
    }
    case "requires": {
      const expr = renderArg(st.expr);
      return [
        `${INDENT}if (!(${expr})) throw new ForbiddenException(${JSON.stringify(`Forbidden: ${st.source}`)});`,
      ];
    }
    case "emit": {
      const args = st.fields.map((f) => `${upperFirst(f.name)}: ${renderArg(f.value)}`).join(", ");
      return [`${INDENT}_workflowEvents.Add(new ${st.eventName}(${args}));`];
    }
    case "factory-let": {
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
      return [`${INDENT}var ${st.name} = ${st.aggName}.Create(${args});`];
    }
    case "repo-let": {
      const fieldName = `_${st.repoName.charAt(0).toLowerCase() + st.repoName.slice(1)}`;
      const argList = st.args.map(renderArg).join(", ");
      const callArgs = argList.length > 0 ? `${argList}, cancellationToken` : `cancellationToken`;
      const call = `await ${fieldName}.${upperFirst(st.method)}Async(${callArgs})`;
      // `getById` is load-or-throw (Hono's returns non-null; the .NET
      // op-command handler guards the same way).  In a reactor / event-create
      // body the loaded aggregate is dereferenced (`ship.MarkTracked()`), so
      // under nullable-reference types the bare `Task<T?>` would be a CS8602
      // error — guard it.  Command-handler workflows keep the unguarded form
      // (byte-identical) since they don't dereference the load.
      if (guardLoads && st.method === "getById") {
        return [
          `${INDENT}var ${st.name} = ${call}`,
          `${INDENT}    ?? throw new AggregateNotFoundException($"${st.aggName} {${argList}} not found");`,
        ];
      }
      return [`${INDENT}var ${st.name} = ${call};`];
    }
    case "op-call": {
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
          `${INDENT}${st.target}.Check${upperFirst(st.op)}(${argList});`,
          `${INDENT}var __${st.op}Request = new ${reqName}(${requestArgs});`,
          `${INDENT}await ${handlerField}.HandleAsync(${st.target}, __${st.op}Request, cancellationToken);`,
          `${INDENT}${st.target}.AssertInvariants();`,
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
      return [`${INDENT}${st.target}.${upperFirst(st.op)}(${callArgs});`];
    }
    case "expr-let": {
      // `let x = files.get(k)` — a resource-op RHS is an async helper, so
      // await it; ordinary expr-lets render unchanged.
      const isResourceOp = st.expr.kind === "call" && st.expr.callKind === "resource-op";
      const exprText = renderArg(st.expr);
      return [`${INDENT}var ${st.name} = ${isResourceOp ? "await " : ""}${exprText};`];
    }
    case "repo-run": {
      // `Repo.run(<Retrieval>(args), page?)` → the generated
      // `Run<Name>Async(args, page?, cancellationToken)` repository method.
      const fieldName = `_${st.repoName.charAt(0).toLowerCase() + st.repoName.slice(1)}`;
      const args = st.retrievalArgs.map(renderArg);
      if (st.page) {
        const off = st.page.offset ? renderArg(st.page.offset) : "null";
        const lim = st.page.limit ? renderArg(st.page.limit) : "null";
        args.push(`(${off}, ${lim})`);
      }
      const callArgs = [...args, "cancellationToken"].join(", ");
      return [
        `${INDENT}var ${st.name} = await ${fieldName}.Run${upperFirst(st.retrievalName)}Async(${callArgs});`,
      ];
    }
    case "for-each": {
      // `for o in xs { … }` → C# `foreach`; body recurses at +4 indent,
      // then each iteration's dirty bindings save inside the loop (the
      // aggregate's events drain through SaveAsync).
      const bodyLines = st.body
        .flatMap((s) => renderStatement(s, renderArg, ctx, usage, guardLoads))
        .map((l) => `    ${l}`);
      const saveLines = st.savesPerIteration.map((sv) => {
        const fieldName = `_${sv.repoName.charAt(0).toLowerCase() + sv.repoName.slice(1)}`;
        return `${INDENT}    await ${fieldName}.SaveAsync(${sv.name}, cancellationToken);`;
      });
      return [
        `${INDENT}foreach (var ${st.var} in ${renderArg(st.iterable)})`,
        `${INDENT}{`,
        ...bodyLines,
        ...saveLines,
        `${INDENT}}`,
      ];
    }
    case "resource-call":
      // 4c: bare resource-op statement (`files.put(k, v)`) → awaited async
      // helper call.
      return [`${INDENT}await ${renderArg(st.call)};`];
  }
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
): string {
  const rewritten = rewriteExprRefs(e, (r) =>
    r.refKind === "param" && paramNames.has(r.name)
      ? { ...r, name: `command.${upperFirst(r.name)}`, refKind: "let" }
      : undefined,
  );
  return renderCsExpr(rewritten, { thisName: "this", resourceClasses });
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
