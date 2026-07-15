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

namespace Api.Application.Customers.Queries;

public sealed class ByEmailHandler : IQueryHandler<ByEmailQuery, CustomerResponse?>
{
    private readonly ICustomerRepository _repo;
    public ByEmailHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<CustomerResponse?> Handle(ByEmailQuery query, CancellationToken cancellationToken)
    {
        var domain = await _repo.ByEmail(query.Email, cancellationToken);
        return domain is null ? null : new CustomerResponse(domain.Id.Value, domain.Username, domain.Email, domain.Age, domain.Version, domain.Display);
    }
}
