# In-process dispatch delivery semantics — at-most-once → transactional outbox

> Status: **PARTIAL** — the in-process dispatcher shipped on all five
> backends (Hono #970, .NET #1012, Phoenix #1020, plus Java
> `java/emit/dispatch.ts` + Python `python/dispatch-builder.ts`), and the **transactional
> outbox tier is now live on Hono** (2026-06-10): a channel with
> `retention: log | work` makes its carried events durable — `createApp`'s
> default dispatcher records them in `__loom_outbox` (schema + MigrationsIR
> table) instead of dispatching inline, and `index.ts` starts a polling
> relay (`startOutboxRelay`) that drains undispatched rows through the
> in-process dispatcher at-least-once, dead-lettering after N attempts
> (`event_dead_lettered` catalog event); an `ephemeral` channel keeps the
> at-most-once path byte-identically.  The **.NET tier shipped alongside**
> (same day): `OutboxDomainEventDispatcher` records durable events in the
> EF-mapped `__loom_outbox` (the MigrationsIR-owned table) and the
> `OutboxRelayService` BackgroundService drains them through the
> in-process Mediator dispatcher with the same retry/dead-letter
> contract.  **Idempotent-consumer markers shipped (Hono + .NET, §3):**
> durable contexts add `last_event_id` to every saga-state row (Drizzle
> schema + EF entity/mapping + shared migration DDL); the relay threads
> the outbox row id onto each redelivery (`__loomEventId` on the event in
> Hono, the `OutboxDelivery.CurrentEventId` AsyncLocal on .NET) and the
> handler preamble no-ops on a repeat, stamping the id before save —
> at-least-once becomes effectively-once.  Inline (ephemeral) dispatch
> carries no id and ephemeral contexts stay marker-free byte-identically.
> Dapper + event subscriptions now fails loud (`loom.dapper-unsupported`)
> instead of emitting a project that references the absent EF
> AppDbContext.  Remaining: the Phoenix/Oban relay (elixir track), the
> real Dapper dispatch/outbox path (needs Dapper saga-state persistence
> first), and the LISTEN/NOTIFY upgrade over polling.
> Companion to [`channels.md`](./channels.md), which owns the **transport**
> surface (`channelSource` → broker) but only *names* the "async
> messaging/outbox" gap without designing it. This doc designs that gap for
> the **default (no-`channelSource`) in-process path** — the layer every
> external transport will sit on top of.

> **[2026-06-20 status audit]** The transactional outbox tier + idempotent-consumer markers now ALSO ship on Python (`python/dispatch-builder.ts`, `__loom_outbox` + `last_event_id`), beyond Hono/.NET. Phoenix/Oban relay + LISTEN/NOTIFY remain the outstanding items.

## What ships today (verified against code)

When a `channel carries:` an event with a subscriber, an emitted domain
event is delivered **in-process, synchronously, in the caller's
transaction-adjacent control flow**:

- **Hono** routes each `emit` through `createInProcessDispatcher(db)`;
  a handler's own `emit` re-enters the dispatcher.
- **.NET** publishes each event as a Mediator notification
  (`IDomainEvent : INotification`) to its reactor / starter
  `INotificationHandler<TEvent>`s.
- **Phoenix** pattern-matches each event struct through a per-context
  `<Ctx>.Dispatcher` into `<Wf>.Start<Event>` / `<Wf>.On<Event>` modules.

Correlation **is** persisted (the saga-state row: load-or-allocate on
`create`, route-or-drop+log `event_unrouted` on `on`). But the **event
itself is not** — it lives only as a value on the stack.

### The delivery property: at-most-once

This is the honest characterisation a reader of the generated code needs:

1. **No crash durability.** The dispatch runs *after* the aggregate save
   (Hono drains at repository-save; .NET after `SaveChangesAsync`/commit;
   Phoenix after the `Ecto.Repo` transaction commit). A process crash in the window
   between *commit* and *reactor completion* loses the event with no
   record that it was owed. The saga that should have started never does.
2. **Partial choreography.** A chain `OrderPlaced → ShipmentRequested →
   …` runs as nested synchronous calls. A failure midway has already
   committed earlier links (each handler saves in its own tx) but not
   later ones — no compensation, no resume.
3. **No idempotency key.** Re-running the same event (a client retry that
   re-emits, a future broker redelivery) re-executes the handler. The
   saga-state row dedups *instance creation* (load-or-allocate is
   idempotent on the correlation key) but **not** the body's side effects
   (a second `ShipmentRequested` for an existing instance re-runs
   `markTracked`).
