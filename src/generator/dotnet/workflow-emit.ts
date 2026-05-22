import type {
  AggregateIR,
  BoundedContextIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/loom-ir.js";
import { pascal, snake } from "../../util/naming.js";
import {
  csIdValueClrType,
  domainToRequestExpr,
  wireToCommandArgument,
  wireType,
} from "./dto-mapping.js";
import { renderCsExpr, renderCsType } from "./render-expr.js";

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

export function emitWorkflows(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string },
): void {
  if (ctx.workflows.length === 0) return;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));

  for (const wf of ctx.workflows) {
    const usage = analyseWorkflow(wf, aggsByName);
    out.set(`Application/Workflows/${pascal(wf.name)}Request.cs`, renderRequestDto(wf, ctx, ns));
    out.set(`Application/Workflows/${pascal(wf.name)}Command.cs`, renderCommand(wf, ns));
    out.set(
      `Application/Workflows/${pascal(wf.name)}Handler.cs`,
      renderHandler(wf, usage, ns, ctx),
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

function renderRequestDto(wf: WorkflowIR, ctx: BoundedContextIR, ns: string): string {
  const params = wf.params
    .map((p) => `${wireType(p.type, ctx, "request")} ${pascal(p.name)}`)
    .join(", ");
  return `// Auto-generated.
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Workflows;

public sealed record ${pascal(wf.name)}Request(${params});
`;
}

// ---------------------------------------------------------------------------
// Mediator command — domain-typed parameter record.
// ---------------------------------------------------------------------------

function renderCommand(wf: WorkflowIR, ns: string): string {
  const params = wf.params.map((p) => `${renderCsType(p.type)} ${pascal(p.name)}`).join(", ");
  return `// Auto-generated.
using Mediator;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Workflows;

public sealed record ${pascal(wf.name)}Command(${params}) : ICommand;
`;
}

// ---------------------------------------------------------------------------
// Handler — orchestrates the workflow body.
// ---------------------------------------------------------------------------

function renderHandler(
  wf: WorkflowIR,
  usage: WorkflowUsage,
  ns: string,
  ctx: BoundedContextIR,
): string {
  void ctx;
  const cmdName = `${pascal(wf.name)}Command`;
  const handlerName = `${pascal(wf.name)}Handler`;
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
  // Extern op-call DI: each unique extern target needs its
  // user-supplied IXAggHandler injected.  Field name follows the
  // op+agg convention (`_confirmOrderHandler`).
  for (const ext of usage.externs.values()) {
    const ifaceName = `I${pascal(ext.opName)}${ext.aggName}Handler`;
    const fieldName = `_${ext.opName}${ext.aggName}Handler`;
    fields.push(`    private readonly ${ifaceName} ${fieldName};`);
    ctorParamPairs.push(`${ifaceName} ${fieldName.replace(/^_/, "")}`);
    ctorAssigns.push(`${fieldName} = ${fieldName.replace(/^_/, "")}`);
  }

  // Statement rendering.
  const stmtLines: string[] = [];
  if (usage.hasEmit) {
    stmtLines.push(
      "        var _workflowEvents = new System.Collections.Generic.List<IDomainEvent>();",
    );
  }
  // Substitute parameter references: cmd.<PascalName>.  Inside lowerExpr-produced ExprIR,
  // params resolve as `name` refs which renderCsExpr would render as bare identifiers.
  // We need them to print as `cmd.PascalName`.  Easiest: pre-rename via expression walk.
  // The simpler path is renaming at render time using a name-set + a tiny custom env.
  const paramNames = new Set(wf.params.map((p) => p.name));
  const renderArg = (e: import("../../ir/loom-ir.js").ExprIR): string => {
    return renderExprWithCmdParams(e, paramNames);
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
    const beginCall = wf.isolation
      ? `_db.Database.BeginTransactionAsync(System.Data.IsolationLevel.${csIsolationLevel(wf.isolation)}, ct)`
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
    ...new Set([...aggsTouched].map((agg) => `using ${ns}.Domain.${pascalPlural(agg)};`)),
  ];
  const externUsings = [
    ...new Set(
      [...usage.externs.values()].flatMap((e) => [
        `using ${ns}.Application.${pascalPlural(e.aggName)}.Handlers;`,
        `using ${ns}.Application.${pascalPlural(e.aggName)}.Requests;`,
      ]),
    ),
  ];
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
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
function csIsolationLevel(level: import("../../ir/loom-ir.js").IsolationLevel): string {
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

function pascalPlural(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(s)) return s + "es";
  return s + "s";
}

function renderStatement(
  st: WorkflowStmtIR,
  renderArg: (e: import("../../ir/loom-ir.js").ExprIR) => string,
  ctx: BoundedContextIR,
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
      const args = st.fields.map((f) => `${pascal(f.name)}: ${renderArg(f.value)}`).join(", ");
      return [`${INDENT}_workflowEvents.Add(new ${st.eventName}(${args}));`];
    }
    case "factory-let": {
      const args = st.fields.map((f) => `${pascal(f.name)}: ${renderArg(f.value)}`).join(", ");
      // Use the aggregate's named-arg Create(...) factory.  C# doesn't
      // support reordering positional args; using named args lets the
      // user write fields in any order in the .ddd source.
      return [`${INDENT}var ${st.name} = ${st.aggName}.Create(${args});`];
    }
    case "repo-let": {
      const fieldName = `_${st.repoName.charAt(0).toLowerCase() + st.repoName.slice(1)}`;
      const argList = st.args.map(renderArg).join(", ");
      const callArgs = argList.length > 0 ? `${argList}, ct` : `ct`;
      return [
        `${INDENT}var ${st.name} = await ${fieldName}.${pascal(st.method)}Async(${callArgs});`,
      ];
    }
    case "op-call": {
      const argList = st.args.map(renderArg).join(", ");
      const op = ctx.aggregates
        .find((a) => a.name === st.aggName)
        ?.operations.find((o) => o.name === st.op);
      if (op?.extern) {
        const reqName = `${pascal(st.op)}Request`;
        const handlerField = `_${st.op}${st.aggName}Handler`;
        // Construct the wire-typed request from the workflow's
        // domain-typed args.  Each arg renders via the regular
        // expression renderer (with cmd-param substitution), then
        // wraps in `domainToRequestExpr` so Id<X>.Value, enum
        // .ToString(), VO → <VO>Request etc. all line up.
        const requestArgs = op.params
          .map((p, i) => domainToRequestExpr(renderArg(st.args[i]!), p.type, ctx))
          .join(", ");
        return [
          `${INDENT}${st.target}.Check${pascal(st.op)}(${argList});`,
          `${INDENT}var __${st.op}Request = new ${reqName}(${requestArgs});`,
          `${INDENT}await ${handlerField}.HandleAsync(${st.target}, __${st.op}Request, ct);`,
          `${INDENT}${st.target}.AssertInvariants();`,
        ];
      }
      return [`${INDENT}${st.target}.${pascal(st.op)}(${argList});`];
    }
    case "expr-let": {
      const exprText = renderArg(st.expr);
      return [`${INDENT}var ${st.name} = ${exprText};`];
    }
  }
}

// Render an ExprIR, but rewrite param refs to `cmd.PascalName`.
function renderExprWithCmdParams(
  e: import("../../ir/loom-ir.js").ExprIR,
  paramNames: Set<string>,
): string {
  // Substitute by rewriting the IR before renderCsExpr.
  const rewrite = (
    e: import("../../ir/loom-ir.js").ExprIR,
  ): import("../../ir/loom-ir.js").ExprIR => {
    if (e.kind === "ref" && e.refKind === "param" && paramNames.has(e.name)) {
      return { ...e, name: `cmd.${pascal(e.name)}`, refKind: "let" };
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
      // Slice 2: lambda body is optional (block-body lambdas land for
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
  return renderCsExpr(rewrite(e));
}

// ---------------------------------------------------------------------------
// Controller — one class per context exposing every workflow as a POST.
// ---------------------------------------------------------------------------

function renderController(ctx: BoundedContextIR, ns: string, routePrefix?: string): string {
  const className = `${ctx.name}WorkflowsController`;
  const route = `${routePrefix ?? ""}workflows`;
  const blocks: string[] = [];
  for (const wf of ctx.workflows) {
    const cmdArgs = wf.params
      .map((p) => wireToCommandArgument(`request.${pascal(p.name)}`, p.type, ctx))
      .join(",\n            ");
    blocks.push(
      `    [HttpPost("${snake(wf.name)}")]\n` +
        `    public async Task<IActionResult> ${pascal(wf.name)}([FromBody] ${pascal(wf.name)}Request request)\n` +
        `    {\n` +
        `        var cmd = new ${pascal(wf.name)}Command(\n            ${cmdArgs});\n` +
        `        await _mediator.Send(cmd);\n` +
        `        return NoContent();\n` +
        `    }\n`,
    );
  }
  void csIdValueClrType;
  return `// Auto-generated.
using System.Threading.Tasks;
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
