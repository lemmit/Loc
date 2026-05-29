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
