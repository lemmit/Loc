// Auto-generated.
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Api.Domain.Events;

namespace Api.Domain.Common;

public sealed class DomainException : Exception
{
    public DomainException(string message) : base(message) { }
}

/// <summary>State-gate failure — an operation's 'when' predicate (the
/// canCommand gate) evaluated false against the loaded aggregate.
/// DomainExceptionFilter maps this to HTTP 409.</summary>
public sealed class DisallowedException : Exception
{
    public DisallowedException(string message) : base(message) { }
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
    Task DispatchAsync(IDomainEvent ev, CancellationToken cancellationToken = default);
}

/// <summary>
/// Carrier-bounded generic payloads (payload-transport-layer.md, P3b).
/// One generic record per blessed carrier; serializes camelCase to the
/// same wire JSON as the Hono / React backends (items/page/pageSize/
/// total/totalPages, id/ts/body).  Used both domain-side (Paged&lt;Order&gt;
/// off the repository) and wire-side (Paged&lt;OrderResponse&gt; from the
/// controller).
/// </summary>
public sealed record Paged<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total, int TotalPages);

public sealed record Envelope<T>(string Id, DateTime Ts, T Body);

/// <summary>
/// Domain-termed read-scope bypass for a retrieval (the DSL <c>ignoring</c>
/// clause).  <c>All</c> skips every capability scope (<c>ignoring *</c>);
/// <c>Capabilities</c> names the specific capabilities to skip by their DOMAIN
/// names (<c>ignoring &lt;Cap&gt;</c>).  The infrastructure repository adapter
/// translates this to its own query-filter mechanism, so the domain repository
/// PORT stays ORM-neutral — no EF <c>IgnoreQueryFilters</c> vocabulary on the
/// interface (audit S7).
/// </summary>
public readonly record struct FilterBypass(bool All, IReadOnlyList<string> Capabilities)
{
    public static readonly FilterBypass None = new(false, Array.Empty<string>());
    public static FilterBypass BypassAll() => new(true, Array.Empty<string>());
    public static FilterBypass Bypass(params string[] capabilities) => new(false, capabilities);
}
