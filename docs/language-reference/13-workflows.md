# 13. Workflows

Context-level orchestration: a `workflow` loads or creates several aggregates, calls their operations, raises orchestration-level events, and (optionally) wraps the lot in one DB transaction. The aggregate stays the single mutation + invariant gate — a workflow only wires those gates together. The body is **members-only**: state fields (`Property`), `create` starters, `handle` continuation commands, `on(e: Event)` event reactors, and (for `eventSourced` workflows) `apply` folds. Reach for it when a use-case touches more than one aggregate, when you want a saga driven by inbound events, or when ACID across a few aggregates is genuinely the right semantic.

> **Grammar:** `Workflow`, `WorkflowCreateDecl`, `HandleDecl`, `OnDecl`, `Apply`, `IsolationLevel` · **Validators:** `loom.workflow-*`, `loom.transactional-no-effect`, `loom.resource-op-in-transaction`, `loom.workflow-correlation-required`, `loom.correlation-*` (`src/ir/validate/checks/workflow-checks.ts`) · **Docs:** [`../workflow.md`](../workflow.md), [`../resources.md`](../resources.md)

A workflow shares its context's namespace (a workflow named like an aggregate / event / repository is a `loom.workflow-name-collision`). Bodies reuse the operation [statement vocabulary](06-behavior-and-statements.md) but the validator narrows it to the orchestration subset: factory-`let`, repo-`let`, op-call, `precondition` / `requires`, `emit`, plus the workflow-only `for` / `if let`. Mutation forms (`:=` / `+=` / `-=`) are rejected in a workflow body (they belong in an aggregate op) — except inside an `eventSourced` workflow's `apply` fold.

> **Output sourcing.** Every tab below is excerpted from a single generated tree: `generate system` over a `Sales` context with one deployable per backend (`node` / `dotnet` / `python` / `java`). The handlers are deterministic string output from each backend's workflow builder — no Elixir tab on the per-feature blocks here because the Phoenix LiveView sample wasn't in this generation run (see the honest-gap notes), but its shape is documented in [`../workflow.md`](../workflow.md) §"Phoenix LiveView".

## `workflow` & state

`workflow Name [eventSourced] [transactional[(level)]] { members }`. State fields are plain `Property` members — they carry the workflow instance's own data. A single id-shaped state field is the **correlation field**: it keys saga instances and routes inbound events (see [`on`](#on-e-event-the-event-reactor)).

```ddd
workflow fulfillment {
  orderId: Order id              // correlation field — keys the saga instance

  create(placed: OrderPlaced) by placed.order { … }
  on(paid: PaymentReceived) by paid.order { … }
}
```

A workflow with event consumers but no id-shaped state field is `loom.workflow-correlation-required`; two id-shaped fields is `loom.correlation-field-ambiguous`. The correlation field surfaces a read model — each backend emits a `GET /workflows/<wf>/instances` + `/{id}` route returning the instance state (`FulfillmentInstanceResponse { orderId }`), and the field can back a [view](12-views.md) (`view X = fulfillment where …`).

## `create` / `handle` — starters & continuations

`create [name](params) [by <expr>] { body }` is an entry point; the **parameter shape** discriminates the trigger (resolved at lowering, not parse time):

| Form | Trigger | Route |
|---|---|---|
| `create(p1: T1, p2: T2, …)` | implicit command (positional domain params) | `POST /workflows/<snake>` |
| `create(c: SomeCommand)` | explicit command (single payload param) | `POST /workflows/<snake>` |
| `create(e: SomeEvent) by e.field` | event-triggered starter (single event param + `by`) | in-process dispatch only |

`handle name(params) { body }` is a continuation command on the same workflow — a second HTTP-callable entry that loads/creates aggregates and calls operations; multiple `handle`s make a multi-command saga. A workflow may declare at most one **unnamed** `create` (`loom.canonical-create-duplicate-workflow`); extra entry points must be named, and no two share a name (`loom.create-name-conflict-workflow`).

```ddd
workflow placeOrder {
  create(customerId: Customer id, placedAt: datetime) {
    let customer = Customers.getById(customerId)        // load (must exist → 404)
    let order = Order.create({                          // factory — saved at exit
      customerId: customerId, status: Draft, placedAt: placedAt
    })
    emit OrderPlaced { order: order.id, at: placedAt }  // workflow-level event
  }
}
```

