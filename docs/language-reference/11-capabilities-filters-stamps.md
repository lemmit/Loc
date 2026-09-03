# 11. Capabilities, filters & stamps

A `capability` is a **pure typed mixin** — a named bundle of *fields* + a query `filter` + lifecycle `stamp`s that an aggregate (or every aggregate in a context) opts into with `with <Cap>` / `implements <Cap>`. The two building blocks are also usable directly on an aggregate or context: `filter <expr>` AND-s a predicate into every read of the host, and `stamp onCreate|onUpdate { … }` runs assignments at the persistence boundary. Five capabilities ship built in — `auditable`, `softDeletable`, `tenantOwned`, `tenantRegistry`, and `versioned` (applied to every aggregate by default) — alongside the `softDelete` / `softDeleteByDefault` / `crudish` operation macros. Reach for this chapter when you want a cross-cutting read rule, automatic audit/tenant stamping, or to bundle either into a reusable opt-in.

> **Grammar:** `Capability`, `CapabilityMember`, `FilterDecl`, `StampDecl`, `StampEvent`, `ImplementsDecl`, `WithClause`, `SelfType` (`Self id`), `IgnoringClause` · **Validators:** `loom.unknown-capability`, `loom.unknown-macro`, `loom.capability-host-invalid`, `loom.self-outside-capability`, `loom.criterion-not-selectable`, `loom.context-filter-unsupported`, `loom.stamp-principal-without-auth`, `loom.stamp-on-event-sourced-invalid`, `loom.stamp-read-before-flush`, `loom.softdelete-field-collision`, `loom.version-field-collision`, `loom.filter-bypass-unknown-capability` / `-no-filter`, `loom.ignoring-clause-placement`, `loom.tph-filter-unsupported`, `loom.tenant-owned-without-tenancy` / `loom.tenant-owned-claim-type` / `loom.tenant-registry-without-tenancy`, `loom.audit-history-ungated` · **Docs:** [`../capabilities.md`](../capabilities.md), [`../tenancy.md`](../tenancy.md), [`../scaffold-macros.md`](../scaffold-macros.md)

