// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using Api.Domain.Common;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Api.Application.Customers.Commands;
using Api.Application.Customers.Queries;
using Api.Application.Customers.Requests;
using Api.Application.Customers.Responses;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Api;

[ApiController]
[Route("api/customers")]
public sealed class CustomersController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly ILogger<CustomersController> _log;
    public CustomersController(IMediator mediator, ILogger<CustomersController> log) { _mediator = mediator; _log = log; }

    [HttpPost]
    [ProducesResponseType(typeof(CreateCustomerResponse), 201)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    [ProducesResponseType(typeof(ProblemDetails), 422)]
    public async Task<ActionResult<CreateCustomerResponse>> CreateCustomer([FromBody] CreateCustomerRequest request)
    {
        var cmd = new CreateCustomerCommand(
            request.Username,
            request.Email,
            request.Age
        );
        var id = await _mediator.Send(cmd);
        _log.LogInformation("{Event} aggregate={Aggregate} id={Id}", "aggregate_created", "Customer", id.Value);
        return CreatedAtAction(nameof(GetCustomerById), new { id = id.Value }, new CreateCustomerResponse(id.Value));
    }

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(CustomerResponse), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<ActionResult<CustomerResponse>> GetCustomerById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetCustomerByIdQuery(new CustomerId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    [ProducesResponseType(typeof(ProblemDetails), 409)]
    public async Task<IActionResult> DestroyCustomer([FromRoute] Guid id)
    {
        try
        {
            await _mediator.Send(new DestroyCustomerCommand(new CustomerId(id)));
        }
        catch (Microsoft.EntityFrameworkCore.DbUpdateException)
        {
            return Conflict(new ProblemDetails { Title = "Conflict", Status = 409, Detail = "Customer is still referenced and cannot be deleted." });
        }
        return NoContent();
    }

    [HttpPost("{id}/update")]
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    [ProducesResponseType(typeof(ProblemDetails), 422)]
    public async Task<IActionResult> UpdateCustomer([FromRoute] Guid id, [FromBody] UpdateCustomerRequest request)
    {
        _log.LogInformation("{Event} aggregate={Aggregate} op={Op} id={Id}", "operation_invoked", "Customer", "update", id);
        var cmd = new UpdateCommand(
            new CustomerId(id),
            request.Username,
            request.Email,
            request.Age
        );
        await _mediator.Send(cmd);
        return NoContent();
    }

    [HttpGet]
    [ProducesResponseType(typeof(Paged<CustomerResponse>), 200)]
    public async Task<ActionResult<Paged<CustomerResponse>>> AllCustomer([FromQuery] int page = 1, [FromQuery] int pageSize = 20, [FromQuery] string sort = "id", [FromQuery] string dir = "asc")
    {
        var result = await _mediator.Send(new AllQuery(page, pageSize, sort, dir));
        return Ok(result);
    }

    [HttpGet("by_email")]
    [ProducesResponseType(typeof(CustomerResponse), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<ActionResult<CustomerResponse?>> ByEmailCustomer([FromQuery] [Microsoft.AspNetCore.Mvc.ModelBinding.BindRequired] string email)
    {
        var result = await _mediator.Send(new ByEmailQuery(email));
        return result is null ? NotFound() : Ok(result);
    }

}
