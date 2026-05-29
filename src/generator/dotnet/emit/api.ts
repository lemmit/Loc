import type { AggregateIR, RepositoryIR } from "../../../ir/types/loom-ir.js";
import { errorStatuses, type OpErrorKind } from "../../../ir/util/openapi-errors.js";
import {
  camelId,
  type OpIdTokens,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "../../../ir/util/openapi-ids.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall, renderDotnetLogCallWithException } from "../../_obs/render-dotnet.js";

/** Controller action method name = PascalCase of the shared operationId,
 *  so Program.cs's `CustomOperationIds` (lower-first of the action name)
 *  yields the exact camelCase operationId Hono/Phoenix emit. */
function actionName(tokens: OpIdTokens): string {
  return upperFirst(camelId(tokens));
}

/** `[ProducesResponseType]` attribute lines declaring the RFC 7807 error
 *  responses for an operation kind (from the shared matrix).  A Swashbuckle
 *  operation filter (see Program.cs) rewrites their content-type to
 *  `application/problem+json` so the emitted spec matches Hono/Phoenix. */
function producesProblem(kind: OpErrorKind, indent = "    "): string[] {
  return errorStatuses(kind).map(
    (s) => `${indent}[ProducesResponseType(typeof(ProblemDetails), ${s})]`,
  );
}

// ASP.NET Core controller emission.  One controller per aggregate root,
// dispatching every endpoint through Mediator (`ISender`).  The
// controller never sees the domain class — only the request/response
// DTOs and the matching command/query records.

/** Compile-time --trace context — when `emitTrace` is true, the
 *  controller's operation routes get a `_log.LogTrace(...)` line for
 *  the catalog's `wire_in` event after binding `[FromBody]`.  Op
 *  param names (lowerCamel — matching the wire JSON key set the
 *  request was de-serialised from) flow through `publicOps[i].paramNames`. */
interface ControllerShape {
  idClrType: string;
  createCmdArgs: string[];
  /** When true, the aggregate has a canonical `destroy` — emit a
   *  `DELETE /{id}` action dispatching `Destroy<Agg>Command`. */
  destroyAction?: boolean;
  publicOps: Array<{ name: string; routeSlug?: string; cmdArgs: string[]; paramNames: string[] }>;
  finds: Array<{
    name: string;
    isRoot: boolean;
    queryRouteParams: string;
    queryConstructorArgs: string;
    /** Cardinality of the response, derived from the IR find's
     * `returnType`.  Drives the controller's `Task<ActionResult<...>>`
     * type + the body's `Ok(result)` / `result is null ? NotFound()`
     * shape.  Must agree with the matching Hono Zod schema for the
     * cross-platform contract check to pass. */
    returnShape: "list" | "optional" | "single";
  }>;
  /** Prefix prepended to the controller's `[Route(...)]` (e.g.
   *  `"api/"` for fullstack-dotnet — leaves `/orders/*` paths free
   *  for the SPA's client-side router and namespaces controllers
   *  under `/api/orders/*`).  Empty for standalone .NET (controllers
   *  stay at root, matching the v0 behaviour). */
  routePrefix?: string;
  /** When true, controllers emit a `wire_in` trace line right after
   *  `[FromBody]` binding so the parsed request's key set is observable
   *  on the structured stream.  Off keeps the operation handler at its
   *  pre-trace shape exactly. */
  emitTrace?: boolean;
  /** Extra namespaces accumulated by the upstream
   *  `wireToCommandArgument` calls (e.g. `System.Globalization` when
   *  a datetime field needs `DateTime.Parse(..., CultureInfo, …)`).
   *  Spliced into the using block so each controller imports only
   *  the namespaces its own argument lowering touched. */
  extraUsings?: readonly string[];
}

export function renderController(
  agg: AggregateIR,
  _repo: RepositoryIR | undefined,
  ns: string,
  shape: ControllerShape,
): string {
  const className = `${plural(upperFirst(agg.name))}Controller`;
  const route = `${shape.routePrefix ?? ""}${snake(plural(agg.name))}`;

  const createBody = renderCmdConstructorBody(shape.createCmdArgs, "            ");

  const opBlocks = shape.publicOps.flatMap((op) => {
    const cmdArgs = [`new ${agg.name}Id(id)`, ...op.cmdArgs];
    const cmdBody = renderCmdConstructorBody(cmdArgs, "            ");
    // wire_in (trace) — the structural shape (keys only, no values) of
    // the parsed request, emitted right after `[FromBody]` binding so
    // a downstream filter pivoting on wire_in sees the same field set
    // Hono emits via `Object.keys(body)`.  Keys are lowerCamel
    // (matching the JSON wire under ASP.NET's default
    // JsonNamingPolicy.CamelCase).  Skipped entirely when --trace is off.
    const wireInLine = shape.emitTrace
      ? [
          `        ${renderDotnetLogCall("wireIn", [
            {
              name: "keys",
              // Empty arrays need an explicit element type so C# can
              // infer the `params object[]` overload of LogTrace —
              // `new[] { }` is a compile error.  Common case (op with
              // params) uses the implicit array literal.
              valueExpr:
                op.paramNames.length === 0
                  ? "Array.Empty<string>()"
                  : `new[] { ${op.paramNames.map((n) => `"${n}"`).join(", ")} }`,
            },
          ])}`,
        ]
      : [];
    return [
      `    [HttpPost("{id}/${snake(op.routeSlug ?? op.name)}")]`,
      // Declare the success response explicitly — once any
      // [ProducesResponseType] is present, Swashbuckle stops inferring the
      // 2xx body from the action signature, so it must be spelled out.
      "    [ProducesResponseType(204)]",
      ...producesProblem("operation"),
      `    public async Task<IActionResult> ${actionName(opOperation(agg.name, op.name))}([FromRoute] ${shape.idClrType} id, [FromBody] ${upperFirst(op.name)}Request request)`,
      "    {",
      ...wireInLine,
      // Business-narrative line — what the controller was asked to do,
      // before Mediator dispatches the command.  Mirrors the
      // operation_invoked emission on the Hono side so a cross-backend
      // log consumer sees the same event with the same field set.
      `        ${renderDotnetLogCall("operationInvoked", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "op", valueExpr: `"${op.name}"` },
        { name: "id", valueExpr: "id" },
      ])}`,
      `        var cmd = new ${upperFirst(op.name)}Command(`,
      ...cmdBody,
      "        );",
      "        await _mediator.Send(cmd);",
      "        return NoContent();",
      "    }",
      "",
    ];
  });

  const findBlocks = shape.finds.flatMap((f) => {
    const responseType =
      f.returnShape === "list"
        ? `IReadOnlyList<${agg.name}Response>`
        : f.returnShape === "optional"
          ? `${agg.name}Response?`
          : `${agg.name}Response`;
    // Optional finds map a null result to 404 — same convention as
    // GetById.  List + single return Ok(result) directly.
    const returnLine =
      f.returnShape === "optional"
        ? "        return result is null ? NotFound() : Ok(result);"
        : "        return Ok(result);";
    // Non-nullable success type for [ProducesResponseType] (typeof can't
    // carry a `?` nullable annotation).
    const successType =
      f.returnShape === "list" ? `IReadOnlyList<${agg.name}Response>` : `${agg.name}Response`;
    return [
      `    [HttpGet${f.isRoot ? "" : `("${snake(f.name)}")`}]`,
      `    [ProducesResponseType(typeof(${successType}), 200)]`,
      ...producesProblem(
        f.returnShape === "optional"
          ? "findOptional"
          : f.returnShape === "list"
            ? "findList"
            : "findSingle",
      ),
      `    public async Task<ActionResult<${responseType}>> ${actionName(opFind(agg.name, f.name))}(${f.queryRouteParams})`,
      "    {",
      `        var result = await _mediator.Send(new ${upperFirst(f.name)}Query(${f.queryConstructorArgs}));`,
      returnLine,
      "    }",
      "",
    ];
  });

  const extraUsingsLines = (shape.extraUsings ?? []).map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Linq;",
      "using System.Threading.Tasks;",
      ...extraUsingsLines,
      "using Mediator;",
      "using Microsoft.AspNetCore.Mvc;",
      "using Microsoft.Extensions.Logging;",
      `using ${ns}.Application.${plural(agg.name)}.Commands;`,
      `using ${ns}.Application.${plural(agg.name)}.Queries;`,
      `using ${ns}.Application.${plural(agg.name)}.Requests;`,
      `using ${ns}.Application.${plural(agg.name)}.Responses;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Api;`,
      "",
      "[ApiController]",
      `[Route("${route}")]`,
      `public sealed class ${className} : ControllerBase`,
      "{",
      "    private readonly IMediator _mediator;",
      // ILogger field — drives the catalog-event emission below.  Same
      // per-class injection idiom DomainExceptionFilter uses, so the
      // pattern stays consistent across the generated codebase.
      `    private readonly ILogger<${className}> _log;`,
      `    public ${className}(IMediator mediator, ILogger<${className}> log) { _mediator = mediator; _log = log; }`,
      "",
      "    [HttpPost]",
      `    [ProducesResponseType(typeof(Create${agg.name}Response), 201)]`,
      ...producesProblem("create"),
      `    public async Task<ActionResult<Create${agg.name}Response>> ${actionName(opCreate(agg.name))}([FromBody] Create${agg.name}Request request)`,
      "    {",
      `        var cmd = new Create${agg.name}Command(`,
      ...createBody,
      "        );",
      "        var id = await _mediator.Send(cmd);",
      // aggregate_created — business narrative, after the Mediator
      // command's Send resolves with the new id.  Mirrors the Hono
      // emission so cross-backend log consumers see the same event +
      // fields ({Aggregate}, {Id}).
      `        ${renderDotnetLogCall("aggregateCreated", [
        { name: "aggregate", valueExpr: `"${agg.name}"` },
        { name: "id", valueExpr: "id.Value" },
      ])}`,
      `        return CreatedAtAction(nameof(${actionName(opGetById(agg.name))}), new { id = id.Value }, new Create${agg.name}Response(id.Value));`,
      "    }",
      "",
      '    [HttpGet("{id}")]',
      `    [ProducesResponseType(typeof(${agg.name}Response), 200)]`,
      ...producesProblem("getById"),
      `    public async Task<ActionResult<${agg.name}Response>> ${actionName(opGetById(agg.name))}([FromRoute] ${shape.idClrType} id)`,
      "    {",
      `        var response = await _mediator.Send(new Get${agg.name}ByIdQuery(new ${agg.name}Id(id)));`,
      "        return response is null ? NotFound() : Ok(response);",
      "    }",
      "",
      // Canonical destroy → DELETE /{id} (hard delete).  Gated; reuses the
      // getById error shape (404).  crudish's destroy is empty-bodied, so
      // the command carries only the id.
      ...(shape.destroyAction
        ? [
            '    [HttpDelete("{id}")]',
            "    [ProducesResponseType(204)]",
            ...producesProblem("getById"),
            "    [ProducesResponseType(typeof(ProblemDetails), 409)]",
            `    public async Task<IActionResult> ${actionName(opDestroy(agg.name))}([FromRoute] ${shape.idClrType} id)`,
            "    {",
            "        try",
            "        {",
            `            await _mediator.Send(new Destroy${agg.name}Command(new ${agg.name}Id(id)));`,
            "        }",
            // EF wraps a Postgres foreign_key_violation in DbUpdateException
            // when the row is still referenced (cross-aggregate `X id` FK is
            // ON DELETE RESTRICT) → 409 Conflict.  Caught locally so the
            // shared DomainExceptionFilter stays untouched.
            "        catch (Microsoft.EntityFrameworkCore.DbUpdateException)",
            "        {",
            `            return Conflict(new ProblemDetails { Title = "Conflict", Status = 409, Detail = "${agg.name} is still referenced and cannot be deleted." });`,
            "        }",
            "        return NoContent();",
            "    }",
            "",
          ]
        : []),
      ...opBlocks,
      ...findBlocks,
      "}",
    ) + "\n"
  );
}

