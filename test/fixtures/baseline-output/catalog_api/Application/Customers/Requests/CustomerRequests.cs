// Auto-generated.
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Customers.Requests;

public sealed record CreateCustomerRequest([Required] string Username, [Required] string Email, [Required] int Age);

