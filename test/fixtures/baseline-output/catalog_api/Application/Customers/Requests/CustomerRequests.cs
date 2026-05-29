// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Customers.Requests;

public sealed record CreateCustomerRequest([property: Required] string Username, [property: Required] string Email, [property: Required] int Age);

public sealed record UpdateRequest([property: Required] string Username, [property: Required] string Email, [property: Required] int Age);

