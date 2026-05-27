# Workflow-centric DDD — appliers, workflows, and the workflow-as-aggregate model

> Status: design agreed in conversation, not yet implemented. Reframes today's `workflow Name(params) [transactional]` (see [`docs/workflow.md`](../workflow.md)) and introduces appliers (`apply(...)`) for event-sourced aggregates and workflows. Companion to the events surface declared today (`event Name { ... }`) and complementary to the schemas-as-boundary commitment that the wire-spec artifact already approximates but currently sources from the wrong layer.

## Problem statement

Today's `workflow` declaration in Loom is a context-level orchestrator with a flat body of statements (`precondition` / `let` / `emit` / `op.call`), optional `transactional` modifier, and an optional SQL isolation level. It is, in the paper's vocabulary, **the conflation of three different things** under one name:

1. A **single-transaction command handler** — when written with `transactional`, the workflow is a classical one-shot handler that fits in one DB transaction. This is structurally the "lucky case" the paper identifies.
2. A **multi-transaction command-triggered process** — without `transactional`, today's workflow saves multiple aggregates in declaration order, each commit independent. The doc admits: *"Mid-workflow failure leaves earlier saves committed."* There is no state aggregate to remember position, no compensation contract, no replay. This is the paper's *unnamed-position-blob* antipattern, encoded into the language.
3. A **placeholder for event-triggered processes** — `docs/workflow.md:178` explicitly defers: *"For event-driven choreography wait for the event-triggered workflow slice — it'll add `starts on event ...` plus the typed event-handler registry."*

Beyond the workflow conflation, there is a second gap: **event-sourced aggregates** have no surface in the language at all. The current model is *operations mutate then emit*; there is no `(state, event) → state` applier form, no replay, no event log. The paper makes this category explicit; Loom should follow.

