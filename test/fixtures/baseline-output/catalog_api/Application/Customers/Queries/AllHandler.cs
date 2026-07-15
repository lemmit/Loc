// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using CatalogApi.Domain.Customers;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Application.Customers.Responses;
using CatalogApi.Domain.Common;

namespace CatalogApi.Application.Customers.Queries;

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
        return new Paged<CustomerResponse>(domain.Items.Select(d => new CustomerResponse(d.Id.Value, d.Username, d.Email, d.Age, d.Display)).ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);
    }
}