The handler builds each repository, runs the body, `save`s in declaration order, then drains workflow-level events.

::: tabs backend
== node
```ts
// http/workflows.ts — POST /place_order handler
async (httpCtx) => {
  const body = httpCtx.req.valid("json");
  const customerId = Ids.CustomerId(body.customerId);
  const placedAt = body.placedAt;
  const workflowEvents: Events.DomainEvent[] = [];
  const customers = new CustomerRepository(db, events);
  const orders = new OrderRepository(db, events);
  const customer = await customers.getById(customerId);
  const order = Order.create({ customerId: customerId, status: OrderStatus.Draft, placedAt: placedAt });
  workflowEvents.push({ type: "OrderPlaced", order: order.id, at: placedAt });
  await orders.save(order);
  for (const ev of workflowEvents) await events.dispatch(ev);
  return httpCtx.body(null, 204);
}
```
== dotnet
```csharp
// Application/Workflows/PlaceOrderHandler.cs — Mediator command handler
public async ValueTask<Unit> Handle(PlaceOrderCommand command, CancellationToken cancellationToken)
{
    var _workflowEvents = new List<IDomainEvent>();
    var customer = await _customers.GetByIdAsync(command.CustomerId, cancellationToken);
    var order = Order.Create(customerId: command.CustomerId, status: OrderStatus.Draft, placedAt: command.PlacedAt);
    _workflowEvents.Add(new OrderPlaced(Order: order.Id, At: command.PlacedAt));
    await _orders.SaveAsync(order, cancellationToken);
    foreach (var ev in _workflowEvents)
        await _events.DispatchAsync(ev, cancellationToken);
    return Unit.Value;
}
```
== python
```python
# app/http/workflows_routes.py — POST /place_order
async def place_order_workflow(body: PlaceOrderRequest, session: SessionDep) -> Response:
    customer_id = CustomerId(body.customerId)
    placed_at = body.placedAt
    customers = CustomerRepository(session, make_dispatcher(session))
    orders = OrderRepository(session, make_dispatcher(session))
    workflow_events: list[DomainEvent] = []
    customer = await customers.get_by_id(customer_id)
    order = Order.create(customer_id=customer_id, status=OrderStatus.Draft, placed_at=placed_at)
    workflow_events.append(OrderPlaced(order=order.id, at=placed_at))
    await orders.save(order)
    dispatcher = make_dispatcher(session)
    for ev in workflow_events:
        await dispatcher.dispatch(ev)
    return Response(status_code=204)
```
== java
```java
// application/workflows/SalesWorkflows.java
public void placeOrder(PlaceOrderRequest request) {
    var customerId = new CustomerId(request.customerId());
    var placedAt = Instant.parse(request.placedAt());
    var customer = customersRepository.getById(customerId);
    var order = Order.create(customerId, OrderStatus.Draft, placedAt);
    { var __ev = new OrderPlaced(order.id(), placedAt); CatalogLog.event("event_dispatched", "info", "event_type", __ev.getClass().getSimpleName()); }
    ordersRepository.save(order);
}
```
::: end

## Body vocabulary

The workflow body draws from a narrowed statement set — distinct from an aggregate op body. The validator (`validateWorkflowBody`) classifies each statement and rejects anything outside this list (`loom.workflow-unrecognised-statement`).

| Form | Meaning |
|---|---|
| `let x = Agg.create({ field: expr, … })` | Factory call. Always saved at workflow exit, in declaration order. |
| `let x = Repo.getById(idExpr)` | Load by id — throws `AggregateNotFound` → 404 if missing; result is non-nullable. |
| `let x = Repo.<find>(args)` | A declared find returning a single non-nullable aggregate. An array (`loom.workflow-load-array-unsupported`) or nullable (`…-nullable-unsupported`) return is rejected here — bind it via `Repo.run`/`find` below. |
| `let xs = Repo.run(<Retrieval>(args), page?)` / `Repo.findAll(<Criterion>, page?)` | Bind an aggregate **array** — consumable only by a `for` loop. |
| `for x in xs { … }` | Iterate an aggregate array; per-iteration op-calls save inside the loop. |
| `if let x = Repo.find(<Criterion>) { … } else { … }` | Single-result criterion lookup; `x` bound (non-null) only in the then-branch. The body's only option-handling construct. |
| `name.op(args)` | Invoke a public operation on a let-bound aggregate (its own preconditions / invariants run inside the call). `private` ops are rejected (`loom.workflow-private-operation`). |
| `precondition Expr` / `requires Expr` | Guard → 400 (`DomainError`) / 403 (`ForbiddenError`). |
| `emit Event { … }` | Workflow-level event; drains after all saves (after commit when `transactional`). |

