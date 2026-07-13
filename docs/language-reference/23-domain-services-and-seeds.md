# 23. Domain services & seeds

Two smaller context-level declarations that sit *beside* the aggregates rather than inside them. A `domainService` is a stateless, named container of non-mutating `operation`s — the pure-calculator floor for a cross-aggregate computation that belongs to the domain layer but to no single aggregate, with a strict no-infrastructure contract. A `seed` is declarative first-boot data: typed records that lower through each aggregate's canonical `create` (so invariants hold), plus a `raw` opt-out for table-level inserts the domain model does not own. Reach for the first when a calculation spans aggregates and has no `this`; reach for the second when the app must boot with rows instead of empty lists.

> **Grammar:** `DomainService`, `DomainServiceOperation`, `Seed`, `SeedRow` · **Validators:** `loom.domain-service-no-emit`, `loom.domain-service-no-mutation`, `loom.domain-service-no-repo`, `loom.domain-service-no-workflow-start`, `loom.domain-service-single-aggregate`, `loom.seed-foreign-aggregate`, `loom.seed-duplicate-field` · **Docs:** [`../domain-services.md`](../domain-services.md) · [`../proposals/database-seeding.md`](../old/proposals/database-seeding.md)

## `domainService` — a stateless pure calculator

`domainService Name { operation op(params): Type { stmts } }` declares a named container of **non-mutating** operations. Each operation takes aggregates / value objects / primitives **by value**, returns a value (or an `or`-union error — see [Payloads & unions](09-payloads-and-unions.md)), and has no `this` to mutate. It fills the gap between an aggregate `operation` (mutates one aggregate) and a `workflow` (orchestrates infrastructure): a cross-aggregate calculation that is pure domain logic.

```ddd
context Catalog {
  valueobject Money { amount: decimal  currency: string }

  domainService Pricing {
    operation lineTotal(unit: Money, qty: int): decimal {
      return unit.amount * qty
    }
  }
}
```

The absence of a constructor / repository injection **is** the no-infra guarantee made physical: every backend emits a stateless module or static class whose parameters resolve as bare locals (`refKind: param`), never `this`.

::: tabs backend
== node
```ts
// domain/services.ts — an exported namespace of pure functions
export namespace Pricing {
  export function lineTotal(unit: Money, qty: number): number {
      return unit.amount * qty;
  }
}
```
== dotnet
```csharp
// Domain/Services/Pricing.cs — constructor-less static class
public static class Pricing
{
    public static decimal LineTotal(Money unit, int qty)
    {
        return unit.Amount * qty;
    }
}
```
== java
```java
// domain/services/Pricing.java — final class, private ctor, static methods
public final class Pricing {
    private Pricing() {
    }

    public static BigDecimal lineTotal(Money unit, int qty) {
        return unit.amount().multiply(qty);
    }
}
```
== python
```python
# app/domain/services/pricing.py — bare module-level functions, no class, no self
from app.domain.value_objects import Money


def line_total(unit: Money, qty: int) -> float:
    return unit.amount * qty
```
== elixir
```elixir
# lib/<app>/domain/services/pricing.ex — plain module, no persistence wiring
defmodule ApiElixir.Domain.Services.Pricing do
  @moduledoc false

  @spec line_total(ApiElixir.Catalog.Money.t(), integer()) :: Decimal.t()
  def line_total(unit, qty) do
    unit.amount * qty
  end
end
```
The Elixir module touches no persistence, so it is independent of the data layer. An unused parameter is discarded as `_ = name` so `mix compile --warnings-as-errors` stays clean.
::: end

All five declaration emitters ship today. The frontends consume only the wire shape and never run domain logic, so they emit nothing here — there is no `frontend` group.

### Calling one

A member call resolves to the `domainService` declaration and lowers to a `Call` with `callKind: "domain-service"` (carrying a structured `serviceRef: { service, op }`), so every backend renders a real call without re-resolving. It is callable from anywhere a pure expression is legal — aggregate operations, workflows, other domain services.

```ddd
aggregate Order {
  operation reprice(catalog: PriceList) {
    let amount = Pricing.lineTotal(this.unit, this.qty)
    this.total := amount
  }
}
```

The shared `ExprTarget.domainServiceCall` leaf renders the call per backend: `Pricing.lineTotal(...)` (TS), `Pricing.LineTotal(...)` (.NET), `Pricing.lineTotal(...)` (Java), the bare `line_total(...)` with a `from app.domain.services.pricing import line_total` import (Python), and `ApiElixir.Domain.Services.Pricing.line_total(...)` (Elixir).

### The no-infra contract (phase ⑦ IR validator)

A domain-service body is restricted to `let` / `precondition` / `requires` / `return` / `expression` / bare `call`. Reaching for infrastructure is a compile error:

| Forbidden in a body | Diagnostic |
|---|---|
| `emit` an event | `loom.domain-service-no-emit` |
| Write state (`:=` / `+=` / `-=`) — there is no `this` | `loom.domain-service-no-mutation` |
| Call a repository in the same context | `loom.domain-service-no-repo` |
| Start a workflow in the same context | `loom.domain-service-no-workflow-start` |

Plus an **anemic-domain warning** (`loom.domain-service-single-aggregate`) when every operation takes exactly one aggregate parameter — that behaviour could be an `operation` on the aggregate instead.

