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
| clock trigger | `job { … emit E }` | `job { … -> handler }` (one context-scope construct) |

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
- **`timerSource` keyword** → folds into the one `job` scheduling construct (see
  below); the scheduling *engine* is reused unchanged.

## Scheduling — one `job` construct (timerSource folds in)

**Decision: one context-scope `job` construct; `timerSource` retires into it.**

### Why timerSource was proposed (scheduling.md RFC)
The problem: Loom could react to *events* but not to *time* — reaping/expiry,
polling, digests, maintenance — and the only recourse was hand-written per-backend
code in `.loomignore` files (the escape-hatch sprawl Loom exists to kill). The
RFC's *first draft* was a `schedule every 5m { … }` trigger; it was **rejected**
for three reasons, and they're a checklist any scheduling surface must pass:

1. **Trigger uniformity** — a cadence sublanguage reads as a foreign parallel
   grammar among the `create`/`on`/`handle` workflow members.
2. **No instance identity** — workflows are correlation-keyed saga entities; a
   recurring tick has no correlation, so a schedule sits awkwardly as a member.
3. **Infra-in-domain** — `every 5m` is an *operational* knob (dev-slow/prod-fast,
   per-environment), not a domain fact.

The RFC's fix: model a tick as an **event** (domain reacts via existing
`on(e)`/`create(e) by`, cadence-blind) and put the cadence at **system scope** as
a `channelSource`-twin binding (`timerSource`). It fired an *event* because, at the
time, there was **no command-dispatch surface** (`send` didn't exist) — a tick
event was the only cadence-blind way to reach domain logic.

### Why `job` replaces it now — and why it's context-scope
With `send`/`job`, a clock can dispatch a command directly. A `job` block still
passes the RFC's three-point checklist — but as a **context-scoped** construct, not
a system-scoped one:

1. **Trigger uniformity** — `job` is a separate construct, not a cadence member
   among `create`/`on`/`handle`. ✓
2. **No instance identity** — `job` is stateless dispatch; identity comes from the
   target workflow. ✓
3. **Infra-in-domain** — *here the RFC was over-general.* It hoisted **cadence** to
   system scope because it **split** the concern (the *what* — a tick event +
   reactor — lived in the context; the *when* — cadence — was hoisted so ops could
   swap it). `job` **unifies** what+when, and the unified thing is **tied to one
   context** through its target (a command is single-aggregate/single-context; a
   workflow is a context orchestrator). Even the case that *looks* operational is
   context-local: "poll an external API every 5 min" is a **workflow in the
   integration's own context** (call the API, process the result — domain work),
   and the interval is a **literal on the job** beside it. So there is no
   domain-vs-operational split to hoist on: cadence is always a **context-local
   value**, and `job` is **context-scope**, declared beside the aggregate/workflow
   it drives. (The RFC hoisted only because its split what/when model wanted the
   cadence swappable *separately* from the domain reaction; a unified context-local
   `job` has no such split.)

Note the `api`/`job` analogy is about **shape**, not scope: `api` faces *outward*
(aggregates a subdomain into an external HTTP surface → system-scope), `job` faces
*inward* (an internal clock triggering domain work in one context → context-scope).
Same trigger→handler shape, opposite direction, different scope.

**`timerSource` with `->` is a category error** — `timerSource` is a `*Source`
*binding* (the `channelSource`/`dataSource` family: `for:` / `use:` clauses), while
`->` is the *dispatch* arrow (the `route`/`api` family). So the choice was never
"add `->` to timerSource"; it was one construct or two. One wins, and "job" reads
correctly for the dominant single-owner case (`timerSource` reads as "a source of
events," wrong for a command).

### The one construct
`job` is context-scope (declared beside the aggregate/workflow it drives); the
**target verb reveals the kind** (the `->`/`emit` cardinality lens — `->`
dispatches to one owner, `emit` fans out to N):

```
job Nightly {
  cron "0 2 * * *" -> DailyClose      // -> command/create-workflow: dispatch, single owner
  every 1h          emit DayRolled     // emit event: fan-out (was timerSource's whole job)
}
```

`job` is a **battery/surface over the scheduling engine** (durable cron/every,
advisory locks, overlap — shipped, reused unchanged), like `api` over HTTP routing.
`timerSource`-the-keyword retires via a mechanical codemod
(`timerSource { for: E, cron … }` → `job { cron … emit E }`) — five backends, the
IR/engine identical.

## Symmetry summary

```
              event (fan-out)            command (single owner)
produce       emit E                     send C
consume       workflow on(e)             commandHandler / workflow create(cmd)
HTTP trigger  —                          api  { route … -> handler }
clock trigger job { … emit E }           job  { … -> handler }   (one context-scope construct)
transport     channel (carries:)         derived queue; mediator in-deployable / broker across
failure       per-reactor retry          retries + onExhausted on the owner
```

`await` = UI-action wait (client on JS, server on LiveView), orthogonal. `->` =
routing binding, orthogonal.

## Open decisions

1. **`send` vs `dispatch`** as the keyword (messaging convention: events are
   published/emitted, commands are *sent* → `send`).
2. **`bff` marker name** — `bff` / `composition` / `portal` / `readModel`.
3. **timerSource/job** — *resolved:* one `job` construct (`-> Command` dispatch /
   `emit Event` fan-out); `timerSource` retires via codemod. Remaining: confirm the
   codemod covers every shipped `timerSource` form (cron/every/in/overlap).
4. **`job` block scope** — *resolved: context-scope* (declared beside the
   aggregate/workflow it drives). The RFC's system-scope was for the cadence
   *binding* in its split what/when model; `job` unifies them and is tied to one
   context via its target. Cadence is a context-local literal.
5. **Cadence env-tunability (NOT discussed — flagged, not designed)** — whether a
   job's cadence should vary per environment is a reasonable future idea but was
   not part of this design. Loom has **no config-valued expression today** — the
   only env mechanism is `env("VAR")` in the auth block (not generalized), so there
   is no existing surface to lean on. Left open; do not assume a `config(...)`.
6. **Route target: command vs handler** — targeting the *command* (single owner ⇒
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