A `capability` is a *pure* mixin: its body is only `Property` / `FilterDecl` / `StampDecl` — never operations or structure (those stay macros, §[Relationship to macros](#relationship-to-macros)). Applying it is a pre-link, AST→AST splice in the macro expander, so everything downstream (scope, lower, enrich, validate, codegen) sees the spliced members as if hand-written. All examples are generated from one scratch `system` (`user { id  tenantId }`, `auth: required`, a `Sales.Order` and an `Inventory.Item`) once per backend pin; output is excerpted.

## `capability` — a typed mixin

`capability <Name> { <field>* filter <expr>? stamp <event> {…}* }` declares a reusable bundle. Resolution of a `with`/`implements <Name>` is by the expander's document-wide inventory (built-ins + every `capability` declaration in the workspace), **not** a Langium cross-reference — so a capability is globally visible by name.

```ddd
system Shop {
  user { id: string  tenantId: string }

  capability tenantScoped {
    tenantId: string
    createdAt: datetime managed
    touchedAt: datetime managed
    filter this.tenantId == currentUser.tenantId   // every read scoped to the caller's tenant
    stamp onCreate { createdAt := now() }           // stamped at persist time
    stamp onUpdate { touchedAt := now() }
  }

  subdomain D {
    context Sales {
      aggregate Order with tenantScoped, crudish {  // gains the fields, the filter, AND the stamps
        subject: string
        total: decimal
      }
    }
  }
}
```

The capability contributes three things to `Order`: the `tenantId` / `createdAt` / `touchedAt` fields, the tenancy `filter`, and the two stamps. The next two sections show the `filter` and `stamp` halves in real generated output; the rest of the chapter covers application, the built-ins, and the validator-gated cases.

## `filter <expr>` — a predicate AND-ed into every read

`filter <expr>` declares a query-filter predicate the backend applies to **every** read of the host aggregate (by-id, by-ids, list, every declared find, every projection sourced from it). The expression has `this` in scope and must lower to the [queryable subset](10-repositories-and-queries.md#the-queryable-subset) (`loom.criterion-not-selectable` otherwise). At context scope it propagates to every aggregate inside (see [Propagation](#propagation--context-vs-aggregate-scope)). The *principal-referencing* `filter this.tenantId == currentUser.tenantId` above lands at the per-backend read site — **on all five backends**:

::: tabs backend
== node
Drizzle has no global query filter, so the repository builder AND-s the predicate into every root-table read, resolving the principal through the ambient `requireCurrentUser()`:
```ts
// db/repositories/order-repository.ts
import { requireCurrentUser } from "../../auth/middleware";

const rootRows = await tx.select().from(schema.orders).where(and(eq(schema.orders.id, id), eq(schema.orders.tenantId, requireCurrentUser().tenantId)));          // findById
const countRows = await this.db.select({ value: count() }).from(schema.orders).where(eq(schema.orders.tenantId, requireCurrentUser().tenantId));            // all()
```
== dotnet
EF Core **named query filters** — one `HasQueryFilter("<Name>", …)` per filter. The name is derived from the column the predicate touches (`tenantId` → `"TenantIdFilter"`), so multiple capability filters are additive and `ignoring` can bypass just one (`IgnoreQueryFilters(["TenantIdFilter"])`). A principal filter is registered on the `DbContext` (it needs the DI-scoped principal); a non-principal one lives in the entity configuration:
```csharp
// Infrastructure/Persistence/AppDbContext.cs
modelBuilder.Entity<Order>().HasQueryFilter("TenantIdFilter", x => x.TenantId == _currentUser.User.TenantId);
// Infrastructure/Persistence/Configurations/ItemConfiguration.cs (non-principal, softDeletable)
builder.HasQueryFilter("IsDeletedFilter", x => !x.IsDeleted);
```
== java
A principal predicate AND-s a SpEL-principal JPQL clause into every read of the JPA repository (the non-principal case instead rides a static `@SQLRestriction` on the entity — see `softDeletable` below):
```java
// features/orders/OrderJpaRepository.java
@Query("select e from Order e where (e.tenantId = :#{@currentUserAccessor.user()?.tenantId()})")
Page<Order> findAllPaged(Pageable pageable);
@Query("select e from Order e where e.id = :id and (e.tenantId = :#{@currentUserAccessor.user()?.tenantId()})")
Optional<Order> findById(@Param("id") OrderId id);
```
== python
```python
# app/db/repositories/order_repository.py
from app.auth.user import require_current_user

row = (await self._session.execute(select(OrderRow).where(and_(OrderRow.id == id, (OrderRow.tenant_id == require_current_user().tenant_id))))).scalars().first()
```
== elixir
The principal is threaded as a `current_user` argument into every repository read:
```elixir
# lib/api/sales/order_repository.ex
def list(page \\ 1, page_size \\ 20, sort \\ "id", dir \\ "asc", current_user \\ nil) do
  query = from(record in Api.Sales.Order, where: record.tenant_id == ^(current_user && current_user.tenant_id))
  # …
end
def find_by_id(id, current_user \\ nil) when is_binary(id) do
  case Repo.one(from(record in Api.Sales.Order, where: record.id == ^id and (record.tenant_id == ^(current_user && current_user.tenant_id)))) do
```
::: end

Every backend family wires capability filters on every persistence shape (relational, `shape: document`, `shape: embedded`); there is no per-backend deferral table. (The one shape-specific consequence: a query-time `projection` that aggregates *in SQL* over a filtered `shape: document` aggregate has no column to name — `loom.projection-document-source-capability-filtered`; per-row reads still apply the filter on hydration.) The one gate is shape- and backend-independent: a principal-referencing filter needs a request principal, so a deployable **without** `auth: required` (and a system `user {}` block) hosting one is `loom.context-filter-unsupported`. The one *storage* restriction is .NET/EF under TPH inheritance (`loom.tph-filter-unsupported` — [chapter 8](08-inheritance-and-polymorphism.md#backend-gating--validation)).

### Reifying a named `criterion`

A filter that is *exactly* one named [`criterion`](../criterion.md) (`capability activeOnly { filter Active }`) **reifies** on node — a module-level `<name>Criterion` predicate function, shared with every find / retrieval consumer of the same criterion — while the other backends inline the predicate at each read. Behaviour-identical to the inline form; only the code organisation differs.

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — one shared predicate, called at every read
const activeCriterion = () => not(eq(schema.orders.archived, true));
// findById:  .where(and(eq(schema.orders.id, id), activeCriterion()))
// byRegion:  .where(and(eq(schema.orders.region, r), activeCriterion()))
```
== elixir
```elixir
# lib/api/sales/order_repository.ex — inlined into each query
query = from(record in Api.Sales.Order, where: not record.archived)
# byRegion:
query = from(record in Api.Sales.Order, where: (record.region == ^r) and (not record.archived))
```
::: end

## `stamp onCreate|onUpdate { … }` — lifecycle assignments

`stamp <event> { <assign>* }` runs assignments on every create (`onCreate`) or update (`onUpdate`) of the host. The body is the same statement shape as an `operation` body, with `this` in scope; `now()` and `currentUser` (bare, or a claim `currentUser.tenantId`) resolve normally. The `createdAt := now()` / `touchedAt := now()` stamps from §[`capability`](#capability--a-typed-mixin) land at each backend's persistence boundary — the aggregate class stays pure:

::: tabs backend
== node
Persist-time, in the Drizzle upsert: a project-wide `db/audit-stamp.ts` helper tailored to every stamping aggregate's field set. The insert branch stamps the create **and** update fields; the update branch overlays only the update fields (create-only columns stay immutable). A bare `currentUser` becomes the ambient `ctx.actorId`; a save outside a request scope (seed / system) is left unstamped:
```ts
// db/audit-stamp.ts
export function stampInsert<T extends Record<string, unknown>>(row: T): T {
  const ctx = requestContext();
  if (!ctx) return row;
  return { ...row, createdAt: new Date(), touchedAt: new Date(), createdBy: ctx.actorId, updatedAt: new Date(), updatedBy: ctx.actorId };
}
export function stampUpdate<T extends Record<string, unknown>>(row: T): Partial<T> {
  const ctx = requestContext();
  if (!ctx) return row;
  const { createdAt: _createdAt, createdBy: _createdBy, ...rest } = row;
  return { ...rest, touchedAt: new Date(), updatedAt: new Date(), updatedBy: ctx.actorId } as unknown as Partial<T>;
}
// db/repositories/order-repository.ts:  tx.insert(schema.orders).values(stampInsert({ … }))  /  tx.update(schema.orders).set(stampUpdate({ … }))
```
== dotnet
A `SaveChangesInterceptor` (`AuditableInterceptor`) on the `DbContext`, one switch arm per stamping aggregate, keyed on `entry.State` (`onUpdate` also fires on `Added`, so a NOT-NULL `touched_at` is filled on create). `now()` → `DateTime.UtcNow`:
```csharp
// Infrastructure/Persistence/AuditableInterceptor.cs
case Order e:
    if (entry.State == EntityState.Added)
    {
        ctx.Entry(e).Property(x => x.CreatedAt).CurrentValue = DateTime.UtcNow;
    }
    if (entry.State == EntityState.Added || entry.State == EntityState.Modified)
    {
        ctx.Entry(e).Property(x => x.TouchedAt).CurrentValue = DateTime.UtcNow;
    }
    break;
```
== java
Spring Data JPA auditing: `now()` stamps map to `@CreatedDate` / `@LastModifiedDate`, `currentUser` stamps to `@CreatedBy` / `@LastModifiedBy` fed by an `AuditorAware<String>` over the `CurrentUserAccessor` (`config/JpaAuditingConfig.java`):
```java
// features/orders/Order.java
@EntityListeners(AuditingEntityListener.class)
public class Order {
    @CreatedDate      Instant createdAt;
    @LastModifiedDate Instant touchedAt;
```
== python
A `_stamp_on_create` / `_stamp_on_update` method on the aggregate, called by the route right before persist (`current_user` passed only when a stamp reads it):
```python
# app/domain/order.py
def _stamp_on_create(self) -> None:
    self._created_at = datetime.now(UTC)
def _stamp_on_update(self) -> None:
    self._touched_at = datetime.now(UTC)
# app/http/order_routes.py:  created._stamp_on_create()  …  found._stamp_on_update()
```
== elixir
`Ecto.Changeset.put_change` in the repository's `insert` / `update` (the insert also applies the `onUpdate` stamps); a principal stamp reads the threaded `current_user`:
```elixir
# lib/api/sales/order_repository.ex
|> Ecto.Changeset.put_change(:created_at, DateTime.utc_now() |> DateTime.truncate(:second))
|> Ecto.Changeset.put_change(:touched_at, DateTime.utc_now() |> DateTime.truncate(:second))
```
::: end

### Validator-gated stamp cases

Three refusals, none backend-specific (each reads only the model — the old per-backend `loom.<plat>-stamp-unsupported` codes are gone):

- `loom.stamp-principal-without-auth` — a `currentUser` stamp on a deployable **without** `auth: required` / a system `user {}` (no principal to stamp from; use `now()`-only stamps or add auth).
- `loom.stamp-on-event-sourced-invalid` — **any** stamp on a `persistedAs: eventLog` aggregate (there is no row to stamp; the truth is the stream).
- `loom.stamp-read-before-flush` — on a stamping aggregate, a `create` body that *reads* any of the four audit columns (`createdAt` / `createdBy` / `updatedAt` / `updatedBy`), or an `operation` body that reads `updatedAt` / `updatedBy`: the value lands only when the unit of work flushes, so the body would observe the prior value (an operation may read `createdAt` / `createdBy` — the create flush already set them).

## `with <Cap>` / `implements <Cap>` — applying a capability

`with` and `implements` are synonyms for applying a capability: the expander deep-clones the capability's members (fields + `filter` + `stamp`) into the host. They differ only in that `with` *also* drives macros, so a `with` clause can name a mix of capabilities and macros.

```ddd
aggregate Order with softDeletable, auditable { subject: string }
// equivalent, capabilities only:
aggregate Order { subject: string  implements softDeletable  implements auditable }
```

An `implements` naming no declared capability is `loom.unknown-capability`; a `with` naming neither a capability nor a macro is `loom.unknown-macro`. A capability may only be applied to an aggregate or a context — `ui W with tagged { }` is `loom.capability-host-invalid`.

## Propagation — context vs aggregate scope

`filter` / `stamp` / `with` / `implements` are admissible at **both** aggregate and context scope. At context scope they fan out to every aggregate in the context (filters/stamps propagate at lowering, `src/ir/lower/lower-capabilities.ts`; capability application splices at expansion):

| Declaration | Applies to |
|---|---|
| `filter <expr>` at aggregate scope | that aggregate |
| `stamp <event> {…}` at aggregate scope | that aggregate |
| `filter <expr>` / `stamp <event> {…}` at **context** scope | every aggregate in the context |
| `with <Cap>` / `implements <Cap>` at **context** scope | the capability is applied to every aggregate in the context |

Inheritance does **not** propagate: an abstract base's capability contributes its columns to the subtypes, but the stamp / filter / tenancy stance stay on the aggregate that declared them ([chapter 8](08-inheritance-and-polymorphism.md#abstract-aggregate--the-base)).

## `Self id` — self-reference inside a capability

A capability that needs to reference its own implementor uses `Self id`; the expander rewrites `Self id` → `<Host> id` when it splices the capability into each aggregate. `Self id` **outside** a capability is `loom.self-outside-capability`.

```ddd
capability hierarchical {
  parent: Self id?           // becomes `parent: Order id?` when applied to Order
}
aggregate Order with hierarchical, crudish { subject: string }
```

```ts
// domain/order.ts (node) — the concrete self-FK the backends see
static create(input: { subject: string; /* … */ parent?: Ids.OrderId | null }): Order {
  // … parent: input.parent ?? null
}
```

## `ignoring` — bypassing a filter at a read site

The clause has exactly three homes: a repository `find … ignoring …`, a query-time projection's `where` slot (*before* `join` / `group by` / `select`), and an inline read bound by a `let` (`let xs = Repo.findAll(…) ignoring …`, `Repo.run(…) ignoring …`). `ignoring *` drops every capability filter on the aggregate; `ignoring A, B` drops exactly those capabilities'. The `let` form rides an ordinary postfix chain, so `group by o.status ignoring softDeletable` also *parses* — it would bind the clause to the grouping expression, where nothing reads it back, so any position other than the three above is `loom.ignoring-clause-placement`; naming a capability the aggregate lacks is `loom.filter-bypass-unknown-capability`, naming one that contributes no filter (`ignoring auditable`) is `loom.filter-bypass-no-filter`. All five backends honour the bypass (EF `IgnoreQueryFilters`, a dropped Drizzle / SQLAlchemy / Ecto conjunct, a Hibernate `@FilterDef`/`@Filter` the read disables) — the per-backend output is in [chapter 10](10-repositories-and-queries.md#ignoring--capability-filter-bypass). One Java gap to know about: a *principal* filter (`currentUser` in the predicate) rides the JPQL `@Query`, and a declared `find … ignoring` currently keeps that conjunct (`select e from Order e where (e.tenantId = …)`) — only the non-principal, `@SQLRestriction`-resident filters are actually bypassed there.

```ddd
repository Orders for Order {
  find allRows(): Order[] ignoring *                              // skips every capability filter
}
```

```ts
// db/repositories/order-repository.ts (node) — no tenant term
async allRows(): Promise<Order[]> {
  const rootRows = await this.db.select().from(schema.orders);
  // …
}
```

## The built-in capabilities

Five capabilities ship in the toolchain prelude (`src/macros/prelude.ts`) — usable by name with nothing declared. A user `capability` of the same name wins (the prelude is a default, not an override). Four are opt-in; `versioned` is default-on.

| Capability | Fields it contributes | Filter / stamps |
|---|---|---|
| **`auditable`** | `createdAt` / `updatedAt` (`managed datetime`), `createdBy` / `updatedBy` (`managed User id` — the principal-id type; prelude-only, a hand-written `User id` does not resolve, and the columns emit as `string`) | `stamp onCreate { createdAt := now()  createdBy := currentUser }`, `stamp onUpdate { updatedAt := now()  updatedBy := currentUser }` |
| **`softDeletable`** | `isDeleted` (`internal bool`), `deletedAt` (`managed datetime?`) | `filter !this.isDeleted` — the `softDelete()` / `restore()` **operations** are the separate `softDelete` macro; compose `with softDeletable, softDelete`. A user field named `isDeleted` of another type is `loom.softdelete-field-collision` |
| **`tenantOwned`** | `tenantId` (`internal string`), `dataKey` (`internal string?` — the materialized ancestor path; `internal`, so it is out of every API read/create payload, though in-system UI reads still see it) | `stamp onCreate { tenantId := currentUser.<claim>  dataKey := currentUser.orgPath }`, `filter this.tenantId == currentUser.<claim>` — the principal side is rebound to the system's `tenancy by user.<claim>` declaration in enrichment; without one it is `loom.tenant-owned-without-tenancy`, and a non-`string` claim is `loom.tenant-owned-claim-type` ([`../tenancy.md`](../tenancy.md)) |
| **`tenantRegistry`** | `parent: Self id?` (`immutable`), `dataKey: string?` (`managed`) | none — the tree fields of the registry aggregate named by `tenancy by … of <Registry>`; the registry is self-scoped, never `tenantOwned` (`loom.tenant-registry-without-tenancy` outside a `tenancy by` system) |
| **`versioned`** | `version: int token = 1` | none — the optimistic-concurrency marker, echoed by the client on update (`If-Match`; a mismatch is a 409). **Applied by default** to every aggregate that is not `persistedAs: eventLog` (the event stream is its own concurrency control) — the expander splices it last, so an explicit `with versioned` is an idempotent no-op. A user-declared `version: int` is accepted as the counter; `version` of any other type is `loom.version-field-collision` |

```ddd
context Inventory {
  aggregate Item with auditable, softDeletable, softDelete, versioned, crudish {   // `versioned` is redundant — it is on by default
    name: string
  }
}
```

The `softDeletable` `filter !this.isDeleted` is **non-principal**, so no auth is needed and all five backends emit it:

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
== java
```java
// features/items/Item.java — a static restriction on the entity (+ a Hibernate filter `ignoring` can disable)
@SQLRestriction("not (is_deleted)")
public class Item { … }
```
== python
```python
# app/db/repositories/item_repository.py
rows = (await self._session.execute(select(ItemRow).where(not_(ItemRow.is_deleted)).order_by(_order).limit(page_size).offset(offset))).scalars().all()
```
== elixir
```elixir
# lib/api/inventory/item_repository.ex — Ecto where clause threaded onto every read
query = from(record in Api.Inventory.Item, where: not record.is_deleted)
```
::: end

The `auditable` stamps thread `currentUser` — each backend through its own stamping seam (§[`stamp`](#stamp-oncreateonupdate----lifecycle-assignments)):

::: tabs backend
== node
```ts
// db/audit-stamp.ts — createdBy / updatedBy from the ambient actor id
return { ...row, createdAt: new Date(), createdBy: ctx.actorId, updatedAt: new Date(), updatedBy: ctx.actorId };
```
== dotnet
```csharp
// Infrastructure/Persistence/AuditableInterceptor.cs
case Item e:
    if (entry.State == EntityState.Added)
    {
        ctx.Entry(e).Property(x => x.CreatedAt).CurrentValue = DateTime.UtcNow;
        ctx.Entry(e).Property(x => x.CreatedBy).CurrentValue = RequestContext.Current!.CurrentUser!.Id;
    }
    if (entry.State == EntityState.Added || entry.State == EntityState.Modified)
    {
        ctx.Entry(e).Property(x => x.UpdatedAt).CurrentValue = DateTime.UtcNow;
        // … UpdatedBy
    }
    break;
```
== java
```java
// features/items/Item.java
@CreatedDate      Instant createdAt;
@LastModifiedDate Instant updatedAt;
@CreatedBy        String createdBy;
@LastModifiedBy   String updatedBy;
```
== python
```python
# app/domain/item.py
def _stamp_on_create(self, current_user: User) -> None: …
def _stamp_on_update(self, current_user: User) -> None: …
# app/http/item_routes.py:  created._stamp_on_create(current_user)  /  found._stamp_on_update(current_user)
```
== elixir
```elixir
# lib/api/inventory/item_repository.ex — insert applies both stamp sets
|> Ecto.Changeset.put_change(:created_at, DateTime.utc_now() |> DateTime.truncate(:second))
|> Ecto.Changeset.put_change(:created_by, current_user && current_user.id)
|> Ecto.Changeset.put_change(:updated_at, DateTime.utc_now() |> DateTime.truncate(:second))
|> Ecto.Changeset.put_change(:updated_by, current_user && current_user.id)
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

A `capability` subsumes the field/filter/stamp surface; **operations and structure stay macros** — `softDelete` (the `softDelete()`/`restore()` ops), `softDeleteByDefault` (context-wide application), `crudish` (canonical `create(...)` / `destroy {}` plus an `update(...)`, built from the host's writable fields; `crudish(updateOnly: true)` leaves deletion to `softDelete`), and the `scaffold*` family. `crudish` builds its parameters from the host's fields minus three sets: fields another macro contributed (origin-tagged), fields a `stamp` assigns (`createdAt`, `touchedAt`), and fields whose access modifier keeps them off the payload (`managed`, `token`, `internal`; `update` also drops `immutable`) — so `auditable`'s columns, `softDeletable`'s `isDeleted`, `tenantOwned`'s `internal tenantId` and the default `version` token are all out. A plain field a user capability contributes is **in**: `tenantScoped`'s `tenantId: string` above lands in `create(input: { subject; total; tenantId; … })`. The aggregate-header `audited` modifier (an `audit_records` trail plus `GET /<aggs>/{id}/history`; under `denyByDefault` the history read inherits the list gate — `loom.audit-history-ungated`) is a sibling facility, not a capability — see [chapter 20](20-observability-provenance.md). See [`../scaffold-macros.md`](../scaffold-macros.md).

## Validation rules

- `implements <X>` naming no capability → `loom.unknown-capability`; `with <X>` naming neither a capability nor a macro → `loom.unknown-macro`; a capability on a `ui` / `api` host → `loom.capability-host-invalid`.
- A capability with no implementors is allowed (declared but unused).
- A capability's `filter` / `stamp` body type-checks against **each** implementing aggregate — e.g. a `stamp onCreate { createdBy := currentUser }` requires every implementor to carry a `createdBy` field; a missing field is an IR-validation error. A `filter` outside the queryable subset → `loom.criterion-not-selectable`.
- `Self id` outside a capability → `loom.self-outside-capability`.
- A principal-referencing `filter` or `stamp` on a deployable with no auth → `loom.context-filter-unsupported` / `loom.stamp-principal-without-auth`; any stamp on an event-sourced aggregate → `loom.stamp-on-event-sourced-invalid`; reading a stamp field in the stamped body → `loom.stamp-read-before-flush`.
- A user field colliding with a built-in's flag → `loom.softdelete-field-collision` (a non-`bool` `isDeleted` under `softDeletable`), `loom.version-field-collision` (a non-`int` `version` on any non-event-sourced aggregate — `versioned` is default-on, so this fires without any `with`).
- `tenantOwned` outside a `tenancy by` system → `loom.tenant-owned-without-tenancy`; a non-`string` tenancy claim → `loom.tenant-owned-claim-type`; `tenantRegistry` outside one → `loom.tenant-registry-without-tenancy`.
- `ignoring` placement / target → `loom.ignoring-clause-placement`, `loom.filter-bypass-unknown-capability`, `loom.filter-bypass-no-filter`.
