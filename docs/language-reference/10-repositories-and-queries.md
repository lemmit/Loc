# 10. Repositories & queries

Reading data: the `repository` container and its `find` operations, the restricted "queryable subset" a `where` clause admits, reusable `criterion` predicate specifications, `retrieval` query bundles with `sort`/`loads`, the `paged`/`envelope`/`option` return shapes, and the `ignoring` capability-filter bypass. Reach for it when you need to know exactly what SQL a `find` lowers to on each backend, why a `where` is rejected, or where a criterion reifies to a real object vs. dissolves inline.

> **Grammar:** `Repository`, `FindDecl`, `Criterion`, `Retrieval`, `SortItem`, `LoadPath`, `IgnoringClause` · **Validators:** `loom.find-where-not-queryable`, `loom.find-where-unknown-field`, `loom.find-where-column-column`, `loom.retrieval-where-not-queryable`, `loom.criterion-*` (queryable oracle: `firstNonQueryableNode` in `src/ir/validate/checks/shared.ts`) · **Docs:** [`../criterion.md`](../criterion.md)

All multi-backend examples below are generated from one scratch `system` with a `node` / `dotnet` / `python` / `java` / `elixir` deployable over the same `Catalog` context; output is excerpted.

## `repository` & `find`

A `repository` binds reads to one aggregate (`repository Name for Agg`). It contains `find` operations — each `find name(params): T [where <expr>]`. The return type `T` is an ordinary [type reference](04-type-system.md): a single aggregate, a collection `T[]`, an option `T?`, or a transport carrier (`T paged` / `T envelope` / `T option`). Every repository also gets two reads for free without declaring them: a by-primary-key lookup and a load-all.

```ddd
aggregate Product { sku: string  name: string  price: money }

repository Products for Product {
  find bySku(s: string): Product?      where this.sku == s
  find pricey(floor: money): Product[] where this.price >= floor
}
```

`bySku` returns `Product?` (zero-or-one) and `pricey` returns a collection. The free reads are `findById`/`getById` and `all()`/`findAll` — auto-`findAll` is derived in enrichment (phase ⑥), so a bare `repository Foo for Foo { }` is already queryable.

::: tabs backend
== node
```ts
// db/repositories/product-repository.ts — Drizzle
async bySku(s: string): Promise<Product | null> {
  const rootRows = await this.db.select().from(schema.products)
    .where(eq(schema.products.sku, s)).limit(1);
  if (rootRows.length === 0) return null;
  return await this.findById(rootRows[0]!.id as Ids.ProductId);
}

async pricey(floor: Decimal): Promise<Product[]> {
  const rootRows = await this.db.select().from(schema.products)
    .where(gte(schema.products.price, floor));
  return rootRows.map((root) => Product._create({ /* … */ }));
}

// free reads
async findById(id: Ids.ProductId): Promise<Product | null> { /* … */ }
async all(): Promise<Product[]> { /* select().from(schema.products) */ }
```
== dotnet
```csharp
// Infrastructure/Repositories/ProductRepository.cs — EF Core
public async Task<Product?> BySku(string s, CancellationToken ct = default)
    => await _db.Products.Where(x => x.Sku == s).FirstOrDefaultAsync(ct);

public async Task<List<Product>> Pricey(decimal floor, CancellationToken ct = default)
    => await _db.Products.Where(x => x.Price >= floor).ToListAsync(ct);
```
== python
```python
# app/db/repositories/product_repository.py — SQLAlchemy
async def by_sku(self, s: str) -> Product | None:
    row = (await self._session.execute(
        select(ProductRow).where((ProductRow.sku == s)).limit(1))).scalars().first()
    return self._to_domain(row) if row else None

async def pricey(self, floor: Decimal) -> list[Product]:
    rows = (await self._session.execute(
        select(ProductRow).where((ProductRow.price >= floor)))).scalars().all()
    return [self._to_domain(r) for r in rows]
```
== java
```java
// features/products/ProductJpaRepository.java — Spring Data derived queries
Optional<Product> findBySku(String s);
List<Product> findByPriceGreaterThanEqual(BigDecimal floor);
```
== elixir
```elixir
# lib/.../catalog.ex — Ecto query functions
def by_sku(s) do
  Repo.one(from p in Product, where: p.sku == ^s)
end
def pricey(floor) do
  Repo.all(from p in Product, where: p.price >= ^floor)
end
```
::: end

