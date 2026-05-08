// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
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
    public CustomersController(IMediator mediator) => _mediator = mediator;

    [HttpPost]
    public async Task<ActionResult<CreateCustomerResponse>> Create([FromBody] CreateCustomerRequest request)
    {
        var cmd = new CreateCustomerCommand(
            request.Username,
            request.Email,
            request.Age
        );
        var id = await _mediator.Send(cmd);
        return CreatedAtAction(nameof(GetById), new { id = id.Value }, new CreateCustomerResponse(id.Value));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<CustomerResponse>> GetById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetCustomerByIdQuery(new CustomerId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpGet]
    public async Task<ActionResult<System.Collections.Generic.IReadOnlyList<CustomerResponse>>> All()
    {
        var result = await _mediator.Send(new AllQuery());
        return Ok(result);
    }

    [HttpGet("by_email")]
    public async Task<ActionResult<CustomerResponse?>> ByEmail([FromQuery] string email)
    {
        var result = await _mediator.Send(new ByEmailQuery(email));
        return result is null ? NotFound() : Ok(result);
    }

}
