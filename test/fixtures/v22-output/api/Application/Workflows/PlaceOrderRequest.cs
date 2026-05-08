// Auto-generated.
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Workflows;

public sealed record PlaceOrderRequest(string CustomerId, Guid ProductId, int Quantity);
