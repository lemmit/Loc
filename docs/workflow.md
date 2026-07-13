# Workflows

A `workflow` is a context-level orchestration that loads or creates
multiple aggregates, invokes their operations, and (optionally) emits
orchestration-level events.  Aggregate operations remain the
single mutation + invariant gate; workflows wire them together.

```ddd
context Sales {

  enum OrderStatus { Draft, Confirmed, Shipped }

  aggregate Customer {
    name: string display
    creditLimit: decimal
    invariant creditLimit >= 0

    operation deductCredit(amount: decimal) {
      precondition amount > 0
      precondition creditLimit >= amount
      creditLimit := creditLimit - amount
    }
  }

  aggregate Order {
    customerId: Customer id
    status: OrderStatus
    placedAt: datetime
  }

  repository Customers for Customer { }
  repository Orders for Order { }

  event OrderPlaced { order: Order id, at: datetime }

  // Non-transactional: each save commits independently.
  workflow placeOrder(customerId: Customer id, placedAt: datetime) {
    let customer = Customers.getById(customerId)
    let order = Order.create({
      customerId: customerId,
      status: Draft,
      placedAt: placedAt
    })
    emit OrderPlaced { order: order.id, at: placedAt }
  }

  // Transactional: all-or-nothing within one DB transaction.
  workflow transferCredit(from: Customer id, to: Customer id, amount: decimal) transactional {
    precondition amount > 0
    let src = Customers.getById(from)
    let dst = Customers.getById(to)
    src.deductCredit(amount)
    dst.addCredit(amount)
  }
}
```

## Body vocabulary

| Form | Meaning |
| --- | --- |
| `precondition Expr` | Workflow-level guard.  Failure → 400 (`DomainException` / `DomainError`). |
| `requires Expr` | Authorization guard.  Same syntactic shape as `precondition`, but failure → 403 (`ForbiddenException` / `ForbiddenError`).  Use this for `currentUser`-based permission checks; use `precondition` for business-rule checks. |
| `let x = Agg.create({ field: expr, ... })` | Factory call.  Saved at workflow exit. |
| `let x = Repo.getById(idExpr)` | Load by id; throws `AggregateNotFound` (→ 404) if missing.  Result is non-nullable. |
| `let x = Repo.<find>(args)` | Call any repo-declared find whose return is a single non-nullable aggregate.  A plain `let` can't bind an array or nullable result. |
| `let xs = Repo.run(<Retrieval>(args), page?)` / `let xs = Repo.findAll(<Criterion>, page?)` | Bind an aggregate **array**; consumable only by a `for` loop. |
| `for x in xs { ... }` | Iterate an aggregate array, binding each element to `x`; per-iteration mutations save inside the loop. |
| `if let x = Repo.find(<Criterion>) { ... } else { ... }` | Look up a **single** aggregate by criterion (the shared `findAllBy<Criterion>` retrieval, capped at one row).  `x` is bound (non-null) only in the then-branch; `else` runs on no match.  The body's only option/null-handling construct.  `else` is optional. |
| `name.opName(args)` | Invoke a public operation on a let-bound aggregate.  The op's own preconditions / invariants run inside that call. |
| `let x = expr` | Plain expression binding. |
| `emit EventName { field: expr, ... }` | Workflow-level event.  Event must be declared in the same context.  Drains through `IDomainEventDispatcher` after all saves (after commit when `transactional`). |

### `if let` — single-result criterion lookup

`Repo.find(<Criterion>)` is the single-result sibling of `Repo.findAll`: it
returns an optional aggregate.  A workflow body has no standalone way to bind
or branch on a nullable, so the lookup and the branch are one construct —
`if let`:

```ddd
workflow ReserveSeat {
  create(c: ReserveSeat) {
    if let seat = Seats.find(AvailableSeat) {
      seat.reserve(c.holder)          // `seat` is non-null here; saved on exit of the branch
    } else {
      emit NoSeatAvailable { event: c.event }
    }
  }
}
```

Both `find` and `findAll` over one criterion share a single internal
`findAllBy<Criterion>` retrieval (no public endpoint is exposed — unlike a
declared `find`).  The else-branch may create a fallback aggregate
(`let s = Seat.create({...})`); branch-local creations / mutations save at the
end of their branch.  `if let`'s source is a criterion `find` in this release.

