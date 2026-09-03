# 8. Inheritance & polymorphism

> **Grammar:** `abstract` prefix on `Aggregate`, `extends`, `inheritanceUsing:` header modifier · **Validators:** `loom.extends-non-abstract`, `loom.extends-self`, `loom.extends-cycle`, `loom.inheritance-modifier-misplaced`, `loom.abstract-aggregate-behavior`, `loom.abstract-aggregate-contains`, `loom.abstract-repository`, `loom.polymorphic-id-ref-unsupported`, `loom.polymorphic-id-ref-mixed-strategy`, `loom.es-tph-forced-own-table`, `loom.tph-own-override-unsupported`, `loom.tph-filter-unsupported`, `loom.tph-backend-unsupported`, `loom.seed-abstract-aggregate`, `loom.tenancy-inherited-stance-conflict` · **Docs:** [`../inheritance.md`](../inheritance.md)

One aggregate may `extend` another so subtypes share a field set and can be read polymorphically. An `abstract aggregate` declares the base; concrete aggregates `extends` it; the `inheritanceUsing: …` header modifier chooses how the hierarchy maps to tables. The whole chapter hinges on one fork: **`sharedTable` (TPH) — one table plus a `kind` discriminator — vs `ownTable` (TPC) — one table per concrete subtype.** That choice changes the emitted SQL, the polymorphic reader, and whether `<Base> id` references are legal; everything below shows both.

All examples are generated from one scratch `system` (`Parties` TPH + `Assets` TPC) once per backend pin; output is excerpted.

## `abstract aggregate` — the base

