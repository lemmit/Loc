# 23. Domain services & seeds

Two smaller context-level declarations that sit *beside* the aggregates rather than inside them. A `domainService` is a stateless, named container of `operation`s for a cross-aggregate computation or decision that belongs to the domain layer but to no single aggregate — pure by default, with an opt-in *reading* tier (read-only repository queries) and a *mutating* tier (calling operations on the aggregates passed in), never a repository write. A `seed` is declarative first-boot data: typed records that lower through each aggregate's canonical `create` (so invariants hold), plus a `raw` opt-out for table-level inserts the domain model does not own. Reach for the first when a calculation spans aggregates and has no `this`; reach for the second when the app must boot with rows instead of empty lists.

> **Grammar:** `DomainService`, `DomainServiceOperation`, `Seed`, `SeedRow` · **Validators:** `loom.domain-service-no-emit`, `loom.domain-service-no-mutation`, `loom.domain-service-no-repo-write`, `loom.domain-service-no-workflow-start`, `loom.domain-service-cross-context-read`, `loom.domain-service-read-unsupported`, `loom.domain-service-infra-call-from-aggregate`, `loom.domain-service-single-aggregate`, `loom.resource-op-outside-workflow` (`src/ir/validate/checks/domain-service-checks.ts`); `loom.seed-foreign-aggregate`, `loom.seed-duplicate-field`, `loom.seed-id-needs-raw`, `loom.seed-raw-column-invalid`, `loom.seed-raw-non-literal-column`, `loom.seed-dataset-name-collision`, `loom.seed-raw-document-shape`, `loom.seed-event-sourced-unsupported`, `loom.seed-abstract-aggregate`, `loom.seed-tenant-owned-needs-raw` (`src/language/validators/seed.ts`) · **Docs:** [`../domain-services.md`](../domain-services.md) · [`../old/proposals/database-seeding.md`](../old/proposals/database-seeding.md)

Every tab below is from one five-deployable generation (node / dotnet / python / java / elixir) of the corpus fixtures `test/fixtures/corpus/domain-services.ddd` and `test/fixtures/corpus/seeding.ddd`.

## `domainService` — a stateless calculator

`domainService Name { operation op(params): Type { stmts } }` declares a named container of operations. Each operation takes aggregates / value objects / primitives **by value** (`account: Account` — a plain aggregate name, not `Account id`), returns a value (or an `or`-union — see [Payloads & unions](09-payloads-and-unions.md)), and has no `this` to mutate. Operations are classified by the phase-⑦ validator from their body (derived, never stamped) into three tiers:

| Tier | The body may… | Callable from |
|---|---|---|
| **pure** | params only; `let`, branch, `match`, call other pure services | anywhere — aggregate ops, workflows, other services |
| **reading** | + read-only repository queries of the **same context** (`Accounts.byHolder(h)`, `getById`, `find`/`findAll`/`run`) | application orchestrators only (workflow / handler) |
| **mutating** | + calling operations on the aggregates passed in (`source.withdraw(amount)`) | application orchestrators only |

```ddd
context Accounts {
  valueobject Money { amount: decimal  currency: string  invariant amount >= 0 }
  aggregate Account with crudish {
    holder: string
    balance: Money
    operation withdraw(amount: Money) { balance := Money { amount: balance.amount - amount.amount, currency: balance.currency } }
    operation deposit(amount: Money)  { balance := Money { amount: balance.amount + amount.amount, currency: balance.currency } }
  }
  repository Accounts for Account {
    find byHolder(holder: string): Account? where this.holder == holder
  }

  domainService FeeQuote {                        // pure
    operation forAmount(amount: Money): Money { return Money { amount: amount.amount, currency: amount.currency } }
  }
  domainService Registration {                    // reading
    operation isHolderFree(holder: string): bool { return Accounts.byHolder(holder) == null }
  }
  domainService Transfer {                        // mutating
    operation run(source: Account, dest: Account, amount: Money) {
      source.withdraw(amount)
      dest.deposit(amount)
    }
  }
}
```

The pure tier is a stateless static/module function everywhere; the reading tier diverges by idiom — a read-port **parameter** on node/python, a **DI'd** class/bean on .NET/Java, a **context function** over the ambient `Repo` on Elixir:

