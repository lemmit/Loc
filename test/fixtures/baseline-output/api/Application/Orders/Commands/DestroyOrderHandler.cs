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

public sealed class DestroyOrderHandler : ICommandHandler<DestroyOrderCommand, Unit>
{
    private readonly IOrderRepository _repo;
    public DestroyOrderHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(DestroyOrderCommand cmd, CancellationToken ct)
    {
        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)
            ?? throw new AggregateNotFoundException($"Order {cmd.Id} not found");
        await _repo.DeleteAsync(aggregate, ct);
        return Unit.Value;
    }
}
