// Auto-generated.
using System;
using System.Collections.Generic;

namespace Api.Application.Products.Responses;

public sealed record MoneyResponse(decimal Amount, string Currency);

public sealed record ProductResponse(Guid Id, string Sku, MoneyResponse Price, string Display);

public sealed record CreateProductResponse(Guid Id);

