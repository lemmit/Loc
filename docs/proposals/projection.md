# Projections — read models folded from events

> Status: **DRAFT / PROPOSED** (2026-07-05). No code yet. This nails down the
> `projection` construct that `channels.md` (§"Surface — consumers", lines
> 274–279) and `bounded-context-model.md` (Pattern B, "Projection design
> deferred to a follow-up proposal") sketch but leave unspecified. It commits to
> a deliberately minimal **v1** and — the load-bearing decision — realises it by
> **reusing the event-sourced-workflow saga machinery that already ships on five
> backends**, not by building a new CQRS subsystem.

> Depends on / reuses: the event-triggered saga-state dispatcher and
> `apply()` fold discipline (`workflow-and-applier.md`); the workflow instance
> read model + endpoints (`workflow-instance-visibility.md`, #1035); `view`
> sources (`workflow-instance-views.md`, #1037); the `channel` publish surface
> and in-process dispatch (`channels.md`, Slice 1). Introduces no new transport.

---

## TL;DR

A **projection** is a **read model folded from an event stream** — the write
side of CQRS. `channels.md` names it as a consumer form and defers the design;
this proposal specifies it.

The key realisation, from reading the IR: **a projection is structurally the
passive, read-only half of an event-sourced workflow.** An `eventSourced`
`WorkflowIR` already carries everything a projection needs — declared state
fields, `on(e: Event)` subscriptions, `apply()` folds, a correlation key, a
persisted per-key state row, an `instanceWireShape` read surface, and it's
already a `view` source. A projection is that machinery **with the command half
amputated**: it never `emit`s, never calls operations, never starts a process,
has no HTTP command entry. It only folds events in and exposes state out.

So v1 is **mostly wiring a passive alias over the event-triggered saga
machinery**, not a new subsystem. That framing is about *machinery reuse*; for
*why projection is its own construct* — it folds **foreign** events (not its own)
and is **derived, not a source of truth** (which is why it has no operations) —
see §"Why its own construct — the source-of-truth axis".

```ddd
context Sales {
  event OrderPlaced  { order: Order id, customer: Customer id }
  event OrderShipped { order: Order id }

  // A read model keyed by `order`, folded from two event types.
  projection OrderBook keyed by order {
    order:    Order id            // ── the read-model schema (state fields)
    customer: Customer id
    status:   OrderStatus

    on(e: OrderPlaced)  { order := e.order; customer := e.customer; status := Placed }
    on(e: OrderShipped) { status := Shipped }   // routed to the row keyed by e.order
  }
}
```

Generated (Hono v1 sketch — mirrors the event-triggered saga path):

```ts
// migrations: a read-model table, keyed by the correlation column
export const orderBook = pgTable("order_book", {
  order:    uuid("order").primaryKey(),
  customer: uuid("customer").notNull(),
  status:   text("status").$type<OrderStatus>().notNull(),
});

// dispatch: the in-process dispatcher already routes carried events here.
// First event for a key allocates the row (load-or-create); later events
// route-or-drop, exactly like `create(e) by` / `on(e) by` saga starters.
async function onOrderPlaced(e: OrderPlaced, db: Db) {
  const row = { order: e.order, customer: e.customer, status: "Placed" };
  await db.insert(orderBook).values(row).onConflictDoUpdate({ target: orderBook.order, set: row });
}
async function onOrderShipped(e: OrderShipped, db: Db) {
  await db.update(orderBook).set({ status: "Shipped" }).where(eq(orderBook.order, e.order));
}

// read surface: GET /projections/orderBook  (mirrors /workflows/<wf>/instances)
```

---

## Problem

The instance surface (#1035) and workflow-sourced views (#1037) answer *"show me
the running sagas, filtered."* They do **not** give the author a first-class way
to maintain a **derived read model** off arbitrary events — the operator
questions *"what's the current order book?"*, *"orders per region this hour"* —
without hand-writing a reactor that writes to a table. `bounded-context-model.md`
explicitly routes cross-BC reads through *"subscribed → local projection"* but
leaves `projection` a placeholder. The `channels.md` sketch invents a bespoke
`upsert {…}` / `set … where …` mini-DSL that exists nowhere else in Loom.

## The alignment — what projection reuses

| Projection needs | Event-sourced `WorkflowIR` already provides | Ships? |
|---|---|---|
| Read-model schema (columns) | `stateFields: FieldIR[]` (lowered by the same `lowerField` as aggregate fields) | ✅ |
| Event subscriptions | `subscriptions: OnIR[]` — `on(e: Event)` | ✅ |
| The fold | `appliers: ApplyIR[]` — `apply(e){…}`, `this`-bound, **pure** | ✅ |
| Key to route to | `correlationField` | ✅ |
| Allocate row on first event | event-triggered `create(e) by` — **load-or-allocate** | ✅ (5 backends) |
| Route/drop later events | `on(e) by` — **route-or-drop+log** | ✅ (5 backends) |
| Read-model **table** | `workflowStateTableShape` → `MigrationsIR` | ✅ |
| Queryable wire + endpoint | `instanceWireShape` → `GET /workflows/<wf>/instances` | ✅ |
| `view` may curate over it | workflow-instance-as-`view`-source (#1037) | ✅ |

The `channels.md` sketch's operations map **exactly** onto shipped machinery, so
the bespoke syntax is rejected in favour of the existing fold vocabulary:

- `upsert { order: e.order, status: Placed }` = event-triggered **`create(e) by e.order`** (load-or-allocate the row for that key)
- `set status = Shipped where order = e.order` = **`on(e) by e.order`** + `apply` (route to the row, fold)

### Why its own construct — the source-of-truth axis

The reuse table shows a projection shares a lot of *shape* with an event-sourced
aggregate (state fields + pure `apply`-style folds + no direct mutation), which
invites the question: is a projection just an event-sourced aggregate that
*lacks operations*? No — "lacks operations" is the **symptom**, and two deeper
differences are the essence, one of which is *why* it has no operations.

**1. It folds foreign events, not its own.** An aggregate's `apply` is a *"pure
intrinsic state transition **from own event**"* (`workflow-and-applier.md`:170);
`AggregateIR` has `appliers` but **no `subscriptions`** — an aggregate can only
fold events it emitted. A projection folds events emitted by *other* aggregates.
The "subscribe to someone else's stream" surface (`on(e: Event)` →
`subscriptions`) exists only on the **workflow** — which is exactly why v1
reuses the workflow saga path, not the aggregate path.

**2. It is derived, not a source of truth — which is why it has no operations.**
An event-sourced aggregate's stream *is* the truth; operations exist to
**originate** new events. A projection originates nothing — it is a derived,
disposable reflection you can delete and rebuild by re-folding. There is nothing
for an operation to *do*: you don't command a read model, you change it only by
changing the upstream events it folds. No source-of-truth ⇒ no `emit` ⇒ no
operations. (This is also *why the fold must be pure* — a disposable reflection
has to be rebuildable — and why it can't read repos.)

| | Folds *whose* events | Source of truth? | Command side (ops/`emit`) | Fold purity |
|---|---|---|---|---|
| **ES aggregate** | its **own** | yes | yes (emit-only) | pure `apply` |
| **ES workflow** | its **own** + reacts to **foreign** | yes (process) | yes (`create`/`handle`) | pure `apply` |
| **Projection** | **foreign** only | **no — derived** | **none** | pure fold |

Projection is the one cell no existing construct occupies: **a reactor's
foreign-event subscription + an applier's pure fold, over derived state.** It
borrows the *subscription* from the reactor and the *purity* from the applier,
and drops the entire command / source-of-truth half. That unique combination —
not the machinery, which is the workflow's — is what earns it a keyword rather
than a flag on `aggregate`.

The `.ddd` contrast that makes the axis concrete:

```ddd
// ES aggregate — folds ITS OWN events; has a command side that emits
aggregate Order persistedAs(eventLog) {
  status: OrderStatus
  create place(customer: Customer id) { emit OrderPlaced { order: id, customer } }  // originates
  operation ship() { emit OrderShipped { order: id } }                              // originates
  apply(e: OrderPlaced)  { status := Placed }    // folds its OWN event
  apply(e: OrderShipped) { status := Shipped }
}

// Projection — folds FOREIGN events; no create, no operation, no emit
projection OrderBook keyed by order {
  order: Order id;  status: OrderStatus
  on(e: OrderPlaced)  { order := e.order; status := Placed }   // folds Order's events
  on(e: OrderShipped) { status := Shipped }                    // reflects; originates nothing
}
```

**Design decision: a sibling `ProjectionIR`, not a `workflow` flavour.** Loom's
direction (`workflow-and-applier.md`) is to *split* the overloaded workflow into
distinct constructs; overloading it back would regress that. Projection is its
own keyword and its own IR node, but its lowering/enrichment/emission **call the
same helpers** the event-triggered saga path already uses — new construct, ~no
new machinery.

## Surface

```ddd
projection <Name> keyed by <field> {
  <field>: <Type>            // state fields — the read-model schema, DECLARED
  ...
  on(e: <Event>) { <pure fold statements> }   // one handler per subscribed event
  ...
}
```

- **Schema is declared, not inferred.** The state fields are the read model's
  columns and its wire shape — explicit, like an aggregate/VO body. (Resolves
  channels.md open question: inference is fragile and has no wire story.)
- **`keyed by <field>` is required — always explicit, no inference.** It names
  the correlation column events route to; it must name one of the declared state
  fields, id-shaped, present as a field (directly or reachable) on **every**
  subscribed event (so every event can be routed. This **deliberately diverges
  from workflows**, which *infer* `correlationField` as the single id-shaped
  state field (`lower-workflow.ts:136`). Inference is safe there because a saga's
  state is one correlation id + non-id fields; a projection's read-model schema
  routinely denormalises **several** foreign ids as columns
  (`OrderBook { order: Order id, customer: Customer id }`), so a single-id rule
  would be ambiguous in the common case and force a disambiguator anyway.
  Explicit keying is clearer and makes the routing column unmissable at the
  declaration site.
- **`on(e: <Event>)`** reuses the *shipped* reactor spelling
  (`ddd.langium:1201`), **not** the sketch's `on OrderPlaced(e)`. First event for
  a key allocates the row; subsequent events for a known key fold into it;
  events for an unknown key on a non-allocating handler are dropped+logged
  (route-or-drop, as sagas do today).

### Fold purity — the projection/workflow/view boundary

Projection `on(...)` bodies are **pure folds**, governed by the **same
`loom.apply-impure` gate** that governs aggregate/workflow `apply()`
(`workflow-and-applier.md` §587): only `:=` assignments and field-derivation
expressions — **no `emit`, no repository/operation calls, no I/O**.

This is not a limitation; it is what makes a projection a projection. A fold gets
**replayed** to rebuild the read model, so it must be a deterministic function of
`(currentState, event)`. A repo read inside a fold is non-deterministic across
replays and breaks rebuildability. The disciplined escape when a fold "needs"
outside data is to **fatten the event** (carry the datum in the event payload at
emit time) or **fold a second event stream** — never to read.

A handler that *must* read another table is, by definition, **not** a projection
— it is a stateful reactor/denormaliser, which Loom already models as a
**workflow reactor** (`on(e: Event)` in a `workflow`, which *may* read repos).
The read-in-a-handler capability is precisely the line between the two
constructs.

The complete three-tier layering this establishes:

| Layer | May read | Purity | Runs |
|---|---|---|---|
| **Projection fold** (`on <Event>`) | the event only | **pure** — rebuildable | write-time (on emit) |
| **Reactor / workflow** | repos + retrievals; writes; emits | impure | on event / command |
| **View** | its one source **+ bind-followed foreign repos** | read-only, no replay | query-time |

Cross-source stitching lives **up in the view at read time** (see v1.1), where
there is no replay and reading a foreign repo *now* is correct-by-definition —
not down in the pure fold.

## Grammar additions

```langium
// ContextMember += Projection
ContextMember:
    ... | Channel | DomainService | Projection ;

Projection:
    'projection' name=ID 'keyed' 'by' key=ID '{'   // keyed by is required
        members+=ProjectionMember*
    '}';

ProjectionMember:
    Property | ProjectionOn ;      // Property = a state field (reused rule)

ProjectionOn:                      // reuse the shipped reactor spelling
    'on' '(' param=LooseName ':' event=[EventDecl:ID] ')'
        '{' body+=Statement* '}';
```

`projection` is a soft keyword outside `ContextMember` position, following the
`channel` / `criterion` precedent.

## IR

```ts
export interface ProjectionIR {
  name: string;
  /** Read-model schema — the fold-target columns and the wire shape.
   *  Lowered with the same lowerField as aggregate/workflow state. */
  stateFields: FieldIR[];
  /** The id-shaped state field inbound events route to. */
  correlationField: string;
  /** One pure fold per subscribed event; body is apply()-discipline. */
  handlers: ProjectionOnIR[];
  /** Canonical wire shape of a projection row — mirrors instanceWireShape.
   *  Populated by enrichment. */
  wireShape?: WireField[];
  origin?: OriginRef;
}
export interface ProjectionOnIR {
  event: string;
  param: string;
  /** Fold statements — validated pure (loom.apply-impure reused). */
  body: StmtIR[];
  /** True for the first-seen-key handler(s) that allocate the row. */
  allocates: boolean;
}
```

`BoundedContextIR` grows `projections: ProjectionIR[]`.

## Lowering / enrichment / migration — all reuse

- **Lower** in a new `src/ir/lower/lower-projection.ts` leaf (sibling of
  `lower-workflow.ts`), wired into the `lower.ts` orchestrator. State fields via
  `lowerField`; bodies via `lowerStmt` in the projection's `this`-bound env
  (identical to workflow appliers).
- **Enrich**: derive `wireShape` off `stateFields` (reuse the
  `instanceWireShape` derivation); derive the read-model table shape (reuse
  `workflowStateTableShape`). Pick a `migrationsOwner` deployable for the table
  the same way workflow saga state does.
- **Dispatch**: the in-process dispatcher already delivers each carried event to
  its reactors/starters. Projections register as additional consumers — the
  allocate-or-route logic is the saga `create(e) by` / `on(e) by` code path,
  reused.

## Read surface

- v1: auto-expose `GET /projections/<snake>` (list) and
  `GET /projections/<snake>/{key}` (one row), serialised through the projection
  `wireShape` DTO — mirrors `/workflows/<wf>/instances` byte-for-byte in shape.
- The projection is **read-only** over HTTP: no POST/PATCH/DELETE. It changes
  only by folding events.

## Validation (new `loom.projection-*` codes)

| Code | Rule |
|---|---|
| `loom.projection-key-unknown` | `keyed by X` names no declared state field. |
| `loom.projection-key-not-id` | the key field is not id-shaped. |
| `loom.projection-key-required` | `keyed by` omitted (it is mandatory — no inference). |
| `loom.projection-event-unkeyed` | a subscribed event carries no field routable to the key. |
| `loom.projection-fold-impure` | a fold body emits / calls a repo or operation (**reuses `loom.apply-impure`**). |
| `loom.projection-duplicate-on` | two `on(...)` handlers for the same event. |
| `loom.projection-event-uncarried` | the subscribed event is carried by no channel the host deployable binds (reuses `loom.reactor-event-uncarried`). |
| `loom.cross-bc-internal-event` | subscribing to another BC's aggregate-internal event (inherited). |

## Target matrix — v1 scope

Because the dispatcher + saga-state persistence already ship on **node, dotnet,
python, java, elixir-vanilla**, v1 targets those five backends. Frontends touch
projection only through the read endpoint + (v1.1) `view` scaffolding — no new
walker primitive. Phoenix OpenAPI parity follows its existing deferral for the
workflow-instance surface.

## Deferred / open questions

- **v1.1 — projection as a `view` source. ✅ shipped.** `Projection` joined
  `type ViewSource = Aggregate | Workflow | Projection` (the exact slice #1037
  was for workflows). A view now curates + bind-follows off a projection row
  (`view ShippedOrders { from OrderBook where status == Shipped bind customerName = customer.name }`)
  — reading the `<Proj>Row` read-model row + repositories at query time, which is
  legal because a view is a query, not a replayable fold. Both view forms
  (shorthand `= Proj where …` → the projection wire shape; full-form `{ … bind … }`
  → an output record with `X id` follows) emit on all five backends and all four
  frontends. See [`views.md`](../views.md).
- **Replay / rebuild.** v1 folds synchronously in-process at emit time; there is
  no durable log to replay from and no rebuild command. Replay lands with the
  durable-log channel tier (`channels.md` `channelSource` → kafka/redis-streams)
  — a `ddd`-side rebuild that re-folds the `<agg>_events` stream. The pure-fold
  discipline is what keeps this a pure follow-up, not a redesign.
- **`from <Channel>` binding.** Dropped in v1 (in-process, transport-neutral,
  like today's default dispatch). Re-introduced when a projection needs to fold
  from a broker-backed durable channel — same `channelSource` mechanism reactors
  will use.
- **Snapshots** of projection state (the read-side analogue of ES snapshots) —
  deferred with ES snapshots generally.
- **Non-keyed / aggregate projections** (whole-table stats with no natural key,
  e.g. running counts) — v1 requires a key; keyless projections are a later
  shape.

## Relationship to `channels.md`

This supersedes the `channels.md` §"Surface — consumers" projection sketch:
same intent, but the fold language is the shipped `apply()`/workflow-body
vocabulary (not `upsert`/`set…where`), and v1 is explicitly in-process (no
`from <Channel>` until the durable tier). `channels.md` keeps ownership of the
transport (`channelSource`, brokers, the durable log projection replay depends
on); this doc owns the `projection` construct and its fold/read semantics.
