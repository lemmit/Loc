// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Products.Responses;

public sealed record MoneyResponse([property: Required] double Amount, [property: Required(AllowEmptyStrings = true)] string Currency);

public sealed record ProductResponse([property: Required] Guid Id, [property: Required(AllowEmptyStrings = true)] string Sku, [property: Required] MoneyResponse Price, [property: Required] int Version, [property: Required(AllowEmptyStrings = true)] string Display);

public sealed record CreateProductResponse([property: Required] Guid Id);

