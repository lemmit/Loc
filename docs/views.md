# Views

A `view` is a saved, strongly-typed query at the bounded-context
level.  Two forms share the same head:

- **Shorthand** (slice 1) — parameterless, filter-only; result is
  the source aggregate's existing wire shape.
- **Full form** (slice 2) — declared output shape with `bind`
  expressions that project from the hydrated source aggregate.

```ddd
context Sales {
  enum OrderStatus { Draft, Confirmed, Shipped, Cancelled }

  aggregate Order {
    customerId: Id<Customer>
    status: OrderStatus
    placedAt: datetime
    contains lines: OrderLine[]
    entity OrderLine { quantity: int, invariant quantity > 0 }
  }
  repository Orders for Order { }

  // Shorthand: result shape == Order's wire shape.
  view ActiveOrders = Order where status == Confirmed

  // Full form: declared output record, bind-projected per row.
  view OrderSummary {
    orderId: Id<Order>
    status: OrderStatus
    lineCount: int

    from Order where status != Cancelled
    bind orderId = id,
         status = status,
         lineCount = lines.count
  }
}
```

## Type rules

A view is strongly typed end-to-end.  The rules are layered: the
shorthand form is a strict subset of the full form's surface.

### Both forms

- **Source** must be an aggregate declared in the same context.
- **Filter** (when present) is type-checked against the source
  aggregate's schema exactly like a repository `find` filter:
  - bare names resolve to the aggregate's properties / containments /
    derived members
  - the whole expression must type to `bool`
  - it must satisfy the **queryable subset** — no collection lambdas
    (`.where(x => …)`), no chained traversal beyond
    `field` / `field.subfield`, no method calls
  - every column reference must resolve to a real field
  - no comparison may set one column against another (Drizzle's
    `eq()` and friends model column-vs-value)
- **Name** must be unique within the context against aggregates,
  events, value objects, enums, repositories, workflows, and
  per-platform reserved names.

### Shorthand form

- `view <Name> = <Aggregate> where <Filter>` — `where` is required.
- **Result type** is `<Aggregate>[]` — exactly the aggregate's
  enriched wire shape, the same DTO that aggregate find routes
  return.

### Full form

- `view <Name> { <Property>* from <Aggregate> [where <Filter>]
  bind <field>=<expr>, ... }` — `where` is optional.
- **Output shape** is the declared `<Property>*` field set.  Each
  field's type follows the standard Loom type grammar
  (`Id<X>` / primitives / enums / value-objects / arrays / `T?`).
- **Bind exhaustiveness** — every declared field must have exactly
  one matching `bind <name> = <expr>`; stray binds (no matching
  field) are rejected; duplicate binds on the same field are
  rejected.
- **Bind expressions** run on the **hydrated source aggregate**,
  not in SQL.  They can use the full domain expression language —
  property refs, derived members, collection ops (`lines.count`,
  `lines.sum(l => l.subtotal.amount)`), arithmetic, ternaries.
- **Bind type-check** — each bind expression's inferred type must
  be assignable to its declared field type.  (Slice 2 ships the
  shape-checking; tighter assignability arrives with slice 3.)
- **Result type** is `<View>Row[]` — a fresh record record matching
  the declared fields, exposed as a Zod schema on Hono and a C#
  record on .NET.

## Joined views (snowflake style)

Slice 3 lets bind expressions **follow** `Id<X>` references into
other aggregates without an explicit join clause.  The type
system already knows that `customerId: Id<Customer>` points at
`Customer`, so `customerId.name` resolves to a typed access on
that aggregate's `name` field.

```ddd
view CustomerOrders {
  orderId: Id<Order>
  customerName: string
  customerEmail: string
  status: OrderStatus

  from Order where status == Confirmed
  bind orderId = id,
       customerName = customerId.name,
       customerEmail = customerId.email,
       status = status
}
```

How it lowers:

