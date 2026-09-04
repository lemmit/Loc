# 10. Repositories, queries & projections

Reading data: the `repository` container and its `find` operations, the restricted "queryable subset" a `where` clause admits, reusable `criterion` predicate specifications, `Repo.run(<Criterion>)` and `retrieval` query bundles with `sort`/`loads`, the `paged`/`envelope`/`option` return shapes, the `ignoring` capability-filter bypass, and — the read-model surface that replaced the removed `view` — `projection` in its two flavours: **query-time** (`from … where … join … group by … select …`, computed on every read) and **folded** (`keyed by` + `on(e: Event) { … }`, a materialized read-model table). Reach for it when you need to know exactly what SQL a read lowers to on each backend, why a `where` is rejected, or which read shape (find / criterion / retrieval / projection) to pick.

> **Grammar:** `Repository`, `FindDecl`, `IgnoringClause` (fragment), `Criterion`, `Retrieval`, `RetrievalLiteral`, `SortItem`, `LoadPath`, `Projection`, `ProjectionMember`, `ProjectionOn`, `ProjectionJoin`, `ProjectionSelect`, `QueryHandler` · **Validators:** `loom.find-where-not-queryable` / `-unknown-field` / `-column-column`, `loom.find-reserved-name`, `loom.duplicate-find`, `loom.repository-find-deprecated`, `loom.find-gate-not-current-user`, `loom.index-suggestion`, `loom.find-predicate-unsupported`, `loom.findall-*`, `loom.criterion-*`, `loom.retrieval-*`, `loom.filter-bypass-*`, `loom.ignoring-clause-placement`, `loom.projection-*` (35 codes, plus two `#document` message variants), `loom.field-mask-projection-source`, `loom.read-context-repo-write`, `loom.paged-query-handler-unsupported-backend` (queryable oracle: `firstNonQueryableNode` in `src/ir/validate/checks/shared.ts`) · **Docs:** [`../criterion.md`](../criterion.md), [`../scaffold-macros.md`](../scaffold-macros.md) (`scaffoldPaged`, `scaffoldDashboard`)

All multi-backend examples below are generated from one scratch `system` (`Catalog` context: `Product`, `Customer`, `Order with softDeletable`) once per backend pin; output is excerpted.

## `repository` & `find`

A `repository` binds reads to one aggregate (`repository Name for Agg`). It contains `find` operations — each `find name(params): T [requires <gate>] [where <expr>] [ignoring …]`. The return type `T` is an ordinary [type reference](04-type-system.md): a single aggregate, an option `T?`, a collection `T[]`, or a transport carrier (`T paged` / `T envelope` / `T option`). Every repository also gets two reads for free without declaring them: a by-primary-key lookup (`findById` / `getById`) and a **paged, sortable** load-all (`all(page, pageSize, sort, dir)` — auto-`findAll` is derived in enrichment, phase ⑥, and is paged by default), so a bare `repository Foo for Foo { }` is already queryable. A declared find may not reuse an auto-emitted name (`loom.find-reserved-name`) or repeat itself (`loom.duplicate-find`).

```ddd
aggregate Product with crudish { sku: string  name: string  price: money }

repository Products for Product {
  find bySku(s: string): Product?      where this.sku == s
  find pricey(floor: money): Product[] where this.price >= floor
}
```

`bySku` returns `Product?` (zero-or-one) and `pricey` returns a collection:

::: tabs backend
== node
```ts
// db/repositories/product-repository.ts — Drizzle
async bySku(s: string): Promise<Product | null> {
  const rootRows = await this.db.select().from(schema.products).where(eq(schema.products.sku, s)).limit(1);
  if (rootRows.length === 0) return null;
  return Product._rehydrate({ id: Ids.ProductId(rootRows[0]!.id), sku: rootRows[0]!.sku, name: rootRows[0]!.name, price: new Decimal(rootRows[0]!.price), version: rootRows[0]!.version });
}

async pricey(floor: Decimal): Promise<Product[]> {
  const rootRows = await this.db.select().from(schema.products).where(gte(schema.products.price, floor));
  return rootRows.map((root) => Product._rehydrate({ /* … */ }));
}

// free reads
async findById(id: Ids.ProductId): Promise<Product | null> { /* … */ }
async all(page: number, pageSize: number, sort: string, dir: string): Promise<{ items: Product[]; page: number; pageSize: number; total: number; totalPages: number }> { /* … */ }
```
== dotnet
```csharp
// Infrastructure/Repositories/ProductRepository.cs — EF Core
public async Task<Product?> BySku(string s, CancellationToken cancellationToken = default)
{
    var result = await _db.Products.Where(x => x.Sku == s).FirstOrDefaultAsync(cancellationToken);
    return result;
}
public async Task<List<Product>> Pricey(decimal floor, CancellationToken cancellationToken = default)
{
    var result = await _db.Products.Where(x => x.Price >= floor).ToListAsync(cancellationToken);
    return result;
}
```
== java
```java
// features/products/ProductJpaRepository.java — JPQL per find
@Query("select e from Product e where e.sku = :s")
Product bySku(@Param("s") String s);
@Query("select e from Product e where e.price >= :floor")
List<Product> pricey(@Param("floor") BigDecimal floor);
```
== python
```python
# app/db/repositories/product_repository.py — SQLAlchemy
async def by_sku(self, s: str) -> Product | None:
    row = (await self._session.execute(select(ProductRow).where((ProductRow.sku == s)))).scalars().first()
    if row is None:
        return None
    return await self._hydrate(row)

async def pricey(self, floor: Decimal) -> list[Product]:
    rows = (await self._session.execute(select(ProductRow).where((ProductRow.price >= floor)))).scalars().all()
    return [await self._hydrate(row) for row in rows]
```
== elixir
```elixir
# lib/d/catalog/product_repository.ex — Ecto
def by_sku(s) do
  query = from(record in D.Catalog.Product, where: record.sku == ^s)
  {:ok, Repo.one(query)}
end
def pricey(floor) do
  query = from(record in D.Catalog.Product, where: record.price >= ^floor)
  {:ok, Repo.all(query)}
end
```
::: end

