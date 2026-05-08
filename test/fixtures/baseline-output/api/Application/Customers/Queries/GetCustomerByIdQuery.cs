// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Application.Customers.Responses;

namespace Api.Application.Customers.Queries;

public sealed record GetCustomerByIdQuery(CustomerId Id) : IQuery<CustomerResponse?>;
