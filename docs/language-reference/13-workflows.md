# 13. Workflows

Context-level orchestration: a `workflow` loads or creates several aggregates, calls their operations, raises orchestration-level events, and (optionally) wraps the lot in one DB transaction. The aggregate stays the single mutation + invariant gate — a workflow only wires those gates together. The body is **members-only**: state fields (`Property`), `create` starters, `handle` continuation commands, `on(e: Event)` event reactors, `function` pure helpers, and (for `eventSourced` workflows) `apply` folds. A `timerSource` fires an event on a wall-clock cadence into that same `on` / `create … by` surface. Reach for it when a use-case touches more than one aggregate, when you want a saga driven by inbound events, or when ACID across a few aggregates is genuinely the right semantic.

> **Grammar:** `Workflow`, `WorkflowCreateDecl`, `HandleDecl`, `OnDecl`, `Apply`, `FunctionDecl`, `IsolationLevel`, `TimerSource` · **Validators:** `loom.workflow-*`, `loom.transactional-no-effect`, `loom.isolation-requires-transactional`, `loom.resource-op-in-transaction`, `loom.resource-op-outside-workflow`, `loom.workflow-correlation-required`, `loom.correlation-*`, `loom.workflow-gate-not-current-user`, `loom.timer-*` (`src/ir/validate/checks/workflow-checks.ts` + `timer-checks.ts`, `src/language/validators/timer.ts`) · **Docs:** [`../workflow.md`](../workflow.md), [`../resources.md`](../resources.md)

A workflow shares its context's namespace (a workflow named like an aggregate / event / repository is a `loom.workflow-name-collision`). Bodies reuse the operation [statement vocabulary](06-behavior-and-statements.md) but the validator narrows it to the orchestration subset: factory-`let`, repo-`let`, op-call, `precondition` / `requires`, `emit`, plus the workflow-only `for` / `if let`. Mutation forms (`:=` / `+=` / `-=`) are rejected in a workflow body (they belong in an aggregate op) — except inside an `eventSourced` workflow's `apply` fold.

> **Output sourcing.** Every tab below is excerpted from one generated tree: `generate system` over a `Sales` context with one deployable per backend (`node` / `dotnet` / `python` / `java` / `elixir`). Tabs are elided, never invented — where a block shows fewer than five backends the others emit the same shape and are left out for length, and a genuine gap is called out in prose.

## `workflow` & state

`workflow Name [eventSourced] [transactional[(level)]] { members }`. State fields are plain `Property` members — they carry the workflow instance's own data. A single id-shaped state field is the **correlation field**: it keys saga instances and routes inbound events (see [`on`](#on-e-event-the-event-reactor)).

```ddd
workflow fulfillment {
  orderId: Order id              // correlation field — keys the saga instance

  create(placed: OrderPlaced) by placed.order { … }
  on(paid: PaymentReceived) by paid.order { … }
}
```

A workflow with event consumers but no id-shaped state field is `loom.workflow-correlation-required`; two id-shaped fields is `loom.correlation-field-ambiguous`. The correlation field surfaces a read model — each backend emits `GET /api/workflows/<wf>/instances` + `/{id}` returning the instance state (`FulfillmentInstanceResponse { orderId, attempts }`), which clients read to inspect in-flight instances.

### `requires` on the header — the instance-read gate

`workflow Name … requires <expr> { … }` guards **those two reads only**, not the commands. It runs before any instance is loaded, so it may reference `currentUser` and constants and nothing else — an instance field or repository call is `loom.workflow-gate-not-current-user`. To gate a *command*, put a `requires` in the `create` / `handle` body (or on the entry header), where the instance is bound.

```ddd
workflow fulfillment requires currentUser.role == "supervisor" {
  orderId: Order id
  attempts: int
  …
}
```

