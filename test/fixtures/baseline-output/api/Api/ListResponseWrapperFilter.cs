// Auto-generated.
using System;
using Microsoft.OpenApi;
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
        //
        // Microsoft.OpenApi 2.0: an array's Type is the JsonSchemaType flags
        // enum, a $ref schema is a distinct OpenApiSchemaReference node (not an
        // OpenApiSchema with a Reference property), and Components.Schemas is
        // keyed by IOpenApiSchema.
        if (swaggerDoc.Paths is null) return;
        foreach (var path in swaggerDoc.Paths.Values)
        {
            if (path.Operations is null) continue;
            foreach (var operation in path.Operations.Values)
            {
                if (operation.Responses is null) continue;
                foreach (var response in operation.Responses.Values)
                {
                    if (response.Content is null) continue;
                    foreach (var media in response.Content.Values)
                    {
                        if (media.Schema is not OpenApiSchema schema) continue;
                        if (schema.Type is not { } t || !t.HasFlag(JsonSchemaType.Array)) continue;
                        if (schema.Items is not OpenApiSchemaReference itemRef) continue;
                        if (itemRef.Reference?.Id is not string elementId) continue;
                        foreach (var (element, wrapper) in Wrappers)
                        {
                            if (element == elementId)
                            {
                                if (swaggerDoc.Components?.Schemas is { } schemas
                                    && !schemas.ContainsKey(wrapper))
                                {
                                    schemas[wrapper] = new OpenApiSchema
                                    {
                                        Type = JsonSchemaType.Array,
                                        Items = new OpenApiSchemaReference(element, swaggerDoc),
                                    };
                                }
                                media.Schema = new OpenApiSchemaReference(wrapper, swaggerDoc);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
}