The comparison binds **one column against one value** (a parameter, literal, or enum value) on every backend — that constraint is what makes the clause selectable, and it is enforced (see the queryable subset below).

## The queryable subset

A `find … where` (and a `retrieval` `where`, a `projection` `where`, a capability `filter`) is **not** a general expression — it must lower to SQL. The oracle `firstNonQueryableNode` admits exactly: comparisons (`== != < <= > >=`), `&& || !`, parenthesised groups, `this.<column>` and one-level `this.<vo>.<sub>` flattened value-object refs, `currentUser.<field>`, parameter refs, and literals. Membership over a reference collection (`this.<refColl>.contains(x)`) is the one collection op admitted (it lowers to an `EXISTS` subquery). Everything richer is rejected — lambdas, collection projections (`.count` / `.first`), arithmetic operators, value-object construction, calls, ternaries, `match`, conversions, and column-vs-column comparisons.

```ddd
repository Orders for Order {
  // rejected: `.count` on a list is a projection needing a subquery
  find busy(): Order[] where this.lines.count > 0
}
```

This is a hard error at generate time — the real diagnostic:

```
Catalog/Orders.busy error: repository 'Orders' find 'busy': where-clause is
not queryable (collection projection '.count' on a list). Allowed: comparisons,
&&/||/!, parens, 'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.
```

