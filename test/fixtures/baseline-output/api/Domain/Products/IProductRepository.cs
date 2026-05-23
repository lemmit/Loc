// Auto-generated.
using Api.Domain.Ids;

namespace Api.Domain.Products;

public interface IProductRepository
{
    Task<Product?> GetByIdAsync(ProductId id, CancellationToken ct = default);
    Task<IReadOnlyList<Product>> FindManyByIdsAsync(IReadOnlyList<ProductId> ids, CancellationToken ct = default);
    Task SaveAsync(Product aggregate, CancellationToken ct = default);
    Task<List<Product>> All(CancellationToken ct = default);
    Task<Product?> BySku(string sku, CancellationToken ct = default);
}
