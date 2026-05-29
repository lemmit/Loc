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
    [ProducesResponseType(typeof(CreateProductResponse), 201)]
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
    [ProducesResponseType(typeof(ProductResponse), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<ActionResult<ProductResponse>> GetProductById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetProductByIdQuery(new ProductId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    [ProducesResponseType(typeof(ProblemDetails), 409)]
    public async Task<IActionResult> DestroyProduct([FromRoute] Guid id)
    {
        try
        {
            await _mediator.Send(new DestroyProductCommand(new ProductId(id)));
        }
        catch (Microsoft.EntityFrameworkCore.DbUpdateException)
        {
            return Conflict(new ProblemDetails { Title = "Conflict", Status = 409, Detail = "Product is still referenced and cannot be deleted." });
        }
        return NoContent();
    }

    [HttpPost("{id}/update")]
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<IActionResult> UpdateProduct([FromRoute] Guid id, [FromBody] UpdateRequest request)
    {
        _log.LogInformation("{Event} aggregate={Aggregate} op={Op} id={Id}", "operation_invoked", "Product", "update", id);
        var cmd = new UpdateCommand(
            new ProductId(id),
            request.Sku,
            new Money(request.Price.Amount, request.Price.Currency)
        );
        await _mediator.Send(cmd);
        return NoContent();
    }

    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<ProductResponse>), 200)]
    public async Task<ActionResult<IReadOnlyList<ProductResponse>>> AllProduct()
    {
        var result = await _mediator.Send(new AllQuery());
        return Ok(result);
    }

    [HttpGet("by_sku")]
    [ProducesResponseType(typeof(ProductResponse), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<ActionResult<ProductResponse?>> BySkuProduct([FromQuery] [Microsoft.AspNetCore.Mvc.ModelBinding.BindRequired] string sku)
    {
        var result = await _mediator.Send(new BySkuQuery(sku));
        return result is null ? NotFound() : Ok(result);
    }

}
