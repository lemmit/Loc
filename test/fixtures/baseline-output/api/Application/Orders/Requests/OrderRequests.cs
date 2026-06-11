// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Orders.Requests;

public sealed record CreateOrderRequest([Required(AllowEmptyStrings = true)] string CustomerId, [Required] OrderStatus Status, [Required(AllowEmptyStrings = true)] string PlacedAt);

public sealed record AddLineOrderRequest([Required] Guid ProductId, [Required] int Qty);

public sealed record ConfirmOrderRequest();

public sealed record UpdateOrderRequest([Required(AllowEmptyStrings = true)] string CustomerId, [Required] OrderStatus Status, [Required(AllowEmptyStrings = true)] string PlacedAt);

