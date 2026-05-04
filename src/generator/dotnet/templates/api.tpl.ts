import type { AggregateIR, RepositoryIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

// Controllers: the boundary between HTTP and the application layer.
// Requests / Responses are wire-shaped DTOs (primitives only) — controllers
// map them to typed commands / queries before dispatching via Mediator.
// This keeps the API contract decoupled from internal domain types.
const CONTROLLER_TPL = hb.compile(
  `// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using {{ns}}.Application.{{plural aggregate.name}}.Commands;
using {{ns}}.Application.{{plural aggregate.name}}.Queries;
using {{ns}}.Application.{{plural aggregate.name}}.Requests;
using {{ns}}.Application.{{plural aggregate.name}}.Responses;
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;

namespace {{ns}}.Api;

[ApiController]
[Route("{{snake (plural aggregate.name)}}")]
public sealed class {{plural (pascal aggregate.name)}}Controller : ControllerBase
{
    private readonly IMediator _mediator;
    public {{plural (pascal aggregate.name)}}Controller(IMediator mediator) => _mediator = mediator;

    [HttpPost]
    public async Task<ActionResult<Create{{aggregate.name}}Response>> Create([FromBody] Create{{aggregate.name}}Request request)
    {
        var cmd = new Create{{aggregate.name}}Command(
{{#each createCmdArgs}}            {{{ this }}}{{#unless @last}},{{/unless}}
{{/each}}        );
        var id = await _mediator.Send(cmd);
        return CreatedAtAction(nameof(GetById), new { id = id.Value }, new Create{{aggregate.name}}Response(id.Value));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<{{aggregate.name}}Response>> GetById([FromRoute] {{idClrType}} id)
    {
        var response = await _mediator.Send(new Get{{aggregate.name}}ByIdQuery(new {{aggregate.name}}Id(id)));
        return response is null ? NotFound() : Ok(response);
    }

{{#each publicOps}}    [HttpPost("{id}/{{snake name}}")]
    public async Task<IActionResult> {{pascal name}}([FromRoute] {{../idClrType}} id, [FromBody] {{pascal name}}Request request)
    {
        var cmd = new {{pascal name}}Command(
            new {{../aggregate.name}}Id(id){{#if cmdArgs.length}},{{/if}}
{{#each cmdArgs}}            {{{ this }}}{{#unless @last}},{{/unless}}
{{/each}}        );
        await _mediator.Send(cmd);
        return NoContent();
    }

{{/each}}{{#each finds}}    [HttpGet{{#unless isRoot}}("{{snake name}}"){{/unless}}]
    public async Task<ActionResult<System.Collections.Generic.IReadOnlyList<{{../aggregate.name}}Response>>> {{pascal name}}({{{ queryRouteParams }}})
    {
        var result = await _mediator.Send(new {{pascal name}}Query({{{ queryConstructorArgs }}}));
        return Ok(result);
    }

{{/each}}
}
`,
);

const FILTER_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using {{ns}}.Domain.Common;

namespace {{ns}}.Api;

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
`,
);

export function renderController(
  agg: AggregateIR,
  _repo: RepositoryIR | undefined,
  ns: string,
  shape: {
    idClrType: string;
    createCmdArgs: string[];
    publicOps: Array<{ name: string; cmdArgs: string[] }>;
    finds: Array<{
      name: string;
      isRoot: boolean;
      queryRouteParams: string;
      queryConstructorArgs: string;
    }>;
  },
): string {
  return CONTROLLER_TPL({
    aggregate: agg,
    idClrType: shape.idClrType,
    createCmdArgs: shape.createCmdArgs,
    publicOps: shape.publicOps,
    finds: shape.finds,
    ns,
  });
}

export function renderExceptionFilter(ns: string): string {
  return FILTER_TPL({ ns });
}
