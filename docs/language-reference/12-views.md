# 12. Views

A `view` is a named, strongly-typed saved query declared inside a context. Two forms share one head: the **shorthand** `view X = Agg where …` returns the source aggregate's existing wire shape; the **full form** `view X { Props… from Agg where … bind name=expr }` declares its own output record and projects each field with a `bind` expression evaluated on the hydrated row. An optional `requires` clause sits before `where` as a caller-authorization gate. Each view lowers to a parameterless repository method plus a `GET /views/<snake_name>` route on every backend that serves its context.

> **Grammar:** `View`, `ViewSource`, `BindEntry`, `IgnoringClause` · **Validators:** `loom.view-where-not-queryable`, `loom.view-where-column-column`, `loom.view-where-unknown-field`, `loom.view-field-unbound`, `loom.view-bind-no-field`, `loom.view-bind-duplicate`, `loom.view-gate-not-current-user`, `loom.default-deny-ungated`, `loom.duplicate-view` · **Docs:** [`../views.md`](../views.md)

All output below is generated from one scratch system (`Sales` context: `Order` with a `customerId: Customer id`, an `OrderStatus` enum, and `contains lines: OrderLine[]`) wired to one `node`, one `dotnet`, and one `python` deployable; fragments are excerpted.

## Shorthand `view` — aggregate wire shape

`view <Name> = <Aggregate> where <Filter>` is parameterless and filter-only. `where` is **required**. The result type is the aggregate's own enriched wire shape — exactly the DTO that aggregate's find routes already return — so the route schema *reuses* `<Agg>ListResponse` rather than minting a fresh record.

```ddd
view ActiveOrders = Order where status == Confirmed
```

The filter lowers to the same query layer a repository `find` uses, and the route projects rows through the aggregate's canonical `toWire`:

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — parameterless method, lowered predicate
async activeOrders(): Promise<Order[]> {
  const rootRows = await this.db.select().from(schema.orders)
    .where(eq(schema.orders.status, "Confirmed"));
  // …same hydration path as findAll (contained lines bulk-loaded by parentId)…
}

// http/views.ts — schema is the aggregate's OrderListResponse, not a new shape
createRoute({ method: "get", path: "/active_orders", operationId: "activeOrdersView",
  responses: { 200: { content: { "application/json": { schema: OrderListResponse } } } } }),
async (httpCtx) => {
  const repo = new OrderRepository(db, events);
  const rows = await repo.activeOrders();
  return httpCtx.json(rows.map((r) => repo.toWire(r)) as z.infer<typeof OrderResponse>[], 200);
},
```
== dotnet
```csharp
// Application/Views/ActiveOrdersQuery.cs — query result is the aggregate's OrderResponse
public sealed record ActiveOrdersQuery() : IQuery<IReadOnlyList<OrderResponse>>;

// Application/Views/ActiveOrdersHandler.cs
public async ValueTask<IReadOnlyList<OrderResponse>> Handle(ActiveOrdersQuery query, CancellationToken ct)
{
    var domain = await _repo.ActiveOrders(ct);
    return domain.Select(d => new OrderResponse(d.Id.Value, d.CustomerId.Value, d.Status,
        d.PlacedAt.ToUniversalTime().ToString("o"),
        d.Lines.Select(__e => new OrderLineResponse(__e.Id.Value, __e.ProductSku, __e.Quantity)).ToList())).ToList();
}

// Api/SalesCtxViewsController.cs — GET api/views/active_orders → ActiveOrdersQuery
[HttpGet("active_orders")]
public async Task<ActionResult<IReadOnlyList<OrderResponse>>> ActiveOrdersView()
    => Ok(await _mediator.Send(new ActiveOrdersQuery()));
```
== python
```python
# app/http/views_routes.py — response_model reuses the aggregate's OrderListResponse
@router.get("/active_orders", response_model=OrderListResponse, operation_id="activeOrdersView")
async def active_orders_view(session: SessionDep) -> list[dict[str, object]]:
    repo = OrderRepository(session, NoopDomainEventDispatcher())
    return [repo.to_wire(r) for r in await repo.active_orders()]
