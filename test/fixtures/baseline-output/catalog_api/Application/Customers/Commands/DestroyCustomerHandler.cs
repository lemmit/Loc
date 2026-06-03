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

public sealed class DestroyCustomerHandler : ICommandHandler<DestroyCustomerCommand, Unit>
{
    private readonly ICustomerRepository _repo;
    public DestroyCustomerHandler(ICustomerRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<Unit> Handle(DestroyCustomerCommand command, CancellationToken cancellationToken)
    {
        var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)
            ?? throw new AggregateNotFoundException($"Customer {command.Id} not found");
        await _repo.DeleteAsync(aggregate, cancellationToken);
        return Unit.Value;
    }
}
