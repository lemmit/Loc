// Auto-generated.
using System;
using Api.Domain.Common;

namespace Api.Domain.ValueObjects;

public sealed record Money
{
    public decimal Amount { get; init; }
    public string Currency { get; init; }
    public Money(decimal amount, string currency)
    {
        Amount = amount;
        Currency = currency;
        if (!(this.Amount >= 0)) throw new DomainException("Invariant violated: amount >= 0");
        if (!(this.Currency.Length == 3)) throw new DomainException("Invariant violated: currency.length == 3");
    }

    /// <summary>Parameterless constructor reserved for EF Core / serializers.</summary>
    private Money()
    {
        Amount = default!;
        Currency = default!;
    }

}
