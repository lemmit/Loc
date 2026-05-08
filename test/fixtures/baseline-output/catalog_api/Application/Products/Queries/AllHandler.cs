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

public sealed class AllHandler : IQueryHandler<AllQuery, System.Collections.Generic.IReadOnlyList<ProductResponse>>
{
    private readonly IProductRepository _repo;
    public AllHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<System.Collections.Generic.IReadOnlyList<ProductResponse>> Handle(AllQuery q, CancellationToken ct)
    {
        var domain = await _repo.All(ct);
        return domain.Select(d => new ProductResponse(d.Id.Value, d.Sku, new MoneyResponse(d.Price.Amount, d.Price.Currency))).ToList();
    }
}
