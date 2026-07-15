// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.Enums;
using CatalogApi.Application.Customers.Responses;
using CatalogApi.Domain.Common;

namespace CatalogApi.Application.Customers.Queries;

public sealed record AllQuery(int Page, int PageSize, string Sort, string Dir) : IQuery<Paged<CustomerResponse>>;
