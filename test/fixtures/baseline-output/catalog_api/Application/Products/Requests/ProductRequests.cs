// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Requests;

public sealed record MoneyRequest([property: Required] decimal Amount, [property: Required] string Currency);

public sealed record CreateProductRequest([property: Required] string Sku, [property: Required] MoneyRequest Price);

public sealed record UpdateRequest([property: Required] string Sku, [property: Required] MoneyRequest Price);

