// ---------------------------------------------------------------------------
// Common types shared across the .NET emission: domain exception base
// classes + the IDomainEventDispatcher boundary.  Trivial substitution
// templates — pure string concatenation.
// ---------------------------------------------------------------------------

export function renderCommon(ns: string): string {
  return `// Auto-generated.
using System;
using System.Threading;
using System.Threading.Tasks;
using ${ns}.Domain.Events;

namespace ${ns}.Domain.Common;

public sealed class DomainException : System.Exception
{
    public DomainException(string message) : base(message) { }
}

public sealed class AggregateNotFoundException : System.Exception
{
    public AggregateNotFoundException(string message) : base(message) { }
}

/// <summary>
/// Marker for user-supplied extern operation handlers.  The Scrutor
/// scan in <see cref="Program"/> picks up every class decorated with
/// this attribute and registers it under its implemented IXAggHandler
/// interface.  See <c>Application/&lt;Aggregate&gt;/Handlers/IXAggHandler.cs</c>
/// for the per-operation interfaces the user must implement.
/// </summary>
[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class ExternHandlerAttribute : Attribute
{
}

/// <summary>
/// Domain-event dispatch boundary.  Replace the no-op default registration
/// in <see cref="Program"/> with an outbox-table writer or message-bus
/// publisher to wire events into your infrastructure.
/// </summary>
public interface IDomainEventDispatcher
{
    Task DispatchAsync(IDomainEvent ev, CancellationToken ct = default);
}
`;
}

export function renderNoopDispatcher(ns: string): string {
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;

namespace ${ns}.Infrastructure.Events;

/// <summary>Default implementation that drops domain events.</summary>
public sealed class NoopDomainEventDispatcher : IDomainEventDispatcher
{
    public Task DispatchAsync(IDomainEvent ev, CancellationToken ct = default)
        => Task.CompletedTask;
}
`;
}
