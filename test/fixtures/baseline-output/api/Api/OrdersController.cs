// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using Mediator;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Api.Application.Orders.Commands;
using Api.Application.Orders.Queries;
using Api.Application.Orders.Requests;
using Api.Application.Orders.Responses;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Api;

[ApiController]
[Route("orders")]
public sealed class OrdersController : ControllerBase
{
    private readonly IMediator _mediator;
    private readonly ILogger<OrdersController> _log;
    public OrdersController(IMediator mediator, ILogger<OrdersController> log) { _mediator = mediator; _log = log; }

    [HttpPost]
    public async Task<ActionResult<CreateOrderResponse>> Create([FromBody] CreateOrderRequest request)
    {
        var cmd = new CreateOrderCommand(
            request.CustomerId,
            System.Enum.Parse<OrderStatus>(request.Status),
            System.DateTime.Parse(request.PlacedAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal)
        );
        var id = await _mediator.Send(cmd);
        _log.LogInformation("{Event} aggregate={Aggregate} id={Id}", "aggregate_created", "Order", id.Value);
        return CreatedAtAction(nameof(GetById), new { id = id.Value }, new CreateOrderResponse(id.Value));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<OrderResponse>> GetById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetOrderByIdQuery(new OrderId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpPost("{id}/add_line")]
    public async Task<IActionResult> AddLine([FromRoute] Guid id, [FromBody] AddLineRequest request)
    {
        _log.LogInformation("{Event} aggregate={Aggregate} op={Op} id={Id}", "operation_invoked", "Order", "addLine", id);
        var cmd = new AddLineCommand(
            new OrderId(id),
            new ProductId(request.ProductId),
            request.Qty
        );
        await _mediator.Send(cmd);
        return NoContent();
    }

    [HttpPost("{id}/confirm")]
    public async Task<IActionResult> Confirm([FromRoute] Guid id, [FromBody] ConfirmRequest request)
    {
        _log.LogInformation("{Event} aggregate={Aggregate} op={Op} id={Id}", "operation_invoked", "Order", "confirm", id);
        var cmd = new ConfirmCommand(
            new OrderId(id)
        );
        await _mediator.Send(cmd);
        return NoContent();
    }

    [HttpGet]
    public async Task<ActionResult<System.Collections.Generic.IReadOnlyList<OrderResponse>>> All()
    {
        var result = await _mediator.Send(new AllQuery());
        return Ok(result);
    }

    [HttpGet("by_customer")]
    public async Task<ActionResult<System.Collections.Generic.IReadOnlyList<OrderResponse>>> ByCustomer([FromQuery] string customerId)
    {
        var result = await _mediator.Send(new ByCustomerQuery(customerId));
        return Ok(result);
    }

}
