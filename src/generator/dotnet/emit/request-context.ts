// The ambient execution context for a single request/flow — the one
// AsyncLocal carrier every governance slice reads from (correlation id,
// request principal, locale, request logger).  Established at the HTTP
// edge by RequestContextMiddleware and folded into by UserMiddleware
// (principal) and ExecutionContextBehavior (logger).  See
// docs/architecture/request-context.md.
//
// Always emitted: the always-on request log carries `scope_id` from the root
// frame this carrier opens (the cross-backend observability envelope).  The
// optional slices are layered per project — the `CurrentUser` field (+ `Auth`
// using) only under `auth: required`, the `Logger` field (+ Logging using)
// only under `--trace`; a no-auth, no-trace project emits the bare carrier
// (correlation id, locale, scope id) with `ActorId`/`PrincipalJson` as nulls.

/**
 * Render `Domain/Common/RequestContext.cs`.  The shape is minimised to
 * the slices the project actually carries: the `CurrentUser` field (and
 * its `Auth` using) only when auth is present; the `Logger` field (and
 * its Logging using) only under `--trace`.
 */
export function renderRequestContext(
  ns: string,
  opts: { hasAuth: boolean; hasLogger: boolean; actorIdProp?: string; hasVersioned?: boolean },
): string {
  const { hasAuth, hasLogger, actorIdProp } = opts;
  const hasVersioned = !!opts.hasVersioned;
  const loggingUsing = hasLogger ? "using Microsoft.Extensions.Logging;\n" : "";
  const authUsing = hasAuth ? `using ${ns}.Auth;\n` : "";
  // The principal is request-stable, so a child frame inherits it from its
  // parent (the accessor still resolves `currentUser` once dispatch opens a
  // child).  Only present when auth carries a CurrentUser slice.
  const childUserCopy = hasAuth ? "\n            CurrentUser = parent.CurrentUser," : "";
  // The client's `If-Match` expected version (optimistic concurrency): read
  // from the request header by RequestContextMiddleware and carried on the
  // request-stable tier so a Mediator child frame (opened under --trace) still
  // sees it when the repository's SaveAsync reads it.  Only emitted when some
  // in-scope aggregate is `versioned`.
  const expectedVersionSlice = hasVersioned
    ? `
    /// <summary>The client's optimistic-concurrency expected version, parsed
    /// from the request's <c>If-Match</c> header (null when absent).  A
    /// <c>versioned</c> aggregate's repository save sets EF's original value of
    /// the version token to this before flushing, so a stale precondition
    /// yields a zero-row UPDATE (DbUpdateConcurrencyException → 409).</summary>
    public int? ExpectedVersion { get; set; }
`
    : "";
  const childExpectedVersionCopy = hasVersioned
    ? "\n            ExpectedVersion = parent.ExpectedVersion,"
    : "";
  const currentUserSlice = hasAuth
    ? `
    /// <summary>The verified principal for this flow, or null before
    /// authentication has run.  Settable because the principal is born
    /// one middleware later than the rest of the request-stable tier —
    /// UserMiddleware attaches it after the verifier succeeds.</summary>
    public User? CurrentUser { get; set; }
`
    : "";
  const loggerSlice = hasLogger
    ? `
    /// <summary>The request-scoped logger slice (--trace).  Bound for the
    /// duration of each Mediator dispatch by ExecutionContextBehavior so
    /// trace-injected domain calls resolve a logger without constructor
    /// injection; null outside any dispatch.</summary>
    public ILogger? Logger { get; set; }
`
    : "";
  // The principal serialized for audit's `actor` column.  Auth-conditional
  // here so consumers (the audited command handler) call a stable
  // `PrincipalJson()` without referencing the auth-only CurrentUser slice or
  // the Auth namespace — when there is no principal slice it is simply null.
  const principalJsonMethod = hasAuth
    ? `
    /// <summary>The bound principal serialized as JSON (audit's actor), or
    /// null when no principal has been resolved for this flow.</summary>
    public string? PrincipalJson()
        => CurrentUser is { } u ? System.Text.Json.JsonSerializer.Serialize(u) : null;
`
    : `
    /// <summary>No principal slice on this carrier (no auth), so there is no
    /// actor to serialize.</summary>
    public string? PrincipalJson() => null;
`;
  // The principal's id — the carrier's who-computed slice that audit /
  // provenance stamp (the design's `currentUser.id`).  Always present (null
  // under no-auth) so consumers read `RequestContext.Current?.ActorId`
  // uniformly without referencing the auth-only CurrentUser slice.
  const actorIdProperty =
    hasAuth && actorIdProp
      ? `
    /// <summary>The bound principal's id (audit / provenance "who computed"),
    /// or null before authentication has run.</summary>
    public string? ActorId => CurrentUser?.${actorIdProp}.ToString();
`
      : `
    /// <summary>No principal slice on this carrier (no auth), so there is no
    /// actor id.</summary>
    public string? ActorId => null;
`;
  return `// Auto-generated.
using System;
using System.Threading;
${loggingUsing}${authUsing}
namespace ${ns}.Domain.Common;

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
${currentUserSlice}${loggerSlice}${expectedVersionSlice}
    // ---- Frame-local tier — a fresh ScopeId per frame.  The root frame
    // (opened at the boundary) has no parent; each Mediator dispatch opens a
    // child whose ParentId chains to its caller, forming the causality chain.
    public string ScopeId { get; init; } = string.Empty;
    public string? ParentId { get; init; }
${principalJsonMethod}${actorIdProperty}
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
            StartedAt = parent.StartedAt,${childUserCopy}${childExpectedVersionCopy}
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
`;
}