A loaded aggregate is saved **only if** an operation was invoked on it inside the body; fresh `Agg.create` results always save. See [`../workflow.md`](../workflow.md) §"Save + event drain semantics".

## `on(e: Event)` — the event reactor

`on(param: Event) [by <expr>] { body }` reacts to a fact dispatched from outside the workflow. Routing keys off the correlation field: the `by` expression must yield the correlation field's id type (`loom.correlation-type-mismatch`), or — if `by` is omitted — the event must carry a field named like the correlation field (`loom.correlation-uninferrable`). In-process delivery is **channel-routed**: a reactor whose event no `channel` carries is `loom.reactor-event-uncarried` (a warning — it never fires).

```ddd
channel sagaBus { carries: OrderPlaced, PaymentReceived, Settled }

workflow fulfillment {
  orderId: Order id
  create(placed: OrderPlaced) by placed.order {
    let order = Orders.getById(placed.order)
  }
  on(paid: PaymentReceived) by paid.order {        // routed by paid.order
    let order = Orders.getById(orderId)            // orderId = the loaded instance's correlation
    order.markSettled()
  }
}
```

The reactor lowers to a handler that **loads or allocates** the persisted saga-instance row by correlation key, then runs the body; a missing instance on an `on` reactor drops + logs `event_unrouted`. The per-context in-process dispatcher fans each emitted event to every matching reactor / starter.

::: tabs backend
== node
```ts
// http/workflows.ts — the on() reactor: load instance by correlation, run, save
export async function fulfillmentOnPaymentReceived(
  db: NodePgDatabase<typeof schema>,
  events: DomainEventDispatcher,
  paid: Events.PaymentReceived,
): Promise<void> {
  const __key = paid.order;
  const state = await loadFulfillment(db, __key);
  if (!state) {
    requestLog().warn({ event: "event_unrouted", workflow: "fulfillment", event_type: "PaymentReceived", key: __key });
    return;
  }
  const orders = new OrderRepository(db, events);
  const order = await orders.getById(state.orderId);
  order.markSettled();
  await orders.save(order);
  await saveFulfillment(db, state);
}

// the per-context dispatcher fans each event to its reactors / starters
export function createInProcessDispatcher(db: NodePgDatabase<typeof schema>): DomainEventDispatcher {
  const dispatcher: DomainEventDispatcher = {
    async dispatch(event: Events.DomainEvent): Promise<void> {
      switch (event.type) {
        case "PaymentReceived": {
          await fulfillmentOnPaymentReceived(db, dispatcher, event);
          await settlementOnPaymentReceived(db, dispatcher, event);
          break;
        }
        case "OrderPlaced": {
          await fulfillmentStartOrderPlaced(db, dispatcher, event);
          await settlementStartOrderPlaced(db, dispatcher, event);
          break;
        }
        default: break;
      }
    },
  };
  return dispatcher;
}
```
::: end

> Honest gap: the `.NET` / `Python` / `Java` reactors emit the equivalent load-or-allocate handler (a Mediator `INotificationHandler<TEvent>` on .NET, a dispatcher-routed coroutine on Python, a dispatch method on Java) over a backend-mapped saga-state row — documented in [`../workflow.md`](../workflow.md) §"Status". They're not re-excerpted here; the Node handler above is the canonical shape and the dispatch wiring is structurally identical per backend.

## `apply` — the `eventSourced` fold

