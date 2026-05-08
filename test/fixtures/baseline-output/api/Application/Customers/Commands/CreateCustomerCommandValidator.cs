// Auto-generated.
using FluentValidation;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Customers.Commands;

public sealed class CreateCustomerCommandValidator : AbstractValidator<CreateCustomerCommand>
{
    public CreateCustomerCommandValidator()
    {
        RuleFor(x => x.Username).Length(3, 32);
        RuleFor(x => x.Age).InclusiveBetween(18, 150);
        RuleFor(x => x).Must(x => x.Username != x.Email)
            .WithName("Username")
            .WithMessage("Invariant violated: username != email");
        RuleFor(x => x).Must(x => System.Text.RegularExpressions.Regex.IsMatch(x.Email, "^[^@]+@[^@]+\\.[^@]+$") && x.Email.Length <= 120)
            .WithName("Email")
            .WithMessage("Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120");
    }
}