::: tabs backend
== node
```ts
// domain/services.ts — one namespace per service
export namespace FeeQuote {
  export function forAmount(amount: Money): Money {
      return new Money(amount.amount, amount.currency);
  }
}

export namespace Registration {                   // reading: the repository port is a parameter
  export async function isHolderFree(accounts: AccountRepositoryPort, holder: string): Promise<boolean> {
      return (await accounts.byHolder(holder)) === null;
  }
}

export namespace Transfer {                       // mutating: plain calls on the passed-in aggregates
  export function run(source: Account, dest: Account, amount: Money) {
      source.withdraw(amount);
      dest.deposit(amount);
  }
}
```
== dotnet
```csharp
// Domain/Services/Transfer.cs — pure / mutating: constructor-less static class
public static class Transfer
{
    public static void Run(Account source, Account dest, Money amount)
    {
        source.Withdraw(amount);
        dest.Deposit(amount);
    }
}
```
```csharp
// Domain/Services/Registration.cs — reading: a DI'd class over the scoped repository (AsNoTracking)
public sealed class Registration
{
    private readonly IAccountRepository _accounts;
    public Registration(IAccountRepository accounts) { _accounts = accounts; }

    public async Task<bool> IsHolderFreeAsync(string holder, CancellationToken cancellationToken = default)
    {
        return (await _accounts.ByHolder(holder, cancellationToken)) == null;
    }
}
```
== java
```java
// domain/services/Registration.java — reading: a @Service bean, read-only transaction
@Service
public class Registration {
    private final AccountRepository accountsRepository;
    public Registration(AccountRepository accountsRepository) { this.accountsRepository = accountsRepository; }

    @Transactional(readOnly = true)
    public boolean isHolderFree(String holder) {
        return accountsRepository.byHolder(holder) == null;
    }
}
```
`FeeQuote.java` / `Transfer.java` are static utility classes with a private constructor.
== python
```python
# app/domain/services/registration.py — reading: the repository port is a parameter
from app.domain.repository_ports import AccountRepositoryPort

async def is_holder_free(accounts: AccountRepositoryPort, holder: str) -> bool:
    return (await accounts.by_holder(holder)) is None
```
```python
# app/domain/services/transfer.py — mutating: bare module functions, no class, no self
def run(source: Account, dest: Account, amount: Money) -> None:
    source.withdraw(amount)
    dest.deposit(amount)
```
== elixir
```elixir
# lib/<app>/domain/services/fee_quote.ex — pure: a plain module (value objects arrive as maps)
defmodule DElixir.Domain.Services.FeeQuote do
  @spec for_amount(map()) :: map()
  def for_amount(amount) do
    %{amount: Map.get(amount, :amount, Map.get(amount, "amount")), currency: Map.get(amount, :currency, Map.get(amount, "currency"))}
  end
end
```
```elixir
# lib/<app>/accounts.ex — reading: a context function over the ambient Repo
@doc "Reading-tier domain service `Registration.isHolderFree` (ambient Repo — domain-services.md rev. 4)."
@spec is_holder_free(String.t()) :: boolean()
def is_holder_free(holder) do
  # …
end
```
The mutating tier has no module of its own on Elixir: `Transfer.run(s, d, amount)` inlines into the calling workflow's `with`-chain as `Context.withdraw_account(s, …)` / `Context.deposit_account(d, …)`.
::: end

The frontends consume only the wire shape and never run domain logic, so they emit nothing here — there is no `frontend` group.

### Calling one — the orchestrator load-protocol

A member call resolves to the `domainService` declaration and lowers to a `Call` with `callKind: "domain-service"` (carrying `serviceRef: { service, op }`), so every backend renders a real call without re-resolving. A **pure** service is callable from anywhere — an aggregate operation included; a **reading** or **mutating** service only from a workflow / handler (`loom.domain-service-infra-call-from-aggregate` otherwise), which loads the aggregates, calls the service, and persists — the workflow's save-at-exit picks up the mutated arguments:

```ddd
workflow RegisterAccount transactional {
  create(holder: string, balance: Money) {
    precondition Registration.isHolderFree(holder)          // reading service as a guard
    let acct = Account.create({ holder: holder, balance: balance })
  }
}
workflow MoveMoney transactional {
  create(source: Account id, dest: Account id, amount: Money) {
    let s = Accounts.getById(source)                         // orchestrator LOADS
    let d = Accounts.getById(dest)
    Transfer.run(s, d, amount)                               // service MUTATES s, d
  }                                                          // both auto-save at exit
}
```

```ts
// http/workflows.ts (node) — the reading call threads the port; the mutating call is followed by the saves
if (!((await Registration.isHolderFree(accounts, holder)))) throw new DomainError("Precondition failed: Registration.isHolderFree(holder)");
// …
Transfer.run(s, d, amount);
await accounts.save(s);
await accounts.save(d);
```

### The no-infra contract (phase ⑦ IR validator)

