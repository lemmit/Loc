import {
  type AggregateIR,
  type BoundedContextIR,
  type EnrichedBoundedContextIR,
  operationUsesCurrentUser,
  type SystemIR,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import { camelId, opWorkflow } from "../../ir/util/openapi-ids.js";
import { resolveWorkflowIsolation } from "../../ir/util/resolve-datasource.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
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

  for (const wf of ctx.workflows) {
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
  out.set(`Api/${ctx.name}WorkflowsController.cs`, renderController(ctx, ns, options?.routePrefix));
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
  for (const st of wf.statements) {
    if (st.kind === "repo-let") {
      repos.set(st.repoName, st.aggName);
    } else if (st.kind === "emit") {
      hasEmit = true;
    } else if (st.kind === "op-call") {
      const agg = aggsByName.get(st.aggName);
      const op = agg?.operations.find((o) => o.name === st.op);
      if (op?.extern) {
        const key = `${st.aggName}.${st.op}`;
        externs.set(key, { aggName: st.aggName, opName: st.op });
      }
    }
  }
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
    stmtLines.push(`        await ${fieldName}.SaveAsync(${save.name}, ct);`);
  }

  let body: string;
  if (wf.transactional) {
    const beginCall = effectiveIsolation
      ? `_db.Database.BeginTransactionAsync(IsolationLevel.${csIsolationLevel(effectiveIsolation)}, ct)`
      : `_db.Database.BeginTransactionAsync(ct)`;
    body =
      `        await using var tx = await ${beginCall};\n` +
      `        try\n` +
      `        {\n` +
      stmtLines.map((l) => "    " + l).join("\n") +
      "\n" +
      `            await tx.CommitAsync(ct);\n` +
      `        }\n` +
      `        catch\n` +
      `        {\n` +
      `            await tx.RollbackAsync(ct);\n` +
      `            throw;\n` +
      `        }\n`;
  } else {
    body = stmtLines.join("\n") + "\n";
  }
  if (usage.hasEmit) {
    body +=
      `        foreach (var ev in _workflowEvents)\n` +
      `            await _events.DispatchAsync(ev, ct);\n`;
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

    public async ValueTask<Unit> Handle(${cmdName} cmd, CancellationToken ct)
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

function renderStatement(
  st: WorkflowStmtIR,
  renderArg: (e: import("../../ir/types/loom-ir.js").ExprIR) => string,
  ctx: EnrichedBoundedContextIR,
  usage: WorkflowUsage,
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
      const args = st.fields.map((f) => `${f.name}: ${renderArg(f.value)}`).join(", ");
      // C# doesn't support reordering positional args; using named
      // args lets the user write fields in any order in the .ddd source.
      return [`${INDENT}var ${st.name} = ${st.aggName}.Create(${args});`];
    }
    case "repo-let": {
      const fieldName = `_${st.repoName.charAt(0).toLowerCase() + st.repoName.slice(1)}`;
      const argList = st.args.map(renderArg).join(", ");
      const callArgs = argList.length > 0 ? `${argList}, ct` : `ct`;
      return [
        `${INDENT}var ${st.name} = await ${fieldName}.${upperFirst(st.method)}Async(${callArgs});`,
      ];
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
          `${INDENT}await ${handlerField}.HandleAsync(${st.target}, __${st.op}Request, ct);`,
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
    case "resource-call":
      // 4c: bare resource-op statement (`files.put(k, v)`) → awaited async
      // helper call.
      return [`${INDENT}await ${renderArg(st.call)};`];
  }
}

// Render an ExprIR, but rewrite param refs to `cmd.PascalName`.
function renderExprWithCmdParams(
  e: import("../../ir/types/loom-ir.js").ExprIR,
  paramNames: Set<string>,
  resourceClasses?: Map<string, string>,
): string {
  // Substitute by rewriting the IR before renderCsExpr.
  const rewrite = (
    e: import("../../ir/types/loom-ir.js").ExprIR,
  ): import("../../ir/types/loom-ir.js").ExprIR => {
    if (e.kind === "ref" && e.refKind === "param" && paramNames.has(e.name)) {
      return { ...e, name: `cmd.${upperFirst(e.name)}`, refKind: "let" };
    }
    if (e.kind === "member") {
      return { ...e, receiver: rewrite(e.receiver) };
    }
    if (e.kind === "method-call") {
      return {
        ...e,
        receiver: rewrite(e.receiver),
        args: e.args.map(rewrite),
      };
    }
    if (e.kind === "call") {
      return { ...e, args: e.args.map(rewrite) };
    }
    if (e.kind === "lambda") {
      // Lambda body is optional (block-body lambdas land for
      // page event handlers).  .NET workflow lowering doesn't see
      // block bodies — those are React-emitter territory — but stay
      // total: pass through unchanged when block is set.
      if (e.body) return { ...e, body: rewrite(e.body) };
      return e;
    }
    if (e.kind === "binary") {
      return { ...e, left: rewrite(e.left), right: rewrite(e.right) };
    }
    if (e.kind === "unary") return { ...e, operand: rewrite(e.operand) };
    if (e.kind === "ternary") {
      return {
        ...e,
        cond: rewrite(e.cond),
        then: rewrite(e.then),
        otherwise: rewrite(e.otherwise),
      };
    }
    if (e.kind === "paren") return { ...e, inner: rewrite(e.inner) };
    if (e.kind === "new") {
      return {
        ...e,
        fields: e.fields.map((f) => ({ name: f.name, value: rewrite(f.value) })),
      };
    }
    if (e.kind === "object") {
      return {
        ...e,
        fields: e.fields.map((f) => ({ name: f.name, value: rewrite(f.value) })),
      };
    }
    return e;
  };
  return renderCsExpr(rewrite(e), { thisName: "this", resourceClasses });
}

// ---------------------------------------------------------------------------
// Controller — one class per context exposing every workflow as a POST.
// ---------------------------------------------------------------------------

function renderController(ctx: EnrichedBoundedContextIR, ns: string, routePrefix?: string): string {
  const className = `${ctx.name}WorkflowsController`;
  const route = `${routePrefix ?? ""}workflows`;
  // Tracks namespaces the wire→domain coercion reaches into beyond the
  // SDK's implicit-usings set (e.g. System.Globalization when a
  // workflow has a datetime param).
  const usings = new Set<string>();
  const blocks: string[] = [];
  for (const wf of ctx.workflows) {
    for (const p of wf.params) collectWireUsings(p.type, ctx, usings);
    const cmdArgs = wf.params
      .map((p) => wireToCommandArgument(`request.${upperFirst(p.name)}`, p.type, ctx))
      .join(",\n            ");
    blocks.push(
      `    [HttpPost("${snake(wf.name)}")]\n` +
        // Explicit success (NoContent → 204) so the added error
        // [ProducesResponseType] doesn't suppress Swashbuckle's 2xx inference.
        `    [ProducesResponseType(204)]\n` +
        `    [ProducesResponseType(typeof(ProblemDetails), 400)]\n` +
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
