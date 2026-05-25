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

public sealed class ByEmailHandler : IQueryHandler<ByEmailQuery, CustomerResponse?>
{
    private readonly ICustomerRepository _repo;
    public ByEmailHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<CustomerResponse?> Handle(ByEmailQuery q, CancellationToken ct)
    {
        var domain = await _repo.ByEmail(q.Email, ct);
        return domain is null ? null : new CustomerResponse(domain.Id.Value, domain.Username, domain.Email, domain.Age, domain.Display);
    }
}
