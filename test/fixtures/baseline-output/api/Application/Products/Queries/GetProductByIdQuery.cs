// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Application.Products.Responses;

namespace Api.Application.Products.Queries;

public sealed record GetProductByIdQuery(ProductId Id) : IQuery<ProductResponse?>;
