// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Api.Domain.Common;
using Api.Domain.Events;

namespace Api.Infrastructure.Events;

/// <summary>Default implementation that drops domain events.</summary>
public sealed class NoopDomainEventDispatcher : IDomainEventDispatcher
{
    public Task DispatchAsync(IDomainEvent ev, CancellationToken ct = default)
        => Task.CompletedTask;
}
