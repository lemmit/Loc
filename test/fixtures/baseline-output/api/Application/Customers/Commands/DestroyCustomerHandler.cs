// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Customers;
using Api.Domain.Common;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Customers.Commands;

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
