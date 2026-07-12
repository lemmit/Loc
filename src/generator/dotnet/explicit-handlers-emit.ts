// ---------------------------------------------------------------------------
// Explicit application/transport layer → .NET Mediator emission
// (unfoldable-api-derivation.md, Layers 3-4; A1 slice).
//
// Reads the explicit `commandHandler` / `queryHandler` context members and the
// `route <METHOD> "<path>" -> <Ctx>.<Handler>` api bindings shipped in #1756 and
// emits them onto the SAME source-generated `martinothamar/Mediator` seam the
// backend already dispatches every endpoint through (`ICommandHandler` /
// `IQueryHandler`, `_mediator.Send(...)`; see emit/cqrs.ts + emit/api.ts):
//
//   commandHandler  → `<Name>Command(params) : ICommand<Ret>` + `<Name>Handler`
//   queryHandler    → `<Name>Query(params)   : IQuery<Ret>`   + `<Name>Handler`
//   route <M> <p>   → a ControllerBase action that builds the command/query and
//                     `_mediator.Send`s it.
//
// PARALLEL emitter (docs/decisions — the reuse fork): it reuses the workflow
// body renderer (`csWorkflowStmtTarget` + `renderExprWithCmdParams`, exported
// from workflow-emit.ts) but writes its own handler shell, so the shipped
// workflow emitter stays byte-identical.  The handler body renders the workflow
// statements, then `return <returnValue>` (the IR field #1793 added — the
// workflow stmt target has no return arm).
//
// Route param binding: a handler param bound by a `{token}` in the route path
// stays URL-bound (id → wire type coerced back with `new <Agg>Id`); every other
// param rides in one `[FromBody] <Handler>Body` request record (a domain-typed
// record emitted alongside the controller).  The command/query ctor args keep
// declared order — path coercions and `body.<Pascal>` reads interleaved.
// Follow-up: full response-DTO projection for aggregate-returning handlers.
// ---------------------------------------------------------------------------

import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ParamIR,
  QueryHandlerIR,
  RouteIR,
  TypeIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { wireTypeInfo } from "../../ir/types/wire-types.js";
import { plural, upperFirst } from "../../util/naming.js";
import { renderWorkflowStmtChunks } from "../_workflow/stmt-target.js";
import { projectToResponse } from "./dto-mapping.js";
import { renderCsType } from "./render-expr.js";
import { csWorkflowStmtTarget, renderExprWithCmdParams } from "./workflow-emit.js";

const INDENT = "        ";

type Handler = CommandHandlerIR | QueryHandlerIR;

/** The repos a handler body references (repo-let loads + exit-saves), keyed by
 *  repo name → aggregate name.  These become the handler's injected
 *  `I<Agg>Repository _<repo>` fields — matching the field naming the shared
 *  workflow stmt target emits (`_<repoLowerFirst>`). */
function collectRepos(h: Handler): Map<string, string> {
  const repos = new Map<string, string>();
  const walk = (stmts: readonly WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      if (s.kind === "repo-let") repos.set(s.repoName, s.aggName);
      else if (s.kind === "for-each") walk(s.body);
      else if (s.kind === "if-let") {
        walk(s.thenBody);
        walk(s.elseBody ?? []);
      }
    }
  };
  walk(h.statements);
  for (const save of h.savesAtExit) repos.set(save.repoName, save.aggName);
  return repos;
}

/** The aggregate a handler is filed under (namespace + `using`).  The exit-save
 *  target for a command; the first loaded aggregate for a query. */
function primaryAgg(h: Handler): string | undefined {
  return h.savesAtExit[0]?.aggName ?? [...collectRepos(h).values()][0];
}

const repoField = (repoName: string): string =>
  `_${repoName.charAt(0).toLowerCase()}${repoName.slice(1)}`;

/** The aggregate a handler's return type resolves to, when it returns an
 *  entity (aggregate or part) — used to import the domain namespace so a
 *  `IQuery<Order>` / `ValueTask<Order>` signature resolves. Undefined for an
 *  id / scalar / void return. */
