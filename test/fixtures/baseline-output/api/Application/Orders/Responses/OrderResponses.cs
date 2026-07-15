// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Orders.Responses;

public sealed record OrderLineResponse([property: Required] Guid Id, [property: Required] Guid ProductId, [property: Required] int Quantity);

public sealed record OrderResponse([property: Required] Guid Id, [property: Required] string CustomerId, [property: Required] OrderStatus Status, [property: Required] string PlacedAt, [property: Required] int Version, [property: Required] IReadOnlyList<OrderLineResponse> Lines);

public sealed record CreateOrderResponse([property: Required] Guid Id);

