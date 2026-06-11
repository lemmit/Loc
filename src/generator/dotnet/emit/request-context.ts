// The ambient execution context for a single request/flow — the one
// AsyncLocal carrier every governance slice reads from (correlation id,
// request principal, locale, request logger).  Established at the HTTP
// edge by RequestContextMiddleware and folded into by UserMiddleware
// (principal) and ExecutionContextBehavior (logger).  See
// docs/architecture/request-context.md.
//
// Emitted whenever the deployable carries a slice that needs it — i.e.
// `auth: required` (the principal slice) OR `--trace` (the logger slice).
// A no-auth, no-trace project emits nothing here, preserving the
// byte-identical-when-off contract.

/**
 * Render `Domain/Common/RequestContext.cs`.  The shape is minimised to
 * the slices the project actually carries: the `CurrentUser` field (and
 * its `Auth` using) only when auth is present; the `Logger` field (and
 * its Logging using) only under `--trace`.
 */
export function renderRequestContext(
  ns: string,
  opts: { hasAuth: boolean; hasLogger: boolean },
): string {
  const { hasAuth, hasLogger } = opts;
  const loggingUsing = hasLogger ? "using Microsoft.Extensions.Logging;\n" : "";
  const authUsing = hasAuth ? `using ${ns}.Auth;\n` : "";
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
${currentUserSlice}${loggerSlice}
    // ---- Frame-local tier — the root frame here.  Per-boundary child
    // frames (a fresh ScopeId + ParentId chain) arrive with nesting.
    public string ScopeId { get; init; } = string.Empty;
    public string? ParentId { get; init; }

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
