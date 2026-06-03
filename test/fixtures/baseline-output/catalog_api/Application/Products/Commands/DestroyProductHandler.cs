// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using CatalogApi.Domain.Products;
using CatalogApi.Domain.Common;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Commands;

public sealed class DestroyProductHandler : ICommandHandler<DestroyProductCommand, Unit>
{
    private readonly IProductRepository _repo;
    public DestroyProductHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(DestroyProductCommand command, CancellationToken cancellationToken)
    {
        var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)
            ?? throw new AggregateNotFoundException($"Product {command.Id} not found");
        await _repo.DeleteAsync(aggregate, cancellationToken);
        return Unit.Value;
    }
}
