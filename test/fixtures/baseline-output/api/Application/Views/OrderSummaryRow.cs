// Auto-generated.
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Views;

public sealed record OrderSummaryRow(Guid OrderId, OrderStatus Status, int LineCount);
