// Births the ambient RequestContext at the HTTP edge.  Mounted FIRST
// (before RequestLoggingMiddleware and UserMiddleware) so the root frame
// covers the entire pipeline — including bypassed (/health, /swagger) and
// unauthenticated paths.  The principal is attached one step later by
// UserMiddleware; the logger slice by ExecutionContextBehavior.  See
// docs/architecture/request-context.md (seam 1: boundary establishment).

/** Render `Middleware/RequestContextMiddleware.cs`. */
export function renderRequestContextMiddleware(ns: string): string {
  return `// Auto-generated.
using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using ${ns}.Domain.Common;

namespace ${ns}.Middleware;

/// <summary>
/// Establishes the request-stable tier of <see cref="RequestContext"/> and
/// opens the root frame for the duration of the request: a correlation id
/// taken from an inbound <c>X-Correlation-Id</c> / <c>X-Request-Id</c>
/// header or freshly minted (never derived from a sampled trace id), the
/// request locale from <c>Accept-Language</c>, and the start timestamp.
/// </summary>
public sealed class RequestContextMiddleware
{
    private readonly RequestDelegate _next;

    public RequestContextMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext ctx)
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
        using (RequestContext.Enter(RequestContext.OpenRoot(correlationId, locale, DateTimeOffset.UtcNow)))
        {
            await _next(ctx);
        }
    }
}
`;
}
