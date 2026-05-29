// Auto-generated.
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using Api.Application.Views;
using Api.Application.Orders.Responses;

namespace Api.Api;

[ApiController]
[Route("views")]
public sealed class OrdersViewsController : ControllerBase
{
    private readonly IMediator _mediator;
    public OrdersViewsController(IMediator mediator) => _mediator = mediator;

    [HttpGet("active_orders")]
    public async Task<ActionResult<IReadOnlyList<OrderResponse>>> ActiveOrdersView()
    {
        var result = await _mediator.Send(new ActiveOrdersQuery());
        return Ok(result);
    }

    [HttpGet("order_summary")]
    public async Task<ActionResult<IReadOnlyList<OrderSummaryRow>>> OrderSummaryView()
    {
        var result = await _mediator.Send(new OrderSummaryQuery());
        return Ok(result);
    }

}
