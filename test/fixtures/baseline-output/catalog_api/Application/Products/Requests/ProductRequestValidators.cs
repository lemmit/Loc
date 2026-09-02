// Auto-generated.
using FluentValidation;

namespace CatalogApi.Application.Products.Requests;

public sealed class MoneyRequestValidator : AbstractValidator<MoneyRequest>
{
    public MoneyRequestValidator()
    {
        RuleFor(x => x.Amount).GreaterThanOrEqualTo(0);
        RuleFor(x => x.Currency).Must(v => v == null || v.EnumerateRunes().Count() == 3)
            .WithMessage("'{PropertyName}' must be exactly 3 characters.");
    }
}

public sealed class CreateProductRequestValidator : AbstractValidator<CreateProductRequest>
{
    public CreateProductRequestValidator()
    {
        RuleFor(x => x.Price).SetValidator(new MoneyRequestValidator());
    }
}

public sealed class UpdateProductRequestValidator : AbstractValidator<UpdateProductRequest>
{
    public UpdateProductRequestValidator()
    {
        RuleFor(x => x.Price).SetValidator(new MoneyRequestValidator());
    }
}
