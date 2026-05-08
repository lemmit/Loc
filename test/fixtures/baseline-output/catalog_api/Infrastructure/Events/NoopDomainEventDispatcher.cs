// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using CatalogApi.Domain.Common;
using CatalogApi.Domain.Events;

namespace CatalogApi.Infrastructure.Events;

/// <summary>Default implementation that drops domain events.</summary>
public sealed class NoopDomainEventDispatcher : IDomainEventDispatcher
{
    public Task DispatchAsync(IDomainEvent ev, CancellationToken ct = default)
        => Task.CompletedTask;
}
