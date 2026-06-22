# 8. Inheritance & polymorphism

> **Grammar:** `abstract aggregate`, `extends`, `inheritanceUsing` · **Validators:** `loom.extends-non-abstract`, `loom.extends-self`, `loom.inheritance-modifier-misplaced`, `loom.abstract-aggregate-behavior`, `loom.abstract-repository`, `loom.polymorphic-id-ref-unsupported` · **Docs:** [`../inheritance.md`](../inheritance.md)

One aggregate may `extend` another so subtypes share a field set and can be read polymorphically. An `abstract aggregate` declares the base; concrete aggregates `extends` it; the `inheritanceUsing(…)` header modifier chooses how the hierarchy maps to tables. The whole chapter hinges on one fork: **`sharedTable` (TPH) — one table plus a `kind` discriminator — vs `ownTable` (TPC) — one table per concrete subtype.** That choice changes the emitted SQL, the polymorphic reader, and whether `<Base> id` references are legal; everything below shows both.

## `abstract aggregate` — the base

`abstract aggregate <Name>` is a base that is never instantiated. It owns **no table, repository, controller, or routes** — only the shared fields (and `derived` getters / `invariant`s / `function`s) the subtypes inherit. It may **not** declare lifecycle behaviour (`create` / `operation` → `loom.abstract-aggregate-behavior`) or have a `repository` target it (`loom.abstract-repository`).

```ddd
abstract aggregate Party inheritanceUsing(sharedTable) {
  name: string
  email: string
  derived display: string = name
}
```

The base materialises as a host-language abstract type carrying the shared fields — but no persistence of its own.

::: tabs backend
== node
```ts
// domain/party.ts (TPH) — a tagged union of the concretes, no class of its own
import type { Customer } from "./customer";
import type { Supplier } from "./supplier";

// Polymorphic Party — the tagged union of its concrete subtypes
// (discriminated by the shared table's `kind` column at the data layer).
export type Party = Customer | Supplier;
```
== dotnet
```csharp
// Domain/Parties/Party.cs (TPH) — abstract class, the concretes derive from it
// Abstract TPH base — the whole hierarchy maps to one table named
// for this base; it owns the shared Id + a 'kind' discriminator.
public abstract class Party
{
    public PartyId Id { get; internal set; } = default!;
    public string Name { get; internal set; } = default!;
    public string Email { get; internal set; } = default!;
    public string Display => this.Name;
}
```
== elixir
```elixir
# lib/elixir_api/parties.ex — the base owns no Ash.Resource; only a
# polymorphic read on the context domain (see `find all <Base>` below).
```
::: end

## `extends` — a concrete subtype

`aggregate <X> extends <Base>` is a concrete subtype. `<Base>` must be an `abstract aggregate` in the **same context** (`loom.extends-non-abstract`, `loom.extends-self`). The subtype gets an ordinary repository, routes, and DTO; the enrichment pass merges its `wireShape` as **`id` → base fields (declaration order) → own fields**, so every backend's DTO for a subtype is the same shape. A like-named own field shadows the base field (the own declaration simply wins — no override semantics).

```ddd
aggregate Customer extends Party with crudish {
  creditLimit: decimal
}
aggregate Supplier extends Party with crudish {
  rating: int
}
```

The merged wire shape, on `Customer`, is `id, name, email, creditLimit`:

::: tabs backend
== node
```ts
// http/customer.routes.ts — id → base (name, email) → own (creditLimit)
export const CustomerResponse = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  creditLimit: z.number(),
}).openapi("CustomerResponse");
```
== dotnet
```csharp
// Domain/Customers/Customer.cs — derives from the base, inherits Name/Email
public sealed class Customer : Party
{
    public decimal CreditLimit { get; internal set; }
}
```
::: end

## `inheritanceUsing(…)` — the storage strategy

`inheritanceUsing(sharedTable | ownTable)` is a **header modifier** on the abstract base (and optionally each concrete). It is legal only on an abstract base or a subtype (`loom.inheritance-modifier-misplaced`); omitted, it defaults to **`sharedTable`**. This single keyword is the whole fork — the same `.ddd` declaration produces fundamentally different schemas:

```ddd
abstract aggregate Party inheritanceUsing(sharedTable) { … }   // TPH
abstract aggregate Party inheritanceUsing(ownTable)    { … }   // TPC
```

The SQL the migration emitter derives from the shared `MigrationsIR` is the clearest contrast. (Postgres SQL is byte-identical across node/Hono, Python, and Java — all three consume the same `sql-pg.ts` renderer; .NET wraps the same SQL in an EF `migrationBuilder.Sql(…)` call, and Elixir maps via Ecto, both shown after.)

