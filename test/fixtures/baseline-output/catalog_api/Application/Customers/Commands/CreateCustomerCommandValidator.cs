// Auto-generated.
using FluentValidation;
using System.Text.RegularExpressions;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Customers.Commands;

public sealed class CreateCustomerCommandValidator : AbstractValidator<CreateCustomerCommand>
{
    public CreateCustomerCommandValidator()
    {
        RuleFor(x => x.Username).Must(v => v == null || v.EnumerateRunes().Count() >= 3 && v.EnumerateRunes().Count() <= 32)
            .WithMessage("'{PropertyName}' must be between 3 and 32 characters.");
        RuleFor(x => x.Age).InclusiveBetween(18, 150);
        RuleFor(x => x).Must(x => x.Username != x.Email)
            .WithName("Username")
            .WithMessage("Invariant violated: username != email");
        RuleFor(x => x).Must(x => Regex.IsMatch(x.Email, "^[^@]+@[^@]+\\.[^@]+$") && x.Email.EnumerateRunes().Count() <= 120)
            .WithName("Email")
            .WithMessage("Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120");
    }
}