`abstract aggregate <Name>` is a base that is never instantiated. It owns **no table, repository, controller, or routes** — only the shared fields the subtypes inherit. It may not declare lifecycle behaviour (`create` / `destroy` / `operation` → `loom.abstract-aggregate-behavior`), may not `contains` a part (`loom.abstract-aggregate-contains` — the base has no reader or writer for the part's table), and no `repository` may target it (`loom.abstract-repository`). A `seed` row on it is rejected too (`loom.seed-abstract-aggregate`).

```ddd
abstract aggregate Party inheritanceUsing: sharedTable {
  name: string
  email: string
  derived display: string = name
  invariant name.length > 0
}
```

**A subtype inherits the base's FIELDS and nothing else.** The enrichment pass merges the base's declared fields (and the root's id value type) into each concrete; a `derived`, an `invariant` or a `function` written on the base is **not** lowered onto the subtype — `Customer._assertInvariants()` is empty on every backend, and `display` reaches the subtype only where the host language has a real base class (.NET / Java inherit `Party.Display` / `display()`; node and Python emit no `display` on `Customer` at all). Declare invariants and derived fields on each concrete. The same rule holds for capabilities — a base's `with tenantOwned` contributes the column, but the stamp / filter / stance stay on the aggregate that declared them ([`../inheritance.md`](../inheritance.md#capabilities-and-inheritance--what-propagates-and-what-does-not)).

The base materialises as a host-language type carrying the shared fields — but no persistence of its own:

::: tabs backend
== node
```ts
// domain/party.ts — a type alias over the concretes, no class of its own
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
    public int Version { get; internal set; } = default!;

    public string Display => this.Name;
}
```
== java
```java
// features/parties/Party.java (TPH) — a JPA SINGLE_TABLE entity
@Entity
@Table(name = "parties", schema = "parties")
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
@DiscriminatorColumn(name = "kind")
public abstract class Party {
    @EmbeddedId protected PartyId id;
    @Column(name = "name") protected String name;
    @Column(name = "email") protected String email;
    public String display() { return this.name; }
}
// (TPC: `@MappedSuperclass public abstract class Asset { … }` — no table of its own)
```
== python
```python
# app/domain/party.py — a union alias, like node
Party = Customer | Supplier
```
== elixir
```elixir
# lib/d/parties/party.ex (TPH) — a base Ecto schema over the SHARED table,
# carrying every concrete's column; used only by the polymorphic reader.
defmodule D.Parties.Party do
  use Ecto.Schema
  @schema_prefix "parties"
  schema "parties" do
    field :kind, :string
    field :name, :string
    field :email, :string
    field :version, :integer, default: 1
    field :credit_limit, :decimal
    field :rating, :integer
    timestamps(type: :utc_datetime)
  end
end
```
::: end

## `extends` — a concrete subtype

`aggregate <X> extends <Base>` is a concrete subtype. `<Base>` must be an `abstract aggregate` in the **same context** (`loom.extends-non-abstract`, `loom.extends-self`; a longer loop is `loom.extends-cycle`). The subtype gets an ordinary repository, routes, and DTO; the enrichment pass merges its `wireShape` as **`id` → base fields (declaration order) → own fields → `version`**, so every backend's DTO for a subtype is the same shape. A like-named own field shadows the base field (the own declaration simply wins — no override semantics).

```ddd
aggregate Customer extends Party with crudish {
  creditLimit: decimal
}
aggregate Supplier extends Party with crudish {
  rating: int
}
```

The merged wire shape, on `Customer`, is `id, name, email, creditLimit, version`:

::: tabs backend
== node
```ts
// http/customer.routes.ts — id → base (name, email) → own (creditLimit) → version
export const CustomerResponse = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  creditLimit: z.number(),
  version: z.number().int(),
}).openapi("CustomerResponse");
```
== dotnet
```csharp
// Domain/Customers/Customer.cs — derives from the base, inherits Name/Email
public sealed class Customer : Party
{
    public decimal CreditLimit { get; private set; } = default!;
    // …
    private void AssertInvariants() { _ = this; }   // the base's invariant is NOT inherited
}
```
== elixir
```elixir
# lib/d/parties/customer.ex (TPH) — its own schema over the SAME table
schema "parties" do
  field :kind, :string
  field :name, :string
  field :email, :string
  field :credit_limit, :decimal
  field :version, :integer, default: 1
  timestamps(type: :utc_datetime)
end
```
::: end

## `inheritanceUsing: …` — the storage strategy

`inheritanceUsing: sharedTable|ownTable` is a **header modifier** on the abstract base (and optionally each concrete). It is legal only on an abstract base or a subtype (`loom.inheritance-modifier-misplaced`); omitted, it defaults to **`sharedTable`**. This single keyword is the whole fork — the same `.ddd` declaration produces fundamentally different schemas:

```ddd
abstract aggregate Party inheritanceUsing: sharedTable { … }   // TPH
abstract aggregate Asset inheritanceUsing: ownTable    { … }   // TPC
```

The SQL the migration emitter derives from the shared `MigrationsIR` is the clearest contrast. (Postgres SQL is byte-identical across node/Hono, Python, and Java — all three consume the same `sql-pg.ts` renderer; .NET wraps the same SQL in an EF `migrationBuilder.Sql(…)` call, and Elixir maps it to an Ecto migration, both shown after.)

::: tabs inheritance
== TPH
```sql
-- db/migrations/…_registry_initial.sql
-- sharedTable: ONE table named for the base + a `kind` discriminator.
-- Every concrete's columns live here; per-concrete columns are forced NULL.
CREATE SCHEMA IF NOT EXISTS "parties";
CREATE TABLE "parties"."parties" (
  "id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "credit_limit" DECIMAL NULL,   -- Customer's, NULL for a Supplier row
  "rating" INTEGER NULL,         -- Supplier's, NULL for a Customer row
  PRIMARY KEY ("id")
);
```
== TPC
```sql
-- ownTable: ONE table per concrete, no base table, no discriminator.
-- Each table carries base + own columns, all NOT NULL.
CREATE SCHEMA IF NOT EXISTS "assets";
CREATE TABLE "assets"."machines" (
  "id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "serial" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);
CREATE TABLE "assets"."vehicles" (
  "id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "plate" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);
```
::: end

The two differences that follow from the table shape:

- **Nullability.** TPH forces every per-concrete column nullable (a `Customer` row has no `rating`); TPC keeps them `NOT NULL` because each table is homogeneous.
- **Discriminator.** TPH adds a non-null `kind` column that every concrete repo stamps and filters on (`where: record.kind == "Customer"` in the Ecto reads, `put_change(:kind, "Customer")` on insert); TPC has none — the table name *is* the type.

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
    builder.ToTable("parties", "parties");
    builder.HasKey(x => x.Id);
    builder.Property(x => x.Name).HasColumnName("name");
    builder.Property(x => x.Email).HasColumnName("email");
    builder.Property(x => x.Version).HasColumnName("version").IsConcurrencyToken();
    builder.HasDiscriminator<string>("kind")
        .HasValue<Customer>("Customer")
        .HasValue<Supplier>("Supplier");
}
// AppDbContext.cs: public DbSet<Party> Parties => Set<Party>();
```
== TPC
```csharp
// Infrastructure/Persistence/AppDbContext.cs — the abstract base is
// excluded from the model; each concrete maps its own table standalone.
modelBuilder.Ignore<Asset>();

// Infrastructure/Persistence/Configurations/MachineConfiguration.cs
public void Configure(EntityTypeBuilder<Machine> builder)
{
    builder.ToTable("machines", "assets");
    builder.HasKey(x => x.Id);
    builder.Property(x => x.Label).HasColumnName("label");
    builder.Property(x => x.Serial).HasColumnName("serial");
}
```
::: end

### Elixir — shared table vs own table

Each concrete gets its own `Ecto.Schema` either way; under TPH they point at the **same** `table` and self-filter on the discriminator in every read, under TPC each names its own table.

::: tabs inheritance
== TPH
```elixir
# lib/d/parties/customer.ex — shared table, discriminator field
schema "parties" do
  field :kind, :string
  # …
end
# lib/d/parties/customer_repository.ex — every read self-filters on `kind`
from(record in D.Parties.Customer, where: record.kind == "Customer")
```
== TPC
```elixir
# lib/d/assets/machine.ex — its own table, no discriminator
@schema_prefix "assets"
schema "machines" do
  field :label, :string
  field :serial, :string
  field :version, :integer, default: 1
  timestamps(type: :utc_datetime)
end
```
::: end

## `find all <Base>` — the polymorphic reader

The abstract base owns no repository, but a polymorphic read home returning the **union of every concrete subtype** is emitted per backend as infrastructure — read-only; writes go through the per-concrete repos. Where a backend emits one, it **delegates to each concrete repository and concatenates** (so every aggregate loads its full tree and through its own capability filters); the exceptions are the backends whose ORM makes the shared TPH table natively polymorphic. Not every backend emits a reader — **Java emits none** (the base is a JPA `SINGLE_TABLE` entity or a `@MappedSuperclass`, nothing more), and **.NET emits none under TPH** (EF's `DbSet<Party>` is already polymorphic through `HasDiscriminator`).

::: tabs backend
== node
```ts
// db/repositories/party-repository.ts — same shape under TPH and TPC:
// delegate to each concrete repo, union the results
export class PartyRepository {
  constructor(db: Db, events: DomainEventDispatcher) {
    this.customerRepo = new CustomerRepository(db, events);
    this.supplierRepo = new SupplierRepository(db, events);
  }
  async findById(id: Ids.PartyId): Promise<Party | null> {
    const customerRepoHit = await this.customerRepo.findById(id as unknown as Ids.CustomerId);
    if (customerRepoHit) return customerRepoHit;
    const supplierRepoHit = await this.supplierRepo.findById(id as unknown as Ids.SupplierId);
    if (supplierRepoHit) return supplierRepoHit;
    return null;
  }
  async findAll(): Promise<Party[]> {
    const results = await Promise.all([this.customerRepo.all(), this.supplierRepo.all()]);
    return results.flat();
  }
}
```
== dotnet
```csharp
// TPC only — Infrastructure/Repositories/AssetRepository.cs (findAll only, no findById)
public async Task<IReadOnlyList<Asset>> FindAllAsync(CancellationToken cancellationToken = default)
{
    var result = new List<Asset>();
    result.AddRange(await _machineRepo.All(cancellationToken));
    result.AddRange(await _vehicleRepo.All(cancellationToken));
    return result;
}
// TPH: no PartyRepository is emitted — `DbSet<Party>` reads the shared table polymorphically.
```
== python
```python
# TPH — app/db/repositories/party_repository.py: reads the shared table once,
# then dispatches each row to its concrete loader by `kind`
async def all(self) -> list[Party]:
    rows = (await self._session.execute(select(PartyRow))).scalars().all()
    return [await self._dispatch(row) for row in rows]

async def _dispatch(self, row: PartyRow) -> Party:
    if row.kind == "Customer":
        return await CustomerRepository(self._session, self._events).get_by_id(CustomerId(row.id))
    elif row.kind == "Supplier":
        return await SupplierRepository(self._session, self._events).get_by_id(SupplierId(row.id))
    raise ValueError(f"unknown Party kind: {row.kind}")

# TPC — asset_repository.py: delegate + concatenate
async def all(self) -> list[Asset]:
    out: list[Asset] = []
    out.extend(await MachineRepository(self._session, self._events).all())
    out.extend(await VehicleRepository(self._session, self._events).all())
    return out
```
== elixir
```elixir
# TPH — lib/d/parties/party_repository.ex: one read over the base schema
def list, do: {:ok, Repo.all(D.Parties.Party)}
def find_by_id(id) when is_binary(id) do
  case Repo.get(D.Parties.Party, id) do
    nil -> {:error, :not_found}
    record -> {:ok, record}
  end
end
# lib/d/parties.ex:  defdelegate list_partys(), to: D.Parties.PartyRepository, as: :list

# TPC — lib/d/assets/asset_repository.ex: reduce over the concrete repos
def list do
  Enum.reduce_while([D.Assets.MachineRepository, D.Assets.VehicleRepository], {:ok, []},
    fn repo, {:ok, acc} ->
      case repo.list() do
        {:ok, rows} -> {:cont, {:ok, acc ++ rows}}
        {:error, _} = err -> {:halt, err}
      end
    end)
end
```
::: end

## `<Base> id` references — TPH only

A `<Base> id` cross-aggregate reference is an FK to the base. Under **TPH** the shared table carries a single identity, so the FK target is unambiguous and the reference is allowed:

```ddd
aggregate Order with crudish { payer: Party id }   // Party is sharedTable
```

```sql
CREATE TABLE "parties"."orders" (
  "id" UUID NOT NULL,
  "payer" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("payer") REFERENCES "parties"."parties" ON DELETE RESTRICT
);
CREATE INDEX "orders_payer_idx" ON "parties"."orders" ("payer");
```

Under **TPC** identity stays per-concrete; there is no shared `<Base>Id` and the FK would be ambiguous across the N concrete tables — so it is rejected at IR-validate time:

```ddd
abstract aggregate Asset inheritanceUsing: ownTable { label: string }
aggregate Machine extends Asset { serial: string }
aggregate Order { asset: Asset id }   // ← rejected under ownTable
```

```
error  loom.polymorphic-id-ref-unsupported
'Asset id' references the abstract base 'Asset', which uses inheritanceUsing: ownTable
(TPC) — there is no single table to key against, so the foreign-key target is ambiguous
across the per-concrete tables. Reference a concrete subtype's id (e.g. 'Customer id'),
or change 'Asset' to inheritanceUsing: sharedTable (TPH) to allow polymorphic references.
```

## Backend gating & validation

Both strategies emit on **all five backends** (node/Hono, .NET, Phoenix, Python, Java). The one storage gate (`loom.tph-backend-unsupported`) fires only when a `sharedTable` hierarchy's context is hosted on **no DB backend** — there is no emission target — and suggests a DB host or `inheritanceUsing: ownTable`.

**One .NET restriction.** EF Core registers a query filter on the **root** entity type only, so under TPH the .NET backend hosts every capability `filter` in the hierarchy on the root config (discriminator-guarded, name-prefixed). A subtype `filter` that reads a column the root does not declare cannot be hosted that way and is rejected (`loom.tph-filter-unsupported`): move the field to the base, switch to `ownTable`, or host the context off .NET.

| Code | Fires when |
|---|---|
| `loom.extends-non-abstract` | `extends` names an aggregate that is not `abstract` |
| `loom.extends-self` / `loom.extends-cycle` | an aggregate `extends` itself / an `extends` loop (`A extends B extends A`) |
| `loom.inheritance-modifier-misplaced` | `inheritanceUsing: …` on an aggregate that is neither an abstract base nor a subtype |
| `loom.abstract-aggregate-behavior` | an abstract base declares `create` / `destroy` / `operation` |
| `loom.abstract-aggregate-contains` | an abstract base declares `contains` — the part would have no reader and no writer |
| `loom.abstract-repository` | a `repository` targets an abstract base |
| `loom.seed-abstract-aggregate` | a `seed` row names an abstract base (no create factory, no repository) |
| `loom.polymorphic-id-ref-unsupported` | a `<Base> id` reference to an `ownTable` (TPC) base |
| `loom.polymorphic-id-ref-mixed-strategy` | a `<Base> id` reference into a hierarchy with an `ownTable` override concrete |
| `loom.es-tph-forced-own-table` | a `persistedAs: eventLog` / `shape: document` concrete under a TPH base must declare `inheritanceUsing: ownTable` explicitly |
| `loom.tph-own-override-unsupported` | a *voluntary* per-concrete `ownTable` override under a TPH base (mixed strategy) |
| `loom.tph-filter-unsupported` | **.NET/EF only** — a TPH subtype `filter` reads a column the hierarchy root lacks |
| `loom.tenancy-inherited-stance-conflict` | a subtype takes the opposite tenancy stance (`crossTenant`) from its `tenantOwned` base |
| `loom.tph-backend-unsupported` | a TPH hierarchy whose context no DB backend hosts |

Mixed-strategy hierarchies (a per-concrete `ownTable` override of a TPH base and the `UNION ALL` reader it would need) are deferred; `contains` on a TPH **concrete** is supported (the part table FKs the shared row). See [`../inheritance.md`](../inheritance.md) for the full strategy comparison and the deferred patterns.
