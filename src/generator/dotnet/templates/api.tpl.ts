import type { AggregateIR, RepositoryIR } from "../../../ir/loom-ir.js";
import { pascal, plural, snake } from "../../../util/naming.js";
import { lines } from "../../../util/code-builder.js";

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
}

export function renderController(
  agg: AggregateIR,
  _repo: RepositoryIR | undefined,
  ns: string,
  shape: ControllerShape,
): string {
  const className = `${plural(pascal(agg.name))}Controller`;
  const route = snake(plural(agg.name));

  const createBody = renderCmdConstructorBody(shape.createCmdArgs, "            ");

  const opBlocks = shape.publicOps.flatMap((op) => {
    const cmdArgs = [`new ${agg.name}Id(id)`, ...op.cmdArgs];
    const cmdBody = renderCmdConstructorBody(cmdArgs, "            ");
    return [
      `    [HttpPost("{id}/${snake(op.name)}")]`,
      `    public async Task<IActionResult> ${pascal(op.name)}([FromRoute] ${shape.idClrType} id, [FromBody] ${pascal(op.name)}Request request)`,
      "    {",
      `        var cmd = new ${pascal(op.name)}Command(`,
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
      `    public async Task<ActionResult<${responseType}>> ${pascal(f.name)}(${f.queryRouteParams})`,
      "    {",
      `        var result = await _mediator.Send(new ${pascal(f.name)}Query(${f.queryConstructorArgs}));`,
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
      "    [HttpGet(\"{id}\")]",
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
  return args.map(
    (a, i) => `${indent}${a}${i < args.length - 1 ? "," : ""}`,
  );
}

export function renderExceptionFilter(ns: string): string {
  return `// Auto-generated.
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using ${ns}.Domain.Common;

namespace ${ns}.Api;

public sealed class DomainExceptionFilter : IExceptionFilter
{
    public void OnException(ExceptionContext context)
    {
        if (context.Exception is DomainException de)
        {
            context.Result = new BadRequestObjectResult(new { error = de.Message });
            context.ExceptionHandled = true;
        }
        else if (context.Exception is AggregateNotFoundException nf)
        {
            context.Result = new NotFoundObjectResult(new { error = nf.Message });
            context.ExceptionHandled = true;
        }
    }
}
`;
}
