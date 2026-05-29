// Auto-generated.
using System;
using System.Collections.Generic;
using Api.Domain.Enums;

namespace Api.Application.Orders.Requests;

public sealed record CreateOrderRequest(string CustomerId, OrderStatus Status, string PlacedAt);

public sealed record AddLineRequest(Guid ProductId, int Qty);

public sealed record ConfirmRequest();

