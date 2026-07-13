// Auto-generated.
using FluentValidation;
using System.Text.RegularExpressions;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Customers.Commands;

public sealed class UpdateCommandValidator : AbstractValidator<UpdateCommand>
{
    public UpdateCommandValidator()
    {
        RuleFor(x => x.Username).Length(3, 32);
        RuleFor(x => x.Age).InclusiveBetween(18, 150);
        RuleFor(x => x).Must(x => x.Username != x.Email)
            .WithName("Username")
            .WithMessage("Invariant violated: username != email");
        RuleFor(x => x).Must(x => Regex.IsMatch(x.Email, "^[^@]+@[^@]+\\.[^@]+$") && x.Email.Length <= 120)
            .WithName("Email")
            .WithMessage("Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120");
    }
}
