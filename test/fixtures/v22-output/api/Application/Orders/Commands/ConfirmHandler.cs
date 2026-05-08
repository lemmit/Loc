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

public sealed class ConfirmHandler : ICommandHandler<ConfirmCommand, Unit>
{
    private readonly IOrderRepository _repo;
    public ConfirmHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(ConfirmCommand cmd, CancellationToken ct)
    {
        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)
            ?? throw new AggregateNotFoundException($"Order {cmd.Id} not found");
        aggregate.Confirm();
        await _repo.SaveAsync(aggregate, ct);
        return Unit.Value;
    }
}
