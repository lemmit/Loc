// Auto-generated.
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace Api.Api;

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
        // ...EXCEPT a MISSING REQUIRED MEMBER.  System.Text.Json reports that
        // under the same "$" root key, and it is NOT a malformed body: the JSON
        // parsed fine, a member the contract requires simply was not there.
        // That is the wire-validation tier's 422 — the same answer this
        // endpoint already gives when an omitted REFERENCE-typed member trips
        // [Required].  Without this arm the two halves of one contract disagree
        // purely on the CLR kind of the field (schemathesis F30).
        //
        // MEASURED on .NET 10, omitting a required int from a create body; the
        // model-state entry is
        //
        //     $ => Exception: none
        //          ErrorMessage: JSON deserialization for type '<ns>.CreateWidgetRequest'
        //                        was missing required properties including: 'qty'.
        //
        // Note it carries NO exception — the message is the whole signal — which
        // is why this reads ErrorMessage and not error.Exception.
        //
        // Matched on the message because STJ raises no distinct exception type
        // and hangs no exception here at all.  If a future runtime rewords it,
        // the check stops matching and the answer falls back to the 400 this
        // arm gave before: the behaviour of today, never a crash and never a
        // laxer contract.
        const string MissingRequiredMarker = "missing required properties";
        static bool IsMissingRequired(ModelError error) =>
            error.ErrorMessage.Contains(MissingRequiredMarker, StringComparison.Ordinal)
            || (error.Exception?.Message.Contains(MissingRequiredMarker, StringComparison.Ordinal) ?? false);

        // The member names STJ lists are quoted and already in WIRE casing, so
        // they need no PointerOf conversion.  The type name it also quotes is
        // fully qualified, so a dot tells the two apart; an unrecognised shape
        // yields nothing and the caller falls back to the whole-document
        // pointer rather than inventing a field.
        static IEnumerable<string> MissingMemberNames(string message)
        {
            foreach (System.Text.RegularExpressions.Match m in
                System.Text.RegularExpressions.Regex.Matches(message, "'([^']+)'"))
            {
                var name = m.Groups[1].Value;
                if (!name.Contains('.')) yield return name;
            }
        }

        var missingRequired = context.ModelState
            .SelectMany(entry => entry.Value is null
                ? Array.Empty<ModelError>()
                : entry.Value.Errors.Where(IsMissingRequired))
            .ToArray();
        if (missingRequired.Length > 0)
        {
            var missingProblem = new ProblemDetails
            {
                Type = "about:blank",
                Title = "Validation failed",
                Status = 422,
                Detail = "One or more fields are invalid.",
                Instance = context.HttpContext.Request.Path,
            };
            // Built ONLY from the missing-member errors: the same rejection also
            // records a companion "The request field is required." entry keyed by
            // the ACTION PARAMETER, which would otherwise ship a bogus
            // "/request" pointer the wire shape has no field for.
            missingProblem.Extensions["errors"] = missingRequired
                .SelectMany(error =>
                {
                    var names = MissingMemberNames(error.ErrorMessage).ToArray();
                    return names.Length > 0
                        ? names.Select(name => new Dictionary<string, object>
                        {
                            ["pointer"] = "/" + name,
                            ["message"] = "The " + name + " field is required.",
                        })
                        : new[] { new Dictionary<string, object>
                        {
                            ["pointer"] = "",
                            ["message"] = error.ErrorMessage,
                        } };
                })
                .ToArray();
            return new ObjectResult(missingProblem)
            {
                StatusCode = 422,
                ContentTypes = { "application/problem+json" },
            };
        }
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
