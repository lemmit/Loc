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

    public async ValueTask<IReadOnlyList<OrderResponse>> Handle(AllQuery q, CancellationToken ct)
    {
        var domain = await _repo.All(ct);
        return domain.Select(d => new OrderResponse(d.Id.Value, d.CustomerId, d.Status.ToString(), d.PlacedAt.ToUniversalTime().ToString("o"), d.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductId.Value, __e.Quantity)).ToList())).ToList();
    }
}
