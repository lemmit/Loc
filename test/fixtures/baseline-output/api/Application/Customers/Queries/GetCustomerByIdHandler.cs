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

public sealed class GetCustomerByIdHandler : IQueryHandler<GetCustomerByIdQuery, CustomerResponse?>
{
    private readonly ICustomerRepository _repo;
    public GetCustomerByIdHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<CustomerResponse?> Handle(GetCustomerByIdQuery query, CancellationToken cancellationToken)
    {
        var found = await _repo.GetByIdAsync(query.Id, cancellationToken);
        return found is null ? null : new CustomerResponse(found.Id.Value, found.Username, found.Email, found.Age, found.Version, found.Display);
    }
}
