// Auto-generated.
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using CatalogApi.Domain.Common;

namespace CatalogApi.Api;

/// <summary>
/// Maps domain-layer exceptions to structured HTTP responses.
/// Domain exceptions get a 400 / 404 with the original message;
/// any unhandled exception falls through to a generic 500 with a
/// safe message (the original is logged but not returned, so
/// internal details don't leak to API consumers).  Mirrors the
/// Hono `app.onError` shape so the cross-platform contract
/// stays in lockstep.
/// </summary>
public sealed class DomainExceptionFilter : IExceptionFilter
{
    private readonly ILogger<DomainExceptionFilter> _log;
    public DomainExceptionFilter(ILogger<DomainExceptionFilter> log) => _log = log;

    public void OnException(ExceptionContext context)
    {
        // Correlation id — ASP.NET Core sets Activity.Current
        // automatically on every request via the
        // HostingApplicationDiagnostics.  Surfacing the trace id on
        // the response lets an operator join the response back to
        // the structured log line without scraping headers.  Empty
        // string when no Activity is active (e.g. middleware errors
        // before the pipeline starts).
        var trace_id = Activity.Current?.TraceId.ToString() ?? "";
        // FluentValidation arm — runs FIRST because validation
        // failures are the most common 4xx cause.  Emits an RFC 7807
        // ProblemDetails with the §3.2 `errors[]` extension carried
        // on `Extensions["errors"]`, status 422 (Unprocessable
        // Entity, the standard for input-shape errors).  Shape matches
        // Hono's defaultHook output byte-for-byte so the frontend
        // ACL's `applyServerErrors` works against either backend.
        // See docs/old/proposals/validation-error-extension.md and
        // docs/old/proposals/frontend-acl.md.
        if (context.Exception is FluentValidation.ValidationException fv)
        {
            var problem = new ProblemDetails
            {
                Type = "about:blank",
                Title = "Validation failed",
                Status = 422,
                Detail = "One or more fields are invalid.",
                Instance = context.HttpContext.Request.Path,
            };
            problem.Extensions["errors"] = fv.Errors
                .Select(e => new { pointer = PointerOf(e.PropertyName), message = e.ErrorMessage })
                .ToArray();
            _log.LogWarning("{Event} message={Message} status={Status}", "domain_error", "Validation failed", 422);
            context.HttpContext.Response.Headers["x-request-id"] = trace_id;
            context.Result = new ObjectResult(problem)
            {
                StatusCode = 422,
                ContentTypes = { "application/problem+json" },
            };
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is ForbiddenException fe)
        {
            _log.LogWarning("{Event} message={Message} status={Status}", "forbidden", fe.Message, 403);
            context.Result = Problem(context, 403, "Forbidden", fe.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is DisallowedException dx)
        {
            _log.LogWarning("{Event} message={Message} status={Status}", "disallowed", dx.Message, 409);
            context.Result = Problem(context, 409, "Disallowed", dx.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is DomainException de)
        {
            _log.LogWarning("{Event} message={Message} status={Status}", "domain_error", de.Message, 400);
            context.Result = Problem(context, 400, "Bad Request", de.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is AggregateNotFoundException nf)
        {
            _log.LogWarning("{Event} status={Status}", "not_found", 404);
            context.Result = Problem(context, 404, "Not Found", nf.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        if (context.Exception is ExternHandlerException xh)
        {
            // 500 — the user handler threw, which is an internal
            // failure from the framework's POV — but the envelope
            // names the offending op + aggregate so operators don't
            // have to grep logs to find the cause.  The original
            // exception (xh.InnerException) is logged in full
            // server-side via the catalog's extern_handler_threw
            // event — same shape the Hono onError arm emits.
            _log.LogError(xh, "{Event} aggregate={Aggregate} op={Op} error={Error}", "extern_handler_threw", xh.AggName, xh.OpName, xh.Message);
            context.Result = Problem(context, 500, "Internal Server Error", xh.Message, trace_id);
            context.ExceptionHandled = true;
            return;
        }
        // Generic 500.  Log the full exception server-side via the
        // catalog's internal_error event; return a sanitized payload
        // to the client.  Matching the Hono fallback envelope.
        _log.LogError(context.Exception, "{Event} error={Error} status={Status}", "internal_error", context.Exception.Message, 500);
        context.Result = Problem(context, 500, "Internal Server Error", "internal", trace_id);
        context.ExceptionHandled = true;
    }

    // RFC 7807 problem responder — application/problem+json body +
    // x-request-id header (trace correlation moves off the body so it's
    // byte-identical to Hono / Phoenix).  Shared by every non-validation arm.
    private static ObjectResult Problem(ExceptionContext context, int status, string title, string detail, string traceId)
    {
        context.HttpContext.Response.Headers["x-request-id"] = traceId;
        return new ObjectResult(new ProblemDetails
        {
            Type = "about:blank",
            Title = title,
            Status = status,
            Detail = detail,
            Instance = context.HttpContext.Request.Path,
        })
        {
            StatusCode = status,
            ContentTypes = { "application/problem+json" },
        };
    }

    // Convert a FluentValidation property path to an RFC 6901 JSON
    // pointer matching the wire shape the frontend ACL expects.  The
    // app's JSON output uses JsonNamingPolicy.CamelCase, so each
    // PascalCase segment is camel-cased; array indexer notation
    // (`Items[0].Qty`) becomes a numeric segment (`/items/0/qty`).
    // RFC 6901 escapes apply inside each segment (`~` → `~0`,
    // `/` → `~1`).  Empty input → empty pointer (the whole document).
    private static string PointerOf(string propertyName)
    {
        if (string.IsNullOrEmpty(propertyName)) return "";
        var segments = new List<string>();
        foreach (var dotPart in propertyName.Split('.'))
        {
            var idx = 0;
            while (idx < dotPart.Length)
            {
                var bracket = dotPart.IndexOf('[', idx);
                if (bracket < 0)
                {
                    segments.Add(JsonNamingPolicy.CamelCase.ConvertName(dotPart.Substring(idx)));
                    break;
                }
                if (bracket > idx)
                {
                    segments.Add(JsonNamingPolicy.CamelCase.ConvertName(dotPart.Substring(idx, bracket - idx)));
                }
                var close = dotPart.IndexOf(']', bracket);
                if (close < 0) break;
                segments.Add(dotPart.Substring(bracket + 1, close - bracket - 1));
                idx = close + 1;
            }
        }
        return "/" + string.Join("/", segments.ConvertAll(s => s.Replace("~", "~0").Replace("/", "~1")));
    }
}
