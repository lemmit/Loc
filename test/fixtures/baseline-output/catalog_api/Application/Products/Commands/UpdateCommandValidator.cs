// Auto-generated.
using FluentValidation;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Commands;

public sealed class UpdateCommandValidator : AbstractValidator<UpdateCommand>
{
    public UpdateCommandValidator()
    {
        RuleFor(x => x.Sku).Must(v => v == null || v.EnumerateRunes().Count() >= 1)
            .WithMessage("'{PropertyName}' must be at least 1 characters.");
    }
}
