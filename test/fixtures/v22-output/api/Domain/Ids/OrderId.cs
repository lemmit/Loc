// Auto-generated.
namespace Api.Domain.Ids;

public readonly record struct OrderId(Guid Value)
{
    public static OrderId New() => new(Guid.NewGuid());
    public override string ToString() => Value.ToString()!;
}
