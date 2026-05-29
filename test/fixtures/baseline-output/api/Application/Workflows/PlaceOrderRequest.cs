// Auto-generated.
using System.ComponentModel.DataAnnotations;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Workflows;

public sealed record PlaceOrderRequest([property: Required] string CustomerId, [property: Required] Guid ProductId, [property: Required] int Quantity);
