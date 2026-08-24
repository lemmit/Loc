// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Domain.Common;

namespace Api.Application.Orders.Commands;

public sealed record AddLineCommand(OrderId Id, ProductId ProductId, int Qty) : ICommand;
