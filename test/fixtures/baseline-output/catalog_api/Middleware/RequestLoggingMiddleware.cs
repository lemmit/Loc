// Auto-generated.
using System.Diagnostics;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace CatalogApi.Middleware;

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
        _log.LogInformation("{Event} method={Method} path={Path}", "request_start", ctx.Request.Method, ctx.Request.Path.Value ?? "/");
        try
        {
            await _next(ctx);
        }
        finally
        {
            sw.Stop();
            _log.LogInformation("{Event} method={Method} path={Path} status={Status} duration_ms={DurationMs}", "request_end", ctx.Request.Method, ctx.Request.Path.Value ?? "/", ctx.Response.StatusCode, sw.ElapsedMilliseconds);
        }
    }
}
