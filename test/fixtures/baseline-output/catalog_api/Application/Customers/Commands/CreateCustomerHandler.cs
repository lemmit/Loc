// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using CatalogApi.Domain.Customers;
using CatalogApi.Domain.Common;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Customers.Commands;

public sealed class CreateCustomerHandler : ICommandHandler<CreateCustomerCommand, CustomerId>
{
    private readonly ICustomerRepository _repo;
    public CreateCustomerHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<CustomerId> Handle(CreateCustomerCommand cmd, CancellationToken ct)
    {
        var aggregate = Customer.Create(cmd.Username, cmd.Email, cmd.Age);
        await _repo.SaveAsync(aggregate, ct);
        return aggregate.Id;
    }
}
