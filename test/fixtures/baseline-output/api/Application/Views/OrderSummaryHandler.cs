// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Orders;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Views;

public sealed class OrderSummaryHandler : IQueryHandler<OrderSummaryQuery, IReadOnlyList<OrderSummaryRow>>
{
    private readonly IOrderRepository _repo;
    public OrderSummaryHandler(IOrderRepository repo) => _repo = repo;

    public async ValueTask<IReadOnlyList<OrderSummaryRow>> Handle(OrderSummaryQuery q, CancellationToken ct)
    {
        var domain = await _repo.OrderSummary(ct);
        return domain.Select(d => new OrderSummaryRow(d.Id.Value, d.Status.ToString(), d.Lines.Count)).ToList();
    }
}