```
::: end

## Full form — declared shape + `bind`

`view <Name> { <Property>* from <Aggregate> [where <Filter>] bind <field>=<expr>, … }`. The declared properties are the output record; `where` is **optional**; each declared field must have exactly one matching `bind`. The result is a fresh `<View>Row` record (`X id → string/Guid`, `enum → string`, etc.), emitted on every backend — **not** the aggregate's wire shape.

```ddd
view OrderSummary {
  orderId: Order id
  status: OrderStatus
  lineCount: int

  from Order where status != Cancelled
  bind orderId = id,
       status = status,
       lineCount = lines.count
}
```

Bind exhaustiveness is checked: a declared field with no `bind` is `loom.view-field-unbound`, a `bind` naming no field is `loom.view-bind-no-field`, and two binds on one field is `loom.view-bind-duplicate`.

The fresh row type plus the per-row projection (`lines.count` becomes the host's length/count idiom):

::: tabs backend
== node
```ts
// http/views.ts — a fresh Zod row object + array alias, then per-row projection
const OrderSummaryRow = z.object({
  orderId: z.string(),
  status: z.enum(["Draft", "Confirmed", "Shipped", "Cancelled"]),
  lineCount: z.number().int(),
}).openapi("OrderSummaryRow");
const OrderSummaryResponse = z.array(OrderSummaryRow).openapi("OrderSummaryResponse");

async (httpCtx) => {
  const repo = new OrderRepository(db, events);
  const rows = await repo.orderSummary();
  const projected = rows.map((r) => ({
    orderId: r.id,
    status: r.status,
    lineCount: r.lines.length,   // lines.count → .length
  }));
  return httpCtx.json(projected as z.infer<typeof OrderSummaryResponse>, 200);
}
```
== dotnet
```csharp
// Application/Views/OrderSummaryRow.cs — fresh wire-typed record (X id → Guid, enum stays typed)
public sealed record OrderSummaryRow(
    [property: Required] Guid OrderId,
    [property: Required] OrderStatus Status,
    [property: Required] int LineCount);

// Application/Views/OrderSummaryHandler.cs — project per row via the C# expr renderer
public async ValueTask<IReadOnlyList<OrderSummaryRow>> Handle(OrderSummaryQuery query, CancellationToken ct)
{
    var domain = await _repo.OrderSummary(ct);
    return domain.Select(d => new OrderSummaryRow(d.Id.Value, d.Status, d.Lines.Count)).ToList();
}
```
== python
```python
# app/http/views_routes.py — fresh Pydantic row model + RootModel array alias
class OrderSummaryRow(BaseModel):
    orderId: str
    status: OrderStatus
    lineCount: int

class OrderSummaryResponse(RootModel[list[OrderSummaryRow]]):
    pass

@router.get("/order_summary", response_model=OrderSummaryResponse, operation_id="orderSummaryView")
async def order_summary_view(session: SessionDep) -> list[dict[str, object]]:
    repo = OrderRepository(session, NoopDomainEventDispatcher())
    rows = await repo.order_summary()
    return [{"orderId": r.id, "status": r.status, "lineCount": len(r.lines)} for r in rows]