function renderCmdConstructorBody(args: string[], indent: string): string[] {
  return args.map((a, i) => `${indent}${a}${i < args.length - 1 ? "," : ""}`);
}

export function renderExceptionFilter(ns: string, options?: { usesValidators?: boolean }): string {
  const usesValidators = !!options?.usesValidators;
  // `Activity.Current` is referenced unconditionally below; the
  // `using System.Diagnostics;` is therefore part of the file's
  // baseline imports rather than something we'd derive from the body.
  // Confined to this file — adding `System.Diagnostics` project-wide
  // would expose `Activity` (a common DDD entity name) to every
  // generated source file.
  return `// Auto-generated.${usesValidators ? "\nusing System.Linq;" : ""}
using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;

namespace ${ns}.Api;

/// <summary>
/// Maps domain-layer exceptions to structured HTTP responses.
/// Domain exceptions get a 400 / 404 with the original message;
/// any unhandled exception falls through to a generic 500 with a
/// safe message (the original is logged but not returned, so
/// internal details don't leak to API consumers).  Mirrors the
/// Hono \`app.onError\` shape so the cross-platform contract
/// stays in lockstep.
/// </summary>
public sealed class DomainExceptionFilter : IExceptionFilter
{
    private readonly ILogger<DomainExceptionFilter> _log;
    public DomainExceptionFilter(ILogger<DomainExceptionFilter> log) => _log = log;

    public void OnException(ExceptionContext context)
    {
        // Correlation id — ASP.NET Core sets Activity.Current
        // automatically on every request via the
        // HostingApplicationDiagnostics.  Surfacing the trace id on
        // the response lets an operator join the response back to
        // the structured log line without scraping headers.  Empty
        // string when no Activity is active (e.g. middleware errors
        // before the pipeline starts).
        var trace_id = Activity.Current?.TraceId.ToString() ?? "";${
          usesValidators
            ? `
        // FluentValidation arm — runs FIRST because
        // validation failures are the most common 400 cause.  The
        // envelope extends the existing { error, trace_id } shape
        // with a structured \`failures\` array carrying field +
        // message per FluentValidation issue, so frontends can
        // surface field-level errors next to the right input.
        if (context.Exception is FluentValidation.ValidationException fv)
        {
            context.Result = new BadRequestObjectResult(new
            {
                error = "Validation failed",
                trace_id,
                failures = fv.Errors
                    .Select(e => new { field = e.PropertyName, message = e.ErrorMessage })
                    .ToArray(),
            });
            context.ExceptionHandled = true;
            return;
        }`
            : ""
        }
        if (context.Exception is ForbiddenException fe)
        {
            context.Result = Problem(context, 403, "Forbidden", fe.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is DomainException de)
        {
            context.Result = Problem(context, 400, "Bad Request", de.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is AggregateNotFoundException nf)
        {
            context.Result = Problem(context, 404, "Not Found", nf.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is ExternHandlerException xh)
        {
            // 500 — the user handler threw, which is an internal
            // failure from the framework's POV — but the envelope
            // names the offending op + aggregate so operators don't
            // have to grep logs to find the cause.  The original
            // exception (xh.InnerException) is logged in full
            // server-side via the catalog's extern_handler_threw
            // event — same shape the Hono onError arm emits.
            ${renderDotnetLogCallWithException("externHandlerThrew", "xh", [
              { name: "aggregate", valueExpr: "xh.AggName" },
              { name: "op", valueExpr: "xh.OpName" },
              { name: "error", valueExpr: "xh.Message" },
            ])}
            context.Result = Problem(context, 500, "Internal Server Error", xh.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        // Generic 500.  Log the full exception server-side via the
        // catalog's internal_error event; return a sanitized payload
        // to the client.  Matching the Hono fallback envelope.
        ${renderDotnetLogCallWithException("internalError", "context.Exception", [
          { name: "error", valueExpr: "context.Exception.Message" },
          { name: "status", valueExpr: "500" },
        ])}
        context.Result = Problem(context, 500, "Internal Server Error", "internal", trace_id);
        context.ExceptionHandled = true;
    }

    // RFC 7807 problem responder — application/problem+json body +
    // x-request-id header (trace correlation moves off the body so it's
    // byte-identical to Hono / Phoenix).  Shared by every non-validation arm.
    private static IActionResult Problem(ExceptionContext context, int status, string title, string detail, string traceId)
    {
        context.HttpContext.Response.Headers["x-request-id"] = traceId;
        return new ObjectResult(new ProblemDetails
        {
            Type = "about:blank",
            Title = title,
            Status = status,
            Detail = detail,
            Instance = context.HttpContext.Request.Path,
        })
        {
            StatusCode = status,
            ContentTypes = { "application/problem+json" },
        };
    }
}
`;
}