function returnEntityAgg(h: Handler, ctx: EnrichedBoundedContextIR): string | undefined {
  if (!h.returnType) return undefined;
  const info = wireTypeInfo(h.returnType, "response");
  if (info.refKind !== "entity") return undefined;
  const owning =
    ctx.aggregates.find((a) => a.name === info.base) ??
    ctx.aggregates.find((a) => a.parts.some((p) => p.name === info.base));
  return owning?.name;
}

/** Render a handler's `<Name>Command` / `<Name>Query` record. */
function renderRecord(
  h: Handler,
  ns: string,
  ctx: EnrichedBoundedContextIR,
  agg: string,
  kind: "Command" | "Query",
): string {
  const recName = `${h.name}${kind}`;
  const params = h.params.map((p) => `${renderCsType(p.type)} ${upperFirst(p.name)}`).join(", ");
  const iface =
    kind === "Command"
      ? h.returnType
        ? `ICommand<${renderCsType(h.returnType)}>`
        : "ICommand"
      : `IQuery<${renderCsType(h.returnType!)}>`;
  const folder = kind === "Command" ? "Commands" : "Queries";
  // A record whose return type is an aggregate needs that aggregate's domain
  // namespace so `ICommand<Order>` / `IQuery<Order>` resolves.
  const retAgg = returnEntityAgg(h, ctx);
  const retUsing = retAgg ? `\nusing ${ns}.Domain.${plural(retAgg)};` : "";
  return `// Auto-generated.
using Mediator;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;${retUsing}

namespace ${ns}.Application.${plural(agg)}.${folder};

public sealed record ${recName}(${params}) : ${iface};
`;
}

/** Render a handler class: injected repos, ctor, and a `Handle` that renders the
 *  body statements + exit-saves + `return <returnValue>`. */