A third gap, smaller but consequential: **commands are not first-class.** A workflow's `(params)` list synthesises the command's payload implicitly; there is no `command` declaration, no published command schema, no symbol the validator can route external callers through. Loom already publishes `wire-spec.json` from aggregate `wireShape` — the wrong layer for a bounded-context boundary (couples external consumers to internal aggregate shape; see the paper's §"Schemas as the Boundary").

This proposal addresses all three gaps in one coordinated revision.

## What the source argument says

The proposal follows the workflow-centric DDD framework (in-tree at `2948ae13-workflowcentricddd.md` for the originating argument; reproduced in this proposal's appendix). The load-bearing claims:

1. **The aggregate is the transaction boundary.** Anything that coordinates across aggregates is structurally a workflow.
2. **The applier/workflow split runs along the aggregate boundary.** Inside the aggregate, pure `(state, event) → state` *appliers*. Outside the aggregate, *workflows* that may coordinate across aggregates.
3. **Workflow state is an aggregate** — identity, invariants, lifecycle, its own table. Not a "saga store" blob.
4. **Five message-handler forms** cover the space — collapsing the old "command handler / process manager / saga" trichotomy into three orthogonal axes (trigger, transaction scope, failure contract).
5. **Schemas of commands + events are the boundary.** Not aggregate shapes.

This proposal lands all five claims as Loom language features.

## Prior art surveyed

Before settling on the syntax, we surveyed how established workflow systems handle the two hard problems: correlation (which workflow instance does this message belong to?) and lifecycle (which messages can create vs. continue an instance?).

| System | Correlation | Lifecycle | What Loom takes |
|---|---|---|---|
| **NServiceBus** sagas | Per-message `ConfigureHowToFindSaga` mapping from message property → saga data property | Implicit "first message creates" with `IAmStartedByMessages<T>` marker interface | Explicit per-event correlation expression |
| **MassTransit** sagas | Per-event `CorrelateById(x => x.Message.OrderId)` lambdas inside state machine | `Initially.When(...).Then(...).TransitionTo(...)` distinguishes initial from in-state events | Per-handler correlation expression + starter-as-header |
| **Axon** sagas | `@SagaEventHandler(associationProperty = "orderId")` (name-match by default; explicit attribute) | `@StartSaga` annotation marks creating handlers | Name-match by default; explicit alias when names diverge |
| **Camunda BPMN** | "Business key" — one identifier per process instance; receive tasks correlate by it | Engine instantiates process from message-start event | Single correlation key per workflow (Loom: the workflow's id field) |
| **Temporal** | Caller resolves workflow ID and targets it directly (no content-based correlation) | Workflow function is the lifecycle; `signal` continues it | Not applicable — Temporal is execution infrastructure, not authoring |
| **Akka Cluster Sharding** | `extractEntityId(message)` function at routing layer | Lazy: first message to an id creates the entity | Routing-by-id model (matches "the workflow is an aggregate") |
| **EventFlow** | Per-event `ISubscribeAsynchronousTo<...>` with saga locator | Configurable starter event | Per-event subscription declaration |
| **Ash Framework (Elixir)** | Resource changesets bound to id | Action types: `:create` / `:update` / `:destroy` distinguish lifecycle phase | The kind-tag approach for distinguishing lifecycle phases (already adopted in [`lifecycle-operations.md`](./lifecycle-operations.md)) |

Three patterns emerge across all of them:

1. **Per-message correlation expression** (NServiceBus, MassTransit, Axon, EventFlow) is the dominant pattern. It scales from "all events share the same id field" (Camunda's business key) to "every event has its own mapping" (NServiceBus's `ConfigureHowToFindSaga`).
2. **Starter-vs-continuation distinction is structural** in every framework. Whether marked by interface (`IAmStartedByMessages`), annotation (`@StartSaga`), state-machine position (MassTransit's `Initially`), or DSL keyword — the lifecycle phase is always made explicit.
3. **State is the aggregate** is the common shape — even when called "saga data" or "process variables" or "actor state", every framework's persistence model is "one row per running instance, keyed by correlation."

**What Loom takes:**
- Per-handler correlation expression (`by <expr>`) with implicit name-match (Axon's defaulting).
- Starter-in-header (the starter is the workflow's *signature*, not a handler annotation — sharpened from MassTransit's state-machine `Initially`).
- State-as-aggregate (already Loom-native — workflows just become aggregates).

**What Loom rejects:**
- Marker interfaces / annotations (the language declares; the runtime follows).
- Generic "saga store" persistence (each workflow gets its own table, like any aggregate).
- Caller-supplied IDs (Temporal-style) — publishers can't know which workflows subscribe.

## Design — the workflow is an aggregate

The unifying insight: **a workflow is an aggregate whose declared scope of authority includes operations on other aggregates, subscriptions to external events, and (optionally) a compensation contract. Its lifecycle is anchored by a triggering message named in the declaration's header.**

This is the load-bearing claim of the proposal. Every other rule follows from it.

The three concrete differences between an `aggregate` and a `workflow` in the language:

| Difference | Why |
|---|---|
| Operations may call other aggregates/repositories | The whole point of coordination |
| `on(e: E)` event subscription is allowed | Reacting to facts from outside your own scope |
| `compensated` modifier is available | Cross-aggregate work can't be atomic; the failure contract has to be explicit |

Plus one syntactic difference:

| Header-declared starter trigger | Aggregates are *invoked into existence* (`Agg.create({...})`); workflows are *triggered into existence* (the header's command or event arriving) |

Everything else is shared: fields, invariants, operations, `apply(...)` blocks when `eventSourced`, ids, repositories, migrations, tables. **The IR treats them as variants of one kind**; the surface grammar uses two keywords for modeller-facing clarity.

### Modifiers

Three modifiers, each asserting a contract the compiler enforces. Orthogonal — any combination is legal.

| Modifier | Applies to | Contract |
|---|---|---|
| `eventSourced` | `aggregate`, `workflow` | Operations may only `emit`; `on(...)` handlers may only `emit`; all mutation lives in `apply(...)` blocks. State is reconstructed by replay. |
| `compensated` | `workflow` | Every domain-aggregate operation invoked across the workflow's bodies must have a declared `compensatedBy` partner. The saga contract from the paper, made compile-time. |
| `transactional` | workflow header (single-handler workflows only) | The starter handler's body fits in one DB transaction. Maps to existing Loom transactional semantics (`db.transaction` / `BeginTransactionAsync`). |

`transactional` is **per-header**, not per-workflow, because multi-handler workflows (process managers, sagas) are structurally multi-transaction. The compiler rejects `transactional` on workflows whose bodies declare any `on(...)` or any additional `operation` (i.e., anything besides the starter).

### Member forms

Three member forms cover all command/event handling:

| Form | Allowed in | Role | Body restrictions |
|---|---|---|---|
| `operation name(params) { ... }` | any aggregate, any workflow | Command handler — mutates own state; may `emit` | In `eventSourced`: may not contain `:=` (only `emit`). In domain `aggregate`: may not call other aggregates / repos. In `workflow`: may call other aggregates / repos. |
| `apply(e: Event) { ... }` | `eventSourced` aggregate or workflow only | Pure intrinsic state transition from the declaring thing's own emitted event | May contain only `:=` and field-derivation expressions. No `emit`, no calls, no I/O. Replay-safe by construction. |
| `on(e: Event) [by <expr>] { ... }` | workflow only | Extrinsic subscription — react to an event published elsewhere | In non-`eventSourced` workflow: may `:=`, `emit`, call. In `eventSourced` workflow: may only `emit` (the translation rule below). |

The parallel between `operation`, `apply(...)`, and `on(...)` is intentional: all three are typed-parameter-in-parens member declarations, like a function. The keyword carries the contract:

```ddd
operation cancel(reason: string)     // typed params, command-driven
apply(e: ShipmentDispatched)         // typed event binding, own event, replay-safe
on(paid: PaymentReceived)            // typed event binding, external event
```

### Trigger shapes (workflow header)

Three trigger kinds, all using the same paren-shaped signature:

```ddd
workflow Name(p: T, q: U)                       // implicit command sugar — synthesises `command Name { p: T, q: U }`
workflow Name(command: C)                       // explicit command — references a declared `command C`
workflow Name(event: E [by <expr>])             // event-triggered starter
```

The implicit-command sugar lowers to an explicit command declaration so the boundary schema includes it. Authors who want to share commands across workflows or publish them on the API surface use the explicit form.

### Correlation

Every event handler (header starter and `on(...)` continuations alike) declares how to extract the workflow's correlation key from the event payload:

```ddd
workflow OrderFulfillment(event: OrderPlaced by event.order) compensated {
  id: Order id
  status: FulfillmentStatus

  on(paid: PaymentReceived) by paid.orderId { ... }
  on(arr:  ShipmentArrived) by arr.shipRef  { ... }
  on(failed: PaymentFailed) by failed.orderId { ... }
}
```

The `by <expr>` clause yields a value typed to match the workflow's id field. The compiler checks the type statically.

**Implicit name-match.** When the event has a field whose name matches the workflow's id field (e.g., the event has `orderId` and the workflow's id is also `orderId`), the `by` clause may be omitted. The compiler infers `by <event-binding>.<id-field-name>`. This handles the common case (intra-org event naming converges) without forcing boilerplate.

```ddd
on(paid: PaymentReceived) { ... }                  // inferred: by paid.orderId  (event has matching field)
on(arr: ShipmentArrived) by arr.shipRef { ... }    // explicit alias            (names differ)
```

**Single identity field per workflow.** A workflow has exactly one id-bearing field that serves as the correlation key. Composite correlation is expressed by making the id a value object. The paper: *"workflows aren't 'find any matching instance,' they're 'the one instance for this thing.'"*

**Header correlation seeds; continuation correlation looks up.** For the starter, `by event.order` seeds the new workflow row's id (lookup must miss); the row is created with that id. For continuation handlers, `by paid.orderId` looks up the existing row (lookup must hit). The compiler distinguishes these positions; the runtime enforces miss-vs-hit semantics.

## The five forms

The paper's five forms, expressed in this proposal's grammar:

### 1. Applier

```ddd
aggregate Shipment eventSourced {
  status: ShipmentStatus
  dispatchedAt: datetime?

  operation dispatch() {
    precondition status == Pending
    emit ShipmentDispatched { at: now() }
  }

  apply(e: ShipmentDispatched) {
    status := Dispatched
    dispatchedAt := e.at
  }
}
```

Aggregate-level state transition. Pure. Replay-safe.

### 2. Single-transaction command-triggered workflow

```ddd
workflow PlaceOrder(customerId: Customer id, placedAt: datetime) transactional {
  id: PlaceOrderId
  status: PlaceOrderStatus

  let order = Order.create({ customerId: customerId, placedAt: placedAt })
  status := Completed
}
```

The starter body (statements at the top level of the block) runs in one transaction. The workflow's state aggregate is a terminal record of the handling (audit trail + idempotency). One handler, no `on(...)`, no continuations.

### 3. Multi-transaction command-triggered workflow

```ddd
workflow OrderFulfillment(orderId: Order id) compensated {
  id: Order id
  status: FulfillmentStatus

  id := orderId
  status := Pending

  operation markPaid() {
    precondition status == Pending
    status := Paid
  }
  operation ship() {
    precondition status == Paid
    let order = Orders.getById(id)
    order.ship()
    status := Shipped
  }
  operation cancel(reason: string) {
    precondition status != Shipped
    let order = Orders.getById(id)
    order.cancel()
    status := Cancelled
  }
}
```

Starter command, multiple continuation `operation`s. Each invocation is its own transaction; the workflow row spans them.

### 4. Event-triggered process manager

```ddd
workflow OrderFulfillment(event: OrderPlaced by event.order) {
  id: Order id
  status: FulfillmentStatus

  id := event.order
  status := AwaitingPayment

  on(paid: PaymentReceived) by paid.orderId { status := Paid }
  on(arr:  ShipmentArrived) by arr.shipRef  { status := Shipped }
}
```

Starter event, continuation events. State machine encoded in `status` field + `invariant` clauses.

### 5. Saga (process manager + compensation contract)

```ddd
workflow OrderFulfillment(event: OrderPlaced by event.order) compensated {
  id: Order id
  status: FulfillmentStatus

  id := event.order
  status := AwaitingPayment

  on(paid: PaymentReceived) by paid.orderId { status := Paid }
  on(failed: PaymentFailed) by failed.orderId {
    let order = Orders.getById(id)
    order.cancel()                // requires `confirm() compensatedBy cancel()` on Order
    status := Cancelled
  }
}
```

The `compensated` modifier obliges every domain operation invoked (`order.cancel()` here) to have a declared `compensatedBy` partner on its source aggregate. The validator gates this at compile time.

### Combinations

`eventSourced` and `compensated` compose freely:

```ddd
workflow OrderFulfillment eventSourced (event: OrderPlaced by event.order) compensated {
  id: Order id
  status: FulfillmentStatus
  paidAt: datetime?

  emit FulfillmentStarted { id: event.order }
  apply(e: FulfillmentStarted) {
    id := e.id
    status := AwaitingPayment
  }

  on(paid: PaymentReceived) by paid.orderId {
    emit PaymentRegistered { at: paid.at }
  }
  apply(e: PaymentRegistered) {
    status := Paid
    paidAt := e.at
  }

  operation cancel(reason: string) {
    emit FulfillmentCancelled { reason: reason }
  }
  apply(e: FulfillmentCancelled) {
    status := Cancelled
  }
}
```

The workflow's event log contains only its own emitted events. External events (`OrderPlaced`, `PaymentReceived`) are triggers; they cause `on(...)` handlers to fire, which translate them into own-events. Replaying the workflow doesn't depend on external streams being available; the history is self-contained.

## What `compensatedBy` looks like

A property of the source operation, declared once, reusable across any saga that invokes it:

```ddd
aggregate Order {
  status: OrderStatus

  operation confirm() {
    precondition status == Draft
    status := Confirmed
  } compensatedBy cancel()

  operation cancel() {
    precondition status != Shipped
    status := Cancelled
  }
}
```

A `compensated` workflow that invokes `order.confirm()` is now valid (the compensator is declared); one that invokes `order.ship()` without a compensator is rejected. The validator's check is local: walk every operation invocation in the workflow's bodies; for each, verify the target operation has a `compensatedBy` clause.

`compensatedBy` is also useful outside saga contexts as documentation of inverse pairs, but only `compensated` workflows make it load-bearing.

## Schemas as the boundary

Today's `<outdir>/.loom/wire-spec.json` is generated from aggregate `wireShape`. This couples external consumers to internal aggregate structure — the paper's antipattern.

This proposal **moves the boundary** to `commands` and `events`. The published schema becomes a catalog of:

- Every declared `command` (including ones synthesised by the implicit-command-sugar header form).
- Every declared `event` that any workflow `emit`s or any external system subscribes to.

Aggregate wire shapes are still emitted for *intra-context* use (the API client and the React forms still consume them), but the published boundary catalog at `.loom/contracts.json` (or however named) is **commands + events only**.

This is a contract-shape change for any downstream tooling that today consumes `wire-spec.json` to talk to a Loom-generated system. The migration is straightforward — re-point at the new artifact, key by command/event name instead of aggregate name.

(This change has implications for the [`payload-transport-layer.md`](./payload-transport-layer.md) proposal: commands and events both become `payload` declarations under that proposal's model. The boundary artifact should likely be derived from the payload layer's IR rather than a parallel mechanism. Cross-reference detail in §"Coordination" below.)

## Grammar additions

The grammar diff against today's `ddd.langium`:

```langium
// === Commands — first-class declared things, alongside events ===
CommandDecl:
    'command' name=ID '{'
        (fields+=Property (','? fields+=Property)* ','?)?
    '}';

// === Aggregate modifiers — add eventSourced ===
Aggregate:
    'aggregate' name=ID
        eventSourced?='eventSourced'?
        ('ids' idKind=IdKind)?
        withClause=WithClause? '{'
        members+=AggregateMember*
    '}';

AggregateMember:
    Containment | DerivedProp | Invariant | FunctionDecl
    | Operation | EntityPart | TestBlock | Property
    | ApplyDecl;  // NEW

ApplyDecl:
    'apply' '(' binding=ID ':' eventType=[EventDecl:ID] ')' '{'
        body+=Statement*
    '}';

// === Operation modifier — compensatedBy ===
Operation:
    /* existing rule */ ...
    ('compensatedBy' compensatedBy=[Operation:ID])?;

// === Workflow — full reshape ===
Workflow:
    'workflow' name=ID
        eventSourced?='eventSourced'?
        triggerHeader=WorkflowTrigger
        compensated?='compensated'?
    '{'
        members+=WorkflowMember*
    '}';

WorkflowTrigger:
    '(' triggerKind=TriggerKind ')' (transactional?='transactional' ('(' isolation=IsolationLevel ')')?)?;

TriggerKind:
    ImplicitCommandTrigger
  | ExplicitCommandTrigger
  | EventTrigger;

ImplicitCommandTrigger:
    params+=Parameter (',' params+=Parameter)*;

ExplicitCommandTrigger:
    'command' ':' commandRef=[CommandDecl:ID];

EventTrigger:
    'event' ':' eventRef=[EventDecl:ID] ('by' correlationExpr=Expression)?;

WorkflowMember:
    Property               // state field
  | Invariant
  | DerivedProp
  | Operation
  | ApplyDecl              // when eventSourced
  | OnDecl                 // workflow-only event subscription
  | Statement;             // starter body statements (top-level)

OnDecl:
    'on' '(' binding=ID ':' eventType=[EventDecl:ID] ')'
        ('by' correlationExpr=Expression)?
    '{'
        body+=Statement*
    '}';
```

The parser distinguishes starter-body `Statement`s from `WorkflowMember` declarations the same way `Aggregate` already distinguishes `Property`/`Invariant`/`Operation` — by keyword presence. Statements (`let`, `precondition`, bare expressions, `:=`, `emit`) are leaf shapes; declarations start with a kind keyword (`operation`, `apply`, `on`, `invariant`, etc.) or a typed field shape (`name: Type`).

## Validation rules

The validator must enforce, beyond what today's pipeline does:

1. **`eventSourced` operation bodies may not contain `:=`.** Direct mutation in operations is the non-event-sourced model; `eventSourced` requires all state changes go through `apply(...)`. (Error code: `loom.event-sourced-operation-mutates`.)
2. **`eventSourced` `on(...)` bodies may not contain `:=` either.** Translation rule: external events must be mapped to own-events via `emit`, then applied. (Error code: `loom.event-sourced-on-mutates`.)
3. **`apply(...)` bodies may not contain `emit`, `let x = Repo.…`, or operation calls.** Purity gate. (Error code: `loom.apply-impure`.)
4. **`apply(...)` is only legal in `eventSourced` declarations.** A non-event-sourced aggregate or workflow may not declare appliers. (Error code: `loom.apply-without-event-sourced`.)
5. **`on(...)` is only legal in workflows.** Domain aggregates don't subscribe to external events. (Error code: `loom.on-outside-workflow`.)
6. **Domain `aggregate` `operation` bodies may not contain cross-aggregate calls** (`Repo.method(...)`, `OtherAgg.create(...)`, `someRef.someOp(...)` where `someRef` is loaded from elsewhere). The current Loom rule that `Repo.getById` is workflow-only stays; this proposal extends the rule to all cross-aggregate operations. (Error code: `loom.aggregate-operation-crosses-boundary`.)
7. **Every workflow has exactly one id-bearing field.** Either spelled `id: T` or declared via the existing `ids` clause syntax (which this proposal extends to workflows). (Error code: `loom.workflow-id-required`.)
8. **`by <expr>` (header and `on`) must yield a value typed-compatible with the workflow's id field.** (Error code: `loom.correlation-type-mismatch`.)
9. **`compensated` workflows: every domain operation invoked from any body (starter, `on`, `operation`) must have a declared `compensatedBy` on its source aggregate.** Walked at IR validation phase. (Error code: `loom.uncompensated-operation`.)
10. **`transactional` is only legal on single-handler workflows.** A workflow with any `on(...)` declaration or any additional `operation` (beyond the starter) cannot be `transactional`. (Error code: `loom.transactional-multi-handler`.)
11. **`compensated` is only legal on workflows.** Aggregates can't be compensated — there is nothing to compensate inside one aggregate's invariant boundary. (Error code: `loom.compensated-on-aggregate`.)
12. **Starter `by` lookup expects miss; `on` `by` lookup expects hit.** Both produce typed `correlationKind: 'starter' | 'continuation'` in IR; runtime enforcement is per-backend. (No validation error; informational tagging.)
13. **`emit` of an event not declared in the same context** remains an error (today's rule, unchanged).
14. **Multi-starter workflows: header may list multiple triggers** (deferred — see §"Open questions"). v1 admits exactly one starter per workflow.

## IR — one node, two facades

The IR collapses `aggregate` and `workflow` into a single node kind with capability flags. This is the *"don't invent everything twice"* commitment.

```typescript
// Conceptual shape — placement details defer to the IR-architecture PR

export interface ProcessAggregateIR {     // working name
  name: string;
  kind: 'aggregate' | 'workflow';         // surface keyword
  eventSourced: boolean;
  compensated: boolean;                   // only true when kind === 'workflow'
  idField: FieldIR;                        // single id-bearing field
  fields: FieldIR[];
  invariants: InvariantIR[];

  trigger?: TriggerIR;                     // only present when kind === 'workflow'

  operations: OperationIR[];               // command handlers
  applies: ApplyIR[];                      // only when eventSourced
  subscriptions: OnIR[];                   // only when kind === 'workflow'

  starterBodyStatements: StmtIR[];         // top-level statements; only when kind === 'workflow'

  wireShape: WireShapeIR;                  // existing — derived in enrichments
}

export interface TriggerIR {
  kind: 'implicit-command' | 'explicit-command' | 'event';
  commandRef?: CommandIR;                  // for implicit-command, this points to the auto-synthesised command
  eventRef?: EventIR;
  correlation?: ExprIR;                    // typed against idField
  transactional?: boolean;
  isolation?: IsolationLevel;
}

export interface OnIR {
  binding: string;
  eventRef: EventIR;
  correlation: ExprIR;                     // explicit, or inferred via name-match resolution
  body: StmtIR[];
}

export interface ApplyIR {
  binding: string;
  eventRef: EventIR;
  body: StmtIR[];                          // restricted: only mutations + derivations
}

export interface CommandIR {
  name: string;
  fields: FieldIR[];
  synthesised: boolean;                    // true when generated from implicit-command header
  declaringWorkflow?: string;              // back-reference when synthesised
}
```

The `wireShape` enrichment already exists; it now applies uniformly to both kinds. The migrations-builder runs unchanged — workflows get tables because the IR shape doesn't distinguish them from aggregates.

The **only** new IR nodes are `ApplyIR`, `OnIR`, `CommandIR`, and `TriggerIR`. Everything else reuses what's already there.

### Lowering

Three phases get extended; nothing gets duplicated.

- **⑤a `src/ir/lower.ts`** — `lowerAggregate` now handles `apply(...)` members; new `lowerWorkflow` produces a `ProcessAggregateIR` with `kind: 'workflow'`. The two share the same field/operation/invariant lowering helpers.
- **⑤b `src/ir/lower-expr.ts`** — adds expression-level support for `<binding>.field` access where `binding` resolves to an event payload binding (refKind `event-binding`). Otherwise unchanged.
- **⑥ `src/ir/enrichments.ts`** — for workflows whose header uses implicit-command sugar, *synthesise* a `CommandIR` with the header's params, link it back via `declaringWorkflow`. Wire-shape derivation already runs over the unified shape; no change there.
- **⑦ `src/ir/validate.ts`** — new validators implementing rules 1–14 above.
- **⑨ `src/system/wire-spec.ts`** — *replace* the artifact, or add a sibling `contracts.json`, that catalogs all `CommandIR` + all `EventIR`. Aggregate `wireShape` continues to be emitted as today for intra-context consumers.

## Per-backend emit

The backends consume the unified IR. Each backend's existing aggregate-emit machinery handles workflows; the workflow-specific additions are:

| Backend | Aggregate today | Workflow additions in this proposal |
|---|---|---|
| **TS / Hono** | Drizzle table, repository, route handlers per operation | One additional event-subscription router per `on(...)`. `apply(...)` blocks lower to event-applier functions called from `repo.append(event)` (event-sourced) or unused (state-based). Command-synth lowers to wire DTO. |
| **.NET / EF + Mediator** | EF entity, repository, mediator handler per operation | Mediator notification handlers per `on(...)`. `apply(...)` lowers to `Apply(Event e)` methods on the aggregate/process class. |
| **Phoenix / Ash** | Resource with actions | Reactions / lifecycle hooks for `on(...)`; Commanded-style event handlers for `apply(...)` when adopting an event-store. |
| **React** | Forms / pages bound to operations | Continuation-operation forms generated as `OperationForm` (already in [`loom-forms.md`](./loom-forms.md)); starter-command forms generated when the trigger is `command:` or implicit-command. Event-triggered workflows have no user-facing form. |

The per-backend implementation surface is deliberately small because the IR is unified. Each backend's `emitProject(...)` in `PlatformSurface` walks the same node list it does today; the new node types (`ApplyIR`, `OnIR`) are additional emission points, not architectural new layers.

The execution model — how `on(...)` handlers get triggered when an event arrives — is deferred to per-backend implementation. v1 can use simple in-process dispatch (the `IDomainEventDispatcher` already in place); later phases may introduce durable execution (Temporal, durable-functions, in-process saga libraries) without changing the language.

## Backward compatibility

This proposal **breaks the current `workflow Name(params) [transactional]` shape** as it stands. The breakage is intentional — the current form is the antipattern.

The migration path for existing `.ddd` files:

1. **`workflow Name(params) transactional { body }`** (today's "single-tx command handler") becomes:
   ```ddd
   workflow Name(params) transactional {
     id: NameId
     status: NameStatus
     // body
   }
   ```
   The body is unchanged. The author adds the state aggregate's id and status fields. Even single-step workflows get a state aggregate (the audit/idempotency record).

2. **`workflow Name(params) { body }` without `transactional`** (today's silently-multi-transaction form) is REJECTED unless the author either:
   - Adds `transactional` (declares atomicity), or
   - Restructures into a stateful workflow with `id`, state field, and per-step `operation`s.

   There is no `bestEffort` opt-out. The antipattern stops being expressible.

3. **`docs/workflow.md`** is rewritten to reflect the new model, with the breaking changes flagged and the migration recipe spelled out.

The current `examples/acme.ddd` (`placeOrder` workflow) and `examples/sales.ddd` migrate cleanly to form 2 (single-tx) with the addition of a state field. The fixtures need re-baselining.

## Coordination with other proposals

This proposal interacts with several others; placement here is to flag, not resolve, the seams.

- **[`payload-transport-layer.md`](./payload-transport-layer.md)** — proposes a `payload` umbrella with `command` and `event` as sugar keywords over it. **Recommendation:** this proposal's `CommandDecl` becomes a sugar form of `payload Name (command shape)` under that proposal's grammar; events similarly. The IR shape `CommandIR` collapses into `PayloadIR` with a `kind: 'command' | 'event'` tag. Sequencing: this proposal should land *after* the payload transport layer's P1–P4, so the boundary artifact (commands + events) is built on the unified payload IR rather than a parallel mechanism.
- **[`exception-less.md`](./exception-less.md)** — workflow operations return `or`-unions on failure under that model. This proposal's `compensated` rule composes: the validator can verify that a compensator exists, and the workflow's failure-handling propagates through `?` as that proposal specifies. No conflict.
- **[`criterion.md`](./criterion.md)** — introduces `private workflow` modifier and workflow-calls-workflow. This proposal's workflow definition trivially extends to `private workflow Name(...)` and to `operation` bodies invoking other workflows. The `compensated` contract applies transitively.
- **[`lifecycle-operations.md`](./lifecycle-operations.md)** — uses `create`/`operation`/`destroy` kind tags for aggregate lifecycle. **This proposal does not introduce equivalent kinds for workflows.** A workflow's "create" is its starter (in the header); its "destroy" is a terminal state in its state machine (`status := Completed` is the equivalent of `destroy` semantically, but the row stays as an audit record). Hard-deleting a completed workflow row is intentionally not surfaced — the audit value of the row is the whole point. If a need for terminal deletion emerges, it joins this proposal as a v2 amendment.
- **[`storage-and-platform-config.md`](./storage-and-platform-config.md)** — per-aggregate `persistenceStrategy: stateBased | eventSourced` already proposes the strategy split this proposal's `eventSourced` modifier expresses inline. **Reconcile**: this proposal's `eventSourced` modifier on the declaration is equivalent to that proposal's `persistenceStrategy: eventSourced` on the storage binding. Choose one surface (likely this one — declaration-site over binding-site, matching Loom's spirit). The storage proposal's adapter contract is unchanged either way.
- **[`authorization.md`](./authorization.md)** — `policy` gates apply to operations and workflows. Workflow `on(...)` handlers triggered by external events bypass the user-facing authorization model (they react to system facts, not user requests). `operation`s on workflows go through the same policy gates as aggregate operations. Already coherent.

## Open questions

1. **Multi-starter workflows.** Real systems sometimes need a workflow that can be started by either of two messages (`OrderPlaced` *or* `OrderImported`). v1 of this proposal admits exactly one starter per workflow. A v2 amendment may extend the header to a union (`event: OrderPlaced | OrderImported by event.order`), but the type-system support depends on the payload-transport-layer's anonymous-union work landing.

2. **External event subscription registry.** When `on(e: E) by ...` references an event declared in a different context (or a different deployable), the runtime needs cross-context routing. v1 expects all subscribed events to be declared in the same `system` definition; cross-system subscription is a follow-up after the schemas-as-boundary artifact stabilises.

3. **Replay storage for `eventSourced` workflows.** This proposal commits to the language form but does not pin a per-backend event-store choice. Phoenix/Ash has Commanded. TS may use a Postgres event log table or external store. .NET has Marten or similar. The `PersistenceAdapter` contract (already in `storage-and-platform-config.md`) gains a `kind: 'state' | 'event-log'` capability flag.

4. **Compensation ordering and partial compensation.** The `compensated` modifier currently asserts a static contract (every forward op has a compensator). It does not specify *when* during workflow failure the compensators run, or whether all-compensated-so-far is the right protocol vs. only-the-failed-step. v1 commits to "all completed forward steps compensate in reverse order" (the strict Garcia-Molina & Salem 1987 semantics). A finer-grained per-step failure policy may follow.

5. **User-configurable workflows.** Out of scope, as per the paper's §"Scope". If a Camunda-style integration is ever pursued, the published commands+events catalog from this proposal is the integration point.

## Concrete checklist (for the implementation plan)

Once this proposal is accepted, the implementation work breaks into:

| Phase | Scope | Approx. weeks |
|---|---|---|
| **W1** — Grammar additions | `command`, modified `aggregate`/`workflow`, `apply`, `on`, `compensatedBy` | ~1 |
| **W2** — IR unification | Single `ProcessAggregateIR`, new IR nodes, lowering helpers | ~2 |
| **W3** — Validators | Rules 1–14 above, with negative tests | ~1.5 |
| **W4** — Backend emit (TS/Hono) | `apply` lowering, `on` subscription router, command DTO generation | ~2 |
| **W5** — Backend emit (.NET) | Same for EF + Mediator | ~2 |
| **W6** — Backend emit (Phoenix) | Same for Ash/Commanded (event-sourced path) | ~2 |
| **W7** — Backend emit (React) | `OperationForm` for workflow operations; starter forms | ~1 |
| **W8** — Schemas-as-boundary artifact | New `contracts.json` from commands+events; deprecate aggregate-shape in wire-spec | ~1 |
| **W9** — Migration of examples + fixtures + docs | Rewrite `docs/workflow.md`, migrate `examples/*.ddd`, re-baseline fixtures | ~1 |

Total ~13.5 weeks focused work. Phases W4-W7 are parallelisable across implementers; W2 blocks everything downstream.

Sequencing relative to the type-system family: this proposal should land **after** the payload-transport-layer (P1–P4) so commands and events live in one unified IR shape. It may land **before** or **after** criterion + exception-less, with mild integration work either way.

## Appendix — relationship to the source argument

The originating document `2948ae13-workflowcentricddd.md` argues five things; this proposal lands each as follows:

| Source claim | Loom landing |
|---|---|
| The aggregate is the transaction boundary | Validation rule 6 — aggregate operations may not cross boundaries; the cross-aggregate work is the workflow's job |
| Appliers and workflows split along the aggregate boundary | `apply(...)` member (intrinsic, replay-safe) vs. `on(...)` member (extrinsic, workflow-only); enforced by validators 3, 4, 5 |
| Five forms (applier, single-tx workflow, multi-tx command workflow, process manager, saga) | The five examples in §"The five forms" |
| Workflow state is an aggregate | The `workflow IS an aggregate` model — unified IR, single declaration with `id`, state, invariants, table |
| Schemas of commands+events are the boundary | §"Schemas as the boundary" — new `contracts.json` artifact |

Three claims from the source are explicitly out of scope:

- **User-configurable workflows** — open question 5.
- **Temporal/Cadence/Restate as execution platforms** — deferred to per-backend implementation; the language allows them, does not require them.
- **Camunda/Flowable/Zeebe as user-configurable layers** — deferred; the boundary catalog from this proposal is the integration point if pursued.
