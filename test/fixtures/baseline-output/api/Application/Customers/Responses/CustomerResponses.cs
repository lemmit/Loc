// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Customers.Responses;

public sealed record CustomerResponse([property: Required] Guid Id, [property: Required(AllowEmptyStrings = true)] string Username, [property: Required(AllowEmptyStrings = true)] string Email, [property: Required] int Age, [property: Required] int Version, [property: Required(AllowEmptyStrings = true)] string Display);

public sealed record CreateCustomerResponse([property: Required] Guid Id);

