// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Api.Domain.Products;
using Api.Domain.Common;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Infrastructure.Persistence;

namespace Api.Infrastructure.Repositories;

public sealed class ProductRepository : IProductRepository
{
    private readonly AppDbContext _db;
    private readonly IDomainEventDispatcher _events;
    private readonly ILogger<ProductRepository> _log;

    public ProductRepository(AppDbContext db, IDomainEventDispatcher events, ILogger<ProductRepository> log)
    {
        _db = db;
        _events = events;
        _log = log;
    }

    public async Task<Product?> GetByIdAsync(ProductId id, CancellationToken ct = default)
    {
        var found = await _db.Products.FirstOrDefaultAsync(x => x.Id == id, ct);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id} found={Found}", "aggregate_loaded", "Product", id.Value, found != null);
        return found;
    }

    public async Task<IReadOnlyList<Product>> FindManyByIdsAsync(IReadOnlyList<ProductId> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return Array.Empty<Product>();
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
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id}", "repository_save", "Product", aggregate.Id.Value);
        foreach (var ev in aggregate.PullEvents())
        {
            _log.LogInformation("{Event} event_type={EventType} aggregate={Aggregate} id={Id}", "event_dispatched", ev.GetType().Name, "Product", aggregate.Id.Value);
            await _events.DispatchAsync(ev, ct);
        }
    }
    public async Task<List<Product>> All(CancellationToken ct = default)
    {
        var result = await _db.Products.ToListAsync(ct);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Product", "all", result.Count);
        return result;
    }
    public async Task<Product?> BySku(string sku, CancellationToken ct = default)
    {
        var result = await _db.Products.Where(x => x.Sku == sku).FirstOrDefaultAsync(ct);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Product", "bySku", result == null ? 0 : 1);
        return result;
    }
}
