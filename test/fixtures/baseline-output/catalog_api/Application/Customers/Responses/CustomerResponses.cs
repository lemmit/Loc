// Auto-generated.
using System;
using System.Collections.Generic;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Customers.Responses;

public sealed record CustomerResponse(Guid Id, string Username, string Email, int Age, string Display);

public sealed record CreateCustomerResponse(Guid Id);

