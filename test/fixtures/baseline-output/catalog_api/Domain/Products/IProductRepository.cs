// Auto-generated.
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.Enums;
using CatalogApi.Domain.Common;

namespace CatalogApi.Domain.Products;

public interface IProductRepository
{
    Task<Product?> GetByIdAsync(ProductId id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<Product>> FindManyByIdsAsync(IReadOnlyList<ProductId> ids, CancellationToken cancellationToken = default);
    Task SaveAsync(Product aggregate, CancellationToken cancellationToken = default);
    Task DeleteAsync(Product aggregate, CancellationToken cancellationToken = default);
    Task<Paged<Product>> All(int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default);
    Task<Product?> BySku(string sku, CancellationToken cancellationToken = default);
}
