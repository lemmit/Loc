// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.Enums;
using CatalogApi.Application.Products.Responses;
using CatalogApi.Domain.Common;

namespace CatalogApi.Application.Products.Queries;

public sealed record AllQuery(int Page, int PageSize, string Sort, string Dir) : IQuery<Paged<ProductResponse>>;
