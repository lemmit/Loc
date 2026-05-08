// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Workflows;

public sealed record PlaceOrderCommand(string CustomerId, ProductId ProductId, int Quantity) : ICommand;
