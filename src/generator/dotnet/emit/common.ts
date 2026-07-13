// ---------------------------------------------------------------------------
// Common types shared across the .NET emission: domain exception base
// classes + the IDomainEventDispatcher boundary.  Trivial substitution
// templates — pure string concatenation.
// ---------------------------------------------------------------------------

export function renderCommon(ns: string): string {
  return `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Data;
using System.Linq.Expressions;
using System.Threading;
using System.Threading.Tasks;
using ${ns}.Domain.Events;

namespace ${ns}.Domain.Common;

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
/// implementation, so the <see cref="DomainExceptionFilter"/> can emit a
/// 500 envelope that names the offending handler instead of the bare
/// <c>{ "error": "internal" }</c> operators see otherwise.  (Since extern
/// (b) Phase 2, an extern aggregate OPERATION is an ordinary domain method
/// — a hand-written exception from its hook bubbles as a generic 500, the
/// same as any other op body.  This wrap + filter arm is retained for the
/// application-layer extern handler surface.)  Domain-layer exceptions
/// (DomainException, ForbiddenException, AggregateNotFoundException) are
/// NOT wrapped — they bubble through to their usual status codes.
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
/// Marker for user-supplied extern application-layer handlers (the
/// <c>extern commandHandler</c> / <c>queryHandler</c> case-2 home).  The
/// Scrutor scan in <see cref="Program"/> picks up every class decorated with
/// this attribute and registers it under its implemented <c>I&lt;Name&gt;Handler</c>
/// port.  See <c>Application/Handlers/I&lt;Name&gt;Handler.cs</c> for the ports
/// the user must implement.  (Extern aggregate OPERATIONS use a domain
/// partial-method hook instead — no attribute, no scan; see
/// <c>Domain/&lt;Plural&gt;/&lt;Agg&gt;.Extern.cs</c>.)
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

/// <summary>
/// The commit boundary (audit S7 Slice C).  Orchestration handlers depend on
/// this instead of the concrete EF <c>AppDbContext</c>; the infrastructure
/// adapter opens the transaction on the SAME scoped DbContext the repositories
/// use, so a repository <c>SaveAsync</c> inside the transaction still commits
/// atomically — byte-identical semantics to the pre-port
/// <c>_db.Database.BeginTransactionAsync(...)</c>.
/// </summary>
public interface IUnitOfWork
{
    Task<IDomainTransaction> BeginTransactionAsync(CancellationToken cancellationToken = default);
    Task<IDomainTransaction> BeginTransactionAsync(IsolationLevel isolationLevel, CancellationToken cancellationToken = default);
}

/// <summary>A domain-owned transaction handle — commit / rollback / dispose.</summary>
public interface IDomainTransaction : IAsyncDisposable
{
    Task CommitAsync(CancellationToken cancellationToken = default);
    Task RollbackAsync(CancellationToken cancellationToken = default);
}

/// <summary>The shape a workflow event-stream record exposes to the event-store
/// port — the per-context log discriminator + stream key + gap-free version
/// (audit S7 Slice C; per-context log — event-log-architecture.md).</summary>
public interface IWorkflowEventRow
{
    string StreamType { get; }
    string StreamId { get; }
    int Version { get; }
}

/// <summary>
/// Append-only event-stream port for an event-sourced workflow (audit S7 Slice
/// C).  The workflow's stream lives in the shared per-context <c>&lt;ctx&gt;_events</c>
/// log (event-log-architecture.md), so every load / max-version scopes to the
/// caller's <c>streamType</c> discriminator — the correctness trap: streams
/// sharing one table must each fold only their own events.  The EF adapter
/// delegates 1:1 to the same scoped DbContext.
/// </summary>
public interface IWorkflowEventStore<TRow> where TRow : class, IWorkflowEventRow
{
    Task<List<TRow>> LoadStreamAsync(string streamType, string streamId, CancellationToken cancellationToken = default);
    Task<int> MaxVersionAsync(string streamType, string streamId, CancellationToken cancellationToken = default);
    void Append(TRow row);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Saga-state row port (audit S7 Slice C).  <c>FindAsync</c> returns the EF
/// change-TRACKED entity off the same scoped DbContext, so a subsequent
/// <c>state.Prop = …; SaveChangesAsync()</c> persists exactly as before.
/// </summary>
public interface ISagaStateStore<TRow> where TRow : class
{
    Task<TRow?> FindAsync(Expression<Func<TRow, bool>> predicate, CancellationToken cancellationToken = default);
    void Add(TRow row);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Projection read-model row port (audit S7 Slice C).  Same TRACKED-load +
/// upsert + flush contract as <see cref="ISagaStateStore{TRow}"/>, named for the
/// projection fold's read model.
/// </summary>
public interface IReadModelStore<TRow> where TRow : class
{
    Task<TRow?> FindAsync(Expression<Func<TRow, bool>> predicate, CancellationToken cancellationToken = default);
    void Add(TRow row);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
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
    public Task DispatchAsync(IDomainEvent ev, CancellationToken cancellationToken = default)
        => Task.CompletedTask;
}
`;
}

/** The in-process dispatcher: publishes each domain event as a Mediator
 *  notification, so every `INotificationHandler<TEvent>` (workflow reactor /
 *  event-triggered starter) for it runs.  Uses the non-generic `Publish(object)`
 *  so dispatch is by the event's RUNTIME type (the concrete event), not the
 *  `IDomainEvent` interface.  Registered (replacing the no-op) when the
 *  deployable has channel-routed subscriptions. */
export function renderInProcessDispatcher(ns: string): string {
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;

namespace ${ns}.Infrastructure.Events;

/// <summary>Publishes domain events as Mediator notifications to their
/// reactor / starter handlers.</summary>
public sealed class InProcessDomainEventDispatcher : IDomainEventDispatcher
{
    private readonly IMediator _mediator;

    public InProcessDomainEventDispatcher(IMediator mediator) => _mediator = mediator;

    public Task DispatchAsync(IDomainEvent ev, CancellationToken cancellationToken = default)
        => _mediator.Publish((object)ev, cancellationToken).AsTask();
}
`;
}
