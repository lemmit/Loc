// Auto-generated.
namespace Api.Domain.Ids;

public readonly record struct OrderId(Guid Value)
{
    public static OrderId New() => new(Guid.CreateVersion7());
    public override string ToString() => Value.ToString()!;
}
