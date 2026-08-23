// Auto-generated.
using FluentValidation;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Products.Commands;

public sealed class UpdateCommandValidator : AbstractValidator<UpdateCommand>
{
    public UpdateCommandValidator()
    {
        RuleFor(x => x.Sku).Must(v => v == null || v.EnumerateRunes().Count() >= 1)
            .WithMessage("'{PropertyName}' must be at least 1 characters.");
    }
}
