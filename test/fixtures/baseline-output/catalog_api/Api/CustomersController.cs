// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using CatalogApi.Application.Customers.Commands;
using CatalogApi.Application.Customers.Queries;
using CatalogApi.Application.Customers.Requests;
using CatalogApi.Application.Customers.Responses;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Api;

[ApiController]
[Route("customers")]
public sealed class CustomersController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly ILogger<CustomersController> _log;
    public CustomersController(IMediator mediator, ILogger<CustomersController> log) { _mediator = mediator; _log = log; }

    [HttpPost]
    [ProducesResponseType(typeof(CreateCustomerResponse), 201)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
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

    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<CustomerResponse>), 200)]
    public async Task<ActionResult<IReadOnlyList<CustomerResponse>>> AllCustomer()
    {
        var result = await _mediator.Send(new AllQuery());
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
