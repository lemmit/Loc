// Auto-generated.
using FluentValidation;

namespace Api.Application.Products.Requests;

public sealed class MoneyRequestValidator : AbstractValidator<MoneyRequest>
{
    public MoneyRequestValidator()
    {
        RuleFor(x => x.Amount).GreaterThanOrEqualTo(0);
        RuleFor(x => x.Currency).Length(3, 3);
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
