// Auto-generated.
namespace CatalogApi.Domain.Ids;

public readonly record struct CustomerId(Guid Value)
{
    public static CustomerId New() => new(Guid.CreateVersion7());
    public override string ToString() => Value.ToString()!;
}