Mark a workflow `eventSourced` and its truth becomes its own event stream (a `<wf>_events` table) instead of a `<Wf>State` row. There, `create` / `on` bodies may only `emit`; each emitted event must be folded by an `apply(param: Event) { body }` block — a pure fold (`:=` assignments only), exactly like an aggregate [applier](06-behavior-and-statements.md#applye-event--the-event-sourcing-fold). An emitted event with no applier is an error (`Event 'X' is emitted … but no applier folds it`).

```ddd
workflow settlement eventSourced {
  orderId: Order id
  paid: int

  create(placed: OrderPlaced) by placed.order {
    emit PaymentReceived { order: placed.order, amount: 0 }
  }
  on(pr: PaymentReceived) by pr.order {
    emit Settled { order: pr.order }
  }
  apply(pr: PaymentReceived) { paid := paid + pr.amount }
  apply(s: Settled)         { paid := paid }
}
```

The fold rehydrates instance state from the stream; the `on` reactor folds the existing stream, runs, and appends the new events (filtered to the folded set) before re-dispatching them.

::: tabs backend
== node
```ts
// http/workflows.ts — fold + the eventSourced on() reactor
type SettlementState = { orderId: Ids.OrderId; paid: number };
function applySettlement(state: SettlementState, ev: Events.DomainEvent): void {
  switch (ev.type) {
    case "PaymentReceived": {
      const pr = ev as Events.PaymentReceived;
      state.paid = state.paid + pr.amount;
      break;
    }
    case "Settled": {
      const s = ev as Events.Settled;
      state.paid = state.paid;
      break;
    }
  }
}
function foldSettlement(key: string, events: Events.DomainEvent[]): SettlementState {
  const state: SettlementState = { orderId: key as Ids.OrderId, paid: 0 };
  for (const ev of events) applySettlement(state, ev);
  return state;
}

export async function settlementOnPaymentReceived(db, events, pr): Promise<void> {
  const workflowEvents: Events.DomainEvent[] = [];
  const __key = pr.order;
  const __stream = await loadSettlementEvents(db, __key as string);
  if (__stream.length === 0) { requestLog().warn({ event: "event_unrouted", workflow: "settlement", … }); return; }
  const state = foldSettlement(__key as string, __stream);
  workflowEvents.push({ type: "Settled", order: pr.order });
  await appendSettlementEvents(db, __key as string, workflowEvents.filter((e) => Settlement_FOLDED_EVENTS.has(e.type)));
  for (const ev of workflowEvents) await events.dispatch(ev);
}
```
::: end

A full multi-backend `eventSourced` workflow lives in [`test/fixtures/corpus/eventsourced-workflow.ddd`](../../test/fixtures/corpus/eventsourced-workflow.ddd); the appliers compile on every backend's build gate. See [`../workflow.md`](../workflow.md) and [`proposals/workflow-and-applier.md`](../old/proposals/workflow-and-applier.md).

## `transactional` & isolation

A bare `transactional` keyword wraps the body, all saves, and the workflow-event drain in one DB transaction (one EF `BeginTransactionAsync` / one Drizzle `db.transaction` / a `@Transactional` method / a session transaction). It accepts an optional SQL-92 isolation level — `readUncommitted` · `readCommitted` · `repeatableRead` · `serializable` — emitted explicitly only when supplied; bare `transactional` keeps the connection default. A `transactional` workflow that mutates nothing is `loom.transactional-no-effect` (warning); an isolation level outside the keyword is `loom.isolation-requires-transactional`.

```ddd
workflow transferCredit transactional(serializable) {
  create(payer: Customer id, payee: Customer id, amount: int) {
    precondition amount > 0
    let srcCust = Customers.getById(payer)
    let dstCust = Customers.getById(payee)
    srcCust.deductCredit(amount)
    dstCust.addCredit(amount)
  }
}
```

The isolation level is threaded into each backend's native transaction API.

::: tabs backend
== node
```ts
// http/workflows.ts — POST /transfer_credit
await db.transaction(async (tx) => {
  const customers = new CustomerRepository(tx, events);
  if (!(amount > 0)) throw new DomainError("Precondition failed: amount > 0");
  const srcCust = await customers.getById(payer);
  const dstCust = await customers.getById(payee);
  srcCust.deductCredit(amount);
  dstCust.addCredit(amount);
  await customers.save(srcCust);
  await customers.save(dstCust);
}, { isolationLevel: "serializable" });
```
== dotnet
```csharp
// Application/Workflows/TransferCreditHandler.cs
await using var tx = await _db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
try
{
    if (!(command.Amount > 0)) throw new DomainException("Precondition failed: amount > 0");
    var srcCust = await _customers.GetByIdAsync(command.Payer, cancellationToken)
        ?? throw new AggregateNotFoundException($"Customer {command.Payer} not found");
    var dstCust = await _customers.GetByIdAsync(command.Payee, cancellationToken)
        ?? throw new AggregateNotFoundException($"Customer {command.Payee} not found");
    srcCust.DeductCredit(command.Amount);
    dstCust.AddCredit(command.Amount);
    await _customers.SaveAsync(srcCust, cancellationToken);
    await _customers.SaveAsync(dstCust, cancellationToken);
    await tx.CommitAsync(cancellationToken);
}
catch { await tx.RollbackAsync(cancellationToken); throw; }
```
== python
```python
# app/http/workflows_routes.py — POST /transfer_credit
async def transfer_credit_workflow(body: TransferCreditRequest, session: SessionDep) -> Response:
    await session.connection(execution_options={"isolation_level": "SERIALIZABLE"})
    payer = CustomerId(body.payer)
    payee = CustomerId(body.payee)
    amount = body.amount
    customers = CustomerRepository(session, make_dispatcher(session))
    if not (amount > 0):
        raise DomainError("Precondition failed: amount > 0")
    src_cust = await customers.get_by_id(payer)
    dst_cust = await customers.get_by_id(payee)
    src_cust.deduct_credit(amount)
    dst_cust.add_credit(amount)
    await customers.save(src_cust)
    await customers.save(dst_cust)
    return Response(status_code=204)
```
== java
```java
// application/workflows/SalesWorkflows.java
@Transactional(isolation = Isolation.SERIALIZABLE)
public void transferCredit(TransferCreditRequest request) {
    var payer = new CustomerId(request.payer());
    var payee = new CustomerId(request.payee());
    var amount = request.amount();
    if (!(amount > 0)) throw new DomainException("Precondition failed: amount > 0");
    var srcCust = customersRepository.getById(payer);
    var dstCust = customersRepository.getById(payee);
    srcCust.deductCredit(amount);
    dstCust.addCredit(amount);
    customersRepository.save(srcCust);
    customersRepository.save(dstCust);
}
```
::: end

## Resource consumption

`objectStore` / `queue` / `api` / `mailer` resources are *used*, not persisted to. A workflow calls them through an **ambient handle** (the resource name, in scope like `currentUser`) and a closed per-kind verb vocabulary — `objectStore`: `put` / `get` / `list` / `signedUrl` / `delete`; `queue`: `enqueue` / `publish`; `api`: `get` / `post`; `mailer`: `send(to, subject, body)`. The verbs are **workflows-only**, capability-gated (an unknown verb is `loom.resource-verb-invalid`), and **forbidden inside a transactional span** (`loom.resource-op-in-transaction` — an external effect can't roll back with the DB).

```ddd
resource files { for: Sales, kind: objectStore, use: bucket }

workflow archiveOrder {
  create(target: Order id) {
    let prev = files.get("orders/x")          // objectStore get → json?
    files.put("orders/x", { id: target })     // objectStore put → blob
  }
}
```

The same vendor-neutral verbs lower to idiomatic native clients per backend (`@aws-sdk/client-s3`, `AWSSDK.S3`, `boto3`, `software.amazon.awssdk:s3`), each emitted as a `files$get` / `files_get` / `filesGet` helper the call site awaits.

::: tabs backend
== node
```ts
// http/workflows.ts — POST /archive_order
import { files$get, files$put } from "../resources/s3";
// …
const target = Ids.OrderId(body.target);
const prev = (await files$get("orders/x"));
(await files$put("orders/x", ({ id: target })));
```
== python
```python
# app/http/workflows_routes.py
from app.resources.s3 import files_get, files_put
# …
target = OrderId(body.target)
await files_get("orders/x")
await files_put("orders/x", {"id": target})
```
== java
```java
// application/workflows/SalesWorkflows.java
public void archiveOrder(ArchiveOrderRequest request) {
    var target = new OrderId(request.target());
    var prev = S3Resources.filesGet("orders/x");
    S3Resources.filesPut("orders/x", Map.of("id", target));
}
```
::: end

The dev `docker-compose` gains a sidecar per object-store / queue / smtp-mailer storage (MinIO for `s3`, `rabbitmq`, **Mailpit** for `smtp`); deployables with no such resource are byte-identical. See [`../resources.md`](../resources.md) for the kind × verb × backend matrix and interface selection.
