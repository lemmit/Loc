// Auto-generated.
using System;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace Api.Api;

public sealed class ListResponseWrapperFilter : IDocumentFilter
{
    private static readonly (string Element, string Wrapper)[] Wrappers = new[]
    {
        ("ProductResponse", "ProductListResponse"),
        ("OrderResponse", "OrderListResponse"),
        ("OrderSummaryRow", "OrderSummaryResponse"),
        ("CustomerResponse", "CustomerListResponse"),
    };

    public void Apply(OpenApiDocument swaggerDoc, DocumentFilterContext context)
    {
        // Retarget inline array responses to the named wrapper $ref, adding the
        // wrapper component ONLY when an endpoint actually returns that array.
        // A paged-by-default findAll (M-T2.6) returns <Agg>Paged, not a bare
        // array, so a paged-only aggregate surfaces no <Agg>ListResponse — the
        // Hono / Phoenix backends omit it too (an unreferenced wrapper never
        // enters their spec), so adding it unconditionally would drift parity.
        foreach (var path in swaggerDoc.Paths.Values)
        foreach (var operation in path.Operations.Values)
        foreach (var response in operation.Responses.Values)
        foreach (var media in response.Content.Values)
        {
            var schema = media.Schema;
            if (schema?.Type == "array" && schema.Items?.Reference?.Id is string elementId)
            {
                foreach (var (element, wrapper) in Wrappers)
                {
                    if (element == elementId)
                    {
                        if (!swaggerDoc.Components.Schemas.ContainsKey(wrapper))
                        {
                            swaggerDoc.Components.Schemas[wrapper] = new OpenApiSchema
                            {
                                Type = "array",
                                Items = new OpenApiSchema
                                {
                                    Reference = new OpenApiReference { Type = ReferenceType.Schema, Id = element }
                                }
                            };
                        }
                        media.Schema = new OpenApiSchema
                        {
                            Reference = new OpenApiReference { Type = ReferenceType.Schema, Id = wrapper }
                        };
                        break;
                    }
                }
            }
        }
    }
}