::: tabs inheritance
== TPH
```sql
-- sharedTable: ONE table named for the base + a `kind` discriminator.
-- Every concrete's columns live here; per-concrete columns are forced NULL.
CREATE SCHEMA IF NOT EXISTS parties;
CREATE TABLE parties.parties (
  id UUID NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  credit_limit DECIMAL NULL,   -- Customer's, NULL for a Supplier row
  rating INTEGER NULL,         -- Supplier's, NULL for a Customer row
  PRIMARY KEY (id)
);
```
== TPC
```sql
-- ownTable: ONE table per concrete, no base table, no discriminator.
-- Each table carries base + own columns, all NOT NULL.
CREATE SCHEMA IF NOT EXISTS parties;
CREATE TABLE parties.customers (
  id UUID NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  credit_limit DECIMAL NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE parties.suppliers (
  id UUID NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  rating INTEGER NOT NULL,
  PRIMARY KEY (id)
);
```
::: end

The two differences that follow from the table shape:

- **Nullability.** TPH forces every per-concrete column nullable (a `Customer` row has no `rating`); TPC keeps them `NOT NULL` because each table is homogeneous.
- **Discriminator.** TPH adds a non-null `kind` column that every concrete repo stamps and filters on; TPC has none — the table name *is* the type.

### .NET — `HasDiscriminator` vs `Ignore<Base>`

.NET maps the hierarchy through EF Core, so the strategy shows up in the entity configuration, not just the raw SQL.

::: tabs inheritance
== TPH
```csharp
// Infrastructure/Persistence/Configurations/PartyConfiguration.cs
// EF native TPH: the base maps the shared table + discriminator; the
// concretes are derived entities sharing it — no per-concrete config.
public void Configure(EntityTypeBuilder<Party> builder)
{
    builder.ToTable("parties");
    builder.HasKey(x => x.Id);
    builder.Property(x => x.Name).HasColumnName("name");
    builder.Property(x => x.Email).HasColumnName("email");
    builder.HasDiscriminator<string>("kind")
        .HasValue<Customer>("Customer")
        .HasValue<Supplier>("Supplier");
}
```
== TPC
```csharp
// Infrastructure/Persistence/AppDbContext.cs — the abstract base is
// excluded from the model; each concrete maps its own table standalone.
modelBuilder.Ignore<Party>();

// Infrastructure/Persistence/Configurations/CustomerConfiguration.cs
public void Configure(EntityTypeBuilder<Customer> builder)
{
    builder.ToTable("customers", "parties");
    builder.HasKey(x => x.Id);
    builder.Property(x => x.CreditLimit).HasColumnName("credit_limit");
}
```
::: end

### Elixir — shared table + `base_filter` vs own table

The Ash backend gives each concrete its own `Ash.Resource` either way; under TPH they point at the **same** `table` and self-filter on the discriminator via `base_filter`, under TPC each names its own table.

::: tabs inheritance
== TPH
```elixir
# lib/elixir_api/parties/customer.ex — shared table, discriminator filter
postgres do
  table "parties"
  repo ElixirApi.Repo
end
resource do
  base_filter expr(kind == "Customer")
end
attributes do
  attribute :kind, :string, default: "Customer", allow_nil?: false
end
```
== TPC
```elixir
# lib/elixir_api/parties/customer.ex — its own table, no discriminator
postgres do
  table "customers"
  repo ElixirApi.Repo
end
```
::: end

## `find all <Base>` — the polymorphic reader

The abstract base owns no repository, but both strategies provide a polymorphic read home returning the **union of every concrete subtype**. It is emitted per backend as infrastructure. The implementations diverge by strategy: under **TPH** there is one physical table, so the reader selects it once and dispatches on `kind`; under **TPC** the rows live in separate tables, so the reader **delegates to each concrete repository and concatenates** (which also means contained parts and `X id[]` associations load through the concrete loaders, not a flat column union).

