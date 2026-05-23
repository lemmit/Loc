// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
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
    public PlaceOrderHandler(IOrderRepository orders)
    {
        _orders = orders;
    }

    public async ValueTask<Unit> Handle(PlaceOrderCommand cmd, CancellationToken ct)
    {
        if (!(cmd.Quantity > 0)) throw new DomainException("Precondition failed: quantity > 0");
        var order = Order.Create(customerId: cmd.CustomerId, status: OrderStatus.Draft, placedAt: DateTime.UtcNow);
        order.AddLine(cmd.ProductId, cmd.Quantity);
        await _orders.SaveAsync(order, ct);
        return Unit.Value;
    }
}
