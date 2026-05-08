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

public sealed class AddLineHandler : ICommandHandler<AddLineCommand, Unit>
{
    private readonly IOrderRepository _repo;
    public AddLineHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(AddLineCommand cmd, CancellationToken ct)
    {
        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)
            ?? throw new AggregateNotFoundException($"Order {cmd.Id} not found");
        aggregate.AddLine(cmd.ProductId, cmd.Qty);
        await _repo.SaveAsync(aggregate, ct);
        return Unit.Value;
    }
}
