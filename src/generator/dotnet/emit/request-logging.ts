import { renderDotnetLogCall } from "../../_obs/render-dotnet.js";

// ---------------------------------------------------------------------------
// Request-logging middleware emission for the .NET backend.
//
// Sister to Phoenix's `<App>.Telemetry` (Bite 1) and Hono's pino access
// log — produces a single ASP.NET Core middleware class that logs the
// catalog `request_start` and `request_end` events for every request,
// with the SAME envelope shape and `event:` key the other backends emit.
//
// Why a custom middleware (and not `UseHttpLogging`):
//   ASP.NET's built-in `UseHttpLogging` writes its own line per request,
//   but the structured field names and `event` identity it picks don't
//   match the cross-backend catalog (which is what dashboards and
//   alert rules pivot on).  This middleware emits the catalog identity
//   verbatim via `renderDotnetLogCall`.  Both can coexist if
//   `UseHttpLogging` stays on — identical to Hono's pino + Node access
//   log coexistence; the catalog stream is the one the cross-backend
//   tooling consumes.
//
// Ordering:
//   `Program.cs` mounts this BEFORE `UseRouting` / `MapControllers` so
//   the Stopwatch covers routing + controller body + response
//   serialization.  See `program.ts` for the pin.
//
// Exception path:
//   `_next(ctx)` runs inside a try/finally; `request_end` fires even
//   when a controller throws so the duration + final response status
//   always lands on the structured stream.  The framework's exception
//   handler still gets to write its own line — they coexist.
// ---------------------------------------------------------------------------

export function renderRequestLoggingMiddleware(ns: string): string {
  const startCall = renderDotnetLogCall("requestStart", [
    { name: "method", valueExpr: "ctx.Request.Method" },
    { name: "path", valueExpr: 'ctx.Request.Path.Value ?? "/"' },
  ]);
  const endCall = renderDotnetLogCall("requestEnd", [
    { name: "method", valueExpr: "ctx.Request.Method" },
    { name: "path", valueExpr: 'ctx.Request.Path.Value ?? "/"' },
    { name: "status", valueExpr: "ctx.Response.StatusCode" },
    { name: "duration_ms", valueExpr: "sw.ElapsedMilliseconds" },
  ]);

  return `// Auto-generated.
using System.Diagnostics;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace ${ns}.Middleware;

public sealed class RequestLoggingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RequestLoggingMiddleware> _log;

    public RequestLoggingMiddleware(
        RequestDelegate next,
        ILogger<RequestLoggingMiddleware> log)
    {
        _next = next;
        _log = log;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        var sw = Stopwatch.StartNew();
        ${startCall}
        try
        {
            await _next(ctx);
        }
        finally
        {
            sw.Stop();
            ${endCall}
            // Record the same finished request against the Prometheus HTTP
            // metrics — same seam as request_end.  The route TEMPLATE (from the
            // matched endpoint), not the raw path, keeps label cardinality
            // bounded (raw paths carry per-request ids).
            var metricRoute =
                (ctx.GetEndpoint() as Microsoft.AspNetCore.Routing.RouteEndpoint)
                    ?.RoutePattern.RawText ?? ctx.Request.Path.Value ?? "/";
            ${ns}.Observability.HttpMetrics.Record(
                ctx.Request.Method, metricRoute, ctx.Response.StatusCode, sw.Elapsed.TotalMilliseconds);
        }
    }
}
`;
}
