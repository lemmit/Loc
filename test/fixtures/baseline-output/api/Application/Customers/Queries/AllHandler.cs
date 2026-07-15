// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Customers;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Application.Customers.Responses;
using Api.Domain.Common;

namespace Api.Application.Customers.Queries;

public sealed class AllHandler : IQueryHandler<AllQuery, Paged<CustomerResponse>>
{
    private readonly ICustomerRepository _repo;
    public AllHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Paged<CustomerResponse>> Handle(AllQuery query, CancellationToken cancellationToken)
    {
        var domain = await _repo.All(query.Page, query.PageSize, query.Sort, query.Dir, cancellationToken);
        return new Paged<CustomerResponse>(domain.Items.Select(d => new CustomerResponse(d.Id.Value, d.Username, d.Email, d.Age, d.Version, d.Display)).ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);
    }
}
