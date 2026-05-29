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

namespace Api.Application.Views;

public sealed class ActiveOrdersHandler : IQueryHandler<ActiveOrdersQuery, IReadOnlyList<OrderResponse>>
{
    private readonly IOrderRepository _repo;
    public ActiveOrdersHandler(IOrderRepository repo) => _repo = repo;

    public async ValueTask<IReadOnlyList<OrderResponse>> Handle(ActiveOrdersQuery q, CancellationToken ct)
    {
        var domain = await _repo.ActiveOrders(ct);
        return domain.Select(d => new OrderResponse(d.Id.Value, d.CustomerId, d.Status, d.PlacedAt.ToUniversalTime().ToString("o"), d.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductId.Value, __e.Quantity)).ToList())).ToList();
    }
}
