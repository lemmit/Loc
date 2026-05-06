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
    customerId: Id<Customer>
    status: OrderStatus
    placedAt: datetime
  }

  repository Customers for Customer { }
  repository Orders for Order { }

  event OrderPlaced { order: Id<Order>, at: datetime }

  // Non-transactional: each save commits independently.
  workflow placeOrder(customerId: Id<Customer>, placedAt: datetime) {
    let customer = Customers.getById(customerId)
    let order = Order.create({
      customerId: customerId,
      status: Draft,
      placedAt: placedAt
    })
    emit OrderPlaced { order: order.id, at: placedAt }
  }

  // Transactional: all-or-nothing within one DB transaction.
  workflow transferCredit(from: Id<Customer>, to: Id<Customer>, amount: decimal) transactional {
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
| `let x = Agg.create({ field: expr, ... })` | Factory call.  Saved at workflow exit. |
| `let x = Repo.getById(idExpr)` | Load by id; throws `AggregateNotFound` (→ 404) if missing.  Result is non-nullable. |
| `let x = Repo.<find>(args)` | Call any repo-declared find whose return is a single non-nullable aggregate.  Arrays / nullables are not yet supported in workflow bodies. |
| `name.opName(args)` | Invoke a public operation on a let-bound aggregate.  The op's own preconditions / invariants run inside that call. |
| `let x = expr` | Plain expression binding. |
| `emit EventName { field: expr, ... }` | Workflow-level event.  Event must be declared in the same context.  Drains through `IDomainEventDispatcher` after all saves (after commit when `transactional`). |

Mutation forms (`:=`, `+=`, `-=`) belong to aggregate operation bodies
and are rejected inside a workflow.  Workflows can't call private
operations, can't call `extern` operations, and can't `findById` (use
`getById` for must-exist loads).

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

Bare `transactional` emits the no-arg form on both backends so the
connection-default behaviour is preserved.

## Generated code

### .NET (ASP.NET Core + Mediator)

```
Application/Workflows/
  PlaceOrderRequest.cs        — wire-shape DTO (Id<X> → Guid, datetime → string)
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

For event-driven choreography ("when an order is placed, decrement
stock in another context") wait for the event-triggered workflow
slice — it'll add `starts on event ...` plus the typed event-handler
registry on both backends.
