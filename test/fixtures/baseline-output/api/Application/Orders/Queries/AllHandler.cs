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
using Api.Domain.Common;

namespace Api.Application.Orders.Queries;

public sealed class AllHandler : IQueryHandler<AllQuery, Paged<OrderResponse>>
{
    private readonly IOrderRepository _repo;
    public AllHandler(IOrderRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Paged<OrderResponse>> Handle(AllQuery query, CancellationToken cancellationToken)
    {
        var domain = await _repo.All(query.Page, query.PageSize, query.Sort, query.Dir, cancellationToken);
        return new Paged<OrderResponse>(domain.Items.Select(d => new OrderResponse(d.Id.Value, d.CustomerId, d.Status, System.Text.RegularExpressions.Regex.Replace(d.PlacedAt.ToUniversalTime().ToString("o"), @"\.?0+Z$", "Z"), d.Version, d.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductId.Value, __e.Quantity)).ToList())).ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);
    }
}
