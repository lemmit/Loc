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

public sealed class BySkuHandler : IQueryHandler<BySkuQuery, ProductResponse?>
{
    private readonly IProductRepository _repo;
    public BySkuHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<ProductResponse?> Handle(BySkuQuery query, CancellationToken cancellationToken)
    {
        var domain = await _repo.BySku(query.Sku, cancellationToken);
        return domain is null ? null : new ProductResponse(domain.Id.Value, domain.Sku, new MoneyResponse(domain.Price.Amount, domain.Price.Currency), domain.Version, domain.Display);
    }
}
