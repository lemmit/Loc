// Births the ambient RequestContext at the HTTP edge.  Mounted FIRST
// (before RequestLoggingMiddleware and UserMiddleware) so the root frame
// covers the entire pipeline — including bypassed (/health, /swagger) and
// unauthenticated paths.  The principal is attached one step later by
// UserMiddleware; the logger slice by ExecutionContextBehavior.  See
// docs/architecture/request-context.md (seam 1: boundary establishment).

/** Render `Middleware/RequestContextMiddleware.cs`. */
export function renderRequestContextMiddleware(
  ns: string,
  opts?: { hasVersioned?: boolean },
): string {
  const hasVersioned = !!opts?.hasVersioned;
  // Optimistic concurrency (`versioned`): parse the client's `If-Match`
  // precondition (a bare or quoted integer version) onto the ambient carrier,
  // so a versioned aggregate's repository save can guard the write on it.  Read
  // here beside the correlation id / locale — the one place the carrier reads
  // request headers.  Emitted only when some in-scope aggregate is `versioned`.
  const ifMatchLines = hasVersioned
    ? `
        if (ctx.Request.Headers.TryGetValue("If-Match", out var __ifMatch)
            && int.TryParse(__ifMatch.ToString().Trim('"'), out var __expectedVersion))
        {
            rootFrame.ExpectedVersion = __expectedVersion;
        }`
    : "";
  return `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;

namespace ${ns}.Middleware;

/// <summary>
/// Establishes the request-stable tier of <see cref="RequestContext"/> and
/// opens the root frame for the duration of the request: a correlation id
/// taken from an inbound <c>X-Correlation-Id</c> / <c>X-Request-Id</c>
/// header or freshly minted (never derived from a sampled trace id), the
/// request locale from <c>Accept-Language</c>, and the start timestamp.
///
/// The correlation id is echoed on the <c>X-Correlation-Id</c> response
/// header so callers (and intermediary proxies) can correlate, and a
/// logging scope carries it onto every log line emitted under the request
/// — including the request_start / request_end access log, which is
/// mounted inside this scope — without touching the cross-backend log
/// catalog (the id rides as a structured scope property).
/// </summary>
public sealed class RequestContextMiddleware
{
    private readonly RequestDelegate _next;

    public RequestContextMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext ctx, ILogger<RequestContextMiddleware> log)
    {
        var correlationId =
            ctx.Request.Headers.TryGetValue("X-Correlation-Id", out var cid) && !string.IsNullOrEmpty(cid)
                ? cid.ToString()
                : ctx.Request.Headers.TryGetValue("X-Request-Id", out var rid) && !string.IsNullOrEmpty(rid)
                    ? rid.ToString()
                    : Guid.NewGuid().ToString();
        var locale =
            ctx.Request.Headers.TryGetValue("Accept-Language", out var al) && !string.IsNullOrEmpty(al)
                ? al.ToString()
                : "en";
        // Echo the correlation id back to the caller.  Set before _next so
        // it lands before the response headers are sent.
        ctx.Response.Headers["X-Correlation-Id"] = correlationId;
        var rootFrame = RequestContext.OpenRoot(correlationId, locale, DateTimeOffset.UtcNow);${ifMatchLines}
        using (RequestContext.Enter(rootFrame))
        using (log.BeginScope(new Dictionary<string, object?>
        {
            ["correlationId"] = correlationId,
            ["scopeId"] = rootFrame.ScopeId,
        }))
        {
            await _next(ctx);
        }
    }
}
`;
}
