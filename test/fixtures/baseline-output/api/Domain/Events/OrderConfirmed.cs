// Auto-generated.
using Api.Domain.Ids;

namespace Api.Domain.Events;

public sealed record OrderConfirmed(OrderId Order, DateTime At) : IDomainEvent;
