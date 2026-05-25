// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Products;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Application.Products.Responses;

namespace Api.Application.Products.Queries;

public sealed class AllHandler : IQueryHandler<AllQuery, IReadOnlyList<ProductResponse>>
{
    private readonly IProductRepository _repo;
    public AllHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<IReadOnlyList<ProductResponse>> Handle(AllQuery q, CancellationToken ct)
    {
        var domain = await _repo.All(ct);
        return domain.Select(d => new ProductResponse(d.Id.Value, d.Sku, new MoneyResponse(d.Price.Amount, d.Price.Currency), d.Display)).ToList();
    }
}
