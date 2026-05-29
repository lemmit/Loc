// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
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
[Route("customers")]
public sealed class CustomersController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly ILogger<CustomersController> _log;
    public CustomersController(IMediator mediator, ILogger<CustomersController> log) { _mediator = mediator; _log = log; }

    [HttpPost]
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
    public async Task<ActionResult<CustomerResponse>> GetCustomerById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetCustomerByIdQuery(new CustomerId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<CustomerResponse>>> AllCustomer()
    {
        var result = await _mediator.Send(new AllQuery());
        return Ok(result);
    }

    [HttpGet("by_email")]
    public async Task<ActionResult<CustomerResponse?>> ByEmailCustomer([FromQuery] string email)
    {
        var result = await _mediator.Send(new ByEmailQuery(email));
        return result is null ? NotFound() : Ok(result);
    }

}
