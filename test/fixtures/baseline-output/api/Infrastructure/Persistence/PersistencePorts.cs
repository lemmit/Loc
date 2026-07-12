// Auto-generated.  EF Core adapters for the domain persistence ports (audit S7 Slice C).
using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Linq.Expressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Api.Domain.Common;

namespace Api.Infrastructure.Persistence;

/// <summary>EF adapter for <see cref="IUnitOfWork"/>.  Opens the transaction on
/// the scoped <c>AppDbContext</c> the repositories share, so a repository
/// <c>SaveAsync</c> inside the transaction commits atomically — identical to the
/// pre-port <c>_db.Database.BeginTransactionAsync(...)</c>.</summary>
public sealed class EfUnitOfWork : IUnitOfWork
{
    private readonly AppDbContext _db;
    public EfUnitOfWork(AppDbContext db) => _db = db;

    public async Task<IDomainTransaction> BeginTransactionAsync(CancellationToken cancellationToken = default)
        => new EfDomainTransaction(await _db.Database.BeginTransactionAsync(cancellationToken));

    public async Task<IDomainTransaction> BeginTransactionAsync(IsolationLevel isolationLevel, CancellationToken cancellationToken = default)
        => new EfDomainTransaction(await _db.Database.BeginTransactionAsync(isolationLevel, cancellationToken));
}

/// <summary>Wraps an EF <see cref="IDbContextTransaction"/> as an <see cref="IDomainTransaction"/>.</summary>
public sealed class EfDomainTransaction : IDomainTransaction
{
    private readonly IDbContextTransaction _tx;
    public EfDomainTransaction(IDbContextTransaction tx) => _tx = tx;
    public Task CommitAsync(CancellationToken cancellationToken = default) => _tx.CommitAsync(cancellationToken);
    public Task RollbackAsync(CancellationToken cancellationToken = default) => _tx.RollbackAsync(cancellationToken);
    public ValueTask DisposeAsync() => _tx.DisposeAsync();
}

/// <summary>EF adapter for <see cref="IWorkflowEventStore{TRow}"/> — 1:1 over the
/// scoped <c>AppDbContext</c>; <c>Set&lt;TRow&gt;()</c> resolves the same DbSet as
/// the named <c>&lt;Wf&gt;Events</c> property.</summary>
public sealed class EfWorkflowEventStore<TRow> : IWorkflowEventStore<TRow> where TRow : class, IWorkflowEventRow
{
    private readonly AppDbContext _db;
    public EfWorkflowEventStore(AppDbContext db) => _db = db;

    public Task<List<TRow>> LoadStreamAsync(string streamId, CancellationToken cancellationToken = default)
        => _db.Set<TRow>().Where(e => e.StreamId == streamId).OrderBy(e => e.Version).ToListAsync(cancellationToken);

    public async Task<int> MaxVersionAsync(string streamId, CancellationToken cancellationToken = default)
        => await _db.Set<TRow>().Where(e => e.StreamId == streamId).Select(e => (int?)e.Version).MaxAsync(cancellationToken) ?? 0;

    public void Append(TRow row) => _db.Set<TRow>().Add(row);
    public Task SaveChangesAsync(CancellationToken cancellationToken = default) => _db.SaveChangesAsync(cancellationToken);
}

/// <summary>EF adapter for <see cref="ISagaStateStore{TRow}"/> — <c>FindAsync</c>
/// returns the change-TRACKED entity so a later mutation + <c>SaveChangesAsync</c>
/// persists unchanged.</summary>
public sealed class EfSagaStateStore<TRow> : ISagaStateStore<TRow> where TRow : class
{
    private readonly AppDbContext _db;
    public EfSagaStateStore(AppDbContext db) => _db = db;

    public Task<TRow?> FindAsync(Expression<Func<TRow, bool>> predicate, CancellationToken cancellationToken = default)
        => _db.Set<TRow>().FirstOrDefaultAsync(predicate, cancellationToken);
    public void Add(TRow row) => _db.Set<TRow>().Add(row);
    public Task SaveChangesAsync(CancellationToken cancellationToken = default) => _db.SaveChangesAsync(cancellationToken);
}

/// <summary>EF adapter for <see cref="IReadModelStore{TRow}"/> — same
/// TRACKED-load + upsert + flush as <see cref="EfSagaStateStore{TRow}"/>.</summary>
public sealed class EfReadModelStore<TRow> : IReadModelStore<TRow> where TRow : class
{
    private readonly AppDbContext _db;
    public EfReadModelStore(AppDbContext db) => _db = db;

    public Task<TRow?> FindAsync(Expression<Func<TRow, bool>> predicate, CancellationToken cancellationToken = default)
        => _db.Set<TRow>().FirstOrDefaultAsync(predicate, cancellationToken);
    public void Add(TRow row) => _db.Set<TRow>().Add(row);
    public Task SaveChangesAsync(CancellationToken cancellationToken = default) => _db.SaveChangesAsync(cancellationToken);
}
