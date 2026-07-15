// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
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
    private readonly ILogger<CustomerRepository> _log;

    public CustomerRepository(AppDbContext db, IDomainEventDispatcher events, ILogger<CustomerRepository> log)
    {
        _db = db;
        _events = events;
        _log = log;
    }

    public async Task<Customer?> GetByIdAsync(CustomerId id, CancellationToken cancellationToken = default)
    {
        var found = await _db.Customers.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id} found={Found}", "aggregate_loaded", "Customer", id.Value, found != null);
        return found;
    }

    public async Task<IReadOnlyList<Customer>> FindManyByIdsAsync(IReadOnlyList<CustomerId> ids, CancellationToken cancellationToken = default)
    {
        if (ids.Count == 0) return Array.Empty<Customer>();
        return await _db.Customers.Where(x => ids.Contains(x.Id)).ToListAsync(cancellationToken);
    }

    public async Task SaveAsync(Customer aggregate, CancellationToken cancellationToken = default)
    {
        var entry = _db.Entry(aggregate);
        if (entry.State == EntityState.Detached)
        {
            _db.Customers.Add(aggregate);
        }
        if (entry.State != EntityState.Added && entry.State != EntityState.Detached)
        {
            var __version = entry.Property(x => x.Version);
            var __expected = RequestContext.Current?.ExpectedVersion;
            if (__expected.HasValue) __version.OriginalValue = __expected.Value;
            __version.CurrentValue = __version.OriginalValue + 1;
        }
        await _db.SaveChangesAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} id={Id}", "repository_save", "Customer", aggregate.Id.Value);
        foreach (var ev in aggregate.PullEvents())
        {
            _log.LogInformation("{Event} event_type={EventType} aggregate={Aggregate} id={Id}", "event_dispatched", ev.GetType().Name, "Customer", aggregate.Id.Value);
            await _events.DispatchAsync(ev, cancellationToken);
        }
    }

    public async Task DeleteAsync(Customer aggregate, CancellationToken cancellationToken = default)
    {
        _db.Customers.Remove(aggregate);
        await _db.SaveChangesAsync(cancellationToken);
    }
    public async Task<Paged<Customer>> All(int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default)
    {
        var offset = (page - 1) * pageSize;
        var sortColumn = sort switch { "username" => "Username", "email" => "Email", "age" => "Age", _ => "Id" };
        var total = await _db.Customers.CountAsync(cancellationToken);
        var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;
        var ordered = dir == "desc" ? _db.Customers.OrderByDescending(e => EF.Property<object>(e, sortColumn)) : _db.Customers.OrderBy(e => EF.Property<object>(e, sortColumn));
        var items = await ordered.Skip(offset).Take(pageSize).ToListAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Customer", "all", items.Count);
        return new Paged<Customer>(items, page, pageSize, total, totalPages);
    }
    public async Task<Customer?> ByEmail(string email, CancellationToken cancellationToken = default)
    {
        var result = await _db.Customers.Where(x => x.Email == email).FirstOrDefaultAsync(cancellationToken);
        _log.LogDebug("{Event} aggregate={Aggregate} find={Find} rows={Rows}", "find_executed", "Customer", "byEmail", result == null ? 0 : 1);
        return result;
    }
}
