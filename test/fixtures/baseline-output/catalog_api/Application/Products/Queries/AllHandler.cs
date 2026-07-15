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
using CatalogApi.Domain.Common;

namespace CatalogApi.Application.Products.Queries;

public sealed class AllHandler : IQueryHandler<AllQuery, Paged<ProductResponse>>
{
    private readonly IProductRepository _repo;
    public AllHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Paged<ProductResponse>> Handle(AllQuery query, CancellationToken cancellationToken)
    {
        var domain = await _repo.All(query.Page, query.PageSize, query.Sort, query.Dir, cancellationToken);
        return new Paged<ProductResponse>(domain.Items.Select(d => new ProductResponse(d.Id.Value, d.Sku, new MoneyResponse(d.Price.Amount, d.Price.Currency), d.Version, d.Display)).ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);
    }
}
