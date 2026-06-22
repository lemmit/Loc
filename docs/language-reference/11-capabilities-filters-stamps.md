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

A filter that is *exactly* one named [`criterion`](09-criteria.md) (`filter NotDeleted`) **reifies** instead of inlining: Hono calls the module-level `<name>Criterion` predicate fn and Phoenix references an Ash boolean calculation (`base_filter expr(active)`), deduped with any find/retrieval consumers of the same criterion. Behaviour-identical to the inline form; only the code organisation differs.
