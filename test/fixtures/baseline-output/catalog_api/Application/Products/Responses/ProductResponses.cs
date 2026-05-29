// Auto-generated.
using System;
using System.Collections.Generic;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Responses;

public sealed record MoneyResponse(decimal Amount, string Currency);

public sealed record ProductResponse(Guid Id, string Sku, MoneyResponse Price, string Display);

public sealed record CreateProductResponse(Guid Id);

