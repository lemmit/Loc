import type { AggregateIR, RepositoryIR } from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";

// ASP.NET Core controller emission.  One controller per aggregate root,
// dispatching every endpoint through Mediator (`ISender`).  The
// controller never sees the domain class — only the request/response
// DTOs and the matching command/query records.

interface ControllerShape {
  idClrType: string;
  createCmdArgs: string[];
  publicOps: Array<{ name: string; cmdArgs: string[] }>;
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
    return [
      `    [HttpPost("{id}/${snake(op.name)}")]`,
      `    public async Task<IActionResult> ${upperFirst(op.name)}([FromRoute] ${shape.idClrType} id, [FromBody] ${upperFirst(op.name)}Request request)`,
      "    {",
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
        ? `System.Collections.Generic.IReadOnlyList<${agg.name}Response>`
        : f.returnShape === "optional"
          ? `${agg.name}Response?`
          : `${agg.name}Response`;
    // Optional finds map a null result to 404 — same convention as
    // GetById.  List + single return Ok(result) directly.
    const returnLine =
      f.returnShape === "optional"
        ? "        return result is null ? NotFound() : Ok(result);"
        : "        return Ok(result);";
    return [
      `    [HttpGet${f.isRoot ? "" : `("${snake(f.name)}")`}]`,
      `    public async Task<ActionResult<${responseType}>> ${upperFirst(f.name)}(${f.queryRouteParams})`,
      "    {",
      `        var result = await _mediator.Send(new ${upperFirst(f.name)}Query(${f.queryConstructorArgs}));`,
      returnLine,
      "    }",
      "",
    ];
  });

  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Linq;",
      "using System.Threading.Tasks;",
      "using Mediator;",
      "using Microsoft.AspNetCore.Mvc;",
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
      `    public ${className}(IMediator mediator) => _mediator = mediator;`,
      "",
      "    [HttpPost]",
      `    public async Task<ActionResult<Create${agg.name}Response>> Create([FromBody] Create${agg.name}Request request)`,
      "    {",
      `        var cmd = new Create${agg.name}Command(`,
      ...createBody,
      "        );",
      "        var id = await _mediator.Send(cmd);",
      `        return CreatedAtAction(nameof(GetById), new { id = id.Value }, new Create${agg.name}Response(id.Value));`,
      "    }",
      "",
      '    [HttpGet("{id}")]',
      `    public async Task<ActionResult<${agg.name}Response>> GetById([FromRoute] ${shape.idClrType} id)`,
      "    {",
      `        var response = await _mediator.Send(new Get${agg.name}ByIdQuery(new ${agg.name}Id(id)));`,
      "        return response is null ? NotFound() : Ok(response);",
      "    }",
      "",
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
  return `// Auto-generated.${usesValidators ? "\nusing System.Linq;" : ""}
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
        var trace_id = System.Diagnostics.Activity.Current?.TraceId.ToString() ?? "";${
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
            context.Result = new ObjectResult(new { error = fe.Message, trace_id })
            {
                StatusCode = 403,
            };
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is DomainException de)
        {
            context.Result = new BadRequestObjectResult(new { error = de.Message, trace_id });
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is AggregateNotFoundException nf)
        {
            context.Result = new NotFoundObjectResult(new { error = nf.Message, trace_id });
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
            // server-side.
            _log.LogError(xh, "Extern handler {Op} on {Agg} threw",
                xh.OpName, xh.AggName);
            context.Result = new ObjectResult(new { error = xh.Message, trace_id })
            {
                StatusCode = 500,
            };
            context.ExceptionHandled = true;
            return;
        }
        // Generic 500.  Log the full exception server-side; return a
        // sanitized payload to the client.
        _log.LogError(context.Exception, "Unhandled exception in {Action}",
            context.ActionDescriptor.DisplayName);
        context.Result = new ObjectResult(new { error = "internal", trace_id })
        {
            StatusCode = 500,
        };
        context.ExceptionHandled = true;
    }
}
`;
}
