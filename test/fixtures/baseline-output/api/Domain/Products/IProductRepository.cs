// Auto-generated.
using Api.Domain.Ids;

namespace Api.Domain.Products;

public interface IProductRepository
{
    System.Threading.Tasks.Task<Product?> GetByIdAsync(ProductId id, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<System.Collections.Generic.IReadOnlyList<Product>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<ProductId> ids, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task SaveAsync(Product aggregate, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<List<Product>> All(System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<Product?> BySku(string sku, System.Threading.CancellationToken ct = default);
}
