// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Responses;

public sealed record MoneyResponse([property: Required] decimal Amount, [property: Required] string Currency);

public sealed record ProductResponse([property: Required] Guid Id, [property: Required] string Sku, [property: Required] MoneyResponse Price, [property: Required] int Version, [property: Required] string Display);

public sealed record CreateProductResponse([property: Required] Guid Id);

