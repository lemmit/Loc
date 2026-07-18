// Auto-generated.
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace CatalogApi.Api;

public sealed class ProblemDetailsResponsesFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        var schema = context.SchemaGenerator.GenerateSchema(typeof(ProblemDetails), context.SchemaRepository);
        AugmentProblemDetailsSchema(context.SchemaRepository);
        if (operation.Responses is null) return;
        foreach (var (code, response) in operation.Responses)
        {
            if (code.Length == 3 && (code[0] == '4' || code[0] == '5') && response is OpenApiResponse resp)
            {
                resp.Content ??= new Dictionary<string, OpenApiMediaType>();
                resp.Content.Clear();
                resp.Content["application/problem+json"] = new OpenApiMediaType { Schema = schema };
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
    // Microsoft.OpenApi 2.0: schema type is the `JsonSchemaType` flags enum
    // (nullability folded in as `| JsonSchemaType.Null`, which the 3.0 writer
    // serializes back to `nullable: true`); property maps are keyed by the
    // `IOpenApiSchema` interface.
    private static void AugmentProblemDetailsSchema(SchemaRepository repo)
    {
        if (!repo.Schemas.TryGetValue("ProblemDetails", out var problemSchema)) return;
        if (problemSchema is not OpenApiSchema problem) return;
        problem.Properties ??= new Dictionary<string, IOpenApiSchema>();
        if (problem.Properties.ContainsKey("errors")) return;

        problem.Properties["errors"] = new OpenApiSchema
        {
            Type = JsonSchemaType.Array | JsonSchemaType.Null,
            Items = new OpenApiSchema
            {
                Type = JsonSchemaType.Object,
                Required = new HashSet<string> { "pointer", "message" },
                Properties = new Dictionary<string, IOpenApiSchema>
                {
                    ["pointer"] = new OpenApiSchema { Type = JsonSchemaType.String },
                    ["message"] = new OpenApiSchema { Type = JsonSchemaType.String },
                },
            },
        };
    }
}
