// Auto-generated.
using System;
using System.Linq;
using System.Threading.Tasks;
using System.Globalization;
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
    [ProducesResponseType(typeof(CreateOrderResponse), 201)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    public async Task<ActionResult<CreateOrderResponse>> CreateOrder([FromBody] CreateOrderRequest request)
    {
        var cmd = new CreateOrderCommand(
            request.CustomerId,
            request.Status,
            DateTime.Parse(request.PlacedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal)
        );
        var id = await _mediator.Send(cmd);
        _log.LogInformation("{Event} aggregate={Aggregate} id={Id}", "aggregate_created", "Order", id.Value);
        return CreatedAtAction(nameof(GetOrderById), new { id = id.Value }, new CreateOrderResponse(id.Value));
    }

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(OrderResponse), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<ActionResult<OrderResponse>> GetOrderById([FromRoute] Guid id)
    {
        var response = await _mediator.Send(new GetOrderByIdQuery(new OrderId(id)));
        return response is null ? NotFound() : Ok(response);
    }

    [HttpPost("{id}/add_line")]
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<IActionResult> AddLineOrder([FromRoute] Guid id, [FromBody] AddLineRequest request)
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
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<IActionResult> ConfirmOrder([FromRoute] Guid id, [FromBody] ConfirmRequest request)
    {
        _log.LogInformation("{Event} aggregate={Aggregate} op={Op} id={Id}", "operation_invoked", "Order", "confirm", id);
        var cmd = new ConfirmCommand(
            new OrderId(id)
        );
        await _mediator.Send(cmd);
        return NoContent();
    }

    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<OrderResponse>), 200)]
    public async Task<ActionResult<IReadOnlyList<OrderResponse>>> AllOrder()
    {
        var result = await _mediator.Send(new AllQuery());
        return Ok(result);
    }

    [HttpGet("by_customer")]
    [ProducesResponseType(typeof(IReadOnlyList<OrderResponse>), 200)]
    public async Task<ActionResult<IReadOnlyList<OrderResponse>>> ByCustomerOrder([FromQuery] [Microsoft.AspNetCore.Mvc.ModelBinding.BindRequired] string customerId)
    {
        var result = await _mediator.Send(new ByCustomerQuery(customerId));
        return Ok(result);
    }

}
