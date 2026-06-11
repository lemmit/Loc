// Domain-layer logger plumbing for the .NET --trace path.  Aggregate
// methods aren't DI-managed (they're POCO entities loaded by EF), so they
// can't take an `ILogger<TSelf>` via constructor injection.  Instead the
// request logger is a SLICE of the ambient RequestContext: a Mediator
// pipeline behaviour binds it onto the frame for the duration of every
// dispatch, and trace-injected statements in aggregate methods resolve it
// through the static `DomainLog` shim.  Folded onto RequestContext per
// docs/architecture/request-context.md — `DomainLog` no longer owns its
// own AsyncLocal; it reads the carrier's logger slice.
//
// Emitted ONLY when --trace is on.  Off path emits nothing — the
// generated `Domain/<Agg>/<Agg>.cs` stays free of any DomainLog
// reference, matching the byte-identical-when-off contract.

export function renderDomainLog(ns: string): string {
  return `// Auto-generated.
using Microsoft.Extensions.Logging;

namespace ${ns}.Domain.Common;

/// <summary>
/// Shim over the request logger slice of <see cref="RequestContext"/>.
/// Set by ExecutionContextBehavior at the start of every Mediator
/// dispatch; read by --trace-injected log calls in aggregate methods.
///
/// Resolves through the ambient RequestContext so concurrent requests
/// don't contaminate each other.  Null when no frame is active (e.g.
/// tests that instantiate an aggregate directly); the LogTrace helper
/// null-checks so out-of-request execution stays silent instead of
/// throwing.
/// </summary>
public static class DomainLog
{
    public static ILogger? Current => RequestContext.Current?.Logger;

    /// <summary>
    /// Emit a Trace-level structured log line through the request-scoped
    /// logger if one is bound.  No-op otherwise — matching the generated
    /// render-stmt inject sites' assumption that out-of-request domain
    /// calls (unit tests, ad-hoc construction) keep working silently.
    /// </summary>
    public static void LogTrace(string template, params object[] args)
    {
        Current?.LogTrace(template, args);
    }
}
`;
}

export function renderExecutionContextBehavior(ns: string): string {
  return `// Auto-generated.
using System;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;

namespace ${ns}.Application.Common;

/// <summary>
/// Mediator pipeline behaviour that binds the request logger onto the
/// ambient <see cref="RequestContext"/> for the duration of every
/// command/query.  Aggregate methods' --trace-injected LogTrace calls
/// resolve through DomainLog → the frame's logger slice, so the
/// per-request correlation reaches the domain layer without a
/// constructor-injection refactor.
///
/// Restores the previous logger on exit so reentrant Send calls (a
/// handler that sends another Mediator message) stack cleanly.  When no
/// frame is active — a non-HTTP entrypoint (background job, outbox relay)
/// where no middleware ran — it opens a root frame for the dispatch, so
/// domain trace logging keeps working off the HTTP edge.
/// </summary>
public sealed class ExecutionContextBehavior<TMessage, TResponse> : IPipelineBehavior<TMessage, TResponse>
    where TMessage : IMessage
{
    private readonly ILogger<TMessage> _log;

    public ExecutionContextBehavior(ILogger<TMessage> log) => _log = log;

    public async ValueTask<TResponse> Handle(
        TMessage message,
        MessageHandlerDelegate<TMessage, TResponse> next,
        CancellationToken cancellationToken)
    {
        var rc = RequestContext.Current;
        if (rc is null)
        {
            // Non-HTTP entrypoint: no middleware established a frame, so
            // open a root frame for this dispatch (a minted correlation id,
            // default locale).  Disposes back to null on exit.
            using (RequestContext.Enter(
                RequestContext.OpenRoot(Guid.NewGuid().ToString(), "en", DateTimeOffset.UtcNow)))
            {
                RequestContext.Current!.Logger = _log;
                return await next(message, cancellationToken);
            }
        }
        var prev = rc.Logger;
        rc.Logger = _log;
        try
        {
            return await next(message, cancellationToken);
        }
        finally
        {
            rc.Logger = prev;
        }
    }
}
`;
}
