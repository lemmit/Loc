// Auto-generated.
using FluentValidation;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Orders.Commands;

public sealed class AddLineCommandValidator : AbstractValidator<AddLineCommand>
{
    public AddLineCommandValidator()
    {
        RuleFor(x => x.Qty).GreaterThanOrEqualTo(1);
    }
}