/** Swashbuckle operation filter — rewrites every declared 4xx/5xx response
 *  to `application/problem+json` carrying the shared `ProblemDetails`
 *  schema.  `[ProducesResponseType(typeof(ProblemDetails), …)]` on each
 *  action declares WHICH statuses; this filter normalises the content-type
 *  (Swashbuckle defaults error responses to `application/json`) so the
 *  emitted spec's error contract matches Hono / Phoenix (RFC 7807). */
export function renderProblemDetailsFilter(ns: string): string {
  return `// Auto-generated.
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ${ns}.Api;

public sealed class ProblemDetailsResponsesFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        var schema = context.SchemaGenerator.GenerateSchema(typeof(ProblemDetails), context.SchemaRepository);
        foreach (var (code, response) in operation.Responses)
        {
            if (code.Length == 3 && (code[0] == '4' || code[0] == '5'))
            {
                response.Content.Clear();
                response.Content["application/problem+json"] = new OpenApiMediaType { Schema = schema };
            }
        }
    }
}
`;
}

/** Swashbuckle document filter — promotes inline `array<XResponse>` list
 *  responses to named component schemas (`XResponse` → `XListResponse`;
 *  full-form views: `XRow` → `XResponse`), matching the Hono / Phoenix
 *  backends which name the wrapper.  Swashbuckle inlines any IEnumerable
 *  type, so the only reliable way to get a named array component is to
 *  add it + retarget the responses here.  The element→wrapper map is baked
 *  in from the IR (no runtime name guessing). */
