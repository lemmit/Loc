// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using Api.Application.Products.Commands;
using Api.Application.Products.Queries;
using Api.Application.Products.Requests;
using Api.Application.Products.Responses;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Api;

[ApiController]
[Route("products")]
public sealed class ProductsController : ControllerBase
{
    private readonly IMediator _mediator;
    public ProductsController(IMediator mediator) => _mediator = mediator;

    [HttpPost]
    public async Task<ActionResult<CreateProductResponse>> Create([FromBody] CreateProductRequest request)
    {
        var cmd = new CreateProductCommand(
            request.Sku,
            new Money(request.Price.Amount, request.Price.Currency)
        );
        var id = await _mediator.Send(cmd);
        return CreatedAtAction(nameof(GetById), new { id = id.Value }, new CreateProductResponse(id.Value));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<ProductResponse>> GetById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetProductByIdQuery(new ProductId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpGet]
    public async Task<ActionResult<System.Collections.Generic.IReadOnlyList<ProductResponse>>> All()
    {
        var result = await _mediator.Send(new AllQuery());
        return Ok(result);
    }

    [HttpGet("by_sku")]
    public async Task<ActionResult<ProductResponse?>> BySku([FromQuery] string sku)
    {
        var result = await _mediator.Send(new BySkuQuery(sku));
        return result is null ? NotFound() : Ok(result);
    }

}
