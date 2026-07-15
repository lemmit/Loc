// Auto-generated.
using System;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace CatalogApi.Api;

public sealed class RequiredFromCtorParamFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        var type = context.Type;
        if (schema.Properties is null || schema.Properties.Count == 0) return;

        // Paged carrier (M-T2.6): the generic Paged<T> record's members
        // (items/page/pageSize/total/totalPages) are all non-optional, but
        // Swashbuckle's non-nullable detection can't read nullability off an
        // OPEN generic parameter, so it leaves the required set empty — while
        // Hono/Phoenix/Java/Python mark every envelope field required.  Mark
        // all of them required to restore cross-backend parity (conformance).
        if (type.IsGenericType
            && type.GetGenericTypeDefinition().Name.StartsWith("Paged", StringComparison.Ordinal))
        {
            foreach (var key in schema.Properties.Keys) schema.Required.Add(key);
            return;
        }

        // Positional records expose their declared fields via the primary
        // constructor.  Pick the longest constructor (the primary one for a
        // positional record) and mark each [Required] parameter's property.
        var ctor = type.GetConstructors()
            .OrderByDescending(c => c.GetParameters().Length)
            .FirstOrDefault();
        if (ctor is null) return;

        foreach (var p in ctor.GetParameters())
        {
            if (p.Name is null) continue;
            if (p.GetCustomAttribute<RequiredAttribute>() is null) continue;
            // Swashbuckle keys schema properties by the serialized name;
            // the app uses camelCase (PropertyNamingPolicy.CamelCase), so
            // match on camelCase first, then fall back to the exact key.
            var camel = JsonNamingPolicy.CamelCase.ConvertName(p.Name);
            var key = schema.Properties.ContainsKey(camel)
                ? camel
                : (schema.Properties.ContainsKey(p.Name) ? p.Name : null);
            if (key is not null) schema.Required.Add(key);
        }
    }
}
