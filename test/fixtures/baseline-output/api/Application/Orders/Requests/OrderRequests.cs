// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Orders.Requests;

public sealed record CreateOrderRequest([Required] string CustomerId, [Required] OrderStatus Status, [Required] string PlacedAt);

public sealed record AddLineOrderRequest([Required] Guid ProductId, [Required] int Qty);

public sealed record ConfirmOrderRequest();

public sealed record UpdateOrderRequest([Required] string CustomerId, [Required] OrderStatus Status, [Required] string PlacedAt);