Own-state assignment (`field := value`) — writing one of the workflow's own
declared state fields — is allowed inside a `create` / `handle` / `on` body; it
mutates the persisted saga-instance row (`attempts := 1`).  The compound mutation
forms (`+=`, `-=`) and any cross-aggregate write (`order.status := …`) belong to
aggregate operation bodies and stay rejected inside a workflow.  An *event-sourced*
workflow can't use `:=` at all — its state is derived only by folding emitted
events through `apply` clauses (`loom.workflow-eventsourced-assign`).  Workflows
can't call private
operations, can call `extern` operations (parameterless or
parameterized — see docs/extern.md; the workflow handler
injects the user's `IXAggHandler` and runs the same dispatch
dance the auto HTTP route does), and can't `findById` (use
`getById` for must-exist loads).

## `function` — private pure helper

A workflow is a state-bearing entity like an aggregate, so it carries the same
private-helper member: a `function`.  It factors a shared, side-effect-free
expression out of the `create` / `handle` / `on` bodies that use it:

```ddd
workflow FulfillOrder {
  orderId: Order id

  // Private pure helper — never a route, callable from any body below.
  function slaDays(priority: int): int = priority > 5 ? 1 : 5

  create(orderId: Order id, priority: int) {
    let order = Orders.getById(orderId)
    order.scheduleShipment(slaDays(priority))   // ← call
  }
}
```

A workflow body is not a class, so — unlike an aggregate `function` (a `private`
method on the entity class) — each backend emits a workflow function as a
**module/file-scoped helper, namespaced by its workflow** (all of a context's
workflows share one generated file), and a call to it renders as that scoped,
per-backend-cased name.  The Hono/TS backend:

```ts
// generated api/http/workflows.ts
function fulfillOrderSlaDays(priority: number): number { return priority > 5 ? 1 : 5; }
// … inside the create handler:
order.scheduleShipment(fulfillOrderSlaDays(priority));
```

and the Python/FastAPI backend:

```py
# generated api/app/http/workflows_routes.py
def fulfill_order_sla_days(priority: int) -> int:
    return 1 if priority > 5 else 5
# … inside the create handler:
order.schedule_shipment(fulfill_order_sla_days(priority))
```

Both body forms an aggregate `function` supports are allowed, identically — the
expression form (`= <expr>`) and the **pure block form** (`{ let … precondition …
return … }`, domain-services.md rev. 4):

```ddd
function slaDays(priority: int): int {
  let expedited = priority > 5
  precondition priority >= 0
  return expedited ? 1 : 5
}
```

Two constraints keep the helper a well-formed module/static function:

- **Pure** — like any `function`, a workflow function may not mutate, `emit`, or
  call an operation / repository / domain service / extern (a block body is
  gated by `loom.function-block-impure`).  It may call a sibling workflow
  `function`.
- **Pure over its parameters** — it may not read the workflow's own state
  (`this` / a state field): the helper is emitted at module/static scope, where
  there is no `this`.  A body that does is rejected —
  `loom.workflow-function-uses-state`.  Pass the value in as a parameter.

## Save + event drain semantics

- **Fresh aggregates** (`Agg.create`) are always saved at workflow
  exit, in declaration order.
- **Loaded aggregates** (`Repo.getById` etc.) are saved only if at
  least one operation was invoked on them inside the workflow body.
- **Aggregate-level events** (raised inside an operation via `emit`)
  drain through the aggregate's repository save — same path as
  before workflows.
- **Workflow-level events** (raised via `emit` directly inside the
  workflow body) accumulate in a local list and dispatch through
  `IDomainEventDispatcher` *after* all saves complete.  When
  `transactional`, the dispatch happens *after* commit; on rollback
  / mid-workflow exception, workflow events are discarded.

## Transactional vs non-transactional

By default, workflows are non-transactional: each aggregate save
commits independently, matching the DDD principle that the aggregate
is the consistency boundary.  Mid-workflow failure leaves earlier
saves committed.

Adding the `transactional` keyword wraps the body, all saves, and
their event drainage in one DB transaction (one EF
`BeginTransactionAsync` / one Drizzle `db.transaction`).  Use it
when the workflow's aggregates share a database AND you want
all-or-nothing semantics — at the cost of locking and the
distribution barrier the keyword represents.

### Isolation levels

`transactional` accepts an optional SQL-92 isolation level:

```ddd
workflow transferCredit(...) transactional(serializable) { ... }
```

