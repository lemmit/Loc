// Auto-generated.
using System;
using System.Threading;
using System.Threading.Tasks;
using Api.Domain.Events;

namespace Api.Domain.Common;

public sealed class DomainException : Exception
{
    public DomainException(string message) : base(message) { }
}

public sealed class AggregateNotFoundException : Exception
{
    public AggregateNotFoundException(string message) : base(message) { }
}

/// <summary>
/// Authorization failure — raised by <c>requires</c> expressions in
/// operation / workflow bodies when the resolved currentUser
/// doesn't satisfy the gate.  The DomainExceptionFilter maps this
/// to HTTP 403 (Forbidden), distinct from DomainException's 400
/// (Bad Request).
/// </summary>
public sealed class ForbiddenException : Exception
{
    public ForbiddenException(string message) : base(message) { }
}

/// <summary>
/// Wraps an exception thrown by a user-supplied <c>[ExternHandler]</c>
/// implementation.  The auto-generated extern command handler catches
/// any non-domain exception coming out of <c>HandleAsync</c> and
/// rethrows as this type so the <see cref="DomainExceptionFilter"/> can
/// emit a 500 envelope that names the offending op + aggregate
/// instead of the bare <c>{ "error": "internal" }</c> operators see
/// otherwise.  Domain-layer exceptions (DomainException,
/// ForbiddenException, AggregateNotFoundException) raised by the
/// user handler are NOT wrapped — they bubble through and the
/// filter maps them to their usual status codes.
/// </summary>
public sealed class ExternHandlerException : Exception
{
    public string OpName { get; }
    public string AggName { get; }
    public ExternHandlerException(string opName, string aggName, Exception inner)
        : base($"Extern handler '{opName}' on '{aggName}' threw: {inner.Message}", inner)
    {
        OpName = opName;
        AggName = aggName;
    }
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