| Forbidden in a body | Diagnostic |
|---|---|
| `emit` an event | `loom.domain-service-no-emit` |
| A `this`-rooted write (`:=` / `+=` / `-=`) — there is no `this` (`a.n := 2` on a param included) | `loom.domain-service-no-mutation` |
| A repository **write** (`save`/`insert`/`update`/`delete`/`add`/`remove`/`commit`) | `loom.domain-service-no-repo-write` |
| Start a workflow in the same context | `loom.domain-service-no-workflow-start` |
| Read a repository of **another context** — the reading tier is scoped to the service's own context | `loom.domain-service-cross-context-read` |
| A repository read used as a member **receiver** (`Accounts.byN(n).n`) — bind it first (`let x = …`) | `loom.domain-service-read-unsupported` |
| A resource op (`files.put(…)`, `mail.send(…)`) — outbound I/O belongs to the orchestrator | `loom.resource-op-outside-workflow` |
| Calling a reading / mutating service from an aggregate operation | `loom.domain-service-infra-call-from-aggregate` |

Plus an **anemic-domain warning** (`loom.domain-service-single-aggregate`) when every operation takes exactly one aggregate parameter — that behaviour could be an `operation` on the aggregate instead. The cross-context gate is permanent by design: another context's data crosses at its public surface (a `resource { kind: api }` call or a projection over its published events, both from a workflow) — see [`../domain-services.md`](../domain-services.md) § "Cross-context data".

A `domainService` may also carry unit `test` blocks (see [Testing](18-testing.md)); statement bodies only (no `= expr` shorthand), and no `private` / `extern` / `audited` / `when` modifiers.

## `seed` — declarative first-boot data

`seed [dataset] [raw] { Agg { field: value, … } … }` declares typed rows for a context's aggregates. Each row lowers through the aggregate's canonical `create` (per **D-SEED-PATH**), so constructor invariants run — a bad seed throws at boot rather than writing a corrupt row. An unnamed block is the `default` dataset; `default` always runs, other datasets opt in via the `LOOM_SEED` env var (comma-separated); same-named blocks merge. Seeding is **idempotent** (per **D-SEED-IDEMPOTENCY**): a `__loom_seed` marker table records each applied dataset, and a present marker makes the dataset a no-op.

```ddd
seed default {
  Widget { name: "Alpha", size: 1, tier: Free }
  Widget { name: "Beta", size: 2, tier: Pro }
}
seed demo { Widget { name: "Gamma", size: 3, tier: Pro } }
```

Each backend emits a runner that creates the marker table, reads `LOOM_SEED`, and per dataset checks `enabled? && !alreadySeeded` before saving rows through the repository and marking the dataset applied. Field values render through the shared expression path, so enum refs (`Tier.Free`), value objects, `money("…")` and `now()` all render correctly.

::: tabs backend
== node
```ts
// db/seed.ts
async function seedDefault(db: Db, requested: Set<string>): Promise<void> {
  if (!datasetEnabled("default", requested)) return;
  if (await alreadySeeded(db, "default")) return;
  const widgetRepo = new WidgetRepository(db, NoopDomainEventDispatcher);
  await widgetRepo.save(Widget.create({ name: "Alpha", size: 1, tier: Tier.Free }));
  await widgetRepo.save(Widget.create({ name: "Beta", size: 2, tier: Tier.Pro }));
  await markSeeded(db, "default");
}
```
== dotnet
```csharp
// Infrastructure/Persistence/Seed.cs
private static async Task SeedDefault(
    AppDbContext db, IServiceProvider sp, HashSet<string> requested, CancellationToken cancellationToken)
{
    if (!DatasetEnabled("default", requested)) return;
    if (await AlreadySeeded(db, "default", cancellationToken)) return;
    var widgetRepo = sp.GetRequiredService<IWidgetRepository>();
    await widgetRepo.SaveAsync(Widget.Create(name: "Alpha", size: 1, tier: Tier.Free), cancellationToken);
    // …
}
```
== java
```java
// infrastructure/persistence/CatalogSeedRunner.java
private void seedDefault(Set<String> requested) {
    if (!datasetEnabled("default", requested)) return;
    if (alreadySeeded("default")) return;
    widgetsRepository.save(Widget.create("Alpha", 1, Tier.Free));
    widgetsRepository.save(Widget.create("Beta", 2, Tier.Pro));
    markSeeded("default");
    CatalogLog.event("seed_applied", "info", "dataset", "default");
}
```
== python
```python
# app/db/seed.py
async def _seed_default(session: AsyncSession, requested: set[str]) -> None:
    if not _dataset_enabled("default", requested):
        return
    if await _already_seeded(session, "default"):
        return
    widget_repo = WidgetRepository(session, NoopDomainEventDispatcher())
    await widget_repo.save(Widget.create(name="Alpha", size=1, tier=Tier.Free))
    await widget_repo.save(Widget.create(name="Beta", size=2, tier=Tier.Pro))
    await _mark_seeded(session, "default")
```
== elixir
```elixir
# lib/<app>/catalog/seeds.ex — a supervised child (runs at boot); priv/repo/seeds.exs just calls Catalog.Seeds.run()
if dataset_enabled?("default", requested) and
     not already_seeded?("default") do
  # …create_widget!/1 per row…
  mark_seeded("default")
end
```
::: end