| DSL token | Postgres meaning | When to reach for it |
| --- | --- | --- |
| (omitted, bare `transactional`) | connection default (Postgres = `read committed`) | Default; fine for most use cases. |
| `readCommitted` | Same as omitted, but explicit. | Document the choice in source. |
| `repeatableRead` | Snapshot taken at first read; subsequent reads see the same snapshot. | Avoid non-repeatable reads when the workflow loads the same row twice. |
| `serializable` | True serializable; commits may fail with `40001` and need retry. | Multi-aggregate balance / invariant updates where read-write skew would corrupt state. |
| `readUncommitted` | Postgres treats as `read committed` (no dirty reads); SQL Server allows dirty reads. | Rare; usually a foot-gun. |

Generators emit explicit settings only when the keyword is
supplied:

- **.NET**: `await _db.Database.BeginTransactionAsync(System.Data.IsolationLevel.Serializable, ct)` (etc.).
- **Hono**: `await db.transaction(async (tx) => { ... }, { isolationLevel: "serializable" })` (etc.).
- **Python**: `await session.connection(execution_options={"isolation_level": "SERIALIZABLE"})` (etc.).
- **Java**: `@Transactional(isolation = Isolation.SERIALIZABLE)` (etc.).

Bare `transactional` emits the no-arg form on every backend so the
connection-default behaviour is preserved.

## Generated code

### .NET (ASP.NET Core + Mediator)

```
Application/Workflows/
  PlaceOrderRequest.cs        — wire-shape DTO (X id → Guid, datetime → string)
  PlaceOrderCommand.cs        — domain-typed Mediator command
  PlaceOrderHandler.cs        — handler that orchestrates the body
Api/
  SalesWorkflowsController.cs — POST /workflows/place_order
```

The handler injects each `IXRepository` it needs (one per repo
referenced) plus `IDomainEventDispatcher` (when the workflow uses
`emit`) and `AppDbContext` (when `transactional`).  All DI is
handled by the existing `AddScoped` registrations + Mediator's
source generator.

### Hono (TypeScript + Drizzle)

```
http/workflows.ts             — POST /workflows/<snake_workflow> per workflow
http/index.ts                 — mounts the workflows router under /workflows
```

The handler constructs each `XRepository` from the request's `db`
handle (or from `tx` inside `db.transaction(async (tx) => {...})`
when `transactional`), runs the body, awaits each `repo.save(...)`
in declaration order, then dispatches workflow-level events.

### Phoenix LiveView (Elixir / Ecto)

```
lib/<app>/<ctx>/
  workflows/place_order.ex      — context module: run/2 wrapping Repo.transaction
lib/<app>_web/controllers/
  workflows_controller.ex       — POST /api/workflows/place_order per command workflow
```

`run/2` threads `current_user` as its second arg, weaves the body into
a `with`-chain over the context's public functions (`create_<agg>`,
`get_<agg>`, `<op>_<agg>`), wraps it in `Repo.transaction/1` when
`transactional`, and broadcasts workflow-level events via
`Phoenix.PubSub`.  An **event-triggered-only** workflow emits no `run/2`
or controller — see *Status* below.

### Python (FastAPI + SQLAlchemy)

The workflow handler constructs each repository from the request session,
runs the body, saves in declaration order, and drains workflow-level
events.  `transactional` wraps the body in the session transaction, with
the `isolation_level` execution option set when a level is pinned.

### Java (Spring Boot + JPA)

The workflow handler injects each repository / service it needs, runs the
body, saves in declaration order, and drains workflow-level events.  A
`transactional` workflow is annotated `@Transactional` (with
`isolation = Isolation.<Level>` when a level is pinned).

## When to reach for a workflow

Reach for a workflow when:
- a use-case naturally touches more than one aggregate ("place an
  order" reads Customer, creates Order),
- you want HTTP-callable orchestration that's bigger than an
  operation but smaller than a saga,
- ACID across a few aggregates is genuinely the right semantic
  (`transactional`).

Stay with an aggregate `operation` when the work fits inside one
aggregate's invariants — that's simpler, faster, and doesn't need
a workflow file.

## Triggers and command parameters

A workflow's entry points are declared by its members (the workflow body
is members-only — `workflow X { create(...) { ... } }`):

| Member | Trigger |
| --- | --- |
| `create [name](params) [by <expr>] { ... }` | A starter.  The parameter shape discriminates the trigger (resolved at lowering): positional domain params synthesise an implicit command; a single payload param (`create(c: PlaceOrder)`) is an explicit command; a single event param with a `by` clause (`create(e: OrderPlaced) by e.order`) is event-triggered. |
| `handle name(params) { ... }` | A continuation command handler — own-state mutation, may call other aggregates / repos.  Multiple handles make a multi-command saga. |
| `on(e: Event) [by <expr>] { ... }` | An external-event reactor. |

