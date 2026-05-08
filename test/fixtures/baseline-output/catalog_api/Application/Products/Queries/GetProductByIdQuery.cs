// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Application.Products.Responses;

namespace CatalogApi.Application.Products.Queries;

public sealed record GetProductByIdQuery(ProductId Id) : IQuery<ProductResponse?>;
