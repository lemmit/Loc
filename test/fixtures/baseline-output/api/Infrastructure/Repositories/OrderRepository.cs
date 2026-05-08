// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
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

    public OrderRepository(AppDbContext db, IDomainEventDispatcher events)
    {
        _db = db;
        _events = events;
    }

    public async Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default)
    {
        return await _db.Orders.FirstOrDefaultAsync(x => x.Id == id, ct);
    }

    public async Task<System.Collections.Generic.IReadOnlyList<Order>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<OrderId> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return System.Array.Empty<Order>();
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
        foreach (var ev in aggregate.PullEvents())
        {
            await _events.DispatchAsync(ev, ct);
        }
    }
    public async Task<List<Order>> All(System.Threading.CancellationToken ct = default)
    {
        return await _db.Orders.ToListAsync(ct);
    }
    public async Task<List<Order>> ByCustomer(string customerId, System.Threading.CancellationToken ct = default)
    {
        return await _db.Orders.Where(x => x.CustomerId == customerId).ToListAsync(ct);
    }
    public async Task<List<Order>> ActiveOrders(System.Threading.CancellationToken ct = default)
    {
        return await _db.Orders.Where(x => x.Status == OrderStatus.Confirmed).ToListAsync(ct);
    }
    public async Task<List<Order>> OrderSummary(System.Threading.CancellationToken ct = default)
    {
        return await _db.Orders.Where(x => x.Status != OrderStatus.Cancelled).ToListAsync(ct);
    }
}
