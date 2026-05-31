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

public sealed class DestroyProductHandler : ICommandHandler<DestroyProductCommand, Unit>
{
    private readonly IProductRepository _repo;
    public DestroyProductHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(DestroyProductCommand cmd, CancellationToken ct)
    {
        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)
            ?? throw new AggregateNotFoundException($"Product {cmd.Id} not found");
        await _repo.DeleteAsync(aggregate, ct);
        return Unit.Value;
    }
}