A row referencing an aggregate from another context is `loom.seed-foreign-aggregate`; a duplicate field in one row is `loom.seed-duplicate-field`; an explicit `id` on the domain path is `loom.seed-id-needs-raw` (the create path mints ids).

## `seed … raw` — table-level inserts

Suffix a dataset with `raw` to **bypass** the domain `create` and emit a direct `INSERT`. This is the escape hatch for data the domain model does not own, or where you need an explicit `id` and a literal cross-aggregate foreign key (per **D-SEED-XREF**). A `raw` row sets `id` explicitly, and a later row may reference that same literal id as an FK (author-ordered, parent first); no `@handle` indirection. Raw columns are scalar / enum / id literals (or `now()`) only — a value object is `loom.seed-raw-column-invalid`, a computed value `loom.seed-raw-non-literal-column`.

```ddd
seed wired raw {
  Widget { id: "11111111-1111-1111-1111-111111111111", name: "Anchor", size: 4, tier: Free }
  Gadget { id: "22222222-2222-2222-2222-222222222222", widgetId: "11111111-1111-1111-1111-111111111111", label: "g1" }
}
```

The shared `renderSeedRowInsert` (Postgres SQL, schema-qualified) produces the same `INSERT` text on every backend; only the execution call differs.

::: tabs backend
== node
```ts
// db/seed.ts — raw rows are direct SQL, importing no domain class
await db.execute(sql.raw("INSERT INTO \"catalog\".\"widgets\" (\"id\", \"name\", \"size\", \"tier\") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')"));
await db.execute(sql.raw("INSERT INTO \"catalog\".\"gadgets\" (\"id\", \"widget_id\", \"label\") VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'g1')"));
```
== dotnet
```csharp
// Infrastructure/Persistence/Seed.cs
await db.Database.ExecuteSqlRawAsync(@"INSERT INTO ""catalog"".""widgets"" (""id"", ""name"", ""size"", ""tier"") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')", cancellationToken);
```
== java
```java
// infrastructure/persistence/CatalogSeedRunner.java
jdbc.execute("INSERT INTO \"catalog\".\"widgets\" (\"id\", \"name\", \"size\", \"tier\") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')");
```
== python
```python
# app/db/seed.py
await (await session.connection()).exec_driver_sql("INSERT INTO \"catalog\".\"widgets\" (\"id\", \"name\", \"size\", \"tier\") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')")
```
== elixir
```elixir
# lib/<app>/catalog/seeds.ex
Repo.query!("INSERT INTO \"catalog\".\"widgets\" (\"id\", \"name\", \"size\", \"tier\") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')")
Repo.query!("INSERT INTO \"catalog\".\"gadgets\" (\"id\", \"widget_id\", \"label\") VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'g1')")
```
::: end

> The imperative (workflow-shaped) seed body and per-row natural-key upsert are later slices. Honest gap.

### What a seed row may not be

Five crossings parsed clean and then produced a *different* wrong artefact on each backend (`F2-SEED-*`, [targets-completeness-2026-08-30](../audits/targets-completeness-2026-08-30.md), closed by #2700). Each is now one AST-tier rule all five backends inherit, raised before any emitter runs.

| Crossing | Code | Why, and what to write instead |
|---|---|---|
| Two datasets in one context whose names collide once cased into a seeder function (`default` + `Default`, `demoSet` + `demo_set`) | `loom.seed-dataset-name-collision` | Each backend derives the function name by casing (`snake` on elixir/python, PascalCase on node/java/.NET) with no uniquifier, so the two datasets emitted one duplicated function. Rename one, or merge them (same-named blocks already merge). |
| `raw` row on a `shape: document` aggregate | `loom.seed-raw-document-shape` | The table is `(id, data, version)` — no per-field columns for the INSERT to target (`42703` at first boot). Use the domain path. |
| Row on an aggregate `persistedAs: eventLog` | `loom.seed-event-sourced-unsupported` | Its truth is the append-only stream and no backend has a seed path that appends one. Tracked by **M-T6.52**. |
| Row on an `abstract` inheritance base | `loom.seed-abstract-aggregate` | A base has no create factory and no repository. Seed a concrete subtype. |
| Domain-path row on a `tenantOwned` aggregate | `loom.seed-tenant-owned-needs-raw` | The capability stamps `tenantId`/`dataKey` **from the principal**; a first-boot seeder has none, so the row would land with an empty tenant the capability's read filter can never match. Use the `raw` path and spell the tenant columns: |

```ddd
seed wired raw {
  Invoice { id: "11111111-1111-1111-1111-111111111111", tenantId: "acme", dataKey: "acme", label: "Seeded", amount: 5 }
}
```
