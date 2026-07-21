# Command dispatch, jobs & read composition — the converged surface

*Design note for M-T4.6 (day-one batteries) — cross-cuts M-T4.1 (timers), M-T4.3
(outbox/DLQ), M-T1.7 (async actions), M-T4.7 (workflow v2), and the read-side of
T5. Captures a design conversation that converged a scattered set of proposals
(`job`, `send`, poison handling, BFF reads, timer scheduling) onto one coherent
surface. Status: **design proposal — not yet built.** Verify against fresh `main`
before implementing; several pieces already ship (see "What already exists").*

## The one idea

Loom already separates **events** (facts, fan-out) from **commands**
(instructions, single owner). Almost everything in this note falls out of making
that split symmetric and explicit — and *removing* the constructs that existed
only because one half of it was missing.

| | event | command |
|---|---|---|
| meaning | a past-tense fact | an instruction / unit of work |
| handlers | **0..N** reactors, independent | **exactly one** owner |
| producer verb | `emit E { … }` | **`send C { … }`** (new — the twin of `emit`) |
| consumer | `workflow on(e)` | `commandHandler` (1 agg) / `workflow create(cmd)` (N aggs) |
| failure model | each reactor's own retry | **retry → `onExhausted` on the owner** |
| HTTP trigger | — | `api { route … -> handler }` |
| clock trigger | — | `job { schedule -> handler }` |

## What already exists (verified on `main`)

- **Events**: `emit E`, `channel { carries: [Event] }`, `channelSource` broker
  binding, `workflow on(e)` / `create(e) by`. Cross-deployable eventing (broker
  fan-out, competing consumers, DLQ, `channel_dead_lettered` obs event) ships
  (M-T4.4).
- **Commands**: `command X { … }` (payload kind), `commandHandler X(cmd): R { … }`
  (single-aggregate, IR-validator enforced — `loom.command-handler-multi-aggregate`),
  `queryHandler` (read-only — `loom.query-handler-saves`). Dispatched **in-process,
  synchronously** — .NET via `IMediator.Send`, the others by direct call. **There is
  no async command path and no command→channel routing today.**
- **Routes**: `api { route METHOD "path" -> Context.Handler }` — explicit HTTP↔handler
  binding, wired across all five backends (M-T5.10). Param binding: path `{token}` →
  same-named field, the rest → body; a `command` record param flattens.