function renderHandlerClass(
  h: Handler,
  ns: string,
  ctx: EnrichedBoundedContextIR,
  agg: string,
  kind: "Command" | "Query",
): string {
  const recName = `${h.name}${kind}`;
  const handlerName = `${h.name}Handler`;
  const ret = h.returnType ? renderCsType(h.returnType) : "Unit";
  const iface =
    kind === "Command"
      ? `ICommandHandler<${recName}, ${ret}>`
      : `IQueryHandler<${recName}, ${ret}>`;

  const repos = collectRepos(h);
  const fields = [...repos].map(
    ([repo, a]) => `    private readonly I${a}Repository ${repoField(repo)};`,
  );
  const ctorParams = [...repos]
    .map(([repo, a]) => `I${a}Repository ${repoField(repo).slice(1)}`)
    .join(", ");
  const ctorAssigns = [...repos]
    .map(([repo]) => `${repoField(repo)} = ${repoField(repo).slice(1)}`)
    .join("; ");
  const ctor =
    repos.size === 0
      ? `    public ${handlerName}() { }`
      : `    public ${handlerName}(${ctorParams})\n    {\n        ${ctorAssigns};\n    }`;

  const paramNames = new Set(h.params.map((p) => p.name));
  const renderArg = (e: ExprIR): string => renderExprWithCmdParams(e, paramNames);
  // Guard every getById load with `?? throw` — a handler body always
  // dereferences its load (op-call target / return projection).
  const stmtLines = renderWorkflowStmtChunks(
    h.statements,
    csWorkflowStmtTarget(ctx, renderArg, true, false),
    INDENT,
  ).flat();
  const saveLines = h.savesAtExit.map(
    (s) => `        await ${repoField(s.repoName)}.SaveAsync(${s.name}, cancellationToken);`,
  );
  const returnLine = h.returnValue
    ? `        return ${renderArg(h.returnValue)};`
    : "        return Unit.Value;";
  const body = [...stmtLines, ...saveLines, returnLine].join("\n");

  // The `Handle` signature (`ValueTask<Order>`) needs the return aggregate's
  // domain namespace too — usually the same as the loaded one, but not always.
  const retAgg = returnEntityAgg(h, ctx);
  const aggUsings = [...new Set([...repos.values(), agg, ...(retAgg ? [retAgg] : [])])]
    .map((a) => `using ${ns}.Domain.${plural(a)};`)
    .join("\n");

  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${ns}.Domain.Common;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${aggUsings}

namespace ${ns}.Application.${plural(agg)}.${kind === "Command" ? "Commands" : "Queries"};

public sealed class ${handlerName} : ${iface}
{
${fields.join("\n")}
${ctor}

    public async ValueTask<${ret}> Handle(${recName} command, CancellationToken cancellationToken)
    {
${body}
    }
}
`;
}

/** Emit `<Name>Command`/`<Name>Query` records + handlers for every explicit
 *  handler in a context.  A no-op for a context with none. */
export function emitExplicitHandlers(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  for (const h of ctx.commandHandlers ?? []) {
    const agg = primaryAgg(h);
    if (!agg) continue;
    out.set(
      `Application/${plural(agg)}/Commands/${h.name}Command.cs`,
      renderRecord(h, ns, ctx, agg, "Command"),
    );
    out.set(
      `Application/${plural(agg)}/Commands/${h.name}Handler.cs`,
      renderHandlerClass(h, ns, ctx, agg, "Command"),
    );
  }
  for (const h of ctx.queryHandlers ?? []) {
    const agg = primaryAgg(h);
    if (!agg) continue;
    out.set(
      `Application/${plural(agg)}/Queries/${h.name}Query.cs`,
      renderRecord(h, ns, ctx, agg, "Query"),
    );
    out.set(
      `Application/${plural(agg)}/Queries/${h.name}Handler.cs`,
      renderHandlerClass(h, ns, ctx, agg, "Query"),
    );
  }
}

/** The `{token}` names in a route path — the params bound from the URL rather
 *  than the request body. */
function pathParamNames(path: string): Set<string> {
  const names = new Set<string>();
  for (const m of path.matchAll(/\{(\w+)\}/g)) names.add(m[1]);
  return names;
}

/** A PATH-bound handler param: the wire-typed action parameter + the
 *  domain-coerced command argument.  id → `Guid`/`long`/`string` route token
 *  wrapped in `new <Agg>Id`; scalar → direct. */
function pathActionParam(p: ParamIR): { actionParam: string; commandArg: string } {
  const t: TypeIR = p.type;
  if (t.kind === "id") {
    const wire = t.valueType === "guid" ? "Guid" : t.valueType === "int" ? "long" : "string";
    return {
      actionParam: `${wire} ${p.name}`,
      commandArg: `new ${t.targetName}Id(${p.name})`,
    };
  }
  return { actionParam: `${renderCsType(t)} ${p.name}`, commandArg: p.name };
}

const HTTP_ATTR: Record<string, string> = {
  GET: "HttpGet",
  POST: "HttpPost",
  PUT: "HttpPut",
  PATCH: "HttpPatch",
  DELETE: "HttpDelete",
};

/** Emit one ControllerBase per api whose route list is non-empty: each `route`
 *  becomes an action that constructs the target command/query from its
 *  (wire-coerced) params and `_mediator.Send`s it. */
export function emitExplicitRouteController(
  apiName: string,
  routes: readonly RouteIR[],
  contexts: readonly EnrichedBoundedContextIR[],
  ns: string,
  out: Map<string, string>,
): void {
  if (routes.length === 0) return;
  const byName = new Map<string, EnrichedBoundedContextIR>(contexts.map((c) => [c.name, c]));
  const nsUsings = new Set<string>();
  const actions: string[] = [];
  const bodyRecords: string[] = [];
  for (const r of routes) {
    const ctx = byName.get(r.target.context);
    if (!ctx) continue;
    const cmd = (ctx.commandHandlers ?? []).find((h) => h.name === r.target.handler);
    const qry = (ctx.queryHandlers ?? []).find((h) => h.name === r.target.handler);
    const h = cmd ?? qry;
    if (!h) continue;
    const agg = primaryAgg(h);
    if (!agg) continue;
    const kind: "Command" | "Query" = cmd ? "Command" : "Query";
    nsUsings.add(`${ns}.Application.${plural(agg)}.${kind === "Command" ? "Commands" : "Queries"}`);

    // Split params: those bound by a `{token}` in the route path stay URL params;
    // the rest ride in one `[FromBody]` request record. (Multiple bare complex
    // action params would each be inferred `[FromBody]`, which ASP.NET rejects,
    // and a simple type would silently bind from the query string instead.)
    const pathNames = pathParamNames(r.path);
    const pathParams = h.params.filter((p) => pathNames.has(p.name));
    const bodyParams = h.params.filter((p) => !pathNames.has(p.name));
    const pathArg = new Map(pathParams.map((p) => [p.name, pathActionParam(p)]));

    const actionParamParts = pathParams.map((p) => pathArg.get(p.name)!.actionParam);
    let bodyRecName: string | undefined;
    if (bodyParams.length > 0) {
      bodyRecName = `${h.name}Body`;
      const fields = bodyParams
        .map((p) => `${renderCsType(p.type)} ${upperFirst(p.name)}`)
        .join(", ");
      bodyRecords.push(`public sealed record ${bodyRecName}(${fields});`);
      actionParamParts.push(`[FromBody] ${bodyRecName} body`);
    }
    const actionParams = actionParamParts.join(", ");
    // Command/query ctor args stay in declared param order: path params coerce
    // from the route token, body params read off `body.<Pascal>`.
    const ctorArgs = h.params
      .map((p) =>
        pathNames.has(p.name) ? pathArg.get(p.name)!.commandArg : `body.${upperFirst(p.name)}`,
      )
      .join(", ");

    const rec = `${h.name}${kind}`;
    const attr = HTTP_ATTR[r.method] ?? "HttpGet";
    // A query always returns; a command returns only with an explicit type.
    const retType = kind === "Query" ? qry!.returnType : cmd?.returnType;
    let sendBlock: string;
    if (retType) {
      // An aggregate/entity return is projected to its wire-shape `<Agg>Response`
      // — the same projection the auto-derived read endpoints use — so the route
      // serialises the contract, not the raw domain entity. Scalar / id returns
      // serialise as-is.
      const info = wireTypeInfo(retType, "response");
      let okExpr = "result";
      if (info.refKind === "entity") {
        const owning =
          ctx.aggregates.find((a) => a.name === info.base) ??
          ctx.aggregates.find((a) => a.parts.some((p) => p.name === info.base));
        if (owning) {
          okExpr = projectToResponse("result", retType, ctx);
          nsUsings.add(`${ns}.Application.${plural(owning.name)}.Responses`);
        }
      }
      sendBlock = `        var result = await _mediator.Send(new ${rec}(${ctorArgs}));\n        return Ok(${okExpr});`;
    } else {
      sendBlock = `        await _mediator.Send(new ${rec}(${ctorArgs}));\n        return NoContent();`;
    }
    actions.push(
      `    [${attr}("${r.path}")]\n` +
        `    public async Task<IActionResult> ${h.name}(${actionParams})\n` +
        `    {\n${sendBlock}\n    }`,
    );
  }
  if (actions.length === 0) return;
  const usings = [...nsUsings].sort().map((u) => `using ${u};`);
  const className = `${apiName}RoutesController`;
  const bodyBlock = bodyRecords.length > 0 ? `${bodyRecords.join("\n")}\n\n` : "";
  out.set(
    `Api/${className}.cs`,
    `// Auto-generated.
using System;
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
${usings.join("\n")}

namespace ${ns}.Api;

${bodyBlock}[ApiController]
public sealed class ${className} : ControllerBase
{
    private readonly IMediator _mediator;
    public ${className}(IMediator mediator) => _mediator = mediator;

${actions.join("\n\n")}
}
`,
  );
}
