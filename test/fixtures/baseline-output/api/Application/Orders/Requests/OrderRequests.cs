// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Orders.Requests;

public sealed record CreateOrderRequest([property: Required] string CustomerId, [property: Required] OrderStatus Status, [property: Required] string PlacedAt);

public sealed record AddLineRequest([property: Required] Guid ProductId, [property: Required] int Qty);

public sealed record ConfirmRequest();

public sealed record UpdateRequest([property: Required] string CustomerId, [property: Required] string Status, [property: Required] string PlacedAt);

