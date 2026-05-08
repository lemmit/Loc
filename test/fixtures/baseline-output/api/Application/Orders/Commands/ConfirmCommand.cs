// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Orders.Commands;

public sealed record ConfirmCommand(OrderId Id) : ICommand;