> v1 is Shape A: statement bodies only (no `= expr` shorthand), and no `private` / `extern` / `audited` / `when` modifiers (those are aggregate-operation-only). Parameter-operation mutation (`from.withdraw(x)`) and `extern` / `api` call rejection are deferred to Shape B. Honest gap.

## `seed` — declarative first-boot data

`seed [dataset] { Agg { field: value, … } … }` declares typed rows for a context's aggregates. Each row lowers through the aggregate's canonical `create` (per **D-SEED-PATH**), so constructor invariants run — a bad seed throws at boot rather than writing a corrupt row. An unnamed block is the `default` dataset; `default` always runs, other datasets opt in via the `LOOM_SEED` env var (comma-separated). Seeding is **idempotent** (per **D-SEED-IDEMPOTENCY**): a `__loom_seed` marker table records each applied dataset, and a present marker makes the dataset a no-op.

```ddd
seed default {
  Widget { name: "Alpha", size: 1, tier: Free }
  Widget { name: "Beta", size: 2, tier: Pro }
}
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
    await widgetRepo.SaveAsync(Widget.Create("Alpha", 1, Tier.Free), cancellationToken);
    await widgetRepo.SaveAsync(Widget.Create("Beta", 2, Tier.Pro), cancellationToken);
    await MarkSeeded(db, "default", cancellationToken);
}
```
== java
```java
// infrastructure/persistence/CatalogSeedRunner.java
private void seedDefault(Set<String> requested) {
    // …enabled? + alreadySeeded guards…
    widgetsRepository.save(Widget.create("Alpha", 1, Tier.Free));
    widgetsRepository.save(Widget.create("Beta", 2, Tier.Pro));
    // …markSeeded…
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
# priv/repo/seeds.exs
if dataset_enabled?.("default") and not already_seeded?.("default") do
  ApiElixir.Catalog.create_widget!(%{name: "Alpha", size: 1, tier: :free})
  ApiElixir.Catalog.create_widget!(%{name: "Beta", size: 2, tier: :pro})
  mark_seeded.("default")
end
```
::: end

All five backends emit the marker-table + ship-once scaffolding (`runSeeds` on TS/.NET/Python, the inline guards in Elixir's `seeds.exs`, the Java `CatalogSeedRunner`). A row referencing an aggregate from another context is `loom.seed-foreign-aggregate`; a duplicate field in one row is `loom.seed-duplicate-field`.

## `seed … raw` — table-level inserts

Prefix a block with `raw` to **bypass** the domain `create` and emit a direct `INSERT`. This is the escape hatch for data the domain model does not own (or where you need an explicit `id` and a literal cross-aggregate foreign key — per **D-SEED-XREF**). A `raw` row sets `id` explicitly, and a later row may reference that same literal id as an FK (author-ordered, parent first); no `@handle` indirection.

```ddd
seed wired raw {
  Widget { id: "11111111-1111-1111-1111-111111111111", name: "Anchor", size: 4, tier: Free }
  Gadget { id: "22222222-2222-2222-2222-222222222222", widgetId: "11111111-1111-1111-1111-111111111111", label: "g1" }
}
```

The shared `renderSeedRowInsert` (Postgres SQL) produces the same `INSERT` text on every backend; only the execution call differs. The Gadget's `widgetId` is the literal id the Widget row set above it.

::: tabs backend
== node
```ts
// db/seed.ts — raw rows are direct SQL, importing no domain class
await db.execute(sql.raw("INSERT INTO \"widgets\" (\"id\", \"name\", \"size\", \"tier\") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')"));
await db.execute(sql.raw("INSERT INTO \"gadgets\" (\"id\", \"widget_id\", \"label\") VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'g1')"));
```
== dotnet
```csharp
// Infrastructure/Persistence/Seed.cs
await db.Database.ExecuteSqlRawAsync(@"INSERT INTO ""widgets"" (""id"", ""name"", ""size"", ""tier"") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')", cancellationToken);
await db.Database.ExecuteSqlRawAsync(@"INSERT INTO ""gadgets"" (""id"", ""widget_id"", ""label"") VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'g1')", cancellationToken);
```
== java
```java
// infrastructure/persistence/CatalogSeedRunner.java (schema-qualified table names)
jdbc.execute("INSERT INTO \"catalog\".\"widgets\" (\"id\", \"name\", \"size\", \"tier\") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')");
jdbc.execute("INSERT INTO \"catalog\".\"gadgets\" (\"id\", \"widget_id\", \"label\") VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'g1')");
```
== python
```python
# app/db/seed.py
await (await session.connection()).exec_driver_sql("INSERT INTO \"catalog\".\"widgets\" (\"id\", \"name\", \"size\", \"tier\") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')")
await (await session.connection()).exec_driver_sql("INSERT INTO \"catalog\".\"gadgets\" (\"id\", \"widget_id\", \"label\") VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'g1')")
```
== elixir
```elixir
# priv/repo/seeds.exs
Ecto.Adapters.SQL.query!(repo, ~s(INSERT INTO "widgets" ("id", "name", "size", "tier") VALUES ('11111111-1111-1111-1111-111111111111', 'Anchor', 4, 'Free')), [])
Ecto.Adapters.SQL.query!(repo, ~s(INSERT INTO "gadgets" ("id", "widget_id", "label") VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'g1')), [])
```
::: end

> The imperative (workflow-shaped) seed body, per-row natural-key upsert, and create-shape validation of seed rows are later slices. Honest gap.
