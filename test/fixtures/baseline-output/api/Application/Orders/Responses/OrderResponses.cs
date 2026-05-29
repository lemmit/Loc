// Auto-generated.
using System;
using System.Collections.Generic;
using Api.Domain.Enums;

namespace Api.Application.Orders.Responses;

public sealed record OrderLineResponse(Guid Id, Guid ProductId, int Quantity);

public sealed record OrderResponse(Guid Id, string CustomerId, OrderStatus Status, string PlacedAt, IReadOnlyList<OrderLineResponse> Lines);

public sealed record CreateOrderResponse(Guid Id);