4. **Synchronous, unsupervised.** The handler runs in the request /
   command process. Latency adds to the originating call; an exception
   propagates back into it. Phoenix in particular runs the reactor in the
   *calling* process — no `Task`/`Oban`/`GenServer` isolation.

For the **fire-and-forget, single-node, best-effort** sagas this targets,
at-most-once is a defensible default — and it's a *prerequisite* layer:
the dispatcher seam is exactly where a durable relay plugs in. But it must
be **named**, not assumed to be reliable.

## The upgrade: transactional outbox + idempotent consumers

The standard fix, and the one that composes with `channelSource`:

### 1. Persist the event in the producer's transaction

Add an **outbox** table written in the *same* transaction as the
aggregate save, so commit atomically records "this event is owed":

```
outbox(id, occurred_at, type, payload jsonb, dispatched_at nullable, attempts int)
```

`emit` becomes "insert into outbox" (inside the tx) instead of "append to
an in-memory list dispatched after commit". This closes the crash window
in property #1: if the tx commits, the event is durable; if it rolls back,
the event never existed.

### 2. A relay drains the outbox → the dispatcher (at-least-once)

A poller / change-feed reader picks up undispatched rows and feeds them to
the *same* `dispatch(event)` seam that exists today, then stamps
`dispatched_at`. Crash-safe: an un-stamped row is retried (so delivery
becomes **at-least-once**, attempts bounded with a dead-letter after N).
This relay is also the single point where `channelSource` swaps in an
external broker (publish to Kafka/NATS instead of the in-process
dispatcher) — Part I of `channels.md` plugs in *here*.

### 3. Idempotent consumers (at-least-once ⇒ effectively-once)

At-least-once means handlers must tolerate redelivery. The saga-state row
already keyed by the correlation field gains a **processed-marker** — a
`last_event_id` / processed-set / monotonic `version` — checked at handler
entry: a `(correlation_key, event_id)` already recorded is a no-op return.
This makes property #3 safe and is the contract any external broker
(which all redeliver) will require anyway.

## Per-backend sketch

| | Outbox store | Relay | Idempotency marker |
|---|---|---|---|
| **Hono** | a Drizzle `outbox` pgTable, inserted in the same `db.transaction` as the save | a polling worker (or `LISTEN/NOTIFY`) calling `createInProcessDispatcher(db).dispatch` | a column on the workflow-state row, checked in the handler preamble |
| **.NET** | an EF `OutboxMessage` entity saved with the aggregate in one `SaveChangesAsync` | a `BackgroundService` draining undispatched rows through `IDomainEventDispatcher` | a property on `<Workflow>State`, checked before the body |
| **Phoenix** | an Ecto `outbox` schema inserted in the same `Ecto.Repo` transaction as the save | an **Oban** worker (the idiomatic durable queue) draining to `<Ctx>.Dispatcher.dispatch/1` — also fixes the *unsupervised, runs-in-caller-process* wart (property #4) | a field on `<Wf>State`, matched in `handle/1` |

The emitted **shapes don't change** — the outbox sits *under* the existing
`emit`/dispatch seam, and the saga-state row already exists. This is an
additive reliability tier, gated (like everything in `channels.md`) on an
opt-in: a channel stays at-most-once until it (or its `channelSource`)
asks for durability.

## Open questions / decisions to pin

- **Opt-in knob.** Reuse `channel { retention: log | work }` as the
  durability signal (an `ephemeral` channel keeps today's at-most-once
  in-process path; `log`/`work` implies an outbox)? Or a separate
  `delivery:` reliability axis? `retention` already exists and reads
  naturally — preferred.
- **Relay placement.** In-process `BackgroundService`/Oban worker
  (single-node) vs a dedicated relay deployable (multi-node). Mirror the
  `migrationsOwner` per-module ownership derivation.
- **Ordering.** The outbox preserves per-producer insert order; a
  partitioned broker preserves per-`key` order. Reconcile with the
  `channel { key: }` partition field already in `ChannelIR`.
- **Dead-letter surface.** Where do exhausted-retry events land, and what
  observability event (`event_dead_lettered`?) joins the catalog next to
  the existing `event_unrouted`.

## Relationship to other docs

- [`channels.md`](./channels.md) — owns the transport binding
  (`channelSource`) and the realtime/caching halves. The relay in §2 is
  the seam its broker publish replaces.
- [`workflow-and-applier.md`](./workflow-and-applier.md) — sagas /
  compensation contract; the resume/compensation story for property #2.
- [`observability.md`](../../observability.md) — the `event_unrouted`
  catalog event; `event_dead_lettered` / `event_redelivered` extend it.
