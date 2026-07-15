// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Api.Domain.Orders;
using Api.Domain.Common;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Infrastructure.Persistence;

namespace Api.Infrastructure.Repositories;

public sealed class OrderRepository : IOrderRepository
{
    private readonly AppDbContext _db;
    private readonly IDomainEventDispatcher _events;
    private readonly ILogger<OrderRepository> _log;

    public OrderRepository(AppDbContext db, IDomainEventDispatcher events, ILogger<OrderRepository> log)
    {
        _db = db;
        _events = events;
        _log = log;
    }

    public async Task<Order?> GetByIdAsync(OrderId id, CancellationToken cancellationToken = default)
    {
        var found = await _db.Orders.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id} found={Found}", "aggregate_loaded", "Order", id.Value, found != null);
        return found;
    }

    public async Task<IReadOnlyList<Order>> FindManyByIdsAsync(IReadOnlyList<OrderId> ids, CancellationToken cancellationToken = default)
    {
        if (ids.Count == 0) return Array.Empty<Order>();
        return await _db.Orders.Where(x => ids.Contains(x.Id)).ToListAsync(cancellationToken);
    }

    public async Task SaveAsync(Order aggregate, CancellationToken cancellationToken = default)
    {
        var entry = _db.Entry(aggregate);
        if (entry.State == EntityState.Detached)
        {
            _db.Orders.Add(aggregate);
        }
        if (entry.State != EntityState.Added && entry.State != EntityState.Detached)
        {
            var __version = entry.Property(x => x.Version);
            var __expected = RequestContext.Current?.ExpectedVersion;
            if (__expected.HasValue) __version.OriginalValue = __expected.Value;
            __version.CurrentValue = __version.OriginalValue + 1;
        }
        await _db.SaveChangesAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id}", "repository_save", "Order", aggregate.Id.Value);
        foreach (var ev in aggregate.PullEvents())
        {
            _log.LogInformation("{Event} event_type={EventType} aggregate={Aggregate} id={Id}", "event_dispatched", ev.GetType().Name, "Order", aggregate.Id.Value);
            await _events.DispatchAsync(ev, cancellationToken);
        }
    }

    public async Task DeleteAsync(Order aggregate, CancellationToken cancellationToken = default)
    {
        _db.Orders.Remove(aggregate);
        await _db.SaveChangesAsync(cancellationToken);
    }
    public async Task<Paged<Order>> All(int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default)
    {
        var offset = (page - 1) * pageSize;
        var sortColumn = sort switch { "customerId" => "CustomerId", "status" => "Status", "placedAt" => "PlacedAt", "version" => "Version", _ => "Id" };
        var total = await _db.Orders.CountAsync(cancellationToken);
        var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;
        var ordered = dir == "desc" ? _db.Orders.OrderByDescending(e => EF.Property<object>(e, sortColumn)) : _db.Orders.OrderBy(e => EF.Property<object>(e, sortColumn));
        var items = await ordered.Skip(offset).Take(pageSize).ToListAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "all", items.Count);
        return new Paged<Order>(items, page, pageSize, total, totalPages);
    }
    public async Task<List<Order>> ByCustomer(string customerId, CancellationToken cancellationToken = default)
    {
        var result = await _db.Orders.Where(x => x.CustomerId == customerId).ToListAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "byCustomer", result.Count);
        return result;
    }
    public async Task<List<Order>> ActiveOrders(CancellationToken cancellationToken = default)
    {
        var result = await _db.Orders.Where(x => x.Status == OrderStatus.Confirmed).ToListAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "ActiveOrders", result.Count);
        return result;
    }
    public async Task<List<Order>> OrderSummary(CancellationToken cancellationToken = default)
    {
        var result = await _db.Orders.Where(x => x.Status != OrderStatus.Cancelled).ToListAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "OrderSummary", result.Count);
        return result;
    }
}
