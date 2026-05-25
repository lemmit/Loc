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

public sealed class GetCustomerByIdHandler : IQueryHandler<GetCustomerByIdQuery, CustomerResponse?>
{
    private readonly ICustomerRepository _repo;
    public GetCustomerByIdHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<CustomerResponse?> Handle(GetCustomerByIdQuery q, CancellationToken ct)
    {
        var found = await _repo.GetByIdAsync(q.Id, ct);
        return found is null ? null : new CustomerResponse(found.Id.Value, found.Username, found.Email, found.Age, found.Display);
    }
}
