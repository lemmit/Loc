// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Customers.Commands;

public sealed record UpdateCommand(CustomerId Id, string Username, string Email, int Age) : ICommand;