export function renderListWrapperFilter(
  ns: string,
  pairs: ReadonlyArray<{ element: string; wrapper: string }>,
): string {
  const wrappersExpr =
    pairs.length === 0
      ? "Array.Empty<(string Element, string Wrapper)>()"
      : `new[]
    {
${pairs.map((p) => `        ("${p.element}", "${p.wrapper}"),`).join("\n")}
    }`;
  return `// Auto-generated.
using System;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ${ns}.Api;

public sealed class ListResponseWrapperFilter : IDocumentFilter
{
    private static readonly (string Element, string Wrapper)[] Wrappers = ${wrappersExpr};

    public void Apply(OpenApiDocument doc, DocumentFilterContext context)
    {
        // Add the named wrapper component for each element schema present.
        foreach (var (element, wrapper) in Wrappers)
        {
            if (doc.Components.Schemas.ContainsKey(element) && !doc.Components.Schemas.ContainsKey(wrapper))
            {
                doc.Components.Schemas[wrapper] = new OpenApiSchema
                {
                    Type = "array",
                    Items = new OpenApiSchema
                    {
                        Reference = new OpenApiReference { Type = ReferenceType.Schema, Id = element }
                    }
                };
            }
        }

        // Retarget inline array responses to the named wrapper $ref.
        foreach (var path in doc.Paths.Values)
        foreach (var operation in path.Operations.Values)
        foreach (var response in operation.Responses.Values)
        foreach (var media in response.Content.Values)
        {
            var schema = media.Schema;
            if (schema?.Type == "array" && schema.Items?.Reference?.Id is string elementId)
            {
                foreach (var (element, wrapper) in Wrappers)
                {
                    if (element == elementId)
                    {
                        media.Schema = new OpenApiSchema
                        {
                            Reference = new OpenApiReference { Type = ReferenceType.Schema, Id = wrapper }
                        };
                        break;
                    }
                }
            }
        }
    }
}
`;
}
