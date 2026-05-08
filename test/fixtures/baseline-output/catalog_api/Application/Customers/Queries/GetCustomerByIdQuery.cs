// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Application.Customers.Responses;

namespace CatalogApi.Application.Customers.Queries;

public sealed record GetCustomerByIdQuery(CustomerId Id) : IQuery<CustomerResponse?>;
