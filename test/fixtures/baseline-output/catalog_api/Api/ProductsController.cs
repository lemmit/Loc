// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using CatalogApi.Application.Products.Commands;
using CatalogApi.Application.Products.Queries;
using CatalogApi.Application.Products.Requests;
using CatalogApi.Application.Products.Responses;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Api;

[ApiController]
[Route("products")]
public sealed class ProductsController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly ILogger<ProductsController> _log;
    public ProductsController(IMediator mediator, ILogger<ProductsController> log) { _mediator = mediator; _log = log; }

    [HttpPost]
    public async Task<ActionResult<CreateProductResponse>> Create([FromBody] CreateProductRequest request)
    {
        var cmd = new CreateProductCommand(
            request.Sku,
            new Money(request.Price.Amount, request.Price.Currency)
        );
        var id = await _mediator.Send(cmd);
        _log.LogInformation("{Event} aggregate={Aggregate} id={Id}", "aggregate_created", "Product", id.Value);
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
