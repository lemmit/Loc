// Auto-generated.
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using Api.Application.Workflows;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Api;

[ApiController]
[Route("workflows")]
public sealed class OrdersWorkflowsController : ControllerBase
{
    private readonly IMediator _mediator;
    public OrdersWorkflowsController(IMediator mediator) => _mediator = mediator;

    [HttpPost("place_order")]
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    [ProducesResponseType(typeof(ProblemDetails), 422)]
    public async Task<IActionResult> PlaceOrderWorkflow([FromBody] PlaceOrderRequest request)
    {
        var cmd = new PlaceOrderCommand(
            request.CustomerId,
            new ProductId(request.ProductId),
            request.Quantity);
        await _mediator.Send(cmd);
        return NoContent();
    }

}
