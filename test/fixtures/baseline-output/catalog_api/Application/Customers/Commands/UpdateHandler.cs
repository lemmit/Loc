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

public sealed class UpdateHandler : ICommandHandler<UpdateCommand, Unit>
{
    private readonly ICustomerRepository _repo;
    public UpdateHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(UpdateCommand cmd, CancellationToken ct)
    {
        var aggregate = await _repo.GetByIdAsync(cmd.Id, ct)
            ?? throw new AggregateNotFoundException($"Customer {cmd.Id} not found");
        aggregate.Update(cmd.Username, cmd.Email, cmd.Age);
        await _repo.SaveAsync(aggregate, ct);
        return Unit.Value;
    }
}
