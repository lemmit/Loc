// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Customers.Commands;

public sealed record CreateCustomerCommand(string Username, string Email, int Age) : ICommand<CustomerId>;