The comparison binds **one column against one value** (a parameter, literal, or enum value) on every backend — that constraint is what makes the clause selectable, and it is enforced (see the queryable subset below).

### List finds are deprecated

`pricey` compiles, but with a **warning**: `loom.repository-find-deprecated` — "repository find 'pricey' is a wire-shaped list query — pass a criterion to 'run' (`Repo.run(<Criterion>(args))`) or name a 'retrieval' instead of accreting a bespoke list finder on the repository." Every find returning `T[]` or `T paged` gets it; a unique-key reconstitution find returning `T` / `T?` stays fine. The compiler-synthesised reads (auto-`findAll`, `scaffoldPaged`'s paged find) are exempt. The replacements are §[`criterion`](#criterion), §[`Repo.run` / paged `queryHandler`](#reporun--the-paged-queryhandler) and §[`projection`](#projection--the-read-model). A `find … where` that filters an un-indexed column also gets an advisory `loom.index-suggestion` pointing at the `resource … { index: [Agg.col] }` hatch ([chapter 14](14-apis-storage-resources-channels.md#resource)).

## The queryable subset

A `find … where` (and a `retrieval` `where`, a `projection` `where`, a capability `filter`) is **not** a general expression — it must lower to SQL. The oracle `firstNonQueryableNode` admits exactly: comparisons (`== != < <= > >=`), `&& || !`, parenthesised groups, `this.<column>` (or the projection alias `o.<column>`) and one-level `this.<vo>.<sub>` flattened value-object refs, `currentUser.<field>`, parameter refs, literals and enum values, a named `criterion` reference, membership over a reference collection (`this.<refColl>.contains(x)` — an `EXISTS` subquery), and the bool-returning queryable intrinsics with the **column as receiver** (`this.path.startsWith(p)` → a prefix filter). Everything richer is rejected — lambdas, collection projections (`.count` / `.first`), arithmetic, value-object construction, calls, ternaries, `match`, conversions, and column-vs-column comparisons.

```ddd
repository Orders for Order {
  // rejected: `.count` on a list is a projection needing a subquery
  find busy(): Order[] where this.lines.count > 0
}
```

```
error  loom.find-where-not-queryable
repository 'Orders' find 'busy': where-clause is not queryable (collection projection
'.count' on a list). Allowed: comparisons, &&/||/!, parens, 'this.<column>' /
'this.<vo>.<sub>' refs, parameter refs, literals.
```

Sibling codes for the same position: `loom.find-where-unknown-field` (a `this.<x>` that isn't a real column), `loom.find-where-column-column` (both sides of a comparison are columns — `eq()` needs one column and one value), and the `loom.retrieval-where-*` / `loom.projection-where-not-queryable` / `loom.criterion-not-selectable` twins for the other three positions. There is no per-backend escape hatch: rejecting at the IR layer means no backend silently emits broken SQL. One further gate keys off the deployable's explicit `persistence:` selector — EF Core and Drizzle (the defaults) lower the whole subset, but `persistence: dapper` / `persistence: mikroorm` lower a narrower one, and a predicate outside it is `loom.find-predicate-unsupported` at validation rather than a codegen throw (`src/ir/util/find-predicate-capability.ts`).

## Return shapes

| `find` return | Cardinality | Method shape |
|---|---|---|
| `T` | exactly one (404 ProblemDetails on miss) | `getById`-style |
| `T?` | zero-or-one | returns `T \| null` |
| `T[]` | collection (**deprecated** — warns) | returns a list |
| `T paged` | a page of `T` (**deprecated** as a declared find) | takes `page`/`pageSize`/`sort`/`dir`, returns `{ items, page, pageSize, total, totalPages }` |
| `T envelope` | `{ id, ts, body }` wrapper | see [Type system → carriers](04-type-system.md#generic-carriers--paged-envelope-option) |
| `T option` / `T or <Error>` | the absence shape | untagged: `T` at 200, 404 / the error's status on miss — [chapter 9](09-payloads-and-unions.md#union-finds--the-untagged-exception) |

A paged read auto-gains `page`/`pageSize`/`sort`/`dir` parameters and a `total`/`totalPages` count query (the same shape the auto-`findAll` and a paged `queryHandler` use):

```ddd
repository Orders for Order {
  find forCustomer(c: string): Order paged where this.customer == c
}
```

`Order` carries `softDeletable`, so every read below also ANDs the capability filter `not is_deleted` ([chapter 11](11-capabilities-filters-stamps.md)):

::: tabs backend
== node
```ts
async forCustomer(c: string, page: number, pageSize: number, sort: string, dir: string):
    Promise<{ items: Order[]; page: number; pageSize: number; total: number; totalPages: number }> {
  const offset = (page - 1) * pageSize;
  const sortColumn = sortColumns[sort] ?? schema.orders.id;
  const orderBy = dir === "desc" ? desc(sortColumn) : asc(sortColumn);
  const countRows = await this.db.select({ value: count() }).from(schema.orders).where(and(eq(schema.orders.customer, c), not(eq(schema.orders.isDeleted, true))));
  const total = Number(countRows[0]?.value ?? 0);
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  const rootRows = await this.db.select().from(schema.orders).where(and(eq(schema.orders.customer, c), not(eq(schema.orders.isDeleted, true)))).orderBy(orderBy).limit(pageSize).offset(offset);
  // …
  return { items, page, pageSize, total, totalPages };
}
```
== dotnet
```csharp
public async Task<Paged<Order>> ForCustomer(string c, int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default)
{
    var offset = (page - 1) * pageSize;
    var sortColumn = sort switch { "customer" => "Customer", "ref" => "Ref", "total" => "Total", "status" => "Status", "placedAt" => "PlacedAt", _ => "Id" };
    var total = await _db.Orders.Where(x => x.Customer == c).CountAsync(cancellationToken);   // IsDeletedFilter applied by EF
    var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;
    var ordered = dir == "desc" ? _db.Orders.Where(x => x.Customer == c).OrderByDescending(e => EF.Property<object>(e, sortColumn)) : /* …OrderBy */;
    var items = await ordered.Skip(offset).Take(pageSize).ToListAsync(cancellationToken);
    return new Paged<Order>(items, page, pageSize, total, totalPages);
}
```
== java
```java
// OrderJpaRepository:  @Query("select e from Order e where e.customer = :c") Page<Order> forCustomer(@Param("c") String c, Pageable pageable);
public Paged<Order> forCustomer(String c, int page, int pageSize, String sort, String dir) {
    String __sortField = java.util.List.of("id", "customer", "ref", "total", "status", "placedAt").contains(sort) ? sort : "id";
    Sort __sort = Sort.by("desc".equals(dir) ? Sort.Direction.DESC : Sort.Direction.ASC, __sortField);
    var result = jpa.forCustomer(c, PageRequest.of(page - 1, pageSize, __sort));
    return new Paged<>(result.getContent(), page, pageSize, (int) result.getTotalElements(), result.getTotalPages());
}
```
== python
```python
async def for_customer(self, c: str, page: int, page_size: int, sort: str, dir: str) -> PagedResult[Order]:
    offset = (page - 1) * page_size
    _sort_attr = getattr(OrderRow, _sort_columns.get(sort, "id"))
    _order = _sort_attr.desc() if dir == "desc" else _sort_attr.asc()
    total = (await self._session.execute(
        select(func.count()).select_from(OrderRow).where(and_((OrderRow.customer == c), not_(OrderRow.is_deleted))))).scalar_one()
    total_pages = (total + page_size - 1) // page_size if page_size > 0 else 0
    # …select(OrderRow).where(…).order_by(_order).limit(page_size).offset(offset)
```
== elixir
```elixir
def for_customer(c, page \\ 1, page_size \\ 20, sort \\ "id", dir \\ "asc") do
  query = from(record in D.Catalog.Order, where: (record.customer == ^c) and (not record.is_deleted))
  total = Repo.aggregate(query, :count, :id)
  offset = (page - 1) * page_size
  sort_col = case sort do "customer" -> :customer  "ref" -> :ref  "total" -> :total  "status" -> :status  "placedAt" -> :placed_at  _ -> :id end
  dir_atom = if dir == "desc", do: :desc, else: :asc
  items = query |> order_by([record], [{^dir_atom, field(record, ^sort_col)}]) |> limit(^page_size) |> offset(^offset) |> Repo.all()
  {:ok, %{items: items, page: page, pageSize: page_size, total: total, totalPages: if(page_size > 0, do: ceil(total / page_size), else: 0)}}
end
```
::: end

### `requires` — gating a read

A find (and a projection) may carry a `requires <expr>` authorization gate. It runs **before** the query, so it may only read `currentUser` (and constants) — `this.<field>` or a parameter there is `loom.find-gate-not-current-user`; use `where` to scope rows and `requires` to allow/deny the caller. The enforcement story (403, `denyByDefault`, history reads inheriting the list gate) is in [chapter 17](17-auth.md) and [`../auth.md`](../auth.md).

```ddd
find mine(c: string): Order? requires currentUser.role == "agent" where this.code == c
```

## `criterion`

A `criterion` is a named, parameterised, **pure boolean predicate** over a candidate type (the Specification pattern). `of <Agg>` names the candidate; inside the body, bare field names (and `this`) resolve against it — the same convention as `invariant`/`derived`. `of <Agg> as <alias>` binds an explicit candidate name instead (an alias that shadows a parameter is `loom.criterion-alias-collision`); `of bool` is an ambient predicate with no candidate — those two are the only admitted targets (`loom.criterion-unsupported-target`), and a criterion may only filter the aggregate it is declared `of` (`loom.criterion-target-mismatch` when a `find`/`retrieval`/`filter` on another aggregate names it). Criteria compose with `&& || !` (the boolean operators *are* the composition), must be pure (`loom.criterion-impure`), acyclic (`loom.criterion-cycle`), and called with the right arity (`loom.criterion-arity`).

```ddd
criterion ActiveOrder of Order = status != OrderStatus.Closed
criterion HighValue(min: money) of Order = total >= min
criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
```

A criterion reference is **inlined** wherever a boolean expression is expected (a `projection where`, an `invariant`, a `find where` composed with other terms) — it produces exactly the same lowered SQL as the hand-written filter. But when a `find`'s, `retrieval`'s or `filter`'s predicate is *exactly* one named criterion, it **reifies**: the backend emits a named predicate object the query consumes. The rule is simply "if it has a name." See [`../criterion.md`](../criterion.md) for the full validation table.

The reification target differs per backend — this is `HighValue` reified:

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — module-level predicate function
const highValueCriterion = (min: Decimal) => gte(schema.orders.total, min);
// …consumed by runBigActive / findAllByHighValue below
```
== dotnet
```csharp
// Domain/Criteria/HighValueCriterion.cs — Criterion<T> with both a runtime
// check and a query-side expression tree
public sealed class HighValueCriterion : Criterion<Order>
{
    private readonly decimal min;
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
== python
```python
# SQLAlchemy is non-reifying: the predicate inlines at each call site
# select(OrderRow).where(and_((OrderRow.total >= min), not_(OrderRow.is_deleted)))
```
== elixir
```elixir
# Ecto is non-reifying too: the predicate inlines into each query module
# from(record in D.Catalog.Order, where: record.total >= ^min)
```
::: end

## `retrieval`

A `retrieval` is a named query *bundle* — a `where` predicate plus the shaping a real query carries: `sort` ordering and (reserved) `loads` fetch paths. Its `where` is a selection position with the same queryable-subset contract as a find — a bare predicate, a criterion, or a composition of both (`loom.retrieval-where-not-queryable` / `-unknown-field` / `-column-column`; a `sort` on a non-field is `loom.retrieval-sort-unknown-field`). The block form carries `where:` / `sort:` / `loads:` slots; the single-line form `retrieval Name of Agg = <expr>` is the bare-predicate shorthand.

```ddd
retrieval BigActive(min: money) of Order {
  where: HighValue(min)
  sort:  [total desc, ref asc]
}
```

A retrieval lowers to a `run<Name>` repository method that consumes the reified criterion and applies the sort. Paging is a **call-site** argument (`Repo.run(BigActive(m), page: { offset: 0, limit: 100 })`), never part of the declaration:

::: tabs backend
== node
```ts
async runBigActive(min: Decimal, page?: { offset?: number; limit?: number }): Promise<Order[]> {
  let query = this.db.select().from(schema.orders)
    .where(and(highValueCriterion(min), not(eq(schema.orders.isDeleted, true))))
    .orderBy(desc(schema.orders.total), asc(schema.orders.ref)).$dynamic();
  // if (page?.limit !== undefined) query = query.limit(page.limit); …offset
}
```
== dotnet
```csharp
// Domain/Orders/BigActiveSpec.cs — an Ardalis Specification bundling the criterion + sort
public sealed class BigActiveSpec : Specification<Order>
{
    public BigActiveSpec(decimal min)
    {
        Query.Where(new HighValueCriterion(min).ToExpression()).OrderByDescending(x => x.Total).ThenBy(x => x.Ref);
    }
}
// OrderRepository.RunBigActiveAsync(decimal min, (int? offset, int? limit)? page = null, FilterBypass bypass = default, …)
//   var __q = _db.Orders.AsQueryable();  if (bypass.All) __q = __q.IgnoreQueryFilters(); …
```
== java
```java
public List<Order> runBigActive(BigDecimal min, Integer offset, Integer limit) {
    return jpa.findAll(OrderCriteria.HighValue(min),
        new OffsetLimitPageRequest(offset, limit, Sort.by(Sort.Order.desc("total"), Sort.Order.asc("ref")))).getContent();
}
```
== python
```python
async def run_big_active(self, min: Decimal, offset: int | None = None, limit: int | None = None) -> list[Order]:
    query = select(OrderRow).where(and_((OrderRow.total >= min), not_(OrderRow.is_deleted))).order_by(OrderRow.total.desc(), OrderRow.ref.asc())
    if offset is not None:
        query = query.offset(offset)
    if limit is not None:
        query = query.limit(limit)
```
== elixir
```elixir
# lib/d/catalog/retrievals/big_active.ex
def run(min, opts \\ []) do
  query = from(record in D.Catalog.Order, where: record.total >= ^min)
  query = if opts[:ignore_all_filters] || "softDeletable" in (opts[:ignore_filters] || []), do: query, else: where(query, [record], not record.is_deleted)
  query = if opts[:limit], do: limit(query, ^opts[:limit]), else: query
  query = if opts[:offset], do: offset(query, ^opts[:offset]), else: query
  query = order_by(query, [record], [desc: record.total, asc: record.ref])
  {:ok, Repo.all(query)}
end
```
::: end

`Repo.run(retrieval { where: <Criterion> sort: […] }, page?)` is the anonymous, call-site twin accepted from workflow / handler bodies (`RetrievalLiteral` in the grammar) — **its** `where:` must be a criterion reference in this release. See [`../workflow.md`](../workflow.md) and [`../criterion.md`](../criterion.md).

### `loads:` shaping

`loads:` declares structural fetch paths through the candidate — e.g. `loads: [this.lines[].product]`, a flat dotted `LoadPath` with `[]` marking "across the collection" (mirrors `contains`). A leading `this.` is admitted and stripped.

**Honest gap:** explicit `loads:` is **not shipped** — a retrieval with one is rejected (`loom.retrieval-loads-unsupported`: "explicit 'loads:' is not supported yet — retrievals load the whole aggregate. (Per-operation autoload is planned.)"). Retrievals load the whole aggregate; treat `loads:` as reserved surface.

## `Repo.run` & the paged `queryHandler`

`Repo.run(<Criterion>(args))` is the read-only port a handler body reads through — the criterion-driven replacement for a list find. A `queryHandler` that returns `<Agg> paged` over it is the ergonomic paged list read (what [`scaffoldPaged`](../scaffold-macros.md) expands to): enrichment synthesises a paged `findAllBy<Criterion>` find on the aggregate's repository (not auto-exposed — the handler's `route` is the exposure), the handler's return is auto-projected to `<Agg>Response paged`, and `page`/`pageSize`/`sort`/`dir` come from the paged infra, never from handler params. Emitted on all five backends (`loom.paged-query-handler-unsupported-backend` is a dormant net).

```ddd
queryHandler ListBig(min: money): Order paged {
  let r = Orders.run(HighValue(min))
  return r
}
api CatalogApi from Sales { route GET "/big" -> Catalog.ListBig }
```

::: tabs backend
== node
```ts
// http/catalogApi-routes.ts
request: { query: z.object({ min: moneySchema, page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(20), sort: z.string().default("id"), dir: z.string().default("asc") }) },
// …
const result = await orders.findAllByHighValue(min, query.page, query.pageSize, query.sort, query.dir);
return httpCtx.json({ ...result, items: result.items.map((__e) => orders.toWire(__e)) }, 200);
```
== dotnet
```csharp
// Application/Orders/Queries/ListBigHandler.cs
public async ValueTask<Paged<OrderResponse>> Handle(ListBigQuery query, CancellationToken cancellationToken)
{
    var domain = await _orders.FindAllByHighValue(query.Min, query.Page, query.PageSize, query.Sort, query.Dir, cancellationToken);
    return new Paged<OrderResponse>(domain.Items.Select(d => new OrderResponse(/* … */)).ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);
}
```
== java
```java
// application/workflows/ListBigHandler.java
public Paged<Order> handle(BigDecimal min, int page, int pageSize, String sort, String dir) {
    return ordersRepository.findAllByHighValue(min, page, pageSize, sort, dir);
}
```
== python
```python
# app/application/list_big.py
async def list_big(session: AsyncSession, min: Decimal, page: int, page_size: int, sort: str, dir: str) -> dict[str, object]:
    orders = OrderRepository(session, make_dispatcher(session))
    result = await orders.find_all_by_high_value(min, page, page_size, sort, dir)
    return {"items": [orders.to_wire(__e) for __e in result.items], "page": result.page, "pageSize": result.page_size, "total": result.total, "totalPages": result.total_pages}
```
== elixir
```elixir
# lib/d_web/controllers/catalog_api_routes_controller.ex
def list_big(conn, params) do
  with {:ok, page_arg} <- page_param(params, "page", 1, 1000000),
       {:ok, page_size_arg} <- page_param(params, "pageSize", 20, 500),
       {:ok, result} <- D.Catalog.find_all_by_high_value_order(params["min"], page_arg, page_size_arg, Map.get(params, "sort", "id"), Map.get(params, "dir", "asc")) do
    json(conn, %{result | items: Enum.map(result.items, &serialize/1)})
  end
end
```
::: end

The inline twin inside a handler / workflow body is `Repo.findAll(<Criterion>(args), page: { offset: 0, limit: N })` (optionally `… ignoring …`, see below): the criterion must exist on that aggregate with the right arity (`loom.findall-unknown-criterion` / `-criterion-mismatch` / `-criterion-arity`), and in a workflow body the `page:` bound is mandatory — an unbounded list read is `loom.findall-no-page`.

A read position (an api `GET`/`HEAD` route, a `queryHandler`, a `reading` service) may not reach the mutating repository face — a read-method route bound to a mutating `commandHandler` or a workflow `handle` is `loom.read-context-repo-write`. Domain-service reads have their own rules (`loom.domain-service-read-unsupported`, `-cross-context-read` — [chapter 23](23-domain-services-and-seeds.md)), and a repository read inside a test `expect(...)` must be `let`-bound first (`loom.integration-find-must-bind` — [chapter 18](18-testing.md)).

## `ignoring` — capability-filter bypass

A trailing `ignoring` clause on a read skips the query-filters a capability contributed (soft-delete row hiding, tenancy scoping, a `filter` capability), keyed on the **capability** name. `ignoring *` bypasses every capability filter on the aggregate; `ignoring A, B` bypasses exactly those. `ignoring` is a soft keyword (fields/params named `ignoring` keep parsing). All five backends honour it (`FILTER_BYPASS_FAMILIES`; `loom.filter-bypass-unsupported` is a dormant net):

```ddd
repository Orders for Order {
  find everything(): Order[] ignoring softDeletable
}
```

::: tabs backend
== node
```ts
async everything(): Promise<Order[]> {
  const rootRows = await this.db.select().from(schema.orders);   // no `not(isDeleted)` term
  // …
}
```
== dotnet
```csharp
public async Task<List<Order>> Everything(CancellationToken cancellationToken = default)
{
    var result = await _db.Orders.IgnoreQueryFilters(["IsDeletedFilter"]).ToListAsync(cancellationToken);
    return result;
}
```
== java
```java
public List<Order> everything() {
    var __session = em.unwrap(org.hibernate.Session.class);
    __session.disableFilter("softDeletable");
    try { return jpa.everything(); } finally { __session.enableFilter("softDeletable"); }
}
```
== python
```python
async def everything(self) -> list[Order]:
    rows = (await self._session.execute(select(OrderRow))).scalars().all()   # no not_(is_deleted)
    return [await self._hydrate(row) for row in rows]
```
== elixir
```elixir
def everything() do
  query = from(record in D.Catalog.Order)
  {:ok, Repo.all(query)}
end
```
::: end

`ignoring` has exactly three homes, each read by a different lowerer; anywhere else it parses, binds to the wrong expression, is never read back — and is now an error (`loom.ignoring-clause-placement`):

| Position | Spelling |
|---|---|
| a repository `find` | `find recent(): Order[] where … ignoring softDeletable` |
| a query-time projection's `where` slot — **before** `join` / `group by` / `select` | `from Order as o ignoring softDeletable  group by …` |
| an inline read bound by a `let` | `let xs = Orders.findAll(Big()) ignoring *` |

Naming a capability the aggregate does not implement is `loom.filter-bypass-unknown-capability`; naming one that contributes no filter (`ignoring auditable`) is `loom.filter-bypass-no-filter`; an `ignoring` over a workflow or projection source has nothing to bypass (`loom.projection-workflow-source-ignoring-no-effect` / `loom.projection-source-ignoring-no-effect`). See [chapter 11](11-capabilities-filters-stamps.md) for the `filter` capability that produces these predicates.

## `projection` — the read model

A `projection` is a named read model served at `GET /projections/<snake_name>` (and `/{key}` for a keyed one). It comes in two flavours, decided by which clauses the body carries — never both (`loom.projection-query-and-fold-invalid`):

| Flavour | Body | Storage | Serves |
|---|---|---|---|
| **query-time** | `from <Source> [as <alias>] [where …] [ignoring …] [join …]* [group by …] [select …]` | none — computed on every read | a list of rows (or one object for the whole-table aggregation) |
| **folded** | `keyed by <field>` + `on(e: <Event>) [by <expr>] { … }` folds | a materialized `<proj>` table, one row per key | the row list + `/{key}` |

Both may declare row fields (`name: type`), take parameters (`projection OrdersInRegion(region: string) { … }`), and carry a `requires` gate (`currentUser`-only — `loom.projection-gate-not-current-user`). The wire row is the declared fields (`wireShape`), so every backend serves the same JSON.

### Query-time — `from … select …`

The per-row read: `from` names the source, `where` is a criterion position over it (the queryable subset), each `join <Agg> as <c> on <idRef>` is a **by-id follow** (the reference's identity only — an arbitrary join key is rejected), and `select` fills each declared field from the source alias and join aliases. The query itself is the source aggregate's repository (a synthesised source find carrying the `where` and the capability filters); the joins are an app-level bulk load by id after it.

```ddd
projection OrderWithCustomer {
  orderId: Order id  ref: string  customerName: string
  from Order as o
  join Customer as c on o.customerId
  select orderId = o.id, ref = o.ref, customerName = c.name
}
```

::: tabs backend
== node
```ts
// http/query-projections.ts — GET /projections/order_with_customer
const OrderWithCustomerRow = z.object({ orderId: z.string(), ref: z.string(), customerName: z.string() }).openapi("OrderWithCustomerRow");
// …
const repo = new OrderRepository(db, events);
const rows = await repo.orderWithCustomer();                       // synthesised source find (+ capability filters)
const customerRepo = new CustomerRepository(db, events);
const customerById = new Map((await customerRepo.findManyByIds(rows.map((r) => r.customerId))).map((a) => [a.id as string, a]));
const projected = rows.map((r) => ({ orderId: r.id as string, ref: r.ref, customerName: customerById.get(r.customerId as string)!.name }));
```
== dotnet
```csharp
// Application/Projections/OrderWithCustomerQpHandler.cs
var domain = await _repo.OrderWithCustomer(cancellationToken);
var customerById = (await _customerRepo.FindManyByIdsAsync(domain.Select(d => d.CustomerId).ToList(), cancellationToken)).ToDictionary(__a => __a.Id);
return domain.Select(d => new OrderWithCustomerRow(d.Id.Value, d.Ref, customerById[d.CustomerId].Name)).ToList();
```
== java
```java
// application/views/CatalogQueryProjections.java
public List<OrderWithCustomerRow> orderWithCustomer() {
    var customerById = customersRepository.findAll().stream().collect(Collectors.toMap(__a -> __a.id().value(), __a -> __a));
    return ordersRepository.orderWithCustomer().stream()
        .map(a -> new OrderWithCustomerRow(a.id().value(), a.ref(), customerById.get(a.customerId().value()).name()))
        .toList();
}
```
== python
```python
# app/http/query_projections_routes.py
rows = await repo.order_with_customer()
customer_by_id = {str(a.id): a for a in await customer_repo.find_many_by_ids([r.customer_id for r in rows])}
return [{"orderId": r.id, "ref": r.ref, "customerName": customer_by_id[str(r.customer_id)].name} for r in rows]
```
== elixir
```elixir
# lib/d/catalog/query_projections/order_with_customer.ex
rows = from(record in D.Catalog.Order, where: not record.is_deleted) |> Repo.all()
customer_by_id = from(row in D.Catalog.Customer, where: row.id in ^Enum.map(rows, fn record -> record.customer_id end)) |> Repo.all() |> Map.new(&{&1.id, &1})
Enum.map(rows, fn record -> %{orderId: record.id, ref: record.ref, customerName: Map.get(customer_by_id, record.customer_id).name} end)
```
::: end

A `select` that names nothing resolvable is `loom.projection-select-unresolved`; a `where` outside the queryable subset is `loom.projection-where-not-queryable`.

### Shorthand — the `select`-less form

Omit **both** the row fields and the `select`, and the row is the **source aggregate's own full wire shape** — each filtered row serialized through the aggregate's own domain→wire mapper, exactly as its list route does. This is the replacement for the removed `view X = A where P`:

```ddd
projection ActiveOrders {
  from Order as o where ActiveOrder
}
```

```ts
// http/query-projections.ts (node) — GET /projections/active_orders
const ActiveOrdersRow = z.object({ id: z.string(), customer: z.string(), ref: z.string(), total: z.string(), status: z.enum([…]), placedAt: z.string(), customerId: z.string(), isDeleted: z.boolean(), deletedAt: z.string().nullish(), version: z.number().int() }).openapi("ActiveOrdersRow");
const rows = await repo.activeOrders();                 // where: status != "Closed" AND not isDeleted
const projected = rows.map((r) => repo.toWire(r));      // the aggregate's own mapper
```

Every backend does the same through its own serializer — .NET `domain.Select(d => new ActiveOrdersRow(d.Id.Value, d.Customer, …))`, Java `.map(a -> new ActiveOrdersRow(a.id().value(), …))`, Python `[repo.to_wire(r) for r in rows]`, Elixir `Enum.map(rows, &serialize/1)`. **Aggregate source only** — a `select`-less projection over a workflow or projection source is `loom.projection-shorthand-nonaggregate`; row fields with no `select` to fill them is the different error `loom.projection-fields-without-select`.

### Whole-table aggregation — the singleton

A `select` made only of aggregations (`count()` / `sum(col)` / `avg(col)` / `min(col)` / `max(col)`) is a **whole-table aggregation**: one SQL query, no rows rehydrated, and the read returns **one object** rather than a list. Aggregation arguments must be bare source columns (`sum(o.total)`, never `sum(o.total + o.tax)` — `loom.projection-aggregate-arg-not-columnar`).

```ddd
projection OrderVolume {
  total: int  revenue: money
  from Order as o
  where Confirmed
  select total = count(), revenue = sum(o.total)
}
```

::: tabs backend
== node
```ts
const OrderVolumeResponse = OrderVolumeRow.openapi("OrderVolumeResponse");   // one object, not an array
const [row] = await db.select({ total: count(), revenue: sum(schema.orders.total) }).from(schema.orders).where(and(eq(schema.orders.status, "Confirmed"), not(eq(schema.orders.isDeleted, true))));
const projected = { total: Number(row?.total ?? 0), revenue: new Decimal(row?.revenue ?? 0).toFixed(4) };
```
== dotnet
```csharp
var agg = await _db.Orders.AsNoTracking().Where(o => o.Status == OrderStatus.Confirmed)
    .GroupBy(_ => 1)
    .Select(g => new { Total = g.Count(), Revenue = g.Sum(o => o.Total) })
    .FirstOrDefaultAsync(cancellationToken);
return new OrderVolumeRow(agg?.Total ?? 0, (agg?.Revenue ?? 0m).ToString("F4", CultureInfo.InvariantCulture));
```
== java
```java
Object[] r = (Object[]) entityManager.createQuery("select count(e), sum(e.total) from Order e where e.status = com.loom.d.domain.enums.OrderStatus.Confirmed").getSingleResult();
return new OrderVolumeRow(((Number) r[0]).intValue(), r[1] == null ? "0.0000" : new java.math.BigDecimal(r[1].toString()).setScale(4, java.math.RoundingMode.HALF_UP).toPlainString());
```
== python
```python
row = (await session.execute(select(func.count(), func.sum(OrderRow.total)).select_from(OrderRow).where(and_((OrderRow.status == OrderStatus.Confirmed), not_(OrderRow.is_deleted))))).one()
return {"total": int(row[0] or 0), "revenue": money_str(Decimal(row[1] or 0))}
```
== elixir
```elixir
row = from(record in D.Catalog.Order, where: (record.status == ^"Confirmed") and (not record.is_deleted), select: %{total: count(record.id), revenue: sum(record.total)}) |> Repo.one()
%{total: row.total || 0, revenue: __money_wire(row.revenue || 0)}
```
::: end

Note the per-field wire coercions every backend applies identically: a `money` aggregate rides the wire as a 4-decimal string, `count` zero-defaults over an empty table.

### Grouped — `group by`

Mixing an aggregate `select` with a per-row `select` is a **GROUP BY** — one row per distinct value of the per-row column. Declare the grouping explicitly with `group by <col>, …` (between `where`/`join` and `select`); the mix without the clause is `loom.projection-groupby-missing`.

```ddd
projection SalesByStatus {
  status: OrderStatus  orders: int  revenue: money
  from Order as o
  group by o.status
  select status = o.status, orders = count(), revenue = sum(o.total)
}
```

The read happens **in SQL** and returns the list shape, **ordered by the grouping columns** so it is deterministic across backends:

::: tabs backend
== node
```ts
const rows = await db.select({ status: schema.orders.status, orders: count(), revenue: sum(schema.orders.total) }).from(schema.orders).where(not(eq(schema.orders.isDeleted, true))).groupBy(schema.orders.status).orderBy(schema.orders.status);
const projected = rows.map((r) => ({ status: r.status, orders: Number(r.orders ?? 0), revenue: new Decimal(r.revenue ?? 0).toFixed(4) }));
```
== dotnet
```csharp
var groups = await _db.Orders.AsNoTracking()
    .GroupBy(o => new { o.Status })
    .Select(g => new { g.Key.Status, Orders = g.Count(), Revenue = g.Sum(o => o.Total) })
    .OrderBy(x => x.Status)
    .ToListAsync(cancellationToken);
```
== java
```java
List<Object[]> rows = entityManager.createQuery("select e.status, count(e), sum(e.total) from Order e group by e.status order by e.status").getResultList();
```
== python
```python
select(OrderRow.status, func.count(), func.sum(OrderRow.total)).select_from(OrderRow).where(not_(OrderRow.is_deleted)).group_by(OrderRow.status).order_by(OrderRow.status)
```
== elixir
```elixir
from(record in D.Catalog.Order, where: not record.is_deleted, group_by: record.status, order_by: record.status, select: %{status: record.status, orders: count(record.id), revenue: sum(record.total)})
```
::: end

The shape discipline (each its own diagnostic):

- **Aggregate `from` source required** — workflow/projection sources and folded projections cannot be grouped (`loom.projection-groupby-source-invalid`).
- **At least one aggregate `select`** — a `group by` with only per-row selects is just DISTINCT (`loom.projection-groupby-no-aggregate`).
- **Per-row selects must be grouping columns** (`loom.projection-groupby-select-not-grouped`).
- **Grouping keys are source columns** — optionally bucketed by the one supported transform, `startOfDay()` on a `datetime` (`GroupKeyTransform` in `src/ir/util/projection-aggregate.ts`); any other computed key (arithmetic, another intrinsic) is `loom.projection-groupby-key-not-columnar`, and a key `select` must repeat the grouping expression exactly (`select day = o.placedAt` against `group by o.placedAt.startOfDay()` is per-row, not per-group).
- **No `join`, no `keyed by`** — a join is an app-level by-id load after the query (`loom.projection-groupby-join-invalid`), and grouped rows are the groups, not id-keyed entities (`loom.projection-groupby-keyed-invalid`).

The transform renders as the same `date_trunc('day', …)` in SELECT, GROUP BY and ORDER BY on every backend — a daily series:

```ddd
projection DailyRevenue {
  day: datetime  revenue: money
  from Order as o
  group by o.placedAt.startOfDay()
  select day = o.placedAt.startOfDay(), revenue = sum(o.total)
}
```

::: tabs backend
== node
```ts
const rows = await db.select({ day: sql`date_trunc('day', ${schema.orders.placedAt})`.mapWith(schema.orders.placedAt), revenue: sum(schema.orders.total) })
  .from(schema.orders).where(not(eq(schema.orders.isDeleted, true)))
  .groupBy(sql`date_trunc('day', ${schema.orders.placedAt})`).orderBy(sql`date_trunc('day', ${schema.orders.placedAt})`);
```
== elixir
```elixir
from(record in D.Catalog.Order, where: not record.is_deleted,
  group_by: fragment("date_trunc('day', ?)", record.placed_at),
  order_by: fragment("date_trunc('day', ?)", record.placed_at),
  select: %{day: fragment("date_trunc('day', ?)", record.placed_at), revenue: sum(record.total)})
```
::: end

**No paging, no `order by`.** A projection read returns the whole row list — there is no `paged` carrier or sort clause on a projection (the grammar reserves `order by` for a later slice; no `loom.projection-paged-*` code exists). Grouped reads are ordered by their grouping columns; for a paged list, use a paged `queryHandler` ([above](#reporun--the-paged-queryhandler)).

### Sources — aggregate, workflow, projection

`from` may name an **aggregate** (read through its repository — the default and only source that supports `join`, `ignoring`, the shorthand, and the direct-table arms), a **workflow** (read through its persisted instance rows — it must be state-backed and observable, i.e. have a single id-shaped correlation field: `loom.projection-workflow-source-not-observable`, `-eventsourced-invalid`; no `join`: `-join-invalid`), or another **materialized projection** (a folded one with a table — a query-time source has nothing to read `from`: `loom.projection-source-not-materialized`; never itself: `-source-self`; no `join`: `-source-join-invalid`).

```ddd
workflow Fulfil {
  orderId: Order id
  attempts: int
  create(p: OrderConfirmed) by p.orderRef { attempts := 1 }
}
projection ActiveFulfils {
  orderId: Order id  attempts: int
  from Fulfil as f where f.attempts > 0
  select orderId = f.orderId, attempts = f.attempts
}
```

The read goes straight to the workflow's instance-state table (no repository, no capability filters):

::: tabs backend
== node
```ts
// http/query-projections.ts — GET /projections/active_fulfils
const rows = await db.select().from(schema.fulfils).where(gt(schema.fulfils.attempts, 0));
const projected = rows.map((r) => ({ orderId: r.orderId, attempts: r.attempts }));
```
== elixir
```elixir
# lib/d/catalog/query_projections/active_fulfils.ex — "Source workflow: Fulfil (saga instance state)"
rows = from(record in D.Catalog.Workflows.FulfilState, where: record.attempts > 0) |> Repo.all()
Enum.map(rows, fn record -> %{orderId: record.order_id, attempts: record.attempts} end)
```
::: end

### The source has to have columns

The two **direct-table** arms — the whole-table aggregation and the grouped read — name columns on the source aggregate's own table, because the arithmetic happens in SQL. Three source shapes have no such columns, and the read is refused on **every** backend (`loom.projection-columnless-source`): `persistedAs: eventLog` (no state table), `shape: document` (the table is `(id, data, version)`; refused per column named — `count()` alone is fine), and a TPC abstract base (no table of its own). The way out is a different *read* — the per-row arm, or a folded projection.

Two more conditions bite only the surviving document `count()`: a capability-filtered document source (`loom.projection-document-source-capability-filtered` — the filter predicates name `tenant_id` / `is_deleted`, columns the jsonb triple lacks; waive them with `ignoring` or store relationally), and **Java** cannot aggregate a document table at all (`loom.projection-whole-table-aggregation-unsupported#document` / `loom.projection-groupby-unsupported-backend#document` — no JPA entity to name). `scaffoldDashboard` skips document aggregates accordingly ([`../scaffold-macros.md`](../scaffold-macros.md)).

### Folded — `keyed by` + `on(e: Event)`

A projection with no query clauses and one or more `on(e: <Event>) { … }` handlers is a **materialized read model**: a table with one row per `keyed by` key, updated by a pure fold on each event. `keyed by` must name a declared id-shaped field (`loom.projection-key-unknown` / `-key-not-id`); the routing key is `e.<key>` unless `by <expr>` says otherwise (an event without the key field and no `by` is `loom.projection-event-unkeyed`). The grammar makes `keyed by` optional — but a *fold* without it has no key to route by and is refused by that same `loom.projection-event-unkeyed`; the keyless ("singleton") projection is the query-time whole-table aggregation above, not a fold. Each event type folds in exactly one handler (`loom.projection-duplicate-on`), and the body is a **pure fold** — `:=` assignments and `let` only; an `emit`, a call, a guard or a `return` is `loom.projection-fold-impure` (use a workflow `on(e)` reactor instead). In-process dispatch is channel-routed, so the event must be carried by a `channel` or the fold never runs (`loom.projection-event-uncarried`); folding an event that carries a `mask unless` field would launder the masked value into an unredacted row, so it is refused too (`loom.field-mask-projection-source` — see [chapter 17](17-auth.md)).

```ddd
event OrderConfirmed { orderRef: Order id, at: datetime }
channel Lifecycle { carries: OrderConfirmed  delivery: broadcast  retention: ephemeral }

projection OrderBoard keyed by orderRef {
  orderRef: Order id
  confirmedAt: datetime
  on(e: OrderConfirmed) { orderRef := e.orderRef  confirmedAt := e.at }
}
```

::: tabs backend
== node
```ts
// http/projections.ts — load-or-allocate the row by key, fold, upsert
export async function foldOrderConfirmedIntoOrderBoard(db, e: Events.OrderConfirmed): Promise<void> {
  const __key = e.orderRef;
  const state = (await loadOrderBoard(db, __key)) ?? { orderRef: __key };
  state.orderRef = e.orderRef;
  state.confirmedAt = e.at;
  await saveOrderBoard(db, state);   // insert … onConflictDoUpdate({ target: schema.orderBoards.orderRef, set: state })
}
// GET /projections/order_board  →  OrderBoardListResponse;  GET /projections/order_board/{key}  →  OrderBoardResponse (404 on miss)
```
== dotnet
```csharp
// Application/Workflows/OrderBoardOnOrderConfirmedHandler.cs folds into
// Infrastructure/Persistence/Projections/OrderBoardRow.cs; served by Api/CatalogProjectionsController.cs
```
== java
```java
// infrastructure/repositories/OrderBoardRowRepository.java + api/CatalogProjectionsController.java
```
== python
```python
# app/http/projections_routes.py — the fold + GET /projections/order_board[/{key}]
```
== elixir
```elixir
# lib/d/catalog/projections/order_board/on_order_confirmed.ex
def handle(%D.Catalog.Events.OrderConfirmed{} = event) do
  key = event.order_ref
  state = case D.Repo.get(D.Catalog.Projections.OrderBoardRow, key) do
    nil -> %D.Catalog.Projections.OrderBoardRow{order_ref: key}
    existing -> existing
  end
  {:ok, _} = D.Repo.insert_or_update(Ecto.Changeset.change(state, %{confirmed_at: event.at |> then(&(&1 && DateTime.truncate(&1, :second)))}))
  :ok
end
```
::: end

The projection tracks **events, not rows**: an aggregate `update` that emits nothing leaves the read model untouched, and deleting the aggregate does not delete the fold row.

### Backend gates

Every projection shape above emits on all five backends (`PROJECTION_QT_SUPPORTED` / `_AGG_` / `_GROUPBY_` / `_WF_SOURCE_` / `_PROJ_SOURCE_SUPPORTED` in `src/ir/validate/checks/system-checks.ts` all list node/dotnet/java/python/elixir); the per-backend codes (`loom.projection-query-time-unsupported`, `-workflow-source-unsupported-backend`, `-source-unsupported-backend`, `-whole-table-aggregation-unsupported`, `-groupby-unsupported-backend`) are dormant nets for a future backend or persistence adapter, except the `#document` Java variants above. There is no per-feature `docs/projections.md`; this chapter and [`../scaffold-macros.md`](../scaffold-macros.md) (`scaffoldDashboard`) are the reference.
