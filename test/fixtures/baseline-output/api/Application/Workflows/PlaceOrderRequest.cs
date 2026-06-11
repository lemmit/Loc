// Auto-generated.
using System.ComponentModel.DataAnnotations;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Workflows;

public sealed record PlaceOrderRequest([Required(AllowEmptyStrings = true)] string CustomerId, [Required] Guid ProductId, [Required] int Quantity);