A `create` or `handle` parameter may be typed by an **event** or a
**payload** (`command` / `query` / `response` / `error`) named directly:

```ddd
command SettleOrder { order: Order id, note: string }
event   PaymentReceived { order: Order id, amount: int }

workflow Fulfillment {
  invoiceId: Invoice id                          // correlation field

  create(c: SettleOrder)               { ... }   // explicit command-triggered
  create(paid: PaymentReceived) by paid.order { ... }   // event-triggered
  handle settle(c: SettleOrder)        { ... }   // continuation command
}
```

The bound parameter is a flat transport record: `paid.amount` resolves
to the field's declared type and is type-checked like any other
expression (`paid.amount == "x"` is a type error).  These transport
types are in scope **only** in `create` / `handle` parameter positions —
elsewhere a bare event/payload name stays unresolved.  See the
[language reference](language.md#type-references).

> **Status.** The parameter surface above parses, resolves, and
> type-checks today.  **In-process dispatch ships on the Hono, .NET,
> Phoenix, Python, and Java backends** (channels.md): when a `channel` in the deployable
> `carries:` the event, an emitted event is delivered to every
> `on(e: Event)` reactor and event-triggered `create(e: Event) by` starter
> that subscribes to it, and a handler's own `emit` re-enters the dispatcher
> so choreography chains run.  No `channelSource` ⇒ this in-process
> dispatcher is the default; a channel-less project keeps the no-op
> (byte-identical).
>
> - **Hono** routes each `emit` through the generated
>   `createInProcessDispatcher(db)`.  Correlation is **persisted**: a
>   `create` starter loads-or-allocates its workflow-state row (keyed by
>   the correlation field), and an `on` reactor routes to the existing row
>   or drops + logs `event_unrouted` when none exists.
> - **.NET** publishes each emitted domain event as a Mediator notification
>   (`IDomainEvent : INotification`), so every reactor / starter
>   `INotificationHandler<TEvent>` runs; Program.cs registers the
>   `InProcessDomainEventDispatcher` (Scoped) instead of the no-op.
>   Correlation is **persisted** the same way: each correlation-bearing
>   workflow gets an EF-mapped saga-state row (a `<Workflow>State` POCO +
>   `IEntityTypeConfiguration` keyed by the correlation field, table shared
>   with the canonical migration); a `create` starter loads-or-allocates the
>   row (seeding the key + typed defaults via the injected `AppDbContext`),
>   an `on` reactor routes to the existing row or drops + logs
>   `event_unrouted`, and `this.<stateField>` reads the loaded row.
> - **Phoenix** emits a per-context `<Ctx>.Dispatcher` that pattern-matches
>   each event struct to its handler module(s); each subscription becomes a
>   `<Wf>.Start<Event>` / `<Wf>.On<Event>` module with a `handle(event)`,
>   and a handler's own `emit` re-enters `<Ctx>.Dispatcher.dispatch/1`.
>   Correlation is **persisted** through a saga-state `Ecto.Schema` keyed by
>   the correlation field (over the table the canonical migration derives),
>   read/written through the app `Repo`: a `create` starter loads-or-allocates
>   the row, an `on` reactor routes to it or drops + logs `event_unrouted`.
>   An event-triggered-only workflow emits no `run/2` / HTTP command surface.
> - **Python** emits an in-process dispatcher (`dispatch-builder.ts`) that
>   routes each emitted event to its reactor / starter handlers; a handler's
>   own `emit` re-enters the dispatcher.  Correlation is **persisted** through
>   a saga-state row keyed by the correlation field: a `create` starter
>   loads-or-allocates the row, an `on` reactor routes to it or drops + logs
>   `event_unrouted`.
> - **Java** emits an in-process dispatcher (`dispatch.ts`) that routes each
>   emitted event to its reactor / starter handlers; a handler's own `emit`
>   re-enters the dispatcher.  Correlation is **persisted** through a
>   JPA-mapped saga-state row keyed by the correlation field: a `create`
>   starter loads-or-allocates the row, an `on` reactor routes to it or drops
>   + logs `event_unrouted`.
>
> Still deferred: external brokers (redis / kafka / nats via
> `channelSource`).  See
> [`channels.md`](old/proposals/channels.md) and
> [`workflow-and-applier.md`](old/proposals/workflow-and-applier.md).
