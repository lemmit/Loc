// Domain-layer logger plumbing for the .NET --trace path.  Mirrors the
// Hono ALS approach: aggregate methods aren't DI-managed (they're
// POCO entities loaded by EF), so they can't take an
// `ILogger<TSelf>` via constructor injection.  Instead, a Mediator
// pipeline behavior sets a request-scoped `AsyncLocal<ILogger?>` for
// the duration of every command/query, and trace-injected statements
// in aggregate methods resolve through the static accessor.
//
// Emitted ONLY when --trace is on.  Off path emits nothing — the
// generated `Domain/<Agg>/<Agg>.cs` stays free of any DomainLog
// reference, matching the byte-identical-when-off contract.

export function renderDomainLog(ns: string): string {
  return `// Auto-generated.
using System.Threading;
using Microsoft.Extensions.Logging;

namespace ${ns}.Domain.Common;

/// <summary>
/// Request-scoped accessor for the domain layer's logger.  Set by
/// DomainLogBehavior at the start of every Mediator command/query;
/// read by --trace-injected log calls in aggregate methods.
///
/// AsyncLocal so concurrent requests don't contaminate each other —
/// the typical pattern for surfacing a request-scoped value to code
/// that doesn't take it as a parameter.  Null when no request is
/// active (e.g. tests that instantiate an aggregate directly); the
/// LogTrace helper null-checks so out-of-request execution stays
/// silent instead of throwing.
/// </summary>
public static class DomainLog
{
    private static readonly AsyncLocal<ILogger?> _current = new();

    public static ILogger? Current
    {
        get => _current.Value;
        set => _current.Value = value;
    }

    /// <summary>
    /// Emit a Trace-level structured log line through the request-
    /// scoped logger if one is bound.  No-op otherwise — matching the
    /// generated render-stmt inject sites' assumption that out-of-
    /// request domain calls (unit tests, ad-hoc construction) keep
    /// working silently.
    /// </summary>
    public static void LogTrace(string template, params object[] args)
    {
        Current?.LogTrace(template, args);
    }
}
`;
}

export function renderDomainLogBehavior(ns: string): string {
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;

namespace ${ns}.Application.Common;

/// <summary>
/// Mediator pipeline behavior that wires the request-scoped logger
/// into <see cref="DomainLog.Current"/> for the duration of every
/// command/query.  Aggregate methods's --trace-injected
/// LogTrace calls resolve through DomainLog → that logger, so the
/// per-request correlation (and the surrounding handler's
/// log context) reaches the domain layer without a constructor-
/// injection refactor.
///
/// Restores the previous value on exit so reentrant Send calls
/// (a handler that sends another Mediator message) stack cleanly.
/// </summary>
public sealed class DomainLogBehavior<TMessage, TResponse> : IPipelineBehavior<TMessage, TResponse>
    where TMessage : IMessage
{
    private readonly ILogger<TMessage> _log;

    public DomainLogBehavior(ILogger<TMessage> log) => _log = log;

    public async ValueTask<TResponse> Handle(
        TMessage message,
        MessageHandlerDelegate<TMessage, TResponse> next,
        CancellationToken cancellationToken)
    {
        var prev = DomainLog.Current;
        DomainLog.Current = _log;
        try
        {
            return await next(message, cancellationToken);
        }
        finally
        {
            DomainLog.Current = prev;
        }
    }
}
`;
}
