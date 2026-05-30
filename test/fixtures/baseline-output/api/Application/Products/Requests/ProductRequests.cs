// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Products.Requests;

public sealed record MoneyRequest([Required] decimal Amount, [Required] string Currency);

public sealed record CreateProductRequest([Required] string Sku, [Required] MoneyRequest Price);