::: tabs backend
== node
```ts
// http/workflows.ts — GET /api/workflows/fulfillment/instances
const currentUser = (httpCtx as unknown as { get(k: "currentUser"): User }).get("currentUser");
if (!(currentUser.role === "supervisor")) throw new ForbiddenError("Forbidden: workflow fulfillment instances");
const rows = await db.select().from(schema.fulfillments);
return httpCtx.json(rows as unknown as z.infer<typeof FulfillmentInstanceListResponse>, 200);
```
== dotnet
```csharp
// Api/SalesWorkflowInstancesController.cs
[HttpGet("fulfillment/instances")]
public async Task<IActionResult> AllFulfillmentInstances()
{
    var currentUser = _currentUser.User;
    if (!(currentUser.Role == "supervisor")) throw new ForbiddenException("Forbidden: workflow fulfillment instances");
    var rows = await _db.Fulfillments.AsNoTracking().ToListAsync();
    return Ok(rows.Select(x => new FulfillmentInstanceResponse(x.OrderId.Value, x.Attempts)));
}
```
== java
```java
// api/SalesWorkflowInstancesController.java
@GetMapping("/fulfillment/instances")
public List<FulfillmentInstanceResponse> allFulfillmentInstances() {
    var currentUser = currentUserAccessor.user();
    if (!(Objects.equals(currentUser.role(), "supervisor"))) throw new ForbiddenException("Forbidden: workflow fulfillment instances");
    return fulfillmentStateRepository.findAll().stream()
        .map(x -> new FulfillmentInstanceResponse(x.orderId().value(), x.attempts()))
        .toList();
}
```
== elixir
```elixir
# lib/api_elixir_web/controllers/workflow_instances_controller.ex
def fulfillment_instances(conn, _params) do
  current_user = Map.get(conn.assigns, :current_user)
  if not (current_user.role == "supervisor") do
    ProblemDetails.problem_response(conn, 403, "Forbidden", "Forbidden: workflow fulfillment instances")
  else
    data = Enum.map(ApiElixir.Repo.all(ApiElixir.Sales.Workflows.FulfillmentState), fn row -> %{orderId: row.order_id, attempts: row.attempts} end)
    json(conn, data)
  end
end
```
::: end

## `create` / `handle` — starters & continuations

`create [name](params) [by <expr>] { body }` is an entry point; the **parameter shape** discriminates the trigger (resolved at lowering, not parse time):

| Form | Trigger | Route |
|---|---|---|
| `create(p1: T1, p2: T2, …)` | implicit command (positional domain params) | `POST /api/workflows/<snake>` |
| `create(c: SomeCommand)` | explicit command (single payload param) | `POST /api/workflows/<snake>` |
| `create(e: SomeEvent) by e.field` | event-triggered starter (single event param + `by`) | in-process dispatch only |

