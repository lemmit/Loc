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

export function renderExecutionContextBehavior(ns: string, opts: { hasLogger: boolean }): string {
  // Under --trace the behaviour also binds the request logger slice onto the
  // frame (and surfaces the ids on a logger scope); without trace it is a pure
  // per-dispatch frame opener — audit / provenance still read the frame's
  // scope / parent ids, so the behaviour is emitted whenever any of trace /
  // audit / provenance is present, not just under --trace.
  if (opts.hasLogger) {
    return `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;

namespace ${ns}.Application.Common;

/// <summary>
/// Mediator pipeline behaviour that opens a per-dispatch frame on the
/// ambient <see cref="RequestContext"/> for the duration of every
/// command/query.  The frame chains to its caller (a child whose
/// <see cref="RequestContext.ParentId"/> is the caller's
/// <see cref="RequestContext.ScopeId"/>), so reentrant Send calls form a
/// causality chain.  The dispatch logger is bound onto the frame's logger
/// slice — aggregate methods' --trace-injected LogTrace calls resolve
/// through DomainLog → that slice without a constructor-injection refactor
/// — and a logger scope carries the correlation / scope / parent ids onto
/// every log line emitted under the dispatch.
///
/// When no frame is active — a non-HTTP entrypoint (background job, outbox
/// relay) where no middleware ran — it opens a root frame for the
/// dispatch, so domain trace logging keeps working off the HTTP edge.  The
/// disposable Enter/scope handles restore the previous frame on exit.
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
        var parent = RequestContext.Current;
        // A child frame under the caller, or a fresh root for a non-HTTP
        // entrypoint where no middleware opened one.
        var frame = parent is null
            ? RequestContext.OpenRoot(Guid.NewGuid().ToString(), "en", DateTimeOffset.UtcNow)
            : RequestContext.OpenChild(parent);
        frame.Logger = _log;
        using (RequestContext.Enter(frame))
        using (_log.BeginScope(new Dictionary<string, object?>
        {
            ["correlationId"] = frame.CorrelationId,
            ["scopeId"] = frame.ScopeId,
            ["parentId"] = frame.ParentId,
            ["actorId"] = frame.ActorId,
        }))
        {
            return await next(message, cancellationToken);
        }
    }
}
`;
  }
  // No-logger variant (audit / provenance, no --trace): the behaviour exists
  // only to open the per-dispatch frame so audit / provenance rows stamp a
  // real per-dispatch scope id and a parent id chaining to the caller.  No
  // ILogger dependency, no logger scope — those are the trace-only additions.
  return `// Auto-generated.
using System;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${ns}.Domain.Common;

namespace ${ns}.Application.Common;

/// <summary>
/// Mediator pipeline behaviour that opens a per-dispatch frame on the
/// ambient <see cref="RequestContext"/> for the duration of every
/// command/query.  The frame chains to its caller (a child whose
/// <see cref="RequestContext.ParentId"/> is the caller's
/// <see cref="RequestContext.ScopeId"/>), so reentrant Send calls form a
/// causality chain — and audit / provenance rows written under the dispatch
/// stamp the frame's scope / parent ids, recording each row's call-structure
/// position within the request.
///
/// When no frame is active — a non-HTTP entrypoint (background job, outbox
/// relay) where no middleware ran — it opens a root frame for the dispatch,
/// so the work always runs inside a frame.  The disposable Enter handle
/// restores the previous frame on exit so reentrant Send calls stack cleanly.
/// </summary>
public sealed class ExecutionContextBehavior<TMessage, TResponse> : IPipelineBehavior<TMessage, TResponse>
    where TMessage : IMessage
{
    public async ValueTask<TResponse> Handle(
        TMessage message,
        MessageHandlerDelegate<TMessage, TResponse> next,
        CancellationToken cancellationToken)
    {
        var parent = RequestContext.Current;
        // A child frame under the caller, or a fresh root for a non-HTTP
        // entrypoint where no middleware opened one.
        var frame = parent is null
            ? RequestContext.OpenRoot(Guid.NewGuid().ToString(), "en", DateTimeOffset.UtcNow)
            : RequestContext.OpenChild(parent);
        using (RequestContext.Enter(frame))
        {
            return await next(message, cancellationToken);
        }
    }
}
`;
}