::: tabs inheritance
== TPH
```ts
// db/repositories/party-repository.ts — single shared table, hydrate by `kind`
export class PartyRepository {
  async findAll(): Promise<Party[]> {
    const rows = await this.db.select().from(schema.parties);
    return rows.map(hydrateParty);
  }
}
function hydrateParty(row: PartyRow): Party {
  switch (row.kind) {
    case "Customer":
      return Customer._create({ id: Ids.CustomerId(row.id), name: row.name!, email: row.email!, creditLimit: Number(row.creditLimit!) });
    case "Supplier":
      return Supplier._create({ id: Ids.SupplierId(row.id), name: row.name!, email: row.email!, rating: row.rating! });
    default:
      throw new Error(`unknown Party kind: ${row.kind}`);
  }
}
```
== TPC
```ts
// db/repositories/party-repository.ts — delegate to each concrete repo + union
// Read-only — writes go through the per-concrete repos.
export class PartyRepository {
  constructor(db: Db, events: DomainEventDispatcher) {
    this.customerRepo = new CustomerRepository(db, events);
    this.supplierRepo = new SupplierRepository(db, events);
  }
  async findAll(): Promise<Party[]> {
    const results = await Promise.all([
      this.customerRepo.all(),
      this.supplierRepo.all(),
    ]);
    return results.flat();
  }
}
```
::: end

The same shape across the other backends — TPH reads the shared table; TPC delegates and unions:

::: tabs backend
== node
```ts
// (shown above) PartyRepository.findAll(): Promise<Party[]>
// — TPH hydrates the `parties` table by `kind`; TPC unions the concrete repos.
```
== dotnet
```csharp
// TPC: Infrastructure/Repositories/PartyRepository.cs — explicit delegating reader
public async Task<IReadOnlyList<Party>> FindAllAsync(CancellationToken ct = default)
{
    var result = new List<Party>();
    result.AddRange(await _customerRepo.All(ct));
    result.AddRange(await _supplierRepo.All(ct));
    return result;
}
// TPH: no PartyRepository is emitted — EF's HasDiscriminator makes the
// shared DbSet<Party> natively polymorphic, so the base reads through EF.
```
== elixir
```elixir
# lib/elixir_api/parties.ex — context domain gains list_<bases>!/0 = the union
@spec list_parties!() :: [ElixirApi.Parties.Customer.t() | ElixirApi.Parties.Supplier.t()]
def list_parties!, do: list_customers!() ++ list_suppliers!()
def list_parties, do: {:ok, list_parties!()}
```
== python
```python
# app — read-only Party repository whose find_all concatenates each concrete read
```
== java
```java
// PartyRepository.findAll() concatenates each concrete repository's reads,
// returning the List<Party> union.
```
::: end

## `<Base> id` references — TPH only

A `<Base> id` cross-aggregate reference is an FK to the base. Under **TPH** the shared table carries a single identity, so the FK target is unambiguous and the reference is allowed (the base reader also exposes a `findById`). Under **TPC** identity stays per-concrete (each keeps its own `<Concrete>Id`); there is no shared `<Base>Id` and the FK would be ambiguous across the N concrete tables — so it is rejected at IR-validate time:

```ddd
abstract aggregate Party inheritanceUsing(ownTable) { name: string }
aggregate Customer extends Party { creditLimit: decimal }
aggregate Order { payer: Party id }   // ← rejected under ownTable
```

```
error  loom.polymorphic-id-ref-unsupported
'Party id' references the abstract base 'Party', which uses inheritanceUsing(ownTable)
(TPC) — there is no single table to key against, so the foreign-key target is ambiguous
across the per-concrete tables. Reference a concrete subtype's id (e.g. 'Customer id'),
or change 'Party' to inheritanceUsing(sharedTable) (TPH) to allow polymorphic references.
```

The TPC readers therefore expose `findAll` only — no polymorphic `findById` target.

## Backend gating & validation

Both strategies emit on **all five backends** (node/Hono, .NET, Phoenix/Ash, Python, Java). The one gate is a storage one: a `sharedTable` (TPH) hierarchy whose context is hosted on **no DB backend** is an IR-validate **error** (there is no emission target) — it names the offending platform and suggests either a DB-backend host or switching to `inheritanceUsing(ownTable)`.

| Code | Fires when |
|---|---|
| `loom.extends-non-abstract` | `extends` names an aggregate that is not `abstract` |
| `loom.extends-self` | an aggregate `extends` itself |
| `loom.inheritance-modifier-misplaced` | `inheritanceUsing(…)` on an aggregate that is neither an abstract base nor a subtype |
| `loom.abstract-aggregate-behavior` | an abstract base declares `create` / `operation` lifecycle behaviour |
| `loom.abstract-repository` | a `repository` targets an abstract base |
| `loom.polymorphic-id-ref-unsupported` | a `<Base> id` reference to an `ownTable` (TPC) base |

Mixed-strategy hierarchies (a per-concrete `ownTable` override of a TPH base) are deferred — see [`../inheritance.md`](../inheritance.md) for the full strategy comparison, the `contains`-on-a-TPH-concrete (TPT) behaviour, and the deferred patterns.