- The validator + lowering walk every bind expression for
  `member` accesses whose receiver is `Id<X>` typed.  Each unique
  `(sourceField, targetAgg)` pair is collected into the view's
  `auxiliaries`.
- Each aggregate's repository gains a canonical `findManyByIds`
  method (TS) / `FindManyByIdsAsync` (.NET) that bulk-loads roots
  matching a list of ids.  This avoids N+1: the view route fires
  one extra query per auxiliary aggregate, regardless of how many
  rows came back from the source.
- The route / handler runs the source view query, then for each
  auxiliary calls `findManyByIds` with the deduped list of source-
  field values, building a `Map<id, Aggregate>` (TS) /
  `Dictionary<TId, T>` (.NET).
- During projection, each `r.customerId.name` rewrites to
  `customerById.get(r.customerId)!.name` (TS) /
  `customerById[d.CustomerId].Name` (.NET).  The non-null
  assertion is correct because the source's `Id<X>` reference
  is non-nullable — if no Customer exists for that id, the
  request errors loudly (which is the right answer; a
  dangling foreign reference is a data-integrity problem).

### Limits in v1

- **Single-hop only**.  `customerId.name` works; chained follows
  like `customerId.regionId.name` are not yet rewritten — they
  parse and type-check, but emit naively (fail at runtime).
  Multi-hop snowflakes can be expressed today by chaining views
  (one per hop).
- **Non-nullable Id only**.  `Id<X>?` follows aren't supported;
  emit hardcodes a non-null assertion.
- **No 1:N joins**.  Cardinality stays 1:1 per follow — each
  source row produces exactly one output row.
- **No `join … on …` syntax**.  If you need a join key that
  isn't an `Id<X>`, you're stuck with two views or a
  hand-written endpoint until slice 4.

## What's NOT yet supported

- Per-view parameters — today the repository's parameterised
  `find` already covers this case; views earn parameters when
  they need to join.
- Pagination / sorting / limit clauses.
- Multi-hop snowflakes (chain `Id<X>.<Id<Y>>.field`).
- Aggregations (`count`, `sum`, `avg` over groups).

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

- **Shorthand**: response schema is the aggregate's
  `<Agg>ListResponse` (imported from `<agg>.routes.ts` — exported
  for this purpose so the OpenAPI specs are bit-identical).
- **Full form**: a `<View>Row` Zod object + `<View>Response`
  array alias are emitted at the top of the file.  The route
  handler projects each hydrated row through the bind expressions:

  ```ts
  async (httpCtx) => {
    const repo = new OrderRepository(db, events);
    const rows = await repo.orderSummary();
    const projected = rows.map((r) => ({
      orderId: r.id,
      status: r.status,
      lineCount: r.lines.length,
    }));
    return httpCtx.json(
      projected as z.infer<typeof OrderSummaryResponse>,
      200,
    );
  }
  ```

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

A Mediator query + handler pair is emitted under
`Application/Views/`.  Shorthand views project to the aggregate's
canonical `<Agg>Response`:

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

Full-form views emit a fresh `<View>Row` record (wire-typed: `Id<X>
→ Guid`, `enum → string`, `datetime → string`) and project per
row using the C# expression renderer with `thisName: "d"`, then
the canonical `projectToResponse` wire helper:

```csharp
public sealed record OrderSummaryRow(Guid OrderId, string Status, int LineCount);

public sealed class OrderSummaryHandler : IQueryHandler<OrderSummaryQuery, IReadOnlyList<OrderSummaryRow>>
{
    private readonly IOrderRepository _repo;
    public OrderSummaryHandler(IOrderRepository repo) => _repo = repo;

    public async ValueTask<IReadOnlyList<OrderSummaryRow>> Handle(OrderSummaryQuery q, CancellationToken ct)
    {
        var domain = await _repo.OrderSummary(ct);
        return domain
            .Select(d => new OrderSummaryRow(d.Id.Value, d.Status.ToString(), d.Lines.Count))
            .ToList();
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
