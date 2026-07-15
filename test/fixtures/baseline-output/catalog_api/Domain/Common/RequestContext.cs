// Auto-generated.
using System;
using System.Threading;

namespace CatalogApi.Domain.Common;

/// <summary>
/// The ambient execution context for a single request/flow — the one
/// carrier every governance slice (correlation, principal, locale,
/// request logger) reads from.  Carried on a dedicated
/// <see cref="AsyncLocal{T}"/>: NOT Activity.Current (tracing is
/// sampled, so it is null on unsampled requests — governance state must
/// never be sampleable) and NOT ThreadLocal (lost across await).
/// Established at the request boundary by RequestContextMiddleware.
/// </summary>
public sealed class RequestContext
{
    private static readonly AsyncLocal<RequestContext?> _current = new();

    /// <summary>The context for the in-flight request, or null outside any flow.</summary>
    public static RequestContext? Current
    {
        get => _current.Value;
        set => _current.Value = value;
    }

    // ---- Request-stable tier — born once at the boundary, constant for the flow.
    public string CorrelationId { get; init; } = string.Empty;
    public string Locale { get; init; } = "en";
    public DateTimeOffset StartedAt { get; init; }

    /// <summary>The client's optimistic-concurrency expected version, parsed
    /// from the request's <c>If-Match</c> header (null when absent).  A
    /// <c>versioned</c> aggregate's repository save sets EF's original value of
    /// the version token to this before flushing, so a stale precondition
    /// yields a zero-row UPDATE (DbUpdateConcurrencyException → 409).</summary>
    public int? ExpectedVersion { get; set; }

    // ---- Frame-local tier — a fresh ScopeId per frame.  The root frame
    // (opened at the boundary) has no parent; each Mediator dispatch opens a
    // child whose ParentId chains to its caller, forming the causality chain.
    public string ScopeId { get; init; } = string.Empty;
    public string? ParentId { get; init; }

    /// <summary>No principal slice on this carrier (no auth), so there is no
    /// actor to serialize.</summary>
    public string? PrincipalJson() => null;

    /// <summary>No principal slice on this carrier (no auth), so there is no
    /// actor id.</summary>
    public string? ActorId => null;

    /// <summary>Open the root frame for a flow: a fresh scope with no parent.
    /// The principal and logger slices are attached later by the boundary
    /// middleware / pipeline behaviour.</summary>
    public static RequestContext OpenRoot(string correlationId, string locale, DateTimeOffset startedAt)
        => new()
        {
            CorrelationId = correlationId,
            Locale = locale,
            StartedAt = startedAt,
            ScopeId = Guid.NewGuid().ToString(),
            ParentId = null,
        };

    /// <summary>Open a child frame under <paramref name="parent"/>: a fresh
    /// scope whose <see cref="ParentId"/> chains to the parent's
    /// <see cref="ScopeId"/>, inheriting the request-stable tier (correlation
    /// id, principal, locale, start time).  The logger slice is dispatch-local
    /// and bound by the pipeline behaviour, so it is not inherited here.</summary>
    public static RequestContext OpenChild(RequestContext parent)
        => new()
        {
            CorrelationId = parent.CorrelationId,
            Locale = parent.Locale,
            StartedAt = parent.StartedAt,
            ExpectedVersion = parent.ExpectedVersion,
            ScopeId = Guid.NewGuid().ToString(),
            ParentId = parent.ScopeId,
        };

    /// <summary>Make <paramref name="frame"/> current until the returned handle
    /// is disposed, restoring the previous frame on dispose — so reentrant
    /// flows (a dispatch inside a dispatch) stack cleanly.</summary>
    public static IDisposable Enter(RequestContext frame)
    {
        var prev = _current.Value;
        _current.Value = frame;
        return new Scope(prev);
    }

    private sealed class Scope : IDisposable
    {
        private readonly RequestContext? _prev;
        public Scope(RequestContext? prev) => _prev = prev;
        public void Dispose() => _current.Value = _prev;
    }
}
