// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Domain.Common;

namespace Api.Application.Customers.Commands;

public sealed record DestroyCustomerCommand(CustomerId Id) : ICommand;
