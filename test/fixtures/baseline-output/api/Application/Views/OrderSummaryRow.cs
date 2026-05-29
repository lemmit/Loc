// Auto-generated.
using System.ComponentModel.DataAnnotations;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Views;

public sealed record OrderSummaryRow([property: Required] Guid OrderId, [property: Required] OrderStatus Status, [property: Required] int LineCount);
