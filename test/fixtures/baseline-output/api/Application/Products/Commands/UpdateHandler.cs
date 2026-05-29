// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Products;
using Api.Domain.Common;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Products.Commands;

public sealed class UpdateHandler : ICommandHandler<UpdateCommand, Unit>
{
    private readonly IProductRepository _repo;
    public UpdateHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(UpdateCommand cmd, CancellationToken ct)
    {
        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)
            ?? throw new AggregateNotFoundException($"Product {cmd.Id} not found");
        aggregate.Update(cmd.Sku, cmd.Price);
        await _repo.SaveAsync(aggregate, ct);
        return Unit.Value;
    }
}
