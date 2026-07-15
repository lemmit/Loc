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

    public async Task<Product?> GetByIdAsync(ProductId id, CancellationToken cancellationToken = default)
    {
        var found = await _db.Products.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id} found={Found}", "aggregate_loaded", "Product", id.Value, found != null);
        return found;
    }

    public async Task<IReadOnlyList<Product>> FindManyByIdsAsync(IReadOnlyList<ProductId> ids, CancellationToken cancellationToken = default)
    {
        if (ids.Count == 0) return Array.Empty<Product>();
        return await _db.Products.Where(x => ids.Contains(x.Id)).ToListAsync(cancellationToken);
    }

    public async Task SaveAsync(Product aggregate, CancellationToken cancellationToken = default)
    {
        var entry = _db.Entry(aggregate);
        if (entry.State == EntityState.Detached)
        {
            _db.Products.Add(aggregate);
        }
        if (entry.State != EntityState.Added && entry.State != EntityState.Detached)
        {
            var __version = entry.Property(x => x.Version);
            var __expected = RequestContext.Current?.ExpectedVersion;
            if (__expected.HasValue) __version.OriginalValue = __expected.Value;
            __version.CurrentValue = __version.OriginalValue + 1;
        }
        await _db.SaveChangesAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id}", "repository_save", "Product", aggregate.Id.Value);
        foreach (var ev in aggregate.PullEvents())
        {
            _log.LogInformation("{Event} event_type={EventType} aggregate={Aggregate} id={Id}", "event_dispatched", ev.GetType().Name, "Product", aggregate.Id.Value);
            await _events.DispatchAsync(ev, cancellationToken);
        }
    }

    public async Task DeleteAsync(Product aggregate, CancellationToken cancellationToken = default)
    {
        _db.Products.Remove(aggregate);
        await _db.SaveChangesAsync(cancellationToken);
    }
    public async Task<Paged<Product>> All(int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default)
    {
        var offset = (page - 1) * pageSize;
        var sortColumn = sort switch { "sku" => "Sku", _ => "Id" };
        var total = await _db.Products.CountAsync(cancellationToken);
        var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;
        var ordered = dir == "desc" ? _db.Products.OrderByDescending(e => EF.Property<object>(e, sortColumn)) : _db.Products.OrderBy(e => EF.Property<object>(e, sortColumn));
        var items = await ordered.Skip(offset).Take(pageSize).ToListAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Product", "all", items.Count);
        return new Paged<Product>(items, page, pageSize, total, totalPages);
    }
    public async Task<Product?> BySku(string sku, CancellationToken cancellationToken = default)
    {
        var result = await _db.Products.Where(x => x.Sku == sku).FirstOrDefaultAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Product", "bySku", result == null ? 0 : 1);
        return result;
    }
}