`handle name(params) { body }` is a continuation command on the same workflow — a second entry that loads/creates aggregates and calls operations; multiple `handle`s make a multi-command saga. A workflow may declare at most one **unnamed** `create` (`loom.canonical-create-duplicate-workflow`); extra entry points must be named, and no two share a name (`loom.create-name-conflict-workflow`). A `handle` name must also not collide with a `commandHandler` / `queryHandler` in the same context (`loom.duplicate-handler`), because an `api` `route` addresses all three through the same `<Context>.<Name>` reference ([APIs](14-apis-storage-resources-channels.md#route--the-explicit-transport-binding)).

> **Honest gap — only the canonical `create` gets an entry point today.** The unnamed `create` becomes the `POST /api/workflows/<snake>` route on every backend. A **named** `create expedite(…)` and a `handle retry(…)` lower to IR (`WorkflowIR.creates` / `.handlers`, `test/ir/workflow-handle.test.ts`) and their repository needs are collected, but no backend emits a route, a command, or any other callable for them — and an `api { route POST "/fulfil/retry" -> C.retry }` naming a handle validates clean while emitting nothing (checked on node, dotnet and python). Until that lands, model a second command as its own `workflow` (or a `commandHandler` bound by an explicit `route`).

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

The handler builds each repository, logs `workflow_started`, runs the body, `save`s in declaration order, drains workflow-level events, and logs `workflow_completed` ([Observability](20-observability-provenance.md)).

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

## `function` — the private pure helper

`function name(params): T = expr` (or a `{ … }` block) is the aggregate-parity helper member: a private, pure calculation over its **parameters**. Reading the workflow's own state from one is `loom.workflow-function-uses-state` — pass the value in as an argument. Each backend emits it as a workflow-scoped helper (not an inlined expression), and a call to it lowers to `callKind: "workflow-fn"`.

```ddd
workflow fulfil {
  function slaDays(priority: int): int = priority > 5 ? 1 : 5
  create(orderId: Order id) {
    let order = Orders.getById(orderId)
    order.scheduleShipment(slaDays(order.priority))
  }
}
```

::: tabs backend
== node
```ts
// http/workflows.ts
function fulfilSlaDays(priority: number): number { return priority > 5 ? 1 : 5; }
// …
order.scheduleShipment(fulfilSlaDays(order.priority));
```
== dotnet
```csharp
// Application/Workflows/FulfilFunctions.cs
public static int SlaDays(int priority) => priority > 5 ? 1 : 5;
// FulfilHandler.cs
order.ScheduleShipment(FulfilFunctions.SlaDays(order.Priority));
```
== python
```python
# app/http/workflows_routes.py
def fulfil_sla_days(priority: int) -> int:
    return (1 if priority > 5 else 5)
# …
order.schedule_shipment(fulfil_sla_days(order.priority))
```
== java
```java
// application/workflows/CWorkflows.java
private int fulfilSlaDays(int priority) { return priority > 5 ? 1 : 5; }
// …
order.scheduleShipment(this.fulfilSlaDays(order.priority()));
```
== elixir
```elixir
# lib/d_elixir/c/workflows/fulfil.ex
defp sla_days(priority) do
  if priority > 5, do: 1, else: 5
end
```
::: end

Both body forms ship: `= expr` and `{ return … }` emit the same helper on all five backends. (The grammar comment and `LoomIR.functions` still mention a `loom.workflow-function-block-body` gate restricting it to the expression form — that code does not exist in `src/diagnostics/messages.ts` and no validator raises it.)

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

## `timerSource` — time as an event source

```
TimerSource: 'timerSource' name=LooseName '{'
    ('for' ':' event=[EventDecl:ID] ','?)
    ('cron' ':' cron=STRING ','?)? ('every' ':' every=DURATION ','?)?
    ('in' ':' timezone=STRING ','?)? ('overlap' ':' overlap?='allow' ','?)?
'}'
```

A `timerSource` is system-scope — the clock twin of `channelSource`: it fires a plain domain `event` on a wall-clock cadence, and workflows react through the **existing** `create(e) by …` / `on(e)` triggers. There is no `schedule` trigger and no new workflow grammar; the cadence lives on the binding, so it is swappable per environment. There is no `docs/scheduling.md` — this section is the reference.

```ddd
context Orders {
  event SweepTick { sweep: Sweep id, at: datetime }   // the tick: a fact carrying the fire time
  channel Ticks { carries: SweepTick }
  workflow sweepRun {
    sweep: Sweep id
    create(t: SweepTick) by t.sweep { … }             // ordinary event-triggered starter
  }
}

timerSource sweep { for: SweepTick, cron: "*/5 * * * *" }
```

Gates (`src/language/validators/timer.ts` for the cadence, `src/ir/validate/checks/timer-checks.ts` for the rest):

| Code | Raised when |
|---|---|
| `loom.timer-cadence` | both `cron:` and `every:`, neither, a malformed cron, an `every:` under the 1000 ms floor, or an `every:` that is cleanly cron-expressible (`every: 5m` → *write `cron: "*/5 * * * *"`*). `every:` is for what cron can't say: sub-minute, or non-dividing (`7m`, `90m`). |
| `loom.timer-event-shape` | the `for:` event is also emitted by domain logic (**error** — a tick must be infrastructure-emitted only), or it has no `at: datetime` field (**warning** — the reactor can't read the fire time). |
| `loom.timer-needs-state` | the owning deployable's platform binds no relational state, or no database-backed deployable owns the event's context. Single-fire across replicas needs a Postgres-backed ledger. |
| `loom.timer-source-unbound` | no workflow reacts to the event (**warning**) — the timer fires into the void. |
| `loom.reserved-not-emitted` | `in: "<tz>"` and `overlap: allow` parse and reach the IR, but **no emitter reads either** — cron is evaluated in the container's clock, and every backend still guards against an overlapping run. |

Each backend hosts the timer on its ecosystem's durable job runner — single-fire across replicas, automatic retry, and missed-boundary catch-up are the runner's, not Loom's:

::: tabs backend
== node
```ts
// scheduler.ts — pg-boss recurring job (+ a loom_timer_runs catch-up ledger)
const queue = "timer_nightly";
await boss.createQueue(queue);
await boss.work(queue, async () => {
  await events.dispatch({ type: "SweepTick", order: Ids.newOrderId(), at: new Date() });
  baseLogger.info({ event: "timer_fired", timer: "nightly" });
});
await boss.schedule(queue, "0 2 * * *", {}, { retryLimit: 3, retryBackoff: true });
```
== dotnet
```csharp
// Infrastructure/Scheduling/TimerScheduler.cs — Hangfire recurring job
public async Task ExecuteAsync()
{
    try {
        await _events.DispatchAsync(new SweepTick(SweepId.New(), DateTime.UtcNow), CancellationToken.None);
        _log.LogInformation("{Event} timer={Timer}", "timer_fired", "sweep");
    } catch (Exception ex) {
        _log.LogError(ex, "{Event} timer={Timer} error={Error}", "timer_emit_failed", "sweep", ex.Message);
        throw; // let Hangfire's automatic retry engage
    }
}
```
== python
```python
# app/scheduling.py — procrastinate periodic task
@timer_app.periodic(cron="*/5 * * * *", periodic_id="sweep")
@timer_app.task(queueing_lock="timer:sweep", retry=RetryStrategy(max_attempts=3, exponential_wait=2))
async def _timer_sweep(timestamp: int) -> None:
    async with session_factory() as session, session.begin():
        await make_dispatcher(session).dispatch(SweepTick(sweep=new_sweep_id(), at=datetime.now(UTC)))
    log("info", "timer_fired", timer="sweep", boundary=timestamp)
```
== java
```java
// SweepTimerJob.java — JobRunr recurring job
public void execute() {
    try {
        events.publishEvent(new SweepTick(SweepId.newId(), Instant.now()));
        CatalogLog.event("timer_fired", "info", "timer", "sweep");
    } catch (RuntimeException err) {
        CatalogLog.event("timer_emit_failed", "error", "timer", "sweep", "error", String.valueOf(err.getMessage()));
        throw err; // let JobRunr's automatic retry engage
    }
}
```
== elixir
```elixir
# lib/d/scheduler/sweep_worker.ex — Oban worker, `unique` on the boundary = the single-fire ledger
use Oban.Worker, queue: :timers, max_attempts: 3,
  unique: [keys: [:boundary], period: :infinity, states: [:scheduled, :available, :executing, :retryable, :completed, :cancelled, :discarded, :suspended]]

@impl Oban.Worker
def perform(%Oban.Job{args: %{"boundary" => _boundary}}) do
  event = %D.Orders.Events.SweepTick{sweep: UUIDv7.generate(), at: DateTime.utc_now()}
  D.Orders.Dispatcher.dispatch(event)
  Logger.info("timer_fired", event: "timer_fired", timer: @timer_name)
  :ok
end
```
::: end

The tick rides the ordinary in-process dispatcher, so a reactor sees no difference between a timer tick and a domain event. A tick dispatched outside a request has no principal — a realtime relay degrades such an event to a refetch ticket ([Channels](14-apis-storage-resources-channels.md#channel--channelsource)).

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
await using var tx = await _uow.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
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

`objectStore` / `queue` / `api` / `mailer` resources are *used*, not persisted to. A workflow calls them through an **ambient handle** (the resource name, in scope like `currentUser`) and a closed per-kind verb vocabulary — `objectStore`: `put` / `get` / `list` / `signedUrl` / `delete`; `queue`: `enqueue` / `publish`; `api`: `get` / `post`; `mailer`: `send(to, subject, body)`. The verbs are legal in a **workflow body and a `commandHandler` / `queryHandler` body, and nowhere else** — an aggregate `operation`, an invariant, a `derived`, a repository filter, and a `domainService` operation are all `loom.resource-op-outside-workflow` (only the two application-layer render sites have the client in scope). They are capability-gated against the bound sourceType (an unknown verb is `loom.resource-verb-invalid`) and **forbidden inside a transactional span** (`loom.resource-op-in-transaction` — an external effect can't roll back with the DB).

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

## Reaching a workflow from elsewhere

- **From a page.** A page drives a workflow through `WorkflowForm` / an `action` body ([UI primitives](16-ui-walker-primitives.md)); a `match await` on an *aggregate instance* operation needs the page's route `:id` to identify the record — a paramless page is `loom.instance-effect-needs-route-id`.
- **From a projection.** A `projection` is the passive read-half — state fields plus pure `on(e: Event)` folds over foreign events, `keyed by` an explicit column, with no command side. It can fold the events a workflow emits; see [Repositories, queries & projections](10-repositories-and-queries.md#projection--the-read-model).
- **From another deployable.** Events leave the process over a `channel` (and its `channelSource` binding); a workflow reactor whose event no channel carries never fires (`loom.reactor-event-uncarried`, a warning) — [APIs, storage, resources & channels](14-apis-storage-resources-channels.md#channel--channelsource).
