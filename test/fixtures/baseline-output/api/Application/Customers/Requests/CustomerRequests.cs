// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Customers.Requests;

public sealed record CreateCustomerRequest([property: Required] string Username, [property: Required] string Email, [property: Required] int Age);

public sealed record UpdateCustomerRequest([property: Required] string Username, [property: Required] string Email, [property: Required] int Age);

