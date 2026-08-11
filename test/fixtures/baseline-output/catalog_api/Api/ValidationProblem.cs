// Auto-generated.
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace CatalogApi.Api;

public static class ValidationProblem
{
    /// <summary>
    /// RFC 7807 answer for a request MVC rejected during model binding or
    /// DataAnnotations validation.  Wired in Program.cs via
    /// ApiBehaviorOptions.InvalidModelStateResponseFactory.
    /// </summary>
    public static IActionResult FromModelState(ActionContext context)
    {
        // An unreadable body is a MALFORMED request, not an invalid one: no
        // field-level pointer describes it, and the sibling backends answer
        // 400.  MVC records it two ways depending on where the read failed —
        // as a JsonException hung on the model-state entry, or (when the
        // formatter already consumed it) as a plain message under the "$"
        // key the System.Text.Json input formatter uses for the body root.
        // Match both: keying on only one of them silently reclassifies half
        // the malformed bodies as field validation failures.
        var malformed = context.ModelState.Any(entry =>
            entry.Key.StartsWith('$')
            || entry.Value?.Errors.Any(error => error.Exception is JsonException) == true);
        if (malformed)
        {
            return new ObjectResult(new ProblemDetails
            {
                Type = "about:blank",
                Title = "Bad Request",
                Status = 400,
                Detail = "Malformed JSON in request body",
                Instance = context.HttpContext.Request.Path,
            })
            {
                StatusCode = 400,
                ContentTypes = { "application/problem+json" },
            };
        }
        var problem = new ProblemDetails
        {
            Type = "about:blank",
            Title = "Validation failed",
            Status = 422,
            Detail = "One or more fields are invalid.",
            Instance = context.HttpContext.Request.Path,
        };
        problem.Extensions["errors"] = context.ModelState
            .SelectMany(entry => entry.Value is null
                ? Array.Empty<Dictionary<string, object>>()
                : entry.Value.Errors.Select(error => new Dictionary<string, object>
                {
                    ["pointer"] = PointerOf(entry.Key),
                    ["message"] = error.ErrorMessage,
                }))
            .ToArray();
        return new ObjectResult(problem)
        {
            StatusCode = 422,
            ContentTypes = { "application/problem+json" },
        };
    }

    /// <summary>
    /// Convert a FluentValidation / ModelState property path to an RFC 6901
    /// JSON pointer matching the wire shape the frontend ACL expects.  The
    /// app's JSON output uses JsonNamingPolicy.CamelCase, so each PascalCase
    /// segment is camel-cased; array indexer notation (<c>Items[0].Qty</c>)
    /// becomes a numeric segment (<c>/items/0/qty</c>).  RFC 6901 escapes
    /// apply inside each segment (<c>~</c> → <c>~0</c>, <c>/</c> → <c>~1</c>).
    /// Empty input → empty pointer (the whole document).
    /// </summary>
    public static string PointerOf(string propertyName)
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
