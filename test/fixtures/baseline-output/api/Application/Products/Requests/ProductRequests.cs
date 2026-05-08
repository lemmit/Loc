// Auto-generated.
using System;
using System.Collections.Generic;

namespace Api.Application.Products.Requests;

public sealed record MoneyRequest(decimal Amount, string Currency);

public sealed record CreateProductRequest(string Sku, MoneyRequest Price);

