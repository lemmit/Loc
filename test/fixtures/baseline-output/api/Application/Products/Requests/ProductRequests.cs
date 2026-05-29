// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Products.Requests;

public sealed record MoneyRequest([property: Required] decimal Amount, [property: Required] string Currency);

public sealed record CreateProductRequest([property: Required] string Sku, [property: Required] MoneyRequest Price);

