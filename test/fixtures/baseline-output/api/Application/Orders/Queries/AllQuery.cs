// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.Enums;
using Api.Application.Orders.Responses;
using Api.Domain.Common;

namespace Api.Application.Orders.Queries;

public sealed record AllQuery(int Page, int PageSize, string Sort, string Dir) : IQuery<Paged<OrderResponse>>;
