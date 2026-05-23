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

    public async Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default)
    {
        var found = await _db.Orders.FirstOrDefaultAsync(x => x.Id == id, ct);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id} found={Found}", "aggregate_loaded", "Order", id.Value, found != null);
        return found;
    }

    public async Task<IReadOnlyList<Order>> FindManyByIdsAsync(IReadOnlyList<OrderId> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return Array.Empty<Order>();
        return await _db.Orders.Where(x => ids.Contains(x.Id)).ToListAsync(ct);
    }

    public async Task SaveAsync(Order aggregate, CancellationToken ct = default)
    {
        var entry = _db.Entry(aggregate);
        if (entry.State == EntityState.Detached)
        {
            _db.Orders.Add(aggregate);
        }
        await _db.SaveChangesAsync(ct);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id}", "repository_save", "Order", aggregate.Id.Value);
        foreach (var ev in aggregate.PullEvents())
        {
            _log.LogInformation("{Event} event_type={EventType} aggregate={Aggregate} id={Id}", "event_dispatched", ev.GetType().Name, "Order", aggregate.Id.Value);
            await _events.DispatchAsync(ev, ct);
        }
    }
    public async Task<List<Order>> All(CancellationToken ct = default)
    {
        var result = await _db.Orders.ToListAsync(ct);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "all", result.Count);
        return result;
    }
    public async Task<List<Order>> ByCustomer(string customerId, CancellationToken ct = default)
    {
        var result = await _db.Orders.Where(x => x.CustomerId == customerId).ToListAsync(ct);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "byCustomer", result.Count);
        return result;
    }
    public async Task<List<Order>> ActiveOrders(CancellationToken ct = default)
    {
        var result = await _db.Orders.Where(x => x.Status == OrderStatus.Confirmed).ToListAsync(ct);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "ActiveOrders", result.Count);
        return result;
    }
    public async Task<List<Order>> OrderSummary(CancellationToken ct = default)
    {
        var result = await _db.Orders.Where(x => x.Status != OrderStatus.Cancelled).ToListAsync(ct);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Order", "OrderSummary", result.Count);
        return result;
    }
}