- **Command-surfaced workflows** auto-emit `POST /workflows/<name>` (see "Kill the
  magic" — this is the one piece we want to *replace*).
- **Scheduling engine**: `timerSource { for: E, cron/every }` fires an event on a
  cadence; durable Postgres cron + advisory locks + overlap ship on all five
  backends (M-T4.1 phases 1–2).

## The surface

### 1. `send` — the async dispatch verb (one word, kills three)

`send` = "issue without waiting for the result," at **every** issuing site.
Waiting is the default (a plain call/route waits); the only marked case is
not-waiting.

```
send ResizeImage { imageId: e.imageId, width: 1024 }   // internal: enqueue, don't wait
```

This **replaces** `async` (derive it — a body "is async" iff it contains a `send`
or `await`; do not stamp) and **`spawn`** (frontend fire-and-forget *is* `send`).
`await` stays as the UI-action *wait* marker (client-side on JS frontends,
**server-side on Phoenix LiveView** — it is a UI-action construct, not
frontend-exclusive). `->` is a routing arrow, orthogonal to this axis.

Validator rules:
- `loom.send-query` — `send` targets a command/workflow, never a `queryHandler`.
- `loom.send-nonvoid-result` / `loom.send-route-response` — a `send` can't surface a
  domain response (the work hasn't run); a `send` route returns **202 + commandId**.
- `loom.poison-without-async` — `retries`/`onExhausted` require the handler be
  async-reachable.

### 2. Consumers — commandHandler vs workflow

Per the grammar's own words, *"a commandHandler is a workflow `handle` lifted out
when the orchestration is single-aggregate."*

| | `commandHandler` | command-surfaced `workflow` |
|---|---|---|
| aggregates | exactly one (static gate) | many — orchestrates |
| body | mutates its aggregate directly | drives aggregates via their ops (`:=` forbidden) |
| result | 200 + response DTO | 204 (orchestration, no single projection) |
| state | stateless per-command | may be `eventSourced` — saga w/ correlation + compensation |

The single-aggregate rule is enforced statically: `aggregatesTouched()` unions the
`aggName` at every load/create/op-call/find/iterate/delete/save site in the lowered
IR; `size > 1` → `loom.command-handler-multi-aggregate`, pushing you to a workflow.

A workflow triggered by a job can **read data and orchestrate freely** — loops,
finds, multi-aggregate op-calls, emits — which is exactly the "run complex work on
a schedule" case. `on`-workflows are **event reactors** and are never a command
target (they react to facts).

### 3. `api` and `job` — sibling trigger surfaces

Both are *trigger → `-> handler`* blocks. Only the trigger differs.

```
api SalesApi {
  route POST "/orders"     -> Ordering.PlaceOrder      // HTTP  → command
  route GET  "/orders/:id" -> Ordering.GetOrder
}

job Maintenance {
  every 1h          -> Search.RebuildIndex             // clock → command (single-aggregate)
  cron "0 2 * * *"  -> Ops.DailyClose                  // clock → create-workflow (reads + orchestrates)
  every 5m in "UTC" -> Media.SweepOrphans
}
```

Asymmetry that falls out naturally: an `api` route has a caller, so it chooses sync
(`->`, 200) or async (`send ->`, 202). A `job` has **no caller** — the scheduler
fires it — so a job entry is *inherently* fire-and-forget and gets the command's
retry/poison lifecycle for free. You never write `send` in a job.

### 4. Kill the auto-POST magic — scaffold explicit routes

The auto `POST /workflows/<name>` is the same implicit-derivation smell as
conjured sidebars (M-T1.13) and dead-letter-as-event (rejected below). Replace it:
a **scaffold macro emits a real `route`** into the api (unfold-able, editable),
instead of the emitter conjuring an endpoint from nowhere.

```
workflow DailyClose { create() { … } }
api Ops with scaffoldApi(of: Operations)
//   ⇩ unfolds to a REAL, customizable line:
//   route POST "/workflows/daily_close" -> Ops.DailyClose
```

This also unifies the emit path: once workflow entries arrive through explicit
`route -> Ctx.Workflow`, the explicit-handlers emitter resolves workflow handles
too (today it only does cmd/qry — the current gap), and the bespoke auto-POST path
retires.

### 5. Dispatch tiers — the deployable is the boundary

`send` (and any cross-context call) picks its transport from the deployable
boundary, not from author syntax:

| scope | transport | needs a channel? |
|---|---|---|
| same context | direct / in-process | no |
| same deployable, other context | **mediator** (in-process) | no — the mediator *is* the queue |
| cross-deployable | broker (commands) / HTTP (reads) | yes (derived queue, `channelSource` broker binding) |

A command's queue is **derived** (one owner → `loom.<ctx>.<command>`, `delivery:
queue`, `retention: work`) — no per-command `carries:` ceremony (events need it
because fan-out transport is a *choice*; a command has one owner). The envelope id
is the `commandId` returned in a 202, doubling as the idempotency key (M-T4.4).

### 6. Poison / dead-letter — on the owner, no phantom events

`retries` + `onExhausted` live **on the command handler** (the single owner). No
synthesized `<Channel>DeadLettered` event — that was rejected as magical/
convention-based. The reaction references **author-declared** objects:

```
commandHandler ResizeImage(cmd: ResizeImage) {
  retries: 5
  do { … }
  onExhausted(msg) { emit ImageProcessingFailed(msg.imageId) }   // msg = the original, declared command
}
```

- `onExhausted` is workflow-natured (effectful) but **sited at the owner**, not a
  separate handler — matches how message frameworks co-locate happy path + poison.
- The DLQ *log/browse/replay* half is a **derived ops projection** (M-T7.7), not
  author surface — auto-*ops-plumbing* is fine; auto-*domain-surface* is not.
- Only meaningful on a durable queue (`loom.deadletter-requires-durable-queue`).

### 7. Read composition — the `bff` context

Reads compose by calling **query contracts** (calling a contract is not "reaching
into" a context — the `X id`-only rule only bars structural refs). A dedicated
`bff` context is the *located* home for cross-context read composition:

```
context Dashboard bff {                       // `bff` = the scoped grant to read other contexts' query contracts
  response DashboardView { orders: Ordering.RecentOrder[]  featured: Catalog.Product[]  balance: money }
  queryHandler GetDashboard(userId: guid): DashboardView {
    let orders   = Ordering.recentOrders(userId)   // cross-context query-contract calls
    let featured = Catalog.featured()
    let balance  = Billing.balanceFor(userId)
    return DashboardView { orders: orders, featured: featured, balance: balance }
  }
}
api Portal { route GET "/dashboard/:userId" -> Dashboard.GetDashboard }
```

Rules keep it a pure read layer: a `bff` context has no aggregates/writes
(`loom.bff-write`), calls only query contracts (`loom.bff-command`), and may
reference other contexts' query/response contract types (not their aggregates).
Same-deployable → the fan-out is in-process mediator sends; cross-deployable → HTTP
calls to each api (M-T4.10). Reads may compose synchronously cross-context;
**writes stay event-choreographed** (autonomy).

## What this removes

The net is a *smaller* surface despite adding `send`/`job`/`bff`:
- **`async` keyword** → derived ("contains a send/await").
- **`spawn`** → it's `send` on the client.
- **auto `POST /workflows/<name>`** → a scaffolded explicit `route`.
- **the phantom dead-letter event** → never introduced.

(`timerSource` is *not* removed — see below; it and `job` are two sugars over one
scheduling mechanism.)

## timerSource + job — one scheduling mechanism, two intent sugars

`timerSource`'s design was *"time as an event source… the clock twin of
`channelSource`… zero new workflow grammar"* — it fires an **event** because, when
it was built, there was **no command-dispatch surface** (`send` did not exist;
commands were mediator-sync-only). Event-firing was the only way to trigger domain
work from a clock.

The clean resolution is **not** to retire it. A scheduled trigger is one
mechanism — **a schedule + a target — and the target's kind picks the producer
verb**, exactly like `emit`/`send`:

- target an **event** → scheduled `emit`, fan-out → the **`timerSource`** spelling
  (`for: E`), unchanged, shipped (M-T4.1).
- target a **command/create-workflow** → scheduled `send`, single owner → the
  **`job`** spelling (`schedule -> Cmd`), the command-side that was missing.

So `timerSource` and `job` are **two intent-revealing sugars over one scheduling
engine** (durable cron/every, advisory locks, overlap — shipped), the clock-trigger
twins of `emit`/`send`. Neither subsumes the other; the name is locked to its
target kind by a validator (`timerSource` → event, `job` → command), so the
spelling tells you what it fires at a glance. This matches Loom's existing house
style — the `payload`/`command`/`query`/`response`/`error` keywords are one wire
mechanism, five intent sugars.

**No deprecation, no migration** — `timerSource` stays valid (the event role);
`job` is added (the command role). A scheduled workflow that *also* wants fan-out
still uses `timerSource → event → on(e)`/`create(e) by`; one that just runs work
uses `job -> command/workflow`. `job` is therefore a **battery/surface over the
scheduling engine** (like `api` over HTTP routing) — it composes schedule + `send`
+ handler, zero new runtime.

## Symmetry summary

```
              event (fan-out)            command (single owner)
produce       emit E                     send C
consume       workflow on(e)             commandHandler / workflow create(cmd)
HTTP trigger  —                          api { route … -> handler }
clock trigger timerSource { for: E }     job { schedule -> handler }
transport     channel (carries:)         derived queue; mediator in-deployable / broker across
failure       per-reactor retry          retries + onExhausted on the owner
```

`await` = UI-action wait (client on JS, server on LiveView), orthogonal. `->` =
routing binding, orthogonal.

## Open decisions

1. **`send` vs `dispatch`** as the keyword (messaging convention: events are
   published/emitted, commands are *sent* → `send`).
2. **`bff` marker name** — `bff` / `composition` / `portal` / `readModel`.
3. **timerSource/job unification** — resolved to "one engine, two intent sugars"
   (timerSource → event, job → command); confirm the validator locks each keyword
   to its target kind, vs. allowing one target-polymorphic keyword.
4. **`job` block scope** — system-level (beside `api`) vs context-level.
5. **Route target: command vs handler** — targeting the *command* (single owner ⇒
   handler derived) reads cleaner but can't point at a workflow `handle` or reuse
   one handler across routes; targeting the *handler* keeps today's flexibility.
   (Separate design point — see the route-overload discussion.)

## Mission mapping

- **M-T4.6** — owns `job` (as the battery/surface) + object-storage/email tail.
- **M-T4.1** — scheduling engine (done); this note reframes its *surface* as `job`
  and proposes deprecating the `timerSource` keyword.
- **M-T4.3** — `send` transport (command queue), retries/backoff/timeout knobs, the
  derived DLQ projection; `onExhausted` co-located on the owner.
- **M-T1.7** — drop `async`/`spawn` in favour of `send`; derive async.
- **M-T4.7** — workflow-as-command-consumer, saga compensation vs command poison.
- **Read-side (new, T5/T4.2)** — the `bff` composition context + cross-context
  query-contract calls; ties to M-T4.2 (projection composition) and M-T4.10
  (cross-deployable calls). Probably deserves its own mission.
