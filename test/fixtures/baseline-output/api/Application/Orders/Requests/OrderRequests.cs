// Auto-generated.
using System;
using System.Collections.Generic;

namespace Api.Application.Orders.Requests;

public sealed record CreateOrderRequest(string CustomerId, string Status, string PlacedAt);

public sealed record AddLineRequest(Guid ProductId, int Qty);

public sealed record ConfirmRequest();

