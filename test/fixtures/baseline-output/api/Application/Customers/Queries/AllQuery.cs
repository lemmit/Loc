// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.Enums;
using Api.Application.Customers.Responses;
using Api.Domain.Common;

namespace Api.Application.Customers.Queries;

public sealed record AllQuery(int Page, int PageSize, string Sort, string Dir) : IQuery<Paged<CustomerResponse>>;
