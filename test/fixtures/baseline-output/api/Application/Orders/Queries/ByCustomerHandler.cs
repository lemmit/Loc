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

public sealed class ByCustomerHandler : IQueryHandler<ByCustomerQuery, System.Collections.Generic.IReadOnlyList<OrderResponse>>
{
    private readonly IOrderRepository _repo;
    public ByCustomerHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<System.Collections.Generic.IReadOnlyList<OrderResponse>> Handle(ByCustomerQuery q, CancellationToken ct)
    {
        var domain = await _repo.ByCustomer(q.CustomerId, ct);
        return domain.Select(d => new OrderResponse(d.Id.Value, d.CustomerId, d.Status.ToString(), d.PlacedAt.ToUniversalTime().ToString("o"), d.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductId.Value, __e.Quantity)).ToList())).ToList();
    }
}
