// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using CatalogApi.Domain.Products;
using CatalogApi.Domain.Common;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Infrastructure.Persistence;

namespace CatalogApi.Infrastructure.Repositories;

public sealed class ProductRepository : IProductRepository
{
    private readonly AppDbContext _db;
    private readonly IDomainEventDispatcher _events;

    public ProductRepository(AppDbContext db, IDomainEventDispatcher events)
    {
        _db = db;
        _events = events;
    }

    public async Task<Product?> GetByIdAsync(ProductId id, CancellationToken ct = default)
    {
        return await _db.Products.FirstOrDefaultAsync(x => x.Id == id, ct);
    }

    public async Task<System.Collections.Generic.IReadOnlyList<Product>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<ProductId> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return System.Array.Empty<Product>();
        return await _db.Products.Where(x => ids.Contains(x.Id)).ToListAsync(ct);
    }

    public async Task SaveAsync(Product aggregate, CancellationToken ct = default)
    {
        var entry = _db.Entry(aggregate);
        if (entry.State == EntityState.Detached)
        {
            _db.Products.Add(aggregate);
        }
        await _db.SaveChangesAsync(ct);
        foreach (var ev in aggregate.PullEvents())
        {
            await _events.DispatchAsync(ev, ct);
        }
    }
    public async Task<List<Product>> All(System.Threading.CancellationToken ct = default)
    {
        return await _db.Products.ToListAsync(ct);
    }
    public async Task<Product?> BySku(string sku, System.Threading.CancellationToken ct = default)
    {
        return await _db.Products.Where(x => x.Sku == sku).FirstOrDefaultAsync(ct);
    }
}
