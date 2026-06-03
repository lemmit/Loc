// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Orders;
using Api.Domain.Common;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Orders.Commands;

public sealed class CreateOrderHandler : ICommandHandler<CreateOrderCommand, OrderId>
{
    private readonly IOrderRepository _repo;
    public CreateOrderHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<OrderId> Handle(CreateOrderCommand command, CancellationToken cancellationToken)
    {
        var aggregate = Order.Create(command.CustomerId, command.Status, command.PlacedAt);
        await _repo.SaveAsync(aggregate, cancellationToken);
        return aggregate.Id;
    }
}
