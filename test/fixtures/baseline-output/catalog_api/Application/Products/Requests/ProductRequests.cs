// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Requests;

public sealed record MoneyRequest([Required] decimal Amount, [Required] string Currency);

public sealed record CreateProductRequest([Required] string Sku, [Required] MoneyRequest Price);

public sealed record UpdateProductRequest([Required] string Sku, [Required] MoneyRequest Price);

