// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.Enums;
using Api.Application.Orders.Responses;

namespace Api.Application.Orders.Queries;

public sealed record ByCustomerQuery(string CustomerId) : IQuery<IReadOnlyList<OrderResponse>>;
