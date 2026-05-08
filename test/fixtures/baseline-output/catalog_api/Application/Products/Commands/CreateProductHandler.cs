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

public sealed class CreateProductHandler : ICommandHandler<CreateProductCommand, ProductId>
{
    private readonly IProductRepository _repo;
    public CreateProductHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<ProductId> Handle(CreateProductCommand cmd, CancellationToken ct)
    {
        var aggregate = Product.Create(cmd.Sku, cmd.Price);
        await _repo.SaveAsync(aggregate, ct);
        return aggregate.Id;
    }
}
