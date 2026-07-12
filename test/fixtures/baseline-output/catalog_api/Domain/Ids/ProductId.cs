// Auto-generated.
namespace CatalogApi.Domain.Ids;

public readonly record struct ProductId(Guid Value)
{
    public static ProductId New() => new(Guid.CreateVersion7());
    public override string ToString() => Value.ToString()!;
}
