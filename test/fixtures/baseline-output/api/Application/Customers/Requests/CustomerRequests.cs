// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using Api.Domain.Enums;

namespace Api.Application.Customers.Requests;

public sealed record CreateCustomerRequest([Required(AllowEmptyStrings = true)] string Username, [Required(AllowEmptyStrings = true)] string Email, [Required] int Age);

public sealed record UpdateCustomerRequest([Required(AllowEmptyStrings = true)] string Username, [Required(AllowEmptyStrings = true)] string Email, [Required] int Age);

