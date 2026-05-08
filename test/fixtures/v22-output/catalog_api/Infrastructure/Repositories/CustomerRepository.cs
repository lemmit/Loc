// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using CatalogApi.Domain.Customers;
using CatalogApi.Domain.Common;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Infrastructure.Persistence;

namespace CatalogApi.Infrastructure.Repositories;

public sealed class CustomerRepository : ICustomerRepository
{
    private readonly AppDbContext _db;
    private readonly IDomainEventDispatcher _events;

    public CustomerRepository(AppDbContext db, IDomainEventDispatcher events)
    {
        _db = db;
        _events = events;
    }

    public async Task<Customer?> GetByIdAsync(CustomerId id, CancellationToken ct = default)
    {
        return await _db.Customers.FirstOrDefaultAsync(x => x.Id == id, ct);
    }

    public async Task<System.Collections.Generic.IReadOnlyList<Customer>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<CustomerId> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return System.Array.Empty<Customer>();
        return await _db.Customers.Where(x => ids.Contains(x.Id)).ToListAsync(ct);
    }

    public async Task SaveAsync(Customer aggregate, CancellationToken ct = default)
    {
        var entry = _db.Entry(aggregate);
        if (entry.State == EntityState.Detached)
        {
            _db.Customers.Add(aggregate);
        }
        await _db.SaveChangesAsync(ct);
        foreach (var ev in aggregate.PullEvents())
        {
            await _events.DispatchAsync(ev, ct);
        }
    }
    public async Task<List<Customer>> All(System.Threading.CancellationToken ct = default)
    {
        return await _db.Customers.ToListAsync(ct);
    }
    public async Task<Customer?> ByEmail(string email, System.Threading.CancellationToken ct = default)
    {
        return await _db.Customers.Where(x => x.Email == email).FirstOrDefaultAsync(ct);
    }
}
