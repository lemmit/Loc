// Auto-generated.
using System;
using System.Collections.Generic;

namespace Api.Application.Customers.Responses;

public sealed record CustomerResponse(Guid Id, string Username, string Email, int Age, string Display);

public sealed record CreateCustomerResponse(Guid Id);

