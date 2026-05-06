# Views

A `view` is a saved, strongly-typed query at the bounded-context
level.  Slice 1: parameterless, filter-only, single-source; result
shape is the source aggregate's existing wire shape.

```ddd
context Sales {
  enum OrderStatus { Draft, Confirmed, Shipped, Cancelled }

  aggregate Order {
    customerId: Id<Customer>
    status: OrderStatus
    placedAt: datetime
  }
  repository Orders for Order { }

  view ActiveOrders = Order where status == Confirmed
  view PendingShipping = Order where status == Confirmed
}
```

## Type rules

A view declaration `view <Name> = <Aggregate> where <Filter>` is
strongly typed end-to-end:

- **Source** must be an aggregate declared in the same context.
- **Filter** is type-checked against the source aggregate's schema
  exactly like a repository `find` filter:
  - bare names resolve to the aggregate's properties / containments /
    derived members
  - the whole expression must type to `bool`
  - it must satisfy the **queryable subset** — no collection lambdas
    (`.where(x => …)`), no chained traversal beyond
    `field` / `field.subfield`, no method calls
  - every column reference must resolve to a real field
  - no comparison may set one column against another (Drizzle's
    `eq()` and friends model column-vs-value)
- **Result type** is `<Aggregate>[]` — exactly the aggregate's
  enriched wire shape, the same DTO that aggregate find routes
  return.
- **Name** must be unique within the context against aggregates,
  events, value objects, enums, repositories, workflows, and
  per-platform reserved names.

## What's NOT in this slice

- Joined sources (slice 3 — "snowflake" denormalisation across
  aggregates).
- Custom output record shapes (slice 2 — `view X { fields { ... }
  bind ... }`).
- Per-view parameters — today the repository's parameterised `find`
  already covers this case; views earn parameters when they need
  to join.
- Pagination / sorting / limit clauses.

## What it generates

### Hono (TypeScript + Drizzle)

Per view, the source aggregate's repository gains a parameterless
method whose Drizzle query embeds the lowered predicate:

```ts
async activeOrders(): Promise<Order[]> {
  const rootRows = await this.db.select().from(schema.orders)
    .where(eq(schema.orders.status, "Confirmed"));
  // ...full hydration of contained parts (same path as findAll)
}
```

A new `http/views.ts` file is emitted, mounted under `/views` in
`http/index.ts`:

```
GET /views/active_orders → 200 OrderListResponse
```

The response schema is imported verbatim from the aggregate's
existing `<Agg>.routes.ts` file (the `<Agg>Response` /
`<Agg>ListResponse` schemas are exported for this), so the OpenAPI
spec for `/views/<name>` matches the spec for the aggregate's
canonical GET endpoints exactly.

### .NET (ASP.NET Core + Mediator + EF)

Per view, the source aggregate's repository (interface +
implementation) gains a parameterless method:

```csharp
Task<List<Order>> ActiveOrders(CancellationToken ct = default);

public async Task<List<Order>> ActiveOrders(CancellationToken ct = default) {
  return await _db.Orders
    .Where(x => x.Status == OrderStatus.Confirmed)
    .ToListAsync(ct);
}
```

A new Mediator query + handler pair is emitted under
`Application/Views/`:

```csharp
public sealed record ActiveOrdersQuery() : IQuery<IReadOnlyList<OrderResponse>>;

public sealed class ActiveOrdersHandler : IQueryHandler<ActiveOrdersQuery, IReadOnlyList<OrderResponse>>
{
    private readonly IOrderRepository _repo;
    public ActiveOrdersHandler(IOrderRepository repo) => _repo = repo;

    public async ValueTask<IReadOnlyList<OrderResponse>> Handle(ActiveOrdersQuery q, CancellationToken ct)
    {
        var domain = await _repo.ActiveOrders(ct);
        return domain.Select(d => new OrderResponse(...)).ToList();
    }
}
```

A shared `Api/<Context>ViewsController.cs` exposes each view at
`GET /views/<snake_view>`.

## When to reach for a view

Reach for a view when:
- you want a named, typed saved query that doesn't fit naturally
  inside one repository declaration,
- the answer is always-current (no event lag),
- the filter expresses a coherent "kind of thing" (active orders,
  shipped today, customers over a credit limit) that consumers
  will ask for repeatedly.

Stay with a repository `find` when the query needs caller-supplied
parameters or you want it co-located with the aggregate's
repository declaration.

A future slice adds **projections** — materialised denormalised
read models updated by event handlers — for the cases where view
queries become too expensive or need to denormalise across
aggregates.
