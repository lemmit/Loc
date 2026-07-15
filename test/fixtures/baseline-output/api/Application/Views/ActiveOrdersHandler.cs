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

    public async ValueTask<IReadOnlyList<OrderResponse>> Handle(ActiveOrdersQuery query, CancellationToken cancellationToken)
    {
        var domain = await _repo.ActiveOrders(cancellationToken);
        return domain.Select(d => new OrderResponse(d.Id.Value, d.CustomerId, d.Status, System.Text.RegularExpressions.Regex.Replace(d.PlacedAt.ToUniversalTime().ToString("o"), @"\.?0+Z$", "Z"), d.Version, d.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductId.Value, __e.Quantity)).ToList())).ToList();
    }
}
