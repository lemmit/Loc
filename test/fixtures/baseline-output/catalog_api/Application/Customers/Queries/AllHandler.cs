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

namespace CatalogApi.Application.Customers.Queries;

public sealed class AllHandler : IQueryHandler<AllQuery, IReadOnlyList<CustomerResponse>>
{
    private readonly ICustomerRepository _repo;
    public AllHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<IReadOnlyList<CustomerResponse>> Handle(AllQuery q, CancellationToken ct)
    {
        var domain = await _repo.All(ct);
        return domain.Select(d => new CustomerResponse(d.Id.Value, d.Username, d.Email, d.Age, d.Display)).ToList();
    }
}
