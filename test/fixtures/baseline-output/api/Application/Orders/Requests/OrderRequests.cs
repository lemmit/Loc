// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using Api.Domain.Enums;

namespace Api.Application.Orders.Requests;

public sealed record CreateOrderRequest([Required(AllowEmptyStrings = true)] string CustomerId, [property: JsonRequired] [Required] OrderStatus Status, [Required(AllowEmptyStrings = true)] string PlacedAt);

public sealed record AddLineOrderRequest([property: JsonRequired] [Required] Guid ProductId, [property: JsonRequired] [Required] int Qty);

public sealed record ConfirmOrderRequest();

public sealed record UpdateOrderRequest([property: JsonRequired] [Required(AllowEmptyStrings = true)] string CustomerId, [property: JsonRequired] [Required] OrderStatus Status, [property: JsonRequired] [Required(AllowEmptyStrings = true)] string PlacedAt);

