// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Requests;

public sealed record MoneyRequest([Required] decimal Amount, [Required(AllowEmptyStrings = true)] string Currency);

public sealed record CreateProductRequest([Required(AllowEmptyStrings = true)] string Sku, [Required] MoneyRequest Price);

public sealed record UpdateProductRequest([Required(AllowEmptyStrings = true)] string Sku, [Required] MoneyRequest Price);