> **Code:** `loom.find-where-not-queryable`. Sibling codes for the same position: `loom.find-where-unknown-field` (a `this.<x>` that isn't a real column), `loom.find-where-column-column` (both sides of a comparison are columns — `eq()` needs one column and one value), and `loom.retrieval-where-not-queryable` for the `retrieval` twin. There is no per-backend escape hatch: rejecting at the IR layer means no backend silently emits broken SQL or an empty result.

## Return shapes

The `find` return type picks the result cardinality and wire shape:

| `find` return | Cardinality | Method shape |
|---|---|---|
| `T` | exactly one (throws `NotFound` on miss) | `getById`-style |
| `T?` | zero-or-one | returns `T \| null` |
| `T[]` | collection | returns a list |
| `T paged` | a page of `T` | takes `page`/`pageSize`, returns `{ items, page, pageSize, total, totalPages }` |
| `T envelope` | `{ id, ts, body }` wrapper | see [Type system → carriers](04-type-system.md) |
| `T option` | tagged `union[T, none]` | discriminated wire (`type` tag) |

The carrier shapes (`paged` / `envelope` / `option`) and their per-backend wire projection are documented once in [Type system → Generic carriers](04-type-system.md#generic-carriers-paged-envelope-option). Here is what `paged` does to a `find` method — a paged read auto-gains `page`/`pageSize` parameters and a `total`/`totalPages` count query:

```ddd
repository Orders for Order {
  find forCustomer(c: string): Order paged where this.customer == c
}
```

::: tabs backend
== node
```ts
async forCustomer(c: string, page: number, pageSize: number):
    Promise<{ items: Order[]; page: number; pageSize: number; total: number; totalPages: number }> {
  const offset = (page - 1) * pageSize;
  // …count query → total; totalPages = ceil(total / pageSize)
  const rootRows = await this.db.select().from(schema.orders)
    .where(eq(schema.orders.customer, c)).limit(pageSize).offset(offset);
  return { items, page, pageSize, total, totalPages };
}
```
== dotnet
```csharp
public async Task<Paged<Order>> ForCustomer(string c, int page, int pageSize, CancellationToken ct = default)
{
    var total = await _db.Orders.Where(x => x.Customer == c).CountAsync(ct);
    var items = await _db.Orders.Where(x => x.Customer == c)
        .Skip(offset).Take(pageSize).ToListAsync(ct);
    return new Paged<Order>(items, page, pageSize, total, totalPages);
}
```
== python
```python
async def for_customer(self, c: str, page: int, page_size: int) -> PagedResult[Order]:
    offset = (page - 1) * page_size
    total = (await self._session.execute(
        select(func.count()).select_from(OrderRow).where((OrderRow.customer == c)))).scalar_one()
    rows = (await self._session.execute(
        select(OrderRow).where((OrderRow.customer == c)).limit(page_size).offset(offset))).scalars().all()
    # → PagedResult(items, page, page_size, total, total_pages)
```
== java
```java
public Paged<Order> forCustomer(String c, int page, int pageSize) {
    var result = jpa.forCustomer(c, PageRequest.of(page - 1, pageSize));
    return new Paged<>(result.getContent(), page, pageSize,
        (int) result.getTotalElements(), result.getTotalPages());
}
```
== elixir
```elixir
read :for_customer do
  argument :c, :string
  filter expr(record.customer == ^arg(:c))
  pagination offset?: true, required?: false
end
```
::: end

## `criterion`

A `criterion` is a named, parameterised, **pure boolean predicate** over a candidate type (the Specification pattern). `of <Agg>` names the candidate; inside the body, bare field names (and `this`) resolve against it — the same convention as `invariant`/`derived`. `of bool` is an ambient predicate with no candidate. Criteria compose with `&& || !` (there is no separate composition machinery — the boolean operators *are* the composition).

```ddd
criterion ActiveOrder of Order = status != OrderStatus.Closed
criterion HighValue(min: money) of Order = total >= min
```

A criterion reference is **inlined** wherever a boolean expression is expected (a `view where`, an `invariant`, a `find where` composed with other terms) — it produces exactly the same lowered SQL as the hand-written filter. But when a `find`'s or `retrieval`'s `where` is *exactly* one named criterion, it **reifies**: the backend emits a named predicate object the query consumes. The rule is simply "if it has a name." See [`../criterion.md`](../criterion.md) for the full validation table (`loom.criterion-impure` / `-cycle` / `-arity` / `-unsupported-target`).

The reification target differs per backend — this is `HighValue` reified:

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — module-level predicate function
const highValueCriterion = (min: Decimal) => gte(schema.orders.total, min);
// …consumed by the retrieval method below
```
== dotnet
```csharp
// Domain/Criteria/HighValueCriterion.cs — Criterion<T> with both a runtime
// check and a query-side expression tree
public sealed class HighValueCriterion : Criterion<Order>
{
    public HighValueCriterion(decimal min) { this.min = min; }
    public override bool IsSatisfiedBy(Order candidate) => candidate.Total >= min;
    public Expression<Func<Order, bool>> ToExpression() => candidate => candidate.Total >= min;
}
```
== java
```java
// domain/criteria/OrderCriteria.java — a Specification<T> factory per criterion
public static Specification<Order> HighValue(BigDecimal min) {
    return (root, query, cb) -> cb.greaterThanOrEqualTo(root.<BigDecimal>get("total"), min);
}
```
== elixir
```elixir
# lib/.../catalog.ex — a reusable Ecto dynamic the query filters by
def high_value(min) do
  dynamic([o], o.total >= ^min)
end
```
== python
```python
# SQLAlchemy is non-reifying: the predicate inlines at the call site
# select(OrderRow).where((OrderRow.total >= min))
```
::: end

## `retrieval`

A `retrieval` is a named query *bundle* — a `where` predicate plus the shaping a real query carries: `sort` ordering and (planned) `loads` fetch paths. Its `where` is a selection position (same queryable-subset contract), but in this release it must be a criterion reference. The block form carries `where:` / `sort:` slots; the single-line form `retrieval Name of Agg = <Criterion>` is the bare-predicate shorthand.

```ddd
retrieval BigActive(min: money) of Order {
  where: HighValue(min)
  sort:  [total desc, ref asc]
}
```

A retrieval lowers to a `run<Name>` repository method that consumes the reified criterion and applies the sort. The `page?` argument is optional offset/limit paging.

::: tabs backend
== node
```ts
async runBigActive(min: Decimal, page?: { offset?: number; limit?: number }): Promise<Order[]> {
  let query = this.db.select().from(schema.orders)
    .where(highValueCriterion(min))
    .orderBy(desc(schema.orders.total), asc(schema.orders.ref)).$dynamic();
  if (page?.limit !== undefined) query = query.limit(page.limit);
  if (page?.offset !== undefined) query = query.offset(page.offset);
  // …
}
```
== dotnet
```csharp
// Domain/Orders/BigActiveSpec.cs — an Ardalis Specification bundling the criterion + sort
public sealed class BigActiveSpec : Specification<Order>
{
    public BigActiveSpec(decimal min) {
        Query.Where(new HighValueCriterion(min).ToExpression())
             .OrderByDescending(x => x.Total).ThenBy(x => x.Ref);
    }
}
// OrderRepository: __q.WithSpecification(new BigActiveSpec(min)).ApplyPaging(page)
```
== python
```python
async def run_big_active(self, min: Decimal, offset: int | None = None,
                         limit: int | None = None) -> list[Order]:
    query = select(OrderRow).where((OrderRow.total >= min)) \
        .order_by(OrderRow.total.desc(), OrderRow.ref.asc())
    if offset is not None: query = query.offset(offset)
    if limit is not None:  query = query.limit(limit)
```
== java
```java
public List<Order> runBigActive(BigDecimal min, Integer offset, Integer limit) {
    return jpa.findAll(OrderCriteria.HighValue(min),
        new OffsetLimitPageRequest(offset, limit,
            Sort.by(Sort.Order.desc("total"), Sort.Order.asc("ref")))).getContent();
}
```
== elixir
```elixir
read :big_active do
  argument :min, :string
  pagination offset?: true, required?: false
  prepare build(sort: [total: :desc, ref: :asc])
  filter expr(high_value(min: ^arg(:min)))
end
```
::: end

`Repo.run(retrieval { where: <Criterion> sort: […] }, page?)` is the anonymous, call-site twin accepted from workflow bodies (`RetrievalLiteral` in the grammar); `Repo.findAll(<Criterion>, page?)` is the bare-criterion shorthand. See [`../workflow.md`](../workflow.md) and [`../criterion.md`](../criterion.md).

## `loads:` shaping

`loads:` declares structural fetch paths through the candidate — e.g. `loads: [this.lines[].product]`, a flat dotted `LoadPath` with `[]` marking "across the collection" (mirrors `contains`). A leading `this.` is admitted and stripped, so `this.lines[].product` and `lines[].product` are equivalent.

**Honest gap:** explicit `loads:` is **not shipped yet** — a retrieval with one is rejected at generate time:

```
Catalog/retrieval BigActive error: retrieval 'BigActive': explicit 'loads:' is
not supported yet — retrievals load the whole aggregate. (Per-operation autoload is planned.)
```

Retrievals currently load the whole aggregate (the backend loads its full `wireShape` and containments regardless). The Elixir read action does emit a `prepare build(load: [:lines])` for the aggregate's own containments, but author-specified deep `loads` paths are not honoured anywhere. Treat `loads:` as reserved surface; track it via the retrieval proposal.

## `ignoring` — capability-filter bypass

A trailing `ignoring` clause on a read skips the query-filters a capability contributed (soft-delete row hiding, tenancy scoping, etc.), keyed on the **capability** name. `ignoring *` bypasses every capability filter on the aggregate; `ignoring A, B` bypasses exactly those. `ignoring` is a soft keyword (fields/params named `ignoring` keep parsing).

```ddd
repository Orders for Order {
  find forCustomer(c: string): Order paged where this.customer == c ignoring *
}
```

On .NET this threads `IgnoreQueryFilters()` into both the count and the page query:

```csharp
// Infrastructure/Repositories/OrderRepository.cs
var total = await _db.Orders.IgnoreQueryFilters().Where(x => x.Customer == c).CountAsync(ct);
var items = await _db.Orders.IgnoreQueryFilters().Where(x => x.Customer == c)
    .Skip(offset).Take(pageSize).ToListAsync(ct);
```

A **query-time projection** carries the same clause — `ignoring` sits in the `where` position (`from <Agg> where … ignoring … join … select …`) and bypasses the `from` source aggregate's capability filters for that read. It rides the same synthesised source find, so all five backends honor it identically (soft-deleted / cross-tenant rows become visible to that projection only):

```ddd
projection PurgeAudit {
  id: Order id  status: string
  from Order as o ignoring softDeletable       // include soft-deleted rows
  select id = o.id, status = o.status
}
```

The bypass is visible in generated code only when a capability actually contributes a filter to that aggregate; with no `filter` capability installed there is nothing to suppress and the clause is a no-op. See [`../capabilities.md`](../capabilities.md) for the `filter` capability that produces these query-layer predicates.

## Shorthand projection — the `select`-less form

A query-time projection may omit **both** its declared row fields **and** the `select` clause. The row shape is then the **source aggregate's own full wire shape**, and the read returns each filtered source row serialized through the aggregate's own domain→wire mapper — the exact serialization its `findAll` route uses. This is the read-model shorthand: a filtered, capability-scoped view over an aggregate with no field remapping, and the replacement for the removed `view X = A where P` form.

```ddd
// Full-select form: an explicit row shape reprojected field-by-field.
projection ActiveOrdersVerbose {
  id: Order id  status: string
  from Order as o where o.status == "active"
  select id = o.id, status = o.status
}

// Shorthand: no fields, no select — the row IS Order's wire shape.
projection ActiveOrders {
  from Order as o where o.status == "active"
}
```

The shorthand `ActiveOrders` exposes `GET /projections/active_orders` returning the same `Order` wire rows the aggregate's own list route emits, filtered to `status == "active"`:

```ts
// api/http/query-projections.ts (Hono)
const ActiveOrdersRow = z.object({
  id: z.string(),
  total: z.number().int(),
  status: z.string(),
  version: z.number().int(),
}).openapi("ActiveOrdersRow");            // ← Order's full wire shape, derived

// … route handler …
const repo = new OrderRepository(db, events);
const rows = await repo.activeOrders();   // synthesised source find + `where`
const projected = rows.map((r) => repo.toWire(r));   // the aggregate's own mapper
```

All five backends emit the same shape — `.NET` `domain.Select(d => new ActiveOrdersRow(d.Id.Value, d.Total, d.Status, d.Version))`, Java `.map(a -> new ActiveOrdersRow(a.id().value(), …))`, Python `[repo.to_wire(r) for r in rows]`, Elixir `Enum.map(rows, &serialize/1)` — each reusing that backend's aggregate wire serializer, so a shorthand projection row is byte-identical to the aggregate's own read.

**Aggregate source only.** The shorthand form is supported for a `from <Aggregate>` source. A `select`-less projection over a `from <Workflow>` or `from <Projection>` source is rejected (`loom.projection-shorthand-nonaggregate`) — those sources have no aggregate wire shape to inherit, so they still require an explicit `select`. A projection that declares row fields but omits the `select` to fill them is a different error (`loom.projection-fields-without-select`) — that is a half-written projection, not the shorthand.
