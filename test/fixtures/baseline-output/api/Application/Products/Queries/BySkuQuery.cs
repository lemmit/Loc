// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.Enums;
using Api.Application.Products.Responses;

namespace Api.Application.Products.Queries;

public sealed record BySkuQuery(string Sku) : IQuery<ProductResponse?>;
