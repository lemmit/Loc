// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Domain.Common;

namespace CatalogApi.Application.Customers.Commands;

public sealed record DestroyCustomerCommand(CustomerId Id) : ICommand;