```
::: end

## `bind` projections — the hydrated-row expression language

Bind expressions run on the **hydrated source aggregate** in host code, *after* the `where` clause has filtered in SQL — so they are not restricted to the queryable subset. They use the full domain expression language: property refs, derived members, collection ops (`lines.count`, `lines.sum(l => l.subtotal.amount)`), arithmetic, and ternaries. Each bind's inferred type must be assignable to its declared field type. The `lines.count` bind above demonstrates the SQL/host split — the filter `status != Cancelled` is pushed to the query; the count is computed on the loaded `lines` collection (`.length` / `.Count` / `len(...)`).

Bind expressions may also **follow `X id` references** into other aggregates without an explicit join — `customerId.name` resolves to a typed access on `Customer.name`, and the route bulk-loads the referenced roots via a derived `findManyByIds` to avoid N+1. That joined-view machinery (multi-hop chains, dependency-ordered auxiliaries, the non-null-Id-only limit) is documented in [`../views.md`](../views.md#joined-views-snowflake-style). **Honest gap:** the Java backend does not yet implement cross-aggregate follows — a view whose binds follow an `X id` into another aggregate is an explicit emit-time error there.

## The queryable filter subset

A view `where` clause is type-checked exactly like a repository `find` filter and must satisfy the **queryable subset** — the filter is pushed to SQL, so it cannot contain anything the query layer can't express:

- no collection lambdas (`lines.where(l => …)`) and no traversal past `field` / `field.subfield` (`loom.view-where-not-queryable`),
- every column reference must resolve to a real field (`loom.view-where-unknown-field`),
- no comparison may set one column against another — the query layer models column-vs-value only (`loom.view-where-column-column`),
- the whole expression must type to `bool`.

Move anything richer into a `bind` expression (which runs on the hydrated row, not in SQL) or a repository `find`.

## `requires` — the authorization gate

Both forms accept an optional `requires <expr>` clause **before** `where`. It is the read-side analogue of an operation's `requires`: a boolean predicate that must hold or the request is rejected with **403 Forbidden** before the query runs.

```ddd
view GatedOrders = Order requires currentUser.role == "manager" where status == Confirmed
```

Because the gate runs before any row exists, it may reference **only `currentUser`** (plus constants). A `requires` expression that touches the source row (`requires status == Confirmed`) is a compile error (`loom.view-gate-not-current-user`) steering you to use `where` for row scoping. `currentUser` requires a system-level `user { … }` block and an `auth: required` deployable.

| Clause | When | Scope | On failure |
|---|---|---|---|
| `requires` | *before* the query — no row exists yet | `currentUser` only (+ constants) | whole request → **403** |
| `where` | *is* the query — pushed to SQL | the source row's fields | row filtered out |

The gate emits as a pre-query guard that raises the backend's `Forbidden` type, mapped to a 403 problem-details response:

::: tabs backend
== node
```ts
// http/views.ts — currentUser read from context, guard before the repo call
async (httpCtx) => {
  const currentUser = (httpCtx as unknown as { get(k: "currentUser"): User }).get("currentUser");
  if (!(currentUser.role === "manager")) throw new ForbiddenError("Forbidden");
  const repo = new OrderRepository(db, events);
  const rows = await repo.gatedOrders();
  return httpCtx.json(rows.map((r) => repo.toWire(r)) as z.infer<typeof OrderResponse>[], 200);
}
// app.onError: if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);
```
== dotnet
```csharp
// Application/Views/GatedOrdersHandler.cs — ICurrentUserAccessor injected, guard before the repo call
public GatedOrdersHandler(IOrderRepository repo, ICurrentUserAccessor currentUser)
{ _repo = repo; _currentUser = currentUser; }

public async ValueTask<IReadOnlyList<OrderResponse>> Handle(GatedOrdersQuery query, CancellationToken ct)
{
    var currentUser = _currentUser.User;
    if (!(currentUser.Role == "manager")) throw new ForbiddenException("Forbidden: view GatedOrders");
    var domain = await _repo.GatedOrders(ct);
    return domain.Select(d => new OrderResponse(/* …wire projection… */)).ToList();
}
```
== python
```python
# app/http/views_routes.py — current_user from request state, guard before the repo call
@router.get("/gated_orders", response_model=OrderListResponse, operation_id="gatedOrdersView")
async def gated_orders_view(request: Request, session: SessionDep) -> list[dict[str, object]]:
    current_user: User = request.state.current_user
    if not (current_user.role == "manager"):
        raise ForbiddenError("Forbidden: view GatedOrders")
    repo = OrderRepository(session, NoopDomainEventDispatcher())
    return [repo.to_wire(r) for r in await repo.gated_orders()]
```
::: end

The 403 gate emits on all five backends, and the `requires`-is-`currentUser`-only and default-deny rules are platform-neutral (they run for every backend).

### Default-deny

Under `auth { enforcement: denyByDefault }`, every view reachable on an `auth: required` deployable **must** declare a `requires` gate; an ungated view is a compile error (`loom.default-deny-ungated`). `requires true` is the explicit "intentionally public" escape — it documents an anonymous-readable view and satisfies default-deny. Under the default `enforcement: opt`, the gate stays opt-in. See [Authorization](17-auth.md) for the enforcement modes.

## Name uniqueness

A view's name must be unique within its context against aggregates, events, value objects, enums, repositories, and workflows, plus per-platform reserved names (`loom.duplicate-view` / `loom.view-name-collision`).

## What's not yet supported

- **Per-view parameters** — a parameterised repository `find` covers this until views earn parameters for joins.
- **Pagination / sorting / limit** clauses on a view.
- **Aggregations** (`count` / `sum` / `avg` over groups) as the view result.

Reach for a view when you want a named, always-current typed query that a coherent "kind of thing" (active orders, shipped today) is asked for repeatedly; stay with a repository `find` when the query needs caller-supplied parameters or wants to live next to the aggregate. See [`../views.md`](../views.md) for joined-view internals and the slice roadmap.
