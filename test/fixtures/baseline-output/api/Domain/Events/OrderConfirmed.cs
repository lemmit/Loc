// Auto-generated.
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Domain.Events;

public sealed record OrderConfirmed(OrderId Order, DateTime At) : IDomainEvent;
