# 11. Capabilities, filters & stamps

A `capability` is a **pure typed mixin** — a named bundle of *fields* + a query `filter` + lifecycle `stamp`s that an aggregate (or every aggregate in a context) opts into with `with <Cap>` / `implements <Cap>`. The two building blocks are also usable directly on an aggregate or context: `filter <expr>` AND-s a predicate into every read of the host, and `stamp onCreate|onUpdate { … }` runs assignments at the persistence boundary. Two capabilities ship built in — `auditable` (audit columns + create/update stamps) and `softDeletable` (soft-delete state + read filter) — alongside the `softDelete` / `crudish` operation macros. Reach for this chapter when you want a cross-cutting read rule, automatic audit/tenant stamping, or to bundle either into a reusable opt-in.

> **Grammar:** `Capability`, `CapabilityMember`, `FilterDecl`, `StampDecl`, `ImplementsDecl`, `SelfType` (`Self id`) · **Validators:** `loom.self-outside-capability`, `loom.context-filter-unsupported`, `loom.node-stamp-unsupported`, `loom.python-stamp-unsupported`, `loom.elixir-stamp-unsupported`, `loom.java-stamp-unsupported`; the `with`/`implements` existence check · **Docs:** [`../capabilities.md`](../capabilities.md)

A `capability` is a *pure* mixin: its body is only `Property` / `FilterDecl` / `StampDecl` — never operations or structure (those stay macros, §[`with` / macros](#relationship-to-macros)). Applying it is a pre-link, AST→AST splice in the macro expander, so everything downstream (scope, lower, enrich, validate, codegen) sees the spliced members as if hand-written.

## `capability` — a typed mixin

`capability <Name> { <field>* filter <expr>? stamp <event> {…}* }` declares a reusable bundle. Resolution of a `with`/`implements <Name>` is by the expander's document-wide inventory (built-ins + every `capability` declaration in the workspace), **not** a Langium cross-reference — so a capability is globally visible by name.

```ddd
system Shop {
  user { id: string  tenantId: string }

  capability tenantScoped {
    tenantId: string
    createdAt: datetime managed
    filter this.tenantId == currentUser.tenantId   // every read scoped to the caller's tenant
    stamp onCreate {
      createdAt := now()                            // stamped at persist time
    }
  }

  context Sales {
    aggregate Order with tenantScoped {             // gains the field, the filter, AND the stamp
      subject: string
      total: decimal
    }
  }
}
```

The capability contributes three things to `Order`: the `tenantId` / `createdAt` fields, the tenancy `filter`, and the `onCreate` stamp. The next two sections show the `filter` and `stamp` halves in real generated output; the rest of the chapter covers application, the built-ins, and the validator-gated cases.

## `filter <expr>` — a predicate AND-ed into every read

`filter <expr>` declares a query-filter predicate the backend applies to **every** read of the host aggregate. The expression has `this` in scope and is type-checked exactly like an [invariant](07-invariants-derived-functions.md). At context scope it propagates to every aggregate inside (see [Propagation](#propagation--context-vs-aggregate-scope)). The `filter this.tenantId == currentUser.tenantId` above — a *principal-referencing* predicate — lands at the per-backend read site:

::: tabs backend
== node
Drizzle has no global query filter, so the repository builder AND-s the predicate into every root-table read site (`findById`, `findByIds`, `findAll`), resolving the principal through the ambient `requireCurrentUser()`:
```ts
// db/repositories/order-repository.ts
import { requireCurrentUser } from "../../auth/middleware";

async findById(id: Ids.OrderId): Promise<Order | null> {
  const rootRows = await tx.select().from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.tenantId, requireCurrentUser().tenantId)));
  // …
}
async findAll(): Promise<Order[]> {
  const rootRows = await this.db.select().from(schema.orders)
    .where(eq(schema.orders.tenantId, requireCurrentUser().tenantId));
  // …
}
```
== dotnet
EF Core 10 **named query filters** — one `HasQueryFilter("<Name>", …)` per filter in the entity configuration. The name is derived from the column the predicate touches (`tenantId` → `"TenantIdFilter"`), making multiple capability filters additive (a query bypasses just one via `IgnoreQueryFilters(["TenantIdFilter"])`). EF resolves the DI-scoped principal:
```csharp
// Infrastructure/Persistence/Configurations/OrderConfiguration.cs
public void Configure(EntityTypeBuilder<Order> builder)
{
    // …
    builder.Property(x => x.TenantId).HasColumnName("tenant_id");
    builder.HasQueryFilter("TenantIdFilter", x => x.TenantId == currentUser.TenantId);
}
```
== java
A principal predicate AND-s a SpEL-principal JPQL clause into the scoped `findAll` / `findById` overrides (the non-principal case instead rides a static `@SQLRestriction` on the entity):
```java
// features/orders/OrderJpaRepository.java
@Query("select e from Order e where (e.tenantId = :#{@currentUserAccessor.user()?.tenantId()})")
List<Order> findAll();

@Query("select e from Order e where e.id = :id and (e.tenantId = :#{@currentUserAccessor.user()?.tenantId()})")
Optional<Order> findById(@Param("id") OrderId id);
```
::: end

> **Python — honest gap.** A *principal-referencing* filter on a Python deployable fails fast with `loom.context-filter-unsupported`:
> `Deployable 'apiPython' (platform python) hosts aggregate 'Sales.Order' with a 'filter' capability predicate that references currentUser … principal-referencing capability filters are not yet wired on the python backend.`
> Non-principal filters on relational aggregates (e.g. `filter !this.isDeleted`, below) **are** emitted on Python. Host a tenancy-filtered aggregate on a `.NET` / `node` / `java` / `elixir-Ash` deployable.

> **Deferred intersection.** One shape stays gated by `loom.context-filter-unsupported` on the query-layer backends (node / java / phoenix): a principal predicate on a **non-relational** (`shape(document)` / `shape(embedded)`) aggregate — binding the request actor *and* reaching into a jsonb column on the always-on read path. **.NET handles it** (EF's `HasQueryFilter` resolves the principal and queries jsonb transparently — the one backend with no deferred filter cases). See [`../capabilities.md`](../capabilities.md#deferred-cases).

### Reifying a named `criterion`

A filter that is *exactly* one named [`criterion`](../criterion.md) (`filter NotDeleted`) **reifies** instead of inlining: Hono calls the module-level `<name>Criterion` predicate fn and Phoenix references an Ash boolean calculation (`base_filter expr(active)`), deduped with any find/retrieval consumers of the same criterion. Behaviour-identical to the inline form; only the code organisation differs.

## `stamp onCreate|onUpdate { … }` — lifecycle assignments

`stamp <event> { <assign>* }` runs assignments on every create (`onCreate`) or update (`onUpdate`) of the host. The body is the same statement shape as an `operation` body, with `this` in scope; `now()` and `currentUser` resolve normally. The `stamp onCreate { createdAt := now() }` from §[`capability`](#capability--a-typed-mixin) lands at each backend's persistence boundary:

::: tabs backend
== node
A `_stampOnCreate` method on the aggregate (`now()` → `new Date()`), called by the route handler right before save:
```ts
// domain/order.ts
_stampOnCreate(): void {
  this._createdAt = new Date();
}
```
```ts
// http/order.routes.ts — handler calls it before persist
const created = Order.create({ subject: body.subject, total: body.total, tenantId: body.tenantId });
created._stampOnCreate();
await repo.save(created);
```
== dotnet
A `SaveChangesInterceptor` (`AuditableInterceptor`) on the `DbContext`, firing at save time with a per-entity-type switch (one arm per stamping aggregate), keyed on `entry.State`. `now()` → `DateTime.UtcNow`:
```csharp
// Infrastructure/Persistence/AuditableInterceptor.cs
foreach (var entry in ctx.ChangeTracker.Entries())
{
    if (entry.State != EntityState.Added && entry.State != EntityState.Modified) continue;
    switch (entry.Entity)
    {
        case Order e:
            if (entry.State == EntityState.Added)
            {
                e.CreatedAt = DateTime.UtcNow;
            }
            break;
        default: break;
    }
}
```
== java
An entity `_stampOnCreate()` hook (`now()` → `Instant.now()`), invoked by the service before `repository.save(...)`:
```java
// features/orders/Order.java
void _stampOnCreate() {
    this.createdAt = Instant.now();
}
```
```java
// features/orders/OrderService.java
aggregate._stampOnCreate();
repository.save(aggregate);
```
::: end

> `onUpdate` stamps run on update; on the elixir and .NET backends an `onUpdate` rule also fires on the initial insert (mirroring EF's `Added || Modified`) so a NOT-NULL `updated_*` column is filled on create.

### Validator-gated stamp cases

Each domain-logic backend gates two cases with a `loom.<plat>-stamp-unsupported` code (`validateNodeStampSupport` / `…PythonStampSupport` / `…ElixirStampSupport` / `…JavaStampSupport`):

- a `currentUser` stamp on a deployable **without** `auth` (no principal to thread), and
- **any** stamp on an **event-sourced** aggregate.

## `with <Cap>` / `implements <Cap>` — applying a capability

`with` and `implements` are synonyms for applying a capability: the expander deep-clones the capability's members (fields + `filter` + `stamp`) into the host. They differ only in that `with` *also* drives macros, so a `with` clause can name a mix of capabilities and macros.

```ddd
aggregate Order with softDeletable, auditable { subject: string }
// equivalent, capabilities only:
aggregate Order { subject: string  implements softDeletable  implements auditable }
```

A `with`/`implements` naming neither a declared capability nor a macro is an **error** — the existence check the old free-string `implements "X"` surface lacked.

## Propagation — context vs aggregate scope

`filter` / `stamp` / `with` / `implements` are admissible at **both** aggregate and context scope. At context scope they fan out to every aggregate in the context (filters/stamps propagate at lowering, `src/ir/lower/lower-capabilities.ts`; capability application splices at expansion):

| Declaration | Applies to |
|---|---|
| `filter <expr>` at aggregate scope | that aggregate |
| `stamp <event> {…}` at aggregate scope | that aggregate |
| `filter <expr>` / `stamp <event> {…}` at **context** scope | every aggregate in the context |
| `with <Cap>` / `implements <Cap>` at **context** scope | the capability is applied to every aggregate in the context |

## `Self id` — self-reference inside a capability

A capability that needs to reference its own implementor uses `Self id`; the expander rewrites `Self id` → `<Host> id` when it splices the capability into each aggregate (so a hierarchy capability yields a concrete `Order id`, `Customer id`, … per host). `Self id` **outside** a capability is a validation error (`loom.self-outside-capability`).

```ddd
capability hierarchical {
  parent: Self id?           // becomes `parent: Order id?` when applied to Order
}
```

## `ignoring` — bypassing a filter at a read site

A repository `find` (or an inline `Repo.findAll(...)` call) can bypass capability filters with a trailing `ignoring` clause — `ignoring *` drops every capability filter on the aggregate, `ignoring A, B` drops exactly those capabilities'. `ignoring` is a *soft* keyword (a field or parameter named `ignoring` still parses).

```ddd
repository Orders for Order {
  find recent(): Order[] where total > 0 ignoring softDeletable   // skips the soft-delete filter
  find allRows(): Order[] ignoring *                              // skips every capability filter
}
```

## Built-in `auditable` & `softDeletable`

Two capabilities ship in the toolchain prelude (`src/macros/prelude.ts`) — usable by name with nothing declared. A user `capability` of the same name wins (the prelude is a default, not an override).

- **`auditable`** = `createdAt` / `updatedAt` (`managed datetime`) + `createdBy` / `updatedBy` (`managed User id`) + `stamp onCreate { createdAt := now()  createdBy := currentUser }` + `stamp onUpdate { updatedAt := now()  updatedBy := currentUser }`.
- **`softDeletable`** = `isDeleted` (`internal bool`) + `deletedAt` (`managed datetime?`) + `filter !this.isDeleted`. The `softDelete()` / `restore()` *operations* are a separate macro (`softDelete`) — a capability is a pure mixin — so compose `with softDeletable, softDelete`.

```ddd
context Inventory {
  aggregate Item with auditable, softDeletable, softDelete {
    name: string
  }
}
```

The `softDeletable` `filter !this.isDeleted` is **non-principal**, so all five backends emit it (including Python):

::: tabs backend
== node
```ts
// db/repositories/item-repository.ts — !isDeleted AND-ed into every read
const rootRows = await this.db.select().from(schema.items).where(not(eq(schema.items.isDeleted, true)));
```
== dotnet
```csharp
// Infrastructure/Persistence/Configurations/ItemConfiguration.cs — named query filter
builder.HasQueryFilter("IsDeletedFilter", x => !x.IsDeleted);
```
== python
```python
# app/db/repositories/item_repository.py
rows = (await self._session.execute(select(ItemRow).where(not_(ItemRow.is_deleted)))).scalars().all()
```
== elixir
```elixir
# lib/<app>/inventory/item.ex — Ash base_filter inside resource do … end
base_filter expr(not is_deleted)
```
::: end

The `auditable` stamps thread `currentUser` (the stamp method takes the principal; `now()` → the host's clock):

::: tabs backend
== node
```ts
// domain/item.ts
_stampOnCreate(currentUser: User): void {
  this._createdAt = new Date();
  this._createdBy = currentUser.id;
}
_stampOnUpdate(currentUser: User): void {
  this._updatedAt = new Date();
  this._updatedBy = currentUser.id;
}
```
== dotnet
```csharp
// Infrastructure/Persistence/AuditableInterceptor.cs — one switch arm per stamping aggregate
case Item e:
    if (entry.State == EntityState.Added)
    {
        e.CreatedAt = DateTime.UtcNow;
        e.CreatedBy = RequestContext.Current!.CurrentUser!.Id;
    }
    if (entry.State == EntityState.Added || entry.State == EntityState.Modified)
    {
        e.UpdatedAt = DateTime.UtcNow;
        e.UpdatedBy = RequestContext.Current!.CurrentUser!.Id;
    }
    break;
```
== python
```python
# app/domain/item.py
def _stamp_on_create(self, current_user: User) -> None:
    self._created_at = datetime.now(UTC)
    self._created_by = current_user.id

def _stamp_on_update(self, current_user: User) -> None:
    self._updated_at = datetime.now(UTC)
    self._updated_by = current_user.id
```
== elixir
```elixir
# lib/<app>/inventory/item.ex — Ash changes block; principal read off the threaded actor
changes do
  change fn changeset, context ->
      current_user = context.actor
      changeset
      |> Ash.Changeset.force_change_attribute(:created_at, DateTime.utc_now())
      |> Ash.Changeset.force_change_attribute(:created_by, current_user.id)
    end,
    on: [:create]
  change fn changeset, context ->
      current_user = context.actor
      changeset
      |> Ash.Changeset.force_change_attribute(:updated_at, DateTime.utc_now())
      |> Ash.Changeset.force_change_attribute(:updated_by, current_user.id)
    end,
    on: [:create, :update]   # onUpdate also fires on insert → NOT-NULL updated_* filled
end
```
::: end

The `softDelete` macro contributes the operations the capability deliberately omits:

```ts
// domain/item.ts (node)
public softDelete(): void {
  this._isDeleted = true;
  this._deletedAt = new Date();
  this._assertInvariants();
}
public restore(): void {
  this._isDeleted = false;
  this._deletedAt = null;
  this._assertInvariants();
}
```

## Relationship to macros

A `capability` subsumes the field/filter/stamp surface; **operations and structure stay macros** — `softDelete` (the `softDelete()`/`restore()` ops), `softDeleteByDefault` (context-wide application), `crudish` (a `update(...)` plus canonical `create(...)` / `destroy {}` built from the host's writable fields), and the `scaffold*` family. `crudish` reads the host's field list and excludes capability-contributed fields (`createdAt`, `isDeleted`, …) and non-payload access modifiers from its generated parameters. See [`../scaffold-macros.md`](../scaffold-macros.md).

## Validation rules

- A `with`/`implements` naming no declared capability **and** no macro is an error.
- A capability with no implementors is allowed (declared but unused).
- A capability's `filter` / `stamp` body type-checks against **each** implementing aggregate — e.g. a `stamp onCreate { createdBy := currentUser }` requires every implementor to carry a `createdBy` field; a missing field is an IR-validation error.
- `Self id` outside a capability → `loom.self-outside-capability`.
- Principal-filter / stamp support per backend is gated by the `loom.context-filter-unsupported` and `loom.<plat>-stamp-unsupported` codes above.
