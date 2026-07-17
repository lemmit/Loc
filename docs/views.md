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
    customerId: Customer id
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
    orderId: Order id
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
  (`X id` / primitives / enums / value-objects / arrays / `T?`).
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
- **Result type** is `<View>Row[]` — a fresh record matching
  the declared fields, emitted on all five backends (a Zod schema on
  Hono, a C# record on .NET, a `<View>Row` dataclass on Python, a
  `<View>Row` record on Java, and the Phoenix equivalent).

## Authorization — the `requires` gate

Both forms accept an optional `requires <expr>` clause **before**
`where`:

```ddd
// Shorthand
view OpenTickets = Ticket requires currentUser.role == "agent" where open == true

// Full form
view TicketSummary {
  ticketId: Ticket id
  subject: string

  from Ticket requires currentUser.role == "agent" where open == true
  bind ticketId = id, subject = subject
}
```

`requires` is the read-side analogue of an operation's `requires`
gate: a boolean predicate that must hold or the request is rejected
with **403 Forbidden** before the query runs.

**`requires` is not `where`.**  They sit next to each other but do
different jobs:

| Clause | When | Scope | On failure |
|---|---|---|---|
| `requires` | *before* the query — no row exists yet | **`currentUser` only** (+ constants) | whole request → **403** |
| `where` | *is* the query — pushed to SQL | the **source row's** fields | row is filtered out |

Because the gate runs before any row is fetched, it can only see the
caller, never the data.  A `requires` expression that references the
source row (`requires open == true`) is a **compile error**
(`loom.view-gate-not-current-user`) steering you to use `where` for
row scoping and `requires` for caller authorization.  Use `requires`
to decide *who* may run the view; use `where` to decide *which rows*
they get back.

`requires true` is the explicit "intentionally public" escape — it
documents an anonymous-readable view and satisfies default-deny.

### Default-deny

Under `auth { enforcement: denyByDefault }`, every view reachable on
an `auth: required` deployable **must** declare a `requires` gate;
an ungated view is a compile error (`loom.default-deny-ungated`).
This closes the read-side hole that the command-side default-deny
already covers — under denyByDefault a view is forbidden until you
say otherwise (`requires true` to opt back into public access).
Under the default `enforcement: opt`, the gate stays opt-in.

> **Backend support.**  The 403 gate now emits on all five backends.
> The validation rules (`requires`-is-currentUser-only, default-deny)
> are platform-neutral and run for every backend.

## Joined views (snowflake style)

Slice 3 lets bind expressions **follow** `X id` references into
other aggregates without an explicit join clause.  The type
system already knows that `customerId: Customer id` points at
`Customer`, so `customerId.name` resolves to a typed access on
that aggregate's `name` field.

```ddd
view CustomerOrders {
  orderId: Order id
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
  `member` accesses whose receiver is `X id` typed.  Each unique
  `(sourceField, targetAgg)` pair is collected into the view's
  `auxiliaries`.
- Each aggregate's repository gains a canonical `findManyByIds`
  method (TS) / `FindManyByIdsAsync` (.NET) — with the equivalent
  bulk-load on Python and Phoenix — that bulk-loads roots
  matching a list of ids.  This avoids N+1: the view route fires
  one extra query per auxiliary aggregate, regardless of how many
  rows came back from the source.  **Java** does not yet implement
  cross-aggregate follows: a view whose binds follow an `X id`
  reference into another aggregate is an explicit emit-time error
  on the Java backend ("cross-aggregate follows — not yet
  implemented on the java backend").
- The route / handler runs the source view query, then for each
  auxiliary calls `findManyByIds` with the deduped list of source-
  field values, building a `Map<id, Aggregate>` (TS) /
  `Dictionary<TId, T>` (.NET).
- During projection, each `r.customerId.name` rewrites to
  `customerById.get(r.customerId)!.name` (TS) /
  `customerById[d.CustomerId].Name` (.NET).  The non-null
  assertion is correct because the source's `X id` reference
  is non-nullable — if no Customer exists for that id, the
  request errors loudly (which is the right answer; a
  dangling foreign reference is a data-integrity problem).

### Multi-hop snowflakes

Chains work too: `customerId.regionId.name` follows
`Customer id` then `Region id` to project `Region.name`.  At
emission time:

- Auxiliaries arrive in dependency order (shortest path first).
- Customer is bulk-loaded from `rows.map(r => r.customerId)`.
- Region is then bulk-loaded from
  `[...customerById.values()].map(c => c.regionId)` (Hono) /
  `customerById.Values.Select(c => c.RegionId).ToList()` (.NET).
- Projection chains the lookups:
  `regionByCustomerId.get(customerById.get(r.customerId)!.regionId)!.name`.

Each unique path produces one map; shared prefixes share their
loads (so `customerName = customerId.name` and
`regionName = customerId.regionId.name` in the same view share
the Customer load).

### Remaining limits

- **Non-nullable Id only**.  `X id?` follows aren't supported;
  emit hardcodes a non-null assertion that throws at runtime if a
  reference dangles.
- **No 1:N joins**.  Cardinality stays 1:1 per follow — each
  source row produces exactly one output row.
- **No `join … on …` syntax**.  If you need a join key that
  isn't an `X id`, you're stuck with two views or a
  hand-written endpoint until slice 5.

## What's NOT yet supported

- Per-view parameters — today the repository's parameterised
  `find` already covers this case; views earn parameters when
  they need to join.
- Pagination / sorting / limit clauses.
- Aggregations (`count`, `sum`, `avg` over groups).

For limitations specific to joined views (1:1-only follows, no
optional-Id follows, no explicit join keys), see [Remaining
limits](#remaining-limits) above.

## What it generates

> The Hono and .NET subsections below are illustrative; Python, Java,
> and Phoenix also emit view code (repository query method + a
> `<View>Row` shape + a route/handler) following the same pattern.

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

Full-form views emit a fresh `<View>Row` record (wire-typed: `X id
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

## The query-time `projection` comprehension (in progress)

The read-path rethink ([`read-path-architecture.md`](old/proposals/read-path-architecture.md)
rev.13) **generalises `projection`** so a `view`'s full form becomes a
query-time projection flavor — a LINQ/SQL-shaped comprehension whose
expressions are Loom's one candidate-rooted language (the same `criterion`
dialect):

```ddd
projection OrdersInRegion(region: string) keyed by orderId {
  orderId: Order id;  customerName: string
  from Order as o                               // query source (aliased like `criterion … of T as o`)
  where InRegion(region) && o.status == Confirmed   // criterion position — composes named criteria
  join Customer as c on o.customerId            // by-id follow (boundary-respecting, batched)
  select orderId = o.id, customerName = c.name  // fills the row from source + join alias
}
```

The `from … as` / `where` / `join … as … on` / `select` clauses are optional
and fixed-order; a projection with **no** query clause is today's folded read
model. "Mode" facts are **derived from clause presence** (never stamped): folds
present ⇒ materialised; no `keyed by` ⇒ singleton; a `from` with no folds ⇒
query-time.

> **Status — surface + IR only.** The grammar, lowering (the cross-aggregate
> `join` reuses the same bulk-load `auxiliaries` machinery as the `view`
> follow), and validation ship, but the per-backend query-time **emit** is a
> follow-up. Until a backend ports it, a query-time / `join` projection is
> HONESTLY rejected (`loom.projection-query-time-unsupported`) rather than
> silently mis-emitted — use a `view` or a folded `projection` today. The
> `order by` ordering clause (and its columnar-paging gate) lands with that
> emit.
