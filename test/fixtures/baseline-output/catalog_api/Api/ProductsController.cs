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
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    public async Task<ActionResult<CreateProductResponse>> CreateProduct([FromBody] CreateProductRequest request)
    {
        var cmd = new CreateProductCommand(
            request.Sku,
            new Money(request.Price.Amount, request.Price.Currency)
        );
        var id = await _mediator.Send(cmd);
        _log.LogInformation("{Event} aggregate={Aggregate} id={Id}", "aggregate_created", "Product", id.Value);
        return CreatedAtAction(nameof(GetProductById), new { id = id.Value }, new CreateProductResponse(id.Value));
    }

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<ActionResult<ProductResponse>> GetProductById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetProductByIdQuery(new ProductId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<ProductResponse>>> AllProduct()
    {
        var result = await _mediator.Send(new AllQuery());
        return Ok(result);
    }

    [HttpGet("by_sku")]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<ActionResult<ProductResponse?>> BySkuProduct([FromQuery] string sku)
    {
        var result = await _mediator.Send(new BySkuQuery(sku));
        return result is null ? NotFound() : Ok(result);
    }

}
