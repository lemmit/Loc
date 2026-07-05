// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Orders;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Application.Orders.Responses;

namespace Api.Application.Orders.Queries;

public sealed class AllHandler : IQueryHandler<AllQuery, IReadOnlyList<OrderResponse>>
{
    private readonly IOrderRepository _repo;
    public AllHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<IReadOnlyList<OrderResponse>> Handle(AllQuery query, CancellationToken cancellationToken)
    {
        var domain = await _repo.All(cancellationToken);
        return domain.Select(d => new OrderResponse(d.Id.Value, d.CustomerId, d.Status, System.Text.RegularExpressions.Regex.Replace(d.PlacedAt.ToUniversalTime().ToString("o"), @"\.?0+Z$", "Z"), d.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductId.Value, __e.Quantity)).ToList())).ToList();
    }
}
