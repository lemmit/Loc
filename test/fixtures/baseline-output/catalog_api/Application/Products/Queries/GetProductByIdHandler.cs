// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using CatalogApi.Domain.Products;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Application.Products.Responses;

namespace CatalogApi.Application.Products.Queries;

public sealed class GetProductByIdHandler : IQueryHandler<GetProductByIdQuery, ProductResponse?>
{
    private readonly IProductRepository _repo;
    public GetProductByIdHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<ProductResponse?> Handle(GetProductByIdQuery query, CancellationToken cancellationToken)
    {
        var found = await _repo.GetByIdAsync(query.Id, cancellationToken);
        return found is null ? null : new ProductResponse(found.Id.Value, found.Sku, new MoneyResponse(found.Price.Amount, found.Price.Currency), found.Version, found.Display);
    }
}
