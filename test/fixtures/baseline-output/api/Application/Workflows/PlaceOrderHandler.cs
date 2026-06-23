// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Mediator;
using Api.Domain.Common;
using Api.Domain.Events;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Domain.Orders;

namespace Api.Application.Workflows;

public sealed class PlaceOrderHandler : ICommandHandler<PlaceOrderCommand, Unit>
{
    private readonly IOrderRepository _orders;
    private readonly ILogger<PlaceOrderHandler> _log;
    public PlaceOrderHandler(IOrderRepository orders, ILogger<PlaceOrderHandler> log)
    {
        _orders = orders; _log = log;
    }

    public async ValueTask<Unit> Handle(PlaceOrderCommand command, CancellationToken cancellationToken)
    {
        _log.LogInformation("{Event} workflow={Workflow}", "workflow_started", "placeOrder");
        if (!(command.Quantity > 0)) throw new DomainException("Precondition failed: quantity > 0");
        var order = Order.Create(customerId: command.CustomerId, status: OrderStatus.Draft, placedAt: DateTime.UtcNow);
        order.AddLine(command.ProductId, command.Quantity);
        await _orders.SaveAsync(order, cancellationToken);
        _log.LogInformation("{Event} workflow={Workflow}", "workflow_completed", "placeOrder");
        return Unit.Value;
    }
}
