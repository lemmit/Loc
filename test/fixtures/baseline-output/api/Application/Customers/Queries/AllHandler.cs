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

public sealed class AllHandler : IQueryHandler<AllQuery, System.Collections.Generic.IReadOnlyList<CustomerResponse>>
{
    private readonly ICustomerRepository _repo;
    public AllHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<System.Collections.Generic.IReadOnlyList<CustomerResponse>> Handle(AllQuery q, CancellationToken ct)
    {
        var domain = await _repo.All(ct);
        return domain.Select(d => new CustomerResponse(d.Id.Value, d.Username, d.Email, d.Age)).ToList();
    }
}
