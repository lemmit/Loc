// Auto-generated.
namespace Api.Domain.Ids;

public readonly record struct OrderLineId(Guid Value)
{
    public static OrderLineId New() => new(Guid.NewGuid());
    public override string ToString() => Value.ToString()!;
}
