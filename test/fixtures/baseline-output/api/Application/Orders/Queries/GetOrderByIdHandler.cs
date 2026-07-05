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

public sealed class GetOrderByIdHandler : IQueryHandler<GetOrderByIdQuery, OrderResponse?>
{
    private readonly IOrderRepository _repo;
    public GetOrderByIdHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<OrderResponse?> Handle(GetOrderByIdQuery query, CancellationToken cancellationToken)
    {
        var found = await _repo.GetByIdAsync(query.Id, cancellationToken);
        return found is null ? null : new OrderResponse(found.Id.Value, found.CustomerId, found.Status, System.Text.RegularExpressions.Regex.Replace(found.PlacedAt.ToUniversalTime().ToString("o"), @"\.?0+Z$", "Z"), found.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductId.Value, __e.Quantity)).ToList());
    }
}
