// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Customers.Commands;

public sealed record CreateCustomerCommand(string Username, string Email, int Age) : ICommand<CustomerId>;
