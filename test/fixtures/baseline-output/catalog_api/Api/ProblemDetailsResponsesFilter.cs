// Auto-generated.
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi.Any;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace CatalogApi.Api;

public sealed class ProblemDetailsResponsesFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        var schema = context.SchemaGenerator.GenerateSchema(typeof(ProblemDetails), context.SchemaRepository);
        AugmentProblemDetailsSchema(context.SchemaRepository);
        foreach (var (code, response) in operation.Responses)
        {
            if (code.Length == 3 && (code[0] == '4' || code[0] == '5'))
            {
                response.Content.Clear();
                response.Content["application/problem+json"] = new OpenApiMediaType { Schema = schema };
            }
        }
    }

    // Augment the auto-generated Microsoft.AspNetCore.Mvc.ProblemDetails
    // OpenAPI schema with the RFC 7807 §3.2 `errors[]` extension array
    // (per-field `{ pointer, message }`) that the FluentValidation arm
    // of DomainExceptionFilter emits on 422 validation responses.
    // Consumed by the frontend ACL's `applyServerErrors`.  Idempotent;
    // safe to run per operation.  See
    // docs/old/proposals/validation-error-extension.md (Phase D).
    private static void AugmentProblemDetailsSchema(SchemaRepository repo)
    {
        if (!repo.Schemas.TryGetValue("ProblemDetails", out var problem)) return;
        if (problem.Properties.ContainsKey("errors")) return;

        problem.Properties["errors"] = new OpenApiSchema
        {
            Type = "array",
            Nullable = true,
            Items = new OpenApiSchema
            {
                Type = "object",
                Required = new HashSet<string> { "pointer", "message" },
                Properties = new Dictionary<string, OpenApiSchema>
                {
                    ["pointer"] = new OpenApiSchema { Type = "string" },
                    ["message"] = new OpenApiSchema { Type = "string" },
                },
            },
        };
    }
}
