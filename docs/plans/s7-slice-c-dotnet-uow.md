# S7 Slice C — .NET `AppDbContext` → domain ports (design)

> Follow-up to merged #1811 (S7 Slice A+B). Replaces the concrete `AppDbContext`
> injected into the 7 .NET orchestration/read handler sites with narrow
> domain-termed ports. **HARD INVARIANT: runtime unchanged** — identical
> transactions, isolation levels, flush timing, and EF change-tracking behavior;
> the EF adapter delegates 1:1 to the same scoped `AppDbContext`.

## Per-site map (exhaustive, fresh `main`)

| # | Site | file:line | `_db` use | Tx? | Writes | Semantics risk |
|---|---|---|---|---|---|---|
| 1 | Transactional command handler (`renderHandler`) | workflow-emit.ts:1206 | **only** `Database.BeginTransactionAsync(IsolationLevel?, ct)` | **yes** (Commit/Rollback) | none (flush via `repo.SaveAsync`) | **none** |
| 2 | Merged ES saga (`renderMergedEventSourcedHandler`/`renderCsEsBranch`) | workflow-emit.ts:898 | stream `Where/OrderBy/ToListAsync` + `MaxAsync`; `.Add` rows; `SaveChangesAsync` | no | append event rows | fold read + gap-free append |
| 3 | Event-saga reactor, persisted (`renderEventReactorHandler`) | workflow-emit.ts:517 | ES: same as 2. State: `FirstOrDefaultAsync` (**tracked**) → mutate `state` → `SaveChangesAsync`; `.Add` on create | no | append / row insert+mutate | **tracked mutation** |
| 4 | WorkflowInstancesController | workflow-emit.ts:2198 | `AsNoTracking` list + `FirstOrDefaultAsync` | no | none | none (read) |
| 5 | Workflow-view handler (`renderWorkflowViewHandler`) | view-emit.ts:332 | `AsNoTracking` [+ WHERE] list | no | none | none (read) |
| 6 | Projection fold (`renderProjectionFoldHandler`) | projection-emit.ts:132 | `FirstOrDefaultAsync` (**tracked**) → `.Add` or mutate → `SaveChangesAsync` | no | row insert+mutate | **tracked mutation** |
| 7 | ProjectionsController | projection-emit.ts:268 | `AsNoTracking` list + `FirstOrDefaultAsync` | no | none | none (read) |

Global: DbSets are accessed by **named property** (`_db.<WfEvents>`), never `_db.Set<T>()`. Command handler injects `I<Agg>Repository` too; `_db` there is *only* transaction control (no literal `SaveChangesAsync` — the single-flush atomicity IS the shared-context transaction).

## The one genuine semantics subtlety (Sites 3-state, 6)

`state = await _db.<Set>.FirstOrDefaultAsync(...)` returns an **EF change-tracked** entity; the handler then does `state.Prop = …` and a single `SaveChangesAsync()` flushes it. To preserve this behind a port, the port's load method MUST return the **same tracked instance** off the **same scoped `AppDbContext`**, and the port's `SaveChangesAsync()` must flush that same context. A port that returned a detached DTO would silently break the update. This is preservable (the adapter returns `_db.Set<TRow>().FirstOrDefaultAsync(...)` — still tracked — and `SaveChangesAsync` on the same context), but it is the thing to get exactly right.

## Recommended port shapes

1. **`IUnitOfWork`** (`Domain.Common`) — Site 1. The commit boundary:
   ```csharp
   public interface IUnitOfWork {
       Task<IDomainTransaction> BeginTransactionAsync(CancellationToken ct = default);
       Task<IDomainTransaction> BeginTransactionAsync(IsolationLevel isolationLevel, CancellationToken ct = default);
   }
   public interface IDomainTransaction : IAsyncDisposable {
       Task CommitAsync(CancellationToken ct = default);
       Task RollbackAsync(CancellationToken ct = default);
   }
   ```
   `EfUnitOfWork` wraps the scoped `AppDbContext`; `BeginTransactionAsync` → `_db.Database.BeginTransactionAsync(...)`, returning an `IDomainTransaction` over the EF `IDbContextTransaction`. Because DI is **scoped**, `EfUnitOfWork` and the repos share the SAME `AppDbContext`, so `repo.SaveAsync` still enrolls in the transaction → atomicity byte-for-byte preserved. **Zero runtime risk.**

2. **`IWorkflowEventStore<TRow>`** (generic over the per-workflow `<Wf>EventRecord`, constrained `where TRow : class, IWorkflowEventRow, new()`) — Sites 2, 3-ES, 4-ES, 5-ES. `IWorkflowEventRow` = `{ string StreamId; int Version; string Type; string Data; DateTime OccurredAt; }` (the shipped record types gain `: IWorkflowEventRow`). Methods: `LoadStreamAsync(streamId, ct)` / `LoadStreamNoTrackingAsync(streamId, ct)` (reads), `LoadAllNoTrackingAsync(ct)` (controller list), `MaxVersionAsync(streamId, ct)`, `Append(TRow)`, `SaveChangesAsync(ct)`. Adapter uses `_db.Set<TRow>()` (resolves the same DbSet as the named property → behavior-equivalent). Registered open-generic: `AddScoped(typeof(IWorkflowEventStore<>), typeof(EfWorkflowEventStore<>))`.

3. **`ISagaStateStore<TRow>`** / **`IReadModelStore<TRow>`** (generic) — Sites 3-state, 6, and the read controllers 4-state/7. Tracked `LoadByKeyAsync(predicate, ct)` (returns the tracked entity for update), `AsNoTracking` `QueryAsync`/`ListAsync` (reads), `Add(TRow)`, `SaveChangesAsync(ct)`. Same open-generic registration + `Set<T>()`.

All adapters live in `Infrastructure.Persistence`, delegate 1:1 to the shared scoped `AppDbContext`. Handler bodies change from inline `_db.<Set>.Where(...)` to `_store.LoadStreamAsync(...)` etc. — **byte-fixtures churn, runtime identical**.

## Open scope/shape questions for sign-off

- **A. Generic vs per-workflow ports.** Recommend the **generic** `Set<T>()`-based ports above (one interface family, open-generic DI) over one interface per workflow/projection (verbose). `Set<T>()` vs named-DbSet is EF-behavior-equivalent. OK?
- **B. Read controllers (Sites 4, 5, 7) — in or out?** They're ASP.NET **controllers** (presentation layer), reading `AsNoTracking`. The S7 layering concern is really the **domain/application** layer touching EF. Options: (i) include them behind the read ports for full consistency (more surface), or (ii) leave the controllers on `AppDbContext` (they're presentation-adjacent) and port only the domain/application handlers (Sites 1,2,3,6). Recommend **(ii)** — smaller, targets the actual layering violation — but will do (i) if you want all 7.
- **C. Dapper persistence path.** Under `persistence: dapper`, `AddDbContext` is replaced. Need to confirm whether ES-saga/projection handlers are even reachable under Dapper (if so the ports need a Dapper adapter or Dapper+sagas is already unsupported). Investigating; may narrow scope to the EF path only.

**Recommendation:** Site 1 `IUnitOfWork` (safe, do unconditionally) + Sites 2,3,6 write ports (generic, tracking-preserved) — the domain/application layer. Leave read controllers (4,5,7) on `AppDbContext` unless you want full coverage. Confirm A/B before I implement the write-port abstraction.
