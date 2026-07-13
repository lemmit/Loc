# Channels, realtime & caching

> Status: **PARTIAL** — Slice 1 shipped (#797): the `channel { carries / delivery /
> retention / key }` context-member surface and the system-scope `channelSource`
> binding lower to `ChannelIR` / `ChannelSourceIR` (`src/ir/types/loom-ir.ts`).
> **In-process dispatch shipped (Hono + .NET + Phoenix):** an emitted event a
> `channel` carries is delivered to its `on(e: Event)` reactors and
> event-triggered `create(e: Event) by` starters (the default when there is no
> `channelSource`) — see `docs/workflow.md` §Triggers.  Hono routes through a
> generated `createInProcessDispatcher(db)`; .NET publishes each event as a
> Mediator notification to its reactor / starter `INotificationHandler<TEvent>`s;
> Phoenix pattern-matches each event struct through a per-context
> `<Ctx>.Dispatcher` into `<Wf>.Start<Event>` / `<Wf>.On<Event>` handler
> modules.  All three **persist** workflow correlation — a saga-state row keyed
> by the correlation field, with load-or-allocate (`create`) and
> route-or-drop+log (`on`); Phoenix stores it as a plain `Ecto.Schema` over the
> canonical migration's table, read/written through the app `Repo`.
> **Realtime wire v1 shipped (Hono + React):** events carried by a
> `delivery: broadcast` channel stream over SSE — the Hono backend emits
> `http/realtime.ts` (`GET /realtime/events` + a `realtimeTee` dispatcher
> decorator that createApp wraps its default with, composing *inside* the
> outbox so relayed durable events reach the wire too) and the React
> generator emits a matching `src/api/realtime.ts` EventSource client
> (`subscribeRealtime(onEvent)`) when its target backend is Hono.  v1 is
> broadcast-to-all: no rooms, no edge relay, no policy-derived router —
> those layer on the authorization work; the authorized read stays the
> gate (clients refetch, payloads carry no privilege).
> **The ui surface shipped too:** `channel <p>: <Ctx>.<Channel>` +
> `on <p>.<Event>(e) { toast(…) }` ui members (scope-checked: the event
> must be carried, the channel must be `delivery: broadcast`) lower to
> `UiChannelParamIR`/`UiNotificationIR` and render a renderless
> `RealtimeHandlers` component every design pack's App shell mounts;
> the toast call is pack-shaped (`realtime-toast` micro-template ×8
> packs).  v1 handler bodies are toast-only
> (`loom.ui-handler-unsupported`).  Still unstarted: the
> .NET / Phoenix realtime wire, external brokers via `channelSource` (redis /
> kafka / nats), the `delivery: queue`
> competing-consumer semantics, the realtime topology (rooms + edge relay
> + router), and **Part II** caching / invalidation. The async-messaging / realtime **and** the
> read-side caching tiers, designed together. Fills the "async messaging/outbox"
> and "caching & invalidation" gaps in `production-readiness.md` (§3.3–3.4).
> Depends on / reuses: the publish-subscribe placement + `on(e: Event)` /
> `projection` consumer surface (`bounded-context-model.md`,
> `workflow-and-applier.md`); `authorization.md` (`DataKey`) and
> `multi-tenancy-design-note.md` (`tenancy by`) — reused, never redefined; the
> existing `storage` / `dataSource` split (D-STORAGE-SPLIT) and the
> `DomainEventDispatcher` seam (`docs/workflow.md`).

> **[2026-06-20 status audit]** Realtime v1 frontend now spans React, Vue (`vue/realtime-handlers-builder.ts`), AND Svelte (`svelte/realtime-handlers-builder.ts`) — Hono remains the only backend serving `/realtime/events`.

This proposal has two halves, designed together and sharing one key model:
**Part I — Channels** (async messaging, queues, realtime delivery) and
**Part II — Reads, freshness & caching** (invalidation, the cache tiers). Part I
moves events; Part II keeps reads fresh off the same `save`/event stream. They
meet on one vocabulary — the resource key + `DataKey` — defined once and reused.

---

# Part I — Channels: async messaging, queues & realtime

## TL;DR

Loom already has the **publish** half of a messaging system and the
**transport slots** for it — it's missing the contract that ties delivery
semantics to a transport, and the realtime path to the UI.

- Producers already `emit Event { … }`; events drain through a pluggable
  `DomainEventDispatcher` (default no-op) at repository-save and
  workflow-exit (`docs/workflow.md`). **The publish side ships today.**
- `storage { type: redis | kafka | rabbitmq }` already parse + validate
  (`docs/architecture.md`); they're transport slots with no wiring yet.
- `bounded-context-model.md` already pins *who may subscribe to what*
  (context-level events are published; aggregate-nested are BC-internal)
  and names the consumer form `on(e: Event)` + `projection`.

The one thing missing is a way to say **"this set of events, delivered
*this way*, over *that* transport."** This proposal adds exactly one new
declaration — `channel` — plus its physical binding `channelSource`,
mirroring the existing `storage` / `dataSource` split (D-STORAGE-SPLIT).

**One declaration, three orthogonal knobs.** A `channel` is a named
transport+policy overlay over a set of event subjects, declared **inside the
context that owns those events** — one context normally has several (see
[Granularity](#granularity--many-channels-per-context)):

```ddd
context Orders {
  event OrderPlaced { order: Order id, at: datetime }
  // … OrderShipped, OrderCancelled …

  channel Lifecycle {             // a context member — many per context
    carries:   OrderPlaced, OrderShipped, OrderCancelled
    delivery:  broadcast          // broadcast | queue       (NATS "delivery group")
    retention: log                // ephemeral | log | work  (NATS "stream retention")
    key:       order              // ordering / partition key (a field on the carried events)
  }
}
```

Flip `delivery` / `retention` and the *same* declaration expresses pub/sub,
a work queue, or a durable replayable stream — the NATS insight that subject
and stream are orthogonal, reduced to two knobs. **The channel contract names
no transport.** Whether an event reaches a peer backend over in-process calls,
Redis, Kafka, or RabbitMQ — and whether it reaches a *browser* over SSE or a
WebSocket — is chosen **at the binding / platform**, not in the contract, so
the same channel runs in-process under test and over Kafka in prod, exactly as
a `context` runs over `inMemory` then `postgres`. SSE-vs-WebSocket is the same
kind of infrastructural choice as Redis-vs-Kafka; it never appears on the
`channel`.

## The question, in Loom's terms

The five-primitive messaging model (subject / subscription / delivery-group
/ stream / reply-subject) was designed for *untyped, string-addressed*
brokers like NATS. Loom is typed and layered, so the five collapse to three:

| General primitive | Loom home | Status |
|---|---|---|
| **Subject** (addressable name) | the typed `event` + its `context` namespace — no free-form strings | **exists** |
| **Stream** + **Retention** | `channel { retention: … }`, bound to `storage{type:kafka/redis}` via `channelSource` | this proposal |
| **Subscription** | `on(e: Event)` reactor / `projection` | pinned by `bounded-context-model.md`; transport supplied here |
| **Delivery group** | `channel { delivery: queue }` | this proposal |
| **Reply subject** (async RPC) | — | **deferred** — synchronous `api` already covers request/reply |

So the "good abstraction over queues of different kinds" is: **`event`
(the subject, already typed) + `channel` (subscription + stream + retention
+ delivery-group, as orthogonal knobs) + `channelSource` (the transport
binding).** Three concepts, because Loom's type system and layering already
carry the rest.

### Why one declaration with knobs, not three keywords

A naïve mapping gives separate `topic` / `queue` / `stream` declarations.
That triples the surface and forces authors to re-pick a keyword when
requirements change (a broadcast topic that later needs durability becomes a
*different declaration*). The orthogonal-knob model — `delivery` ⟂
`retention` — is the whole reason NATS JetStream unifies Kafka, RabbitMQ,
and Redis PubSub behind one API. We keep that property: changing a
requirement flips a knob, not a keyword.

| `delivery` | `retention` | Behaviour | Classic equivalent |
|---|---|---|---|
| `broadcast` | `ephemeral` | every live subscriber gets each event; nothing kept | Redis PubSub, Phoenix.PubSub |
| `broadcast` | `log`       | durable, replayable, many independent readers | Kafka topic |
| `queue`     | `ephemeral` | one of N competing consumers handles each event | RabbitMQ, SQS |
| `queue`     | `work`      | durable until acked, then deleted | RabbitMQ work queue, SQS, Kafka consumer group |

`retention: log` + a cursor is exactly event-sourcing replay — and Loom
already has the `eventLog` persistence kind and `apply(…)` appliers
(`docs/architecture.md`, `workflow-and-applier.md`) to consume it.

## Relationship to existing proposals (what this does and doesn't touch)

| Already pinned / proposed elsewhere | This proposal |
|---|---|
| **Placement = visibility.** Context-level events published; aggregate-nested internal (`bounded-context-model.md`, `loom.cross-bc-internal-event`). | Unchanged. A `channel` may only `carries:` **published** (context-level) events; carrying an aggregate-internal event reuses that same error. |
| **Consumer form** `on(e: Event)` + `projection` (`bounded-context-model.md` §"Pattern B", `workflow-and-applier.md` §Sagas). | Unchanged surface. We define the **transport** those consumers ride on and the delivery-group semantics (`queue`) that govern competing consumers. |
| **`.loom/asyncapi.yaml` — "events as channels"** (`bounded-context-model.md`). | A `channel` declaration becomes the explicit AsyncAPI channel object (bindings, retention) instead of one synthesised per event. |
| **`persistedAs(eventLog)` is a context/domain decision; `dataSource` is the system binding** (`docs/architecture.md`). | Exact precedent for the split here: `channel` (delivery/retention contract) lives **in the context**; `channelSource` (physical broker) lives at system scope. |
| **Producer** `emit Event { … }` → `DomainEventDispatcher` (`docs/workflow.md`). | **Unchanged.** Producers never name a channel. Routing is derived: the dispatcher publishes each event to every channel that `carries:` it. |

The net new surface is small: one declaration (`channel`), one binding
(`channelSource`), two consumer additions already foreshadowed (`on` reactor
gets a transport; `projection` gets defined), and a UI live-event subscription
(`on Param.Event`). Realtime push to the browser needs **no** contract knob — it's derived
from a UI subscribing to a channel, and the SSE-vs-WebSocket wire is platform
infra (see [Realtime](#websockets--sse--an-infrastructural-concern-not-a-contract-knob)).

## Surface — the `channel` declaration

A **context member**, declared alongside the events it carries. A channel is
the publisher-side contract for *how a context's own events are transported* —
so it lives with them, not at system scope. There is **no `from` clause**: the
`carries:` list names events of the enclosing context, and a channel may only
carry **published** (context-level) events of *that* context. (Cross-context
fan-in is the consumer's job — a reactor/projection subscribes to several
channels — never the publisher reaching across a boundary.)

```langium
// ContextMember += Channel   (sibling of EventDecl / View, inside `context { … }`)
Channel:
    'channel' name=ID '{'
        ('carries'   ':' carries+=[EventDecl:ID] (',' carries+=[EventDecl:ID])* ','?)
        ('delivery'  ':' delivery=ChannelDelivery ','?)?
        ('retention' ':' retention=ChannelRetention ('(' retentionArg=RetentionArg ')')? ','?)?
        ('key'       ':' key=ID ','?)?            // partition/ordering key — a field common to carried events
        ('scope'     ':' scope=Expression ','?)?  // subchannel/room predicate — see "Subchannels"
        ('requires'  ':' requires=Expression ','?)?  // capability gate at connect (same shape as op `requires`)
    '}';

ChannelDelivery  returns string: 'broadcast' | 'queue';
ChannelRetention returns string: 'ephemeral' | 'log' | 'work';
// RetentionArg carries log limits: maxAge / maxBytes (deferred to a follow-up; parses as a knob list).
```

The contract carries **delivery semantics and audience** — what's delivered,
to a broadcast audience or a competing-consumer group, kept how long, and (via
`scope:`/`requires:`) *which subset of subscribers may receive each event*. It
says nothing about the wire (in-process / Redis / Kafka / RabbitMQ for backends;
SSE / WebSocket for browsers); that's `channelSource` + platform. `scope:` is
audience, not transport — it lowers to broker room keys, never to a wire choice
(see [Subchannels](#subchannels--not-every-browser-gets-every-event)).

Defaults (when a knob is omitted) reproduce **today's behaviour** so existing
`.ddd` files are unaffected: `delivery: broadcast`, `retention: ephemeral`,
no `key`, no `scope`/`requires` (with tenancy implicitly applied when the system
declares `tenancy by …`). An author who declares no `channel` at all keeps the
current in-process no-op-able dispatcher.

### Granularity — many channels per context

`carries:` *selects a subset* of the context's events; it is not a 1:1 wrapper
and it is not exhaustive. The common case is **several channels in one
context**, each grouping events that share a delivery profile — and the *same*
event may appear on more than one channel (e.g. a durable audit log **and** an
ephemeral UI feed), in which case the dispatcher fans it out to each:

```ddd
context Orders {
  event OrderPlaced    { order: Order id, at: datetime }
  event OrderShipped   { order: Order id, at: datetime }
  event StockLevel     { sku: string, onHand: int }          // high-volume telemetry
  event PaymentCapture { order: Order id, amount: decimal }  // must-process-once

  // durable, replayable lifecycle log — read models replay it
  channel Lifecycle { carries: OrderPlaced, OrderShipped; retention: log; key: order }

  // fire-and-forget metrics — ephemeral broadcast (a dashboard UI can subscribe for live events)
  channel Telemetry { carries: StockLevel; delivery: broadcast; retention: ephemeral }

  // competing-consumer work queue — one worker captures each payment
  channel Payments  { carries: PaymentCapture; delivery: queue; retention: work; key: order }

  // OrderPlaced also rides Lifecycle above AND this ephemeral feed — fan-out, two profiles
  channel Board     { carries: OrderPlaced, OrderShipped; retention: ephemeral }
}
```

A consumer that could match an event on more than one bound channel **must**
disambiguate with `via <Channel>` (see below); `loom.reactor-channel-ambiguous`
fires otherwise. This is why reactors name a channel rather than just an event.

References elsewhere use the same name rule as every Loom cross-ref: bare when
globally unique (`Lifecycle`), dotted when not (`Orders.Lifecycle`).

**Validation** (`loom.channel-*`):

| Code | Rule |
|---|---|
| `loom.channel-internal-event` | a `carries:` event is aggregate-nested (BC-internal) — reuses the `cross-bc-internal-event` boundary. |
| `loom.channel-key-missing-field` | `key:` names a field absent from one of the carried events. |
| `loom.channel-key-type` | the `key:` field has a different type across carried events (no common partition key). |
| `loom.channel-retention-needs-key` | `retention: work` or `log` with `delivery: queue` requires a `key:` for stable per-key ordering (warning). |

## Surface — consumers (the transport under an already-pinned form)

The consumer keywords are pinned elsewhere; here is how they bind to a
channel. A reactor is **a workflow that starts on an event instead of an
HTTP POST** — so it reuses the entire workflow body vocabulary and lowering
(`docs/workflow.md`), which is the single biggest implementation saving.

```ddd
context Shipping {

  // Reactor / policy — choreography. `on(e: Event)` is the form pinned by
  // bounded-context-model.md; `via Orders.Lifecycle` selects the channel (and
  // thus the delivery group); omitted ⇒ derived when exactly one bound channel
  // carries the event. Body = workflow body (let / create / op-call / emit).
  on(e: OrderPlaced) via Orders.Lifecycle {
    let shipment = Shipment.create({ order: e.order, status: Pending })
    emit ShipmentRequested { shipment: shipment.id, at: now() }
  }

  // Projection — write side of a read model, folded from a channel.
  // Reuses apply()-style pure fold discipline (workflow-and-applier.md).
  // NOTE: this bespoke `upsert`/`set…where` sketch is SUPERSEDED by
  // `projection.md`, which specifies the construct using the shipped
  // `apply()`/workflow-body fold vocabulary and drops `from <Channel>` in v1
  // (in-process fold; `from` returns with the durable-log tier below).
  projection OrderBook from Orders.Lifecycle {
    on OrderPlaced(e)   { upsert { order: e.order, status: Placed } }
    on OrderShipped(e)  { set status = Shipped where order = e.order }
  }
}
```

> **The `projection` construct now has its own proposal —
> [`projection.md`](./projection.md)** (minimal in-process v1). It supersedes
> the sketch above: same intent, but the fold language is the shipped
> `apply()`/workflow-body vocabulary (not `upsert`/`set…where`), and v1 is
> explicitly in-process — the `from <Channel>` binding re-enters only when a
> projection folds from a **durable** channel (`retention: log`), which is also
> where projection **replay/rebuild** lives. Channels keeps ownership of the
> transport (`channelSource`, brokers, the durable log); `projection.md` owns
> the construct and its fold/read semantics.

```langium
// ContextMember += Reactor | Projection
Reactor:
    'on' '(' param=ID ':' event=[EventDecl:ID] ')' ('via' channel=[Channel:ID])?
    '{' body+=Statement* '}';            // body = the existing Workflow Statement rules
```

Delivery-group identity for `delivery: queue` channels defaults to the
reactor's qualified name, so N replicas of one deployable form one competing-
consumer group automatically; `broadcast` channels deliver to every replica.
No extra DSL — replica count is a deployment fact, the channel knob is the
only switch.

**Validation:** `loom.reactor-event-uncarried` (the reacted event is carried
by no channel the hosting deployable binds) **[shipped]** and
`loom.reactor-channel-ambiguous` (the event is carried by more than one channel
in its context — in-process dispatch records the first by declaration order)
**[shipped, warning]**.  Still deferred pending the `via <Channel>` surface:
`loom.reactor-channel-mismatch` (`via X` where `X` doesn't carry the event) and
upgrading the ambiguity rule to an error once `via` gives it a remedy.  Plus the
inherited `cross-bc-internal-event`.

## Surface — transport binding (`channelSource`)

The channel is **transport-neutral** — like every other Loom contract, it
names no platform or broker. Binding to a physical `storage` mirrors
`dataSource` exactly (D-STORAGE-SPLIT): a sibling declaration, listed on the
deployable.

```ddd
storage bus     { type: redis }       // ephemeral pub/sub + lightweight streams
storage eventLog { type: kafka }      // durable, partitioned, replayable

channelSource lifecycleBus { for: Orders.Lifecycle, use: eventLog }  // qualified channel ref
channelSource paymentsBus  { for: Orders.Payments,  use: bus      }

deployable salesApi {
  platform:    node
  contexts:    [Orders]
  serves:      SalesApi
  dataSources: [ordersState]
  channels:    [lifecycleBus, paymentsBus]   // one binding per channel this deployable wires
  port:        3000
}
```

The default — **no `channelSource`** — keeps the in-process dispatcher
(today's behaviour, ideal for a monolith and for tests). Adding a binding is
what activates a broker. A channel may bind to different transports in
different deployables/environments without touching the contract or the
domain.

### Transport compatibility matrix (the answer table, in Loom terms)

`channelSource` validates the channel's `delivery`×`retention` against the
bound `storage.type`, the same way `dataSource` validates `kind` against
`storage.type` today:

| `delivery` | `retention` | Compatible `storage.type` | UI live-event subscribable |
|---|---|---|---|
| `broadcast` | `ephemeral` | `inMemory`, `redis`, `nats` | yes |
| `broadcast` | `log`       | `kafka`, `nats` (JetStream) | yes (replay-from-cursor) |
| `queue`     | `ephemeral` | `redis`, `rabbitmq`, `nats` | no — competing consumers |
| `queue`     | `work`      | `redis`, `rabbitmq`, `kafka`, `nats` | no — competing consumers |

`loom.channelsource-incompatible` fires on a mismatch (e.g. `retention: work`
bound to a bare `inMemory` with no durability), carrying the same
suggestion-with-alternatives shape as the existing dataSource matrix error.
Note the last column is a *semantic* property (a browser can't join a work
group) — **not** a transport choice; SSE-vs-WebSocket doesn't appear here.

#### Choosing the broker — NATS vs Redis vs Kafka vs RabbitMQ

They are different designs, and for *this* proposal the **routing model** (the
hierarchical `dataKey`-ancestor rooms) splits them: "publish to the leaf,
subscribe to ancestors" needs **subject/topic wildcards**, which NATS (`>`/`*`),
RabbitMQ topic (`#`/`*`), and Redis (`PSUBSCRIBE *`) have but **Kafka does not**
(topic+partition; it's a *log*, not a router).

| | sweet spot | wildcards | persistence | ops |
|---|---|---|---|---|
| **NATS (+JetStream)** | pub/sub + queue + stream + req/reply in one light binary; subjects map *directly* onto our ancestor rooms | **yes** | JetStream | light |
| **Redis** (Pub/Sub + Streams) | ephemeral fan-out; relay backplane; **already run for the cache** | yes (pattern) | Streams only (memory-bound) | light |
| **Kafka** | durable, replayable, high-throughput **log** (event-sourcing, projection replay) | **no** | yes, long retention | heavy |
| **RabbitMQ** | reliable **work queues**, rich routing, DLQ/delay | yes (topic) | queues no / Streams plugin | moderate |

So, by role:
- **router / invalidation fan-out / fine rooms** → **NATS** (best routing fit) or
  **Redis** (pragmatic — cache + invalidation + relay backplane share one system;
  ticket loss doesn't matter, tickets are disposable);
- **durable event log** (`retention: log`) → **Kafka** (or JetStream);
- **work queues** (`queue`/`work`) → **RabbitMQ** (or JetStream / Redis Streams).

Not exclusive — each channel binds its own `channelSource`, so a system can run
**Redis for cache+invalidation, Kafka for the durable log, RabbitMQ for work
queues** at once. And note **NATS is the one broker that covers the whole matrix
*with* the wildcards our routing wants** — fitting, since NATS's "one system for
every messaging pattern" thesis is where this proposal's framing began; it's the
strongest single choice if you want one transport for the realtime tier, while
Redis is the lower-friction start if you're already Redis-heavy.

**Honest caveat — they've converged.** On a feature checklist these are now
largely the same (all four do pub/sub *and* durable streams *and* consumer
groups *and* some replay). What still differs is **not the feature list** but the
*tradeoff point* (latency vs throughput vs durability — feature present ≠
fit-for-purpose at the extreme; Redis Streams is memory-bound, Kafka can't do
fine-grained wildcard routing), the **operational weight** (Kafka heavy,
NATS/Redis light), and the **grain of the core abstraction** (partition vs subject
vs exchange — which fixes ordering/routing/retention no matter how many features
are bolted on). So for a **typical** workload any of them works and the choice
collapses to "what you already run"; the table's sweet spots bite mainly at the
**extremes** and in ops cost. This *strengthens* the transport-neutral contract —
if brokers are largely swappable for common cases, deferring the choice to a
per-binding `channelSource` is exactly right.

## WebSockets / SSE — an infrastructural concern, not a contract knob

SSE and WebSocket are two wire formats for the same thing: pushing a
`broadcast` channel's events to a browser. The delivery semantics are
identical, so the **`channel` says nothing about which is used** — just as it
says nothing about Redis-vs-Kafka. A channel becomes UI-observable simply
because a UI *subscribes* to it; nothing is declared on the producer side.

The channels-owned UI surface is the **live-event subscription** (a `channel`
param + an `on Param.Event(...)` handler). A live *read* — a list/detail kept
fresh — needs **no marker**: an ordinary cached query is auto-invalidated (see
the **Reads & caching** part below); it rides this same wire but carries tickets, not
payloads.

```ddd
ui WebApp {
  api     Sales:  SalesApi
  channel Orders: Orders.Lifecycle     // subscribe to events — wire format derived, not stated

  // A live EVENT — render the event itself (toast / feed / badge).
  on Orders.OrderShipped(e) { toast("Order " + e.order + " shipped") }

  page OrderBoard {
    route: "/board"
    // A live READ — just a cached query; auto-fresh while on screen. No marker;
    // its freshness semantics are Part II's; it rides the wire below.
    body: For { Sales.Order.all, o => Card { o.id, o.status } }
  }
}
```

**Where the wire format is decided.** Derived from the frontend's platform,
with an optional override at the *deployable* — the same tier as `port:`, an
infra fact:

| Frontend platform | Default wire | Why |
|---|---|---|
| React (`static` target) | **SSE** | one-way server→client fits both invalidation tickets and event payloads; survives proxies; no upgrade handshake. |
| Phoenix LiveView | **native WebSocket** | LiveView already holds a socket; reusing it is free. |

```ddd
deployable webApp {
  platform: static
  targets:  salesApi
  ui:       WebApp { Sales: salesApi }
  realtime: websocket        // optional infra override; default SSE for React. NOT on the channel.
  port:     3002
}
```

So `realtime:` exists in the grammar, but on the **deployable** (infra),
never on the `channel` (contract). Most authors never write it.

```langium
// UiMember += UiChannelParam  +  an `on Param.Event(p){…}` live-event handler.
// (Live READS need no UI syntax — a cached query is auto-fresh; see Part II.)
UiChannelParam: 'channel' name=ID ':' channel=[Channel:ID];
UiNotification:  'on' param=[UiChannelParam:ID] '.' event=[EventDecl:ID]
                 '(' bind=ID ')' '{' body+=Statement* '}';
```

Per-frontend lowering of the realtime wire (both planes ride it):

| Platform | Realtime mechanism | Lowers to |
|---|---|---|
| **React** (`hono`/`static` target) | `EventSource` (SSE) or `WebSocket` client in the generated `api/` client | one subscription; an **event** ticket → render via the `on` handler; an **invalidation** ticket → `queryClient.invalidateQueries([...])` (Part II). |
| **Phoenix LiveView** | **native** — `Phoenix.PubSub.subscribe` + `handle_info` | a `handle_info({:order_shipped, …}, socket)` re-`assign`s the stream; LiveView diffs and pushes over its own WebSocket. No client code. |

This is where the layering pays off: Phoenix LiveView's WebSocket fabric is
*already* a channel transport, so native WebSocket is free there, while React
gets an SSE (or WS, if the deployable overrides) client generated against the
same channel contract. The wire format is a `PlatformSurface` capability
(`realtimeWire: "sse" | "websocket"`), defaulted per platform and overridable on
the deployable; the channel and the page body are identical regardless.

### Realtime topology — the edge relay (browser delivery is two-hop)

A subtle but load-bearing point: **a browser never connects to the broker.**
It can't speak Kafka/AMQP/Redis, and exposing an internal broker to the public
internet with per-user ACLs is a non-starter. A browser speaks SSE/WebSocket to
exactly one backend — the one its frontend `targets:`. So when a UI in context
B (deployable Y) wants a channel produced by context A (deployable X), delivery
is unavoidably **two hops**:

```
emit (ctx A, in DU X) ─▶ broker channel  ─▶ [relay backend] ─▶ SSE/WS ─▶ browser (UI of ctx B)
                         └ hop 1: backend↔backend ┘          └ hop 2: edge / trust boundary ┘
```

This is the "second channel" the topology seems to demand — but it is **not a
second declaration**. There is deliberately **no domain-level channel→channel
router**; that would leak network topology into the domain. Instead the edge
relay is *derived*:

- **The relay is the backend the UI's frontend `targets:`.** For it to relay
  channel `C`, it must itself be a **subscriber** of `C` — i.e. bind `C`'s
  `channelSource` (list it in `channels:`). It does **not** need to *host* `C`'s
  owning context; subscribing to a *published* channel across DUs is the same
  mechanism a cross-DU reactor/projection already uses (the broker is the shared
  fabric; `channelSource.connection` says where it lives).
- **The relay re-publishes a *scoped* view** of the channel's events to
  connected browsers. Hop 1 is trusted backend-to-backend; **hop 2 is the
  authorization boundary** — the relay subscribes each socket only to the
  broker rooms its verified JWT claims permit (tenant + `scope:`), and rejects
  the connection with 403 if `requires:` fails. A browser receives only the
  events for its rooms — see [Subchannels](#subchannels--not-every-browser-gets-every-event).
  The two-hop split is therefore a *feature* (the place scoping happens), not
  just a transport limitation.
- **Phoenix LiveView collapses the two hops** — backend and frontend are one
  process, so it subscribes to the broker and pushes over its own socket with no
  separate relay. A `static` React frontend has no server of its own, so its
  relay *must* be the targeted backend. Two-hop is the general shape; Phoenix is
  the degenerate one-hop case.

**The one obligation the compiler enforces** to make the relay materialize:

> If a UI subscribes to channel `C` (a `channel` param / `on` handler, or a
> cached read it serves), the UI's deployable `targets:` a backend deployable
> that **must** bind `C`. Otherwise `loom.relay-target-not-subscribed` fires:
> *"frontend `webApp` subscribes to channel `Orders.Lifecycle`, but its target
> backend `reportsApi` does not bind it — add a `channelSource` for
> `Orders.Lifecycle` to `reportsApi.channels`."*

That single rule turns the intuited "router" into derived infra: the targeted
backend's broker subscription **is** the upstream, its generated SSE/WS endpoint
**is** the downstream, and the frontend's client points at it automatically.

```ddd
// Cross-DU realtime: A produces, B's UI consumes, B's backend relays.
deployable salesApi  { platform: node;   contexts: [Orders]    // DU X — producer
                       channels: [lifecycleBus]; serves: SalesApi; port: 3000 }
deployable reportsApi{ platform: dotnet; contexts: [Reports]   // DU Y — hosts ctx B
                       channels: [lifecycleBus]    // ← MUST subscribe to relay A's channel to B's UI
                       serves: ReportsApi; port: 8080 }
deployable reportsUi { platform: static; targets: reportsApi   // browser talks only to reportsApi
                       ui: Dashboard { Reports: reportsApi }; port: 3009 }
```

`reportsApi` hosts context B, not A — but binding `lifecycleBus` makes it a
subscriber of A's published `Lifecycle` channel (hop 1) and the SSE/WS relay for
`reportsUi` (hop 2). One channel declared; the edge channel is generated.

#### How rooms are realized — a relay registry, not per-user broker objects

A "room" (e.g. `tenant.X.orders`) is **not an allocated object** — it's a key in
the relay's in-memory connection registry, exactly like Socket.IO rooms,
**Phoenix.PubSub topics**, and **SignalR Groups**. It exists implicitly while a
connection is in it:

- **on connect**, the relay reads the JWT, computes the rooms from the `DataKey`
  scope, and `registry[room].add(conn)` — O(1), torn down on disconnect;
- **on a ticket/event**, it publishes to the **fixed set of scope levels** the
  payload belongs to (`tenant.X.orders` for owner subscribers *and*
  `tenant.orders` for admins) and pushes to `registry[room]`.

**Cost, precisely** (correcting a sloppy earlier phrasing): delivery *is*
per-recipient — you write to each interested socket, so it's **O(recipients)**,
unavoidably. What the room index buys is the *other* two costs: you do **not**
scan the tenant's uninterested connections, and you **never evaluate a predicate
per connection per ticket** (room membership was decided once, at connect). So:
**O(recipients), not O(all tenant connections), and zero per-ticket authz.**

So "a room per user/owner" is just inserting a connection into a hash bucket
keyed by its `DataKey` — what every websocket server already does; Loom merely
*derives* the room key instead of you hand-writing `socket.join("user:"+id)`. The
**durable broker stays coarse** — one stream per resource type, partitioned by
owner key; per-owner rooms live **only at the edge relay**, never as per-user
Kafka topics / SQS queues (which would not scale):

| Layer | Granularity |
|---|---|
| Durable broker (Kafka / Redis stream) | coarse — one stream per resource type, partitioned by owner key |
| Edge relay (holds the sockets) | fine — in-memory rooms keyed by `DataKey`; the per-owner routing |

Horizontal scale across relay instances is the standard **pub/sub backplane**
(Redis / NATS, the Phoenix.PubSub adapter, the SignalR backplane) — the room key
is the routing key there too. No new mechanism.

#### When to scope rooms, and what they route on

Scoped (per-owner) rooms are an **opt-in optimization, not the default** — the
default is the coarse `tenant.<type>` room (everyone in the tenant viewing that
type refetches; active-only + coalescing absorb it). Reach for per-owner rooms
only when the coarse room actually hurts:

| Coarse `tenant.orders` (default) | Per-owner `tenant.X.orders` (opt-in) |
|---|---|
| small / low-traffic tenants | large tenant × high write rate → refetch storm |
| tenant-uniform / admin views (everyone sees all) | per-owner views where most users can't see most changes |
| the "something changed" signal is harmless | the existence/timing side-channel is sensitive |

It's a cost knob, so it's infra (a `realtime:` / per-read opt-in), not something
every read pays for — same stance as `cached: none` being the default.

**What it routes on:** the key is `(resource type, DataKey prefix)`, and **both
sides compute it without any per-ticket policy evaluation**:

- *publish:* the changed aggregate's own owner / `DataKey` path (a field already
  on the row) → ticket room `tenant.X.orders`;
- *subscribe:* the connection's `DataKey` scope from its JWT → joins
  `tenant.X.orders` at connect;
- *match:* prefix containment (realized by publishing to the fixed scope-levels,
  so exact-match registries like SignalR Groups need no prefix scan).

So routing **reuses the visibility key** (`DataKey`, from `authorization.md` /
`tenancy by`) — it is *not* a second routing policy, and the relay never runs
`data { reachable when … }` per ticket; the policy ran once to mint the
`DataKey`, and routing is string-prefix matching on it. The honest limit (the
same discrete-vs-continuous line as parametrized tags): scoped rooms are
derivable only when the view's scope **is** a clean `DataKey`/owner prefix. A view
with an arbitrary filter (`where total > 100`) has no `DataKey` room → it stays on
the coarse type room (or graduates to a projection). The compiler knows which
case a read is in, so it picks the granularity — or warns that a read can't be
scoped and will be tenant-wide.

#### The limit of routing-by-key — and the trilemma behind it

Routing-by-key (`DataKey`, or a generalized `ResourceKey` for owner/team/region)
works **only when authorization is an equality/prefix on a key the resource and
the principal both carry** — then both sides compute the same room string
independently and a match *means* authorized, with no evaluation. **Relationship /
ACL authorization does not reduce to such a key**: "Y may see order 42 because a
`Share(42, Y)` row exists / Y is on the assigned team" — the authorized set is an
arbitrary set in a join table, and no field on the order lets Y compute a
matching room. For that class the key trick fails, and you face an
**information-theoretic trilemma** — you pay the authz cost at exactly one of
three times:

| When you pay | Mechanism | Cost | Use when |
|---|---|---|---|
| **never** (reduce to key) | `DataKey`/`ResourceKey` room; both sides compute it | zero at delivery | authz is equality/prefix on a shared attribute |
| **subscribe-time** (materialize) | per-resource room, membership **= the ACL** (loaded on join, updated when shares change) | at join + on ACL change; delivery O(recipients) | authz changes rarely vs. events (the Slack-channel model) |
| **publish-time** (per ticket) | evaluate "who is authorized for R?" over the **interested** (connected, subscribed) set | per ticket, but only over watchers of R — *not* all users | few watchers per resource (detail views), or rare events |

There is no fourth option. The earlier "zero per-ticket authz" claim is true for
the first row only.

**The escape that makes invalidation always cheap — over-delivery is harmless.**
An invalidation ticket carries **no data**, so routing only needs to be a
*superset* of the authorized set: correctness comes from the **authz'd refetch**,
not the routing. A ticket reaching an unauthorized user just makes them refetch
and get back only their authorized rows — worst case leaked is the faint
"something changed" signal. So **cache invalidation never needs per-ticket authz**
(route on the coarse `tenant.<type>` room, always correct); `ResourceKey` rooms
are a pure *optimization* to cut refetch noise and tighten that signal — opt-in,
and only when the key is expressible.

**Payload delivery (live events) cannot over-deliver**, so for non-prefix authz
it *must* pay — `subscribe-time` (per-resource room, ACL-as-membership, the usual
right choice) or `publish-time` (eval over watchers). Or restrict live-event
payloads to prefix-expressible authz and route everything else through
invalidation + authz'd refetch.

So the rule that resolves the distinction:

| | Routing must be… | Non-prefix authz handled by |
|---|---|---|
| **Invalidation (tickets)** | a **superset** is fine | nothing — coarse room + authz'd refetch; `ResourceKey` only to reduce noise |
| **Live events (payloads)** | **exact / a subset** | per-resource room with ACL-membership, or per-ticket eval over watchers |

"Interested" is *which rooms a connection joined* (its mounted queries /
subscriptions); "authorized" is decided by whichever trilemma row applies —
baked into the key, checked once at join, evaluated at publish, or (for tickets)
deferred to the refetch.

#### Non-cheap routing, concretely — the two rows + the projection escape

**First, the invariant:** all of this is *still* rooms + pushing tickets — change
→ push to a room → members refetch. Cheap routing, A, B, and C differ **only in
how room membership is decided**, not in the transport:

| | How membership is decided | Room keyed by |
|---|---|---|
| cheap (equi) | a label match | the resource's own value (`region:A`) |
| **A** | an explicit authorized set, resolved once at join | the resource itself (`order:42`) |
| **B** | a coarse room + a per-push filter | the type (`orders`), filtered at push |
| **C** | route on a *pre-built list* instead of the raw resource | the **projection's** key (`openOrders:region:A`) |

When the policy is **not** equi-join (relationship / ACL / attribute) *and* you
can't tolerate over-delivery (payload live-events, or zero-leak invalidation), you
leave cheap routing. Both non-cheap rows reuse two Loom-derivable pieces: the
policy compiled to an **in-memory predicate** `maySee(claims, resource)` (the same
policy, as a function rather than SQL), and the **dependency set** (which saves
affect a resource's visibility).

**A. Subscribe-time — per-resource room with authorized membership** (for
*instance / detail* subscriptions):

```
  join:    client mounts order#42 → relay runs maySee(claims, #42) ONCE
           → if true, registry["order:42"].add(conn)
           (a detail page already loaded #42 via the authz'd read → the join rides it)
  deliver: save(#42) → publish "order:42" → all members already authorized → push
           (NO per-ticket authz)
  upkeep:  Share(#42, Z) added → that's a save on the ACL aggregate; its dependency
           set says it changes #42's visibility → ticket "membership:order:42" →
           relay repairs membership (add Z / drop W)
```

This is the Slack-channel / authorized-join model. Cost: O(1) authz per join +
membership repair on ACL change; **no per-ticket authz**. Limit: a **list** can't
join a room per row — use B or C.

**B. Publish-time — relay-side authorized fan-out** (for *lists / collections*
under non-equi authz):

```
  a coarse room ("orders", or a scope room) defines the INTERESTED set
  save(#42) → relay loads #42's authz inputs ONCE (payload-carried, else 1 lookup)
            → for each interested conn:  maySee(conn.claims, #42)?   (in-memory)
            → push to those who pass
```

Cost per ticket: **O(interested) in-memory predicate evals + O(1) resource load** —
bounded by *connected interested* users, not all users, and no DB-per-connection
(load once, check in memory). Requires the authz inputs reachable by the relay.
This is "fan-out-on-read" / authorized edge filtering.

**C. Projection — pay once at write, then route cheap** (the escape for hot /
expensive / many-subscriber cases):

```
  maintain the authorized result per BOUNDED scope (region / team / user) as a
  read model; the projection's own resource key is equi-join-routable → updates
  route by the cheap row-1 rooms. The complicated visibility rule (the part that
  is NOT a simple equality — ranges, relationships, multi-condition) is actually
  evaluated ONCE, when a change updates a list, and only for the item that
  changed — not per read, not per user (fan-out-on-write).
```

Bounded when the scope dimension is bounded (regions/teams); per-user projections
are feasible at moderate user counts. This is the materialized-feed model
(fan-out-on-write, like a timeline). It **converts a non-equi policy back into
cheap routing on the read model's key.**

In plain terms: instead of working out *who may see this* every time something
changes, you keep a **ready-made list per group** — e.g. *Open orders in Region
A* — and keep it current. The complicated rule is checked **once, when a change
updates a list** (and only for the item that changed), not on every read or every
notification. After that, both reading and notifying are trivial because each list
has one simple name (`region-A`) that its group already watches — so you ping that
one room and they refetch a dumb "give me list A." It's exactly a social-media
timeline (prepare the feed at post time vs. compute it at read time), and Loom
already has `projection` to build it. The catch: you now **store and maintain
those lists**, which only stays sane while the number of lists is bounded
(per-region/team fine; per-user-with-arbitrary-sharing is a lot).

**Choosing:** A for instance/detail; B for lists with volatile authz or modest
interest; **C (projection)** for hot lists / expensive policy / many subscribers —
the classic fan-out-on-read (B) vs fan-out-on-write (C) trade, with A the special
case where the resource *is* the subscription unit. Loom can scaffold the choice:
detail → A, equi-join list → row-1 rooms, non-equi list → B by default and C when
flagged hot/wide (`loom.live-wide-dependency`). And recall this whole tier is a
**payload** concern: **invalidation** never needs it — it tolerates over-delivery
and lets the refetch gate (use A/B/C only if the side-channel itself must close).

#### Policies are arbitrary — rooms capture only the equality part

Don't assume authorization is a simple equality. A policy is an **arbitrary
predicate over domain state** — relationships, computed values, and sometimes
time (`shared with me`, `total > 100`, `during working hours`, `while the
subscription is active`). Only the part that's an **equality on a shared key**
(`department == currentUser.department`, a `dataKey` prefix) becomes a **room**;
**everything else is residual** and is just `maySee` (the policy as a function),
evaluated at the **refetch** for tickets or **per-event** for payloads. There's no
special handling per kind of residual — relational, computed, and temporal are all
"evaluate the policy."

| Part of the policy | Handled by |
|---|---|
| equality on a shared key (`department`, `dataKey` prefix) | **room key** (cheap pre-filter) |
| everything else — relational / computed / temporal residual | **`maySee`** — at the refetch (tickets) or per-event (payloads) |

So "orders for my department during working hours" splits: `department` is a room
key; `during working hours` is residual — evaluated by `maySee` like any other
predicate.

**One honest wrinkle with time-dependent policies.** Rooms + tickets are
**save-triggered**, so a policy whose truth depends on the *clock* (not on data)
can flip with **no save to announce it** — at 17:01 nothing was written, so
nothing fires, and an open live view would keep showing access it no longer has.
There is **no general way to compute that boundary**, so the only options are a
**periodic re-check** (re-evaluate on some cadence; interval-granular lag) or a
**per-event `maySee`** (precise, payload-only cost). This is a genuine limitation,
not a feature — there's no elegant mechanism; tickets sidestep it (the refetch
re-evaluates whenever it runs), payloads under a clock-dependent rule don't.

### Subchannels — not every browser gets every event

`broadcast` + `ephemeral` describes the *delivery profile*, **not the
audience**. Pushing every event to every connected browser and filtering
client-side is a data leak: events cross the trust boundary to browsers that
shouldn't see them. So the relay must decide, per socket, **what it may see**
and **what it asked for** — and those are *two different keys*, the distinction
the rest of this section turns on (and the reason the "magic caching" key is the
one to reuse).

The mechanics are the same regardless of keying: a **subchannel** is a
server-derived address (a "room"). Fan-out happens at the broker by room, so the
relay never runs a per-connection predicate, and the browser never names a room
— it presents only its bearer token and the server derives the rooms. That last
point is the security property, and it rides the **existing** auth plumbing,
because an SSE/WS connect is just an authenticated request:

| Backend | Subscriber identity at connect | Room join |
|---|---|---|
| **Hono** | the same verifier middleware on the SSE/WS route; `c.get("currentUser")` from the bearer token | handler subscribes the stream to the rooms it derives — never a client-supplied room |
| **.NET** | `ICurrentUserAccessor.User` on the hub/SSE connection (`UserMiddleware` runs first) | `Groups.AddToGroupAsync(connId, room)` in `OnConnectedAsync` |
| **Phoenix LiveView** | `socket.assigns.current_user`, set in `mount/3` from the session — how a page already authenticates | `Phoenix.PubSub.subscribe(topic)` per derived room |

Anonymous connections get the public/tenant room only, and are rejected outright
if a `requires:` capability gate is set. With that mechanism fixed, the question
is **which** rooms a socket joins — and that needs the two keys below.

### Authorization vs interest — two different keys, not one

Take an **Order detail page** open on order `#42`. Scoping by `customerId`
alone, the socket receives **every event for every order that customer owns**
and throws all but `#42` away in the browser — the fan-out-then-filter leak, one
level down. The reason is that two *genuinely different keys* were collapsed into
one, and **`DataKey` cannot carry both**:

| Concern | Question | Carried by | Shape | Browser can widen? |
|---|---|---|---|---|
| **Visibility / authz** | "May this user see this *at all*?" | **`DataKey`** (tenant + org-hierarchy) + the read-side policy predicate | a path prefix `{tenant}.{parent}.…` | **No** — JWT-pinned |
| **Interest** | "Which data does *this page* want?" | the **query key** (React Query) | `["orders"]`, `["orders", 42]`, `["orders","find","mine",args]` | Yes — it's the page's own choice |

`DataKey` answers visibility, tenant- and org-wise. It says **nothing** about
*which order* a page is looking at — that's the query key's job, and the query
key is also the cache key and the invalidation key. **That is exactly why the
"magic caching" connection is the right one**: interest is not a new channel
concept, it's the query key the frontend already emits and the (future) cache
already keys by.

So a detail page needs **both keys**, doing two different jobs:

```
room address  =   {tenant}                :   ["orders", 42]
                  └ isolation namespace ─┘     └ interest = the query key ┘
                   (leftmost DataKey seg)       (what the page subscribed to)

admission     =   may currentUser read ["orders", 42]?   <- the SAME read-side authz
                  (DataKey reachability / row filter / policy data { reachable when })
```

- **Interest (routing) is the query key**, verbatim — `Order.byId(42)` →
  key `["orders", 42]`; `Order.all` → key `["orders"]`;
  `Order.mine()` → key `["orders","find","mine",…]`. The page already
  names it (it's the React Query key), so **nothing new is declared** on the
  channel or the page.
- **Tenant** is the hard namespace prefix on the room so keys can't collide or
  leak across tenants (order 42 in tenant A ≠ tenant B). It's the leftmost
  `DataKey` segment, JWT-pinned.
- **Finer visibility** (per-customer, per-org-node, per-user) is **not** in the
  room address — it's an **admission check at subscribe time**: "may this user
  read `["orders", 42]`?" is the *same* predicate that gates `GET /orders/42`
  (DataKey reachability / the row filter / the policy `data { reachable when }`).
  Pass → join the room; fail → 403, exactly as the REST read would 403/404.

This is why `customerId` was the wrong thing to put in the address: per-user
visibility is an *admission predicate you already have*, while the *address* is
the *interest* — the query key. `key:`/`scope:` on the channel drop back to what
they actually are: `key:` is the broker **partition/ordering** key (Kafka), and
an explicit `scope:` is only the flat fallback for non-hierarchical ownership
when there's no `DataKey`. Neither carries interest.

> **Don't redefine the key — reuse what authorization already pins.** The
> visibility prefix is `DataKey` (`authorization.md` §2): a materialized path
> `{rootTenantId}.{parentId}.…` on `currentUser.dataKey`, built so reachability
> is prefix arithmetic. The leftmost segment is the `TenantId` multi-tenancy
> auto-stamps. Channels neither define nor extend it — they read it for the room
> namespace and the admission check, identically to the read path.

### Realtime is not one feature — the delivery planes

"Realtime" is not a single mechanism. The planes below differ on every axis;
this proposal (messaging/transport) owns the **delivery** of planes 2–5, while
plane 1 and everything about read-freshness live in the companion proposal
the **Reads & caching** part below.

| # | Plane | Room keyed by | Payload | Source | Home |
|---|---|---|---|---|---|
| 1 | **Cache invalidation** | resource (type / id) | **ticket** (no data) | implicit `save` | the **Reads & caching** part below |
| 2 | **Live view / feed** (dashboard) | resource / topic | **event data** | explicit `emit` | this doc (delivery) |
| 3 | **Targeted notification** | **recipient** (user id) | event data | explicit event | this doc (delivery) |
| 4 | Presence / typing (deferred) | topic, ephemeral | ephemeral | not events | — |
| 5 | Job / progress (deferred) | correlation id | progress | extern / job | — |

Planes 1 and 2 are **opposites** — ticket vs payload, implicit vs explicit,
over-broadcast-safe vs must-be-scoped — so they do not share a mechanism. The
**addressing mode** (resource / recipient / topic / correlation) is the
realtime-layer analogue of `delivery`×`retention`.

**A live read is not the same thing as a live event feed.** A **live read** —
a cached on-screen query kept fresh by `save`-driven invalidation — needs no
marker and carries tickets, not data; its semantics live in
the **Reads & caching** part below. Showing the *events themselves* — a feed of
"Order #42 shipped", a toast — is a **live event** (plane 2/3): subscribe to an
event channel and render its payloads, here. Rule of thumb: persisted state →
cached query (caching); ephemeral event stream → event subscription (this doc).
And most "show events" UIs are actually a cached read over a persisted log table.

The split this proposal turns on: **who may *receive* a pushed event** is
delivery scoping — the [Subchannels](#subchannels--not-every-browser-gets-every-event)
and [Authorization vs interest](#authorization-vs-interest--two-different-keys-not-one)
sections above (visibility = `DataKey`, rooms, subscribe-time admission). **What
*changed* and how reads stay fresh** — interest = the query key, invalidation
tickets, the event→query-keys map, surrogate-key HTTP caching, dependency-set
tagging, the cache tier — is the *read-freshness* concern, fully developed in
the **Reads & caching** part below. The two proposals share **one key vocabulary** (the
resource key for *what changed* + `DataKey` for *who may see it*), defined once
and reused on both sides.

> **Read-side summary** (see the **Reads & caching** part below for the full design):
> a cached on-screen query is auto-invalidated: a `save` publishes an
> *invalidation ticket* (not data) for the affected query keys; the client
> refetches through the already-authorized read (so per-user filtering never
> enters the push layer); the *same* ticket evicts the server cache and purges
> CDN surrogate keys. Caching is invalidation-based (cache hard, purge exactly),
> tag sets are derived dependency sets (joins/lists key by type, wide sets
> graduate to a `projection`), and the cache tier is chosen by the read's authz
> shape (per-user reads cache in-handler below the gate, not in OutputCache).

## Runtime — the moving parts, end to end

How it actually *runs*, concretely. Five components:

```
  WRITE backend (hosts the context)              RELAY backend (holds the sockets)        BROWSER
  ┌─────────────────────────────┐    broker      ┌──────────────────────────────┐  SSE/WS ┌────────────┐
  │ aggregate.save(order#42)     │  (Redis/Kafka/ │ connections: connId→{claims,  │◀───────▶│ React Query │
  │  → DomainEventDispatcher     │──in-proc)─────▶│   rooms, socket}              │         │ + realtime  │
  │  → publishRoomsFor(#42)      │  ticket /room  │ rooms: roomKey→Set<connId>    │         │ client      │
  │  → publish ticket to rooms   │                │ onTicket(room): push members  │         └────────────┘
  └─────────────────────────────┘                │  (+ optional per-push filter) │
                                                  └──────────────────────────────┘
  authorized READ endpoint (the gate) ◀────── refetch GET /orders (authz'd WHERE) ─────────┘
```

**Generated at compile time** (from the policy + read/view ASTs) — no policy is
interpreted at runtime, it's compiled into these:

| Generated | From | Used by |
|---|---|---|
| `publishRoomsFor(Type, after, before)` → room keys | policy equi dimensions (dataKey ancestors, dept, region) + instance + before-image | dispatcher |
| `roomOf(queryKey, claims)` → room key | same, mirrored | the **client** |
| `maySee(claims, resourceFields)` → bool | the full policy as an in-memory predicate | relay (B filter / A join check) |
| `invalidates: tag → queryKeys[]` | read/view dependency sets | the client |
| before-image field set | which fields are room keys | the save path |

**One request, traced:**

```
① CONNECT   verify JWT → claims { tenantId:t.acme, dataKey:t.acme.dept.D, dept:D, regions:{A}, perms }
            relay: connections[c1] = { claims, rooms:∅, socket }
② SUBSCRIBE mount useQuery(["orders"]) → client: room = roomOf(["orders"],claims) = "t.acme.dept.D:orders"
            → {join:room} → relay asserts room ∈ roomsDerivableFrom(c1.claims)   ← structural join authz
            → rooms[room].add(c1)
③ WRITE     save(order#42)[dept:D,region:A,dataKey:t.acme.dept.D,status:open]
            dispatcher: publishRoomsFor = ["t.acme.dept.D:orders","t.acme:orders","t:orders",
                                           "orders:region:A","orders:42"]  (+ OLD-value rooms if a key field changed)
            ticket {tag:"orders",id:42}  (no payload) → broker.publish(room, ticket) for each
④ ROUTE     broker → relays subscribed to those rooms (backplane if sharded)
            relay.onTicket(room): for c in rooms[room]:
                if residualFilter && !maySee(c.claims,#42fields): continue   ← option B (status/region residual)
                c.socket.send(ticket)
⑤ DELIVER   client.onTicket({orders,42}) → qc.invalidateQueries(["orders"])  (list + [orders,42] + finds)
            active query → refetch GET /orders → WHERE <full policy> (dept=D AND status=open AND withinHours()) ← GATE
            → only rows c1 may see → re-render
⑥ AMBIENT   that read also returned { validUntil: 17:00 } → client setTimeout(refetch, 17:00−now)  (clock re-check)
   on unmount → {leave:room} → relay drops c1 from rooms[room]
```

**The split that makes it tractable:** compile time turns the policy into three
small functions (`publishRoomsFor`, `roomOf`, `maySee`) + the invalidation map +
the before-image set; runtime is then cheap and dumb — the dispatcher computes
room keys from the resource's own fields (O(1)), the relay is two hash maps + a
push loop (O(recipients), optional in-memory `maySee` filter), the client is a
query-cache hook + `invalidateQueries` + a couple of timers; and **the gate is
always the refetch** — rooms/`maySee` only decide *who to nudge*, the authorized
read's `WHERE` decides *what they get*, every time.

**This is the router.** `publishRoomsFor` (addressing — derive the destination
rooms from the resource's own fields) + `roomOf` (the subscribe-side address —
derive from verified claims) + the relay (the routing table `room→{connections}`
and the forward) together *are* a content-and-identity-derived publish/subscribe
router — the shape of a RabbitMQ topic exchange / NATS subject routing. The one
twist: **both addresses are *derived*, not chosen** — the publisher can't
mis-address (room computed from the resource), the subscriber can't forge one
(room computed from the JWT), and they match exactly when the policy says so,
because **the address-derivation *is* the compiled authorization policy**. There
are two stacked routers — the **broker** (backbone, between backend processes, by
room key) and the **relay** (edge / last-mile, room key → sockets) — both fed by
`publishRoomsFor`. So "the router" the realtime topology needs is not hand-wired
rules: it's **two generated addressing functions + one stock relay component +
the broker**, which is exactly why it can be a derived DSL feature rather than
per-app plumbing.

**The relay is off-the-shelf — Loom generates only the derivation layer.** A relay
is "a websocket/SSE server with rooms + a backplane," one of the most well-trodden
pieces of infrastructure there is, and for two backends it is *native*:

| Backend | Relay primitive (rooms + backplane) |
|---|---|
| **Phoenix** | **Phoenix Channels / `Phoenix.PubSub` / Presence** — topics = rooms, PG/Redis adapter = backplane. *This is the relay.* |
| **.NET** | **ASP.NET SignalR** — `Groups` = rooms, Redis backplane (`AddStackExchangeRedis`) = scale-out. In-box. |
| **Hono / Node** | **Socket.IO** (rooms + `@socket.io/redis-adapter`), or a sidecar / managed service |

Turnkey / managed options if you don't self-host: **Centrifugo** and **Mercure**
(open-source; the **JWT carries the channels/topics you may subscribe to** —
almost exactly this proposal's "subscription pinned by the verifier"),
**Supabase Realtime** (ties **RLS policies to channels** — "the policy *is* the
routing", productized), **Pusher / Ably** (capability-token channel auth),
**Azure SignalR Service**. So Loom does **not** build a connection registry, room
index, or backplane — those are exactly what these provide. It generates
`roomOf` / `publishRoomsFor` (from the policy) and the connect-time "join my
allowed rooms" + `save → publish` glue, and **wires them to the platform's native
relay** (or a sidecar). The novel infrastructure surface is ~zero.

### Prior art — and what to build on vs. build

**The layer matters.** Loom's "something changed" signal is a **domain event at
the application write seam** (`repo.save` / `emit` → `DomainEventDispatcher`) — it
is **DB-agnostic** (same over Postgres / MySQL / in-memory, across all backends),
**domain-semantic** ("OrderShipped", not "row in `orders` changed"), and needs
**no change-data-capture** (Loom owns the write, so it already knows). So the
existing solutions worth building on are the ones at *that* layer — **you publish
the event, they route it** — not the ones that watch the database.

**Fit — application-layer pub/sub routers** (DB-agnostic; fed by the dispatcher):

| Tool | |
|---|---|
| **NATS** | subjects + wildcards; JetStream for durability |
| **Centrifugo** (OSS) | channels, **JWT subscription tokens**, proxy-authorized subs, presence |
| **Mercure** (OSS) | SSE hub; **JWT carries the topics you may subscribe to** |
| **Ably / Pusher** (managed) | capability / auth-callback channel routing |
| **MQTT brokers** (EMQX / Mosquitto / HiveMQ) | topic trees + wildcards + ACLs |
| **Phoenix Channels / ASP.NET SignalR / Socket.IO** | the platform-native relays — `broadcast` to a topic/group |

These take a domain event you hand them and fan it to authorized subscribers;
none knows or cares about your database. That's the fit: **dispatcher publishes a
domain event → an app-layer router fans it to authorized subscribers → clients
refetch through the authorized read.** The DB appears only at the very end,
*behind* the authorized read, as where the refetch gets its data — incidental,
not the mechanism.

**How the generated authz plugs in (Centrifugo as the worked example).** A
turnkey relay owns connections/rooms/fan-out but not your rules, so it exposes a
seam for *your* authorization — and that seam is exactly where Loom's generated
policy goes. Centrifugo offers two, matching our cheap-vs-non-cheap split:

- **token** — your backend signs a JWT listing the channels the user may join.
  Loom fills it from `roomOf(claims)` (the equi-join / `dataKey` rooms) — no
  per-subscribe callback. Fits the cheap case.
- **subscribe proxy** — on *each* subscription attempt Centrifugo calls your
  backend over HTTP/GRPC ("may user U subscribe to channel X?"); your endpoint
  runs the policy live and returns allow/deny. This is the **trilemma's
  subscribe-time authorization (option A) as a product feature** — Loom generates
  that endpoint (the compiled `maySee`); Centrifugo does everything else. Fits the
  relationship/ACL/dynamic case.

So integration is: **Loom emits the channel-list-in-JWT and/or one
`may-subscribe?` endpoint; the relay owns the rest.** (Ably/Pusher have the same
shape via capability tokens + an auth-callback; SignalR/Phoenix authorize in the
hub/`mount`.) The relay is bought; only the policy check is generated.

**Note the subscribe proxy authorizes *once, at subscribe* — there is no
per-event check.** After a member joins, every message on the channel is fanned
out unconditionally. This is sound **only if the channel is a unit of *uniform*
visibility** (everyone who may subscribe may see every message on it) — which is
exactly what correct room granularity (`publishRoomsFor` keyed by the equi-join /
`dataKey` / per-resource key) guarantees. Channel relays do **not** filter
per-subscriber *within* a channel (the publish proxy authorizes a publisher, not
per-recipient delivery) — so heterogeneous-within-a-channel visibility isn't the
channel model. For the **resource/identity** dimension the fix is not a per-event
check but **finer, uniform rooms** (the per-event decision lives in
`publishRoomsFor`'s *room selection*, not in per-recipient filtering); where the
residual can't be roomed, fall back to **tickets + authz'd refetch**
(over-delivery is safe) rather than push a payload through a non-uniform channel.
So for that dimension the channel relay is an **option-A machine** — no per-event
check.

**The residual policy, and the time wrinkle.** Subscribe-time auth only covers
what the room key captures (the equality part). The **residual** policy — the
arbitrary rest (relational, computed, temporal) — is evaluated by `maySee`: at the
**refetch** for tickets, **per-event** for payloads. Two practical notes: push as
much of the policy into room keys as you can, so per-event `maySee` runs only on
the residual over the room-narrowed candidates; and for tickets you skip
per-event `maySee` entirely — over-deliver a payload-free ticket and let the
authz'd refetch apply the full policy. The one wrinkle is a **time-dependent**
residual: its truth can flip with **no save**, so neither the room nor a
save-ticket catches 17:01 — you either re-check on a cadence (coarse; a short
token TTL + refresh, which Centrifugo/Ably do off-the-shelf) or `maySee` per event
(precise, payload-only). No general boundary-compilation, no elegant fix; tickets
sidestep it because the refetch re-evaluates whenever it runs.

**On over-sending — rethink whether lists should be live at all.** Tickets are
cheap but not free, and **list views are where over-sending bites** (broad rooms,
many subscribers, frequent changes → many refetches). The fix is a *product*
judgment, not a mechanism: **don't default lists to live** — most are fine with
refetch-on-focus / on-navigation or a sane poll, with no realtime and no
over-sending. Reserve live lists for where realtime genuinely pays (dashboards,
work queues, collaboration), and there room them as tightly as the roomable
dimensions allow (per-owner/per-scope, never tenant-wide). Detail views and
counters (one resource, one room) are the cheap, usually-worth-it live cases;
broad live lists usually aren't.

**Different architecture — DB-coupled sync engines** (note them, but they're the
wrong layer here): **Supabase Realtime** (Postgres-changes/RLS), **ElectricSQL**
(Postgres shapes), **PowerSync** (sync rules over Postgres/Mongo), **Rocicorp
Zero**, **Convex**. These solve a similar-*looking* problem from the **database
up** — watching the WAL / owning the data layer and syncing rows. They couple to a
specific DB and bypass the domain layer, so despite the surface resemblance they
don't fit a DB-agnostic, domain-event-driven model. (Their *Broadcast*-style
generic pub/sub features, where present, reduce to the app-layer routers above.)

So: build on an **app-layer pub/sub router** (NATS / Centrifugo / Mercure / the
native relays), fed by the dispatcher; reach for a sync engine only if you're
willing to make the database the source of truth for change capture — which this
design deliberately is not.

### Optimizing the per-event routing — the part that *isn't* the relay

The relay is bought; the **per-event routing computation** — `publishRoomsFor`
(which rooms does this change touch?) and, for payloads, the per-push `maySee`
filter — is the custom hot path. It's rich in optimizations, and the leverage is
that **most are compiler-derivable** (Loom has the dependency sets, the dimension
selectivity, and the target broker's capabilities), so they ship as generated
code, not per-app tuning:

- **Dead-room skip.** Don't publish to a room with no subscribers; the relay knows
  which rooms are live, so per-event publish cost ≈ O(*live* rooms touched) — near
  zero when few are connected.
- **Irrelevant-save skip.** If the changed fields are neither a room key nor in
  any cached read's dependency set, emit **no ticket** (the dependency sets are
  already computed).
- **Wildcard subscription vs publish-to-ancestors.** On brokers that support it
  (NATS `>`, Redis `PSUBSCRIBE`, MQTT `#`) publish once to the leaf and let
  subscribers match ancestors — kills the O(depth) fan-out; exact-match brokers
  (Kafka / SignalR / Phoenix.PubSub) keep publish-to-levels.
- **Coalesce per transaction.** Dedupe rooms; one publish per room per flush.
- **Invalidation needs no per-push check at all** — over-deliver the payload-free
  ticket, the refetch gates. `maySee`-at-relay is a **payload-only** cost; and
  even then, load the resource's authz inputs **once per event** and check the
  (already room-narrowed) connections in-memory, memoized — never a DB query per
  connection.
- **Move it off the hot path** — a `projection` (C) pays the routing complexity at
  write-time and routes cheap after; selectivity-tier the rooms (room only the
  high-selectivity dimensions); start coarse and split a room only when its
  fan-out is measured to hurt.

This is the part that's genuinely Loom's to get right — and the argument for
*generating* it: the optimal choice ("room on region? skip dead rooms? NATS
wildcards?") is **workload-dependent** (write rate × connections × policy shape),
so the compiler emitting a sensible default + knobs beats every team re-deriving
it by hand.

## IR, lowering, enrichment (phase mapping)

Following the `view`/`criterion`/`workflow` vertical-slice recipe:

```ts
// src/ir/types/loom-ir.ts
export interface ChannelIR {
  name: string;
  owningContext: string;             // the context this channel is declared in (carries its events)
  carries: string[];                 // event type names (resolved, this context's published events)
  delivery: "broadcast" | "queue";
  retention: "ephemeral" | "log" | "work";
  key?: string;                      // broker partition / ordering key (Kafka) — NOT interest
  scope?: ExprIR;                    // OPTIONAL flat per-owner VISIBILITY when there's no DataKey hierarchy
  requires?: ExprIR;                 // capability gate evaluated at connect (reuses requires lowering)
  // NO realtime/transport field — the contract is wire-agnostic.
}

// TWO orthogonal keys (see "Authorization vs interest — two different keys").
// This proposal owns the DELIVERY half:
//
//   VISIBILITY — `DataKey` from authorization.md (tenancy = segment 0). Answers
//   "may this principal RECEIVE this pushed event?". JWT-pinned. Reused, NOT
//   redefined. Serves as the room's isolation namespace + the subscribe-time
//   admission predicate (the same read-side authz that gates GET /orders/42).
//
//   INTEREST — the React Query key (what changed / what to refetch). Defined and
//   used in Part II (cache key = invalidation key = room-routing key). The
//   delivery side only needs the resource room; the client maps it to its query
//   keys. So `InvalidationRuleIR` / `QueryKeyIR` live in Part II, not here.
//
// ChannelIR gains (derived in enrich):
//   visibility: DataKeyRef   — room namespace + admission, from authorization.md (reused)
// stored on BoundedContextIR.channels: ChannelIR[]  (sibling of events / views)
export interface ReactorIR {
  event: string; param: string;
  channel?: string;                  // resolved channel name (or derived)
  body: StmtIR[];                    // SAME shape as WorkflowIR.body — reuse the lowerer
}
export interface ProjectionIR { /* target read model + per-event fold (reuse ApplyIR) */ }
export interface ChannelSourceIR { channel: string; storage: string; }
// DeployableIR += channelNames: string[]
//             += realtimeWire?: "sse" | "websocket"   // infra override; defaulted by PlatformSurface
```

- **⑤ lower** — `lowerChannel` (structural, in `lower.ts`); `lowerReactor`
  delegates to the **existing workflow body lowerer** in `lower-stmt.ts`
  (`e` bound as a `param` ref typed by the event). `projection` reuses the
  applier fold lowering. `scope:`/`requires:` lower through the *same* path as
  a `find … where` filter and an operation `requires` — no new expression
  machinery.
- **⑥ enrich** — derive each event's *routing set* (channels carrying it) and
  attach it to the publish side, so the dispatcher emitter knows where each
  `emit` goes; and each channel's **visibility** `DataKey` ref (room namespace +
  subscribe-time admission). For *delivery*, a pushed event goes to the resource
  room `{tenant}:{resource}` and the relay joins a socket to the rooms its claims
  admit. (The *what-to-refetch* map — `InvalidationRuleIR`, `save`-driven — is enriched in
  Part II, reusing this same routing seam.) Derive, per frontend deployable,
  the resolved realtime wire (`realtimeWire` override ?? `PlatformSurface`
  default) and the set of channels its pages subscribe to (live events) or read live (cached queries). Sibling of the
  existing `migrationsOwner` enrichment.
- **⑦ validate** — the `loom.channel-*` / `loom.reactor-*` /
  `loom.channelsource-*` cross-cutting checks above (needs the fully-resolved
  routing graph, so it lives in phase ⑦ like the eventSourced-discipline
  check).
- **⑨ compose** — emit `.loom/asyncapi.yaml` from `ChannelIR` (replacing the
  per-event synthesis the BC-model placeholdered); add broker services
  (Redis/Kafka/RabbitMQ) to `docker-compose.yml` for every bound
  `channelSource`, alongside the existing Postgres service wiring.

**No target-backend IR.** Every backend consumes `ChannelIR` directly, per
the architectural invariant.

## Generated code, per backend (anchored on the existing seam)

The publish side already drains through `DomainEventDispatcher` /
`IDomainEventDispatcher` — **the entire Phase-1 publish path is "give that
hook a real, channel-driven implementation."** Producer code is untouched.

| Backend | Publish (dispatcher impl) | Consume (`on` reactor) | Realtime (relay + rooms) |
|---|---|---|---|
| **Hono** | `DomainEventDispatcher` that fans an event to each carrying channel's driver: in-proc `EventEmitter` / `ioredis` pub/sub / `kafkajs` producer / `amqplib`. Publishes to the resource room `{tenant}:{resource}`. | per-channel subscriber loop → reuses the generated **workflow handler** for the reactor body; `queue` ⇒ consumer-group / `BLPOP`; ack on success. | `streamSSE` / `ws` endpoint; on connect runs `requires:` (403 on fail) and joins the socket **only** to the rooms computed from `currentUser` claims — never a client-supplied room. |
| **.NET** | `IDomainEventDispatcher` → in-proc MediatR notification / MassTransit publish (Redis/RabbitMQ/Kafka transport) — DI-registered like the existing `AddScoped` repos. Publishes to the resource room. | `IConsumer<T>` / `INotificationHandler<T>` invoking the reactor's Mediator command (same handler the workflow controller calls). | SSE (`text/event-stream`) or a SignalR hub; SignalR **Groups** *are* rooms — `Groups.AddToGroupAsync(conn, roomFromClaims)` after the `ICurrentUserAccessor` auth gate. |
| **Phoenix LiveView** | `Phoenix.PubSub.broadcast(topic)` (ephemeral) / Broadway + Oban (durable), where `topic` is the room. | a `GenServer` `handle_info` running the reactor body as a plain context function. | **native** — `subscribe` to the room topic derived from `socket.assigns.current_user`; `handle_info` re-assigns the stream. Rooms are just PubSub topics. |
| **React** (consumer of realtime) | — | — | generated SSE/WS client; connects with its bearer token (server derives rooms). For *plane-1 invalidation* refetch semantics (`invalidateQueries`), see the **Reads & caching** part below. |

## Worked example (end to end)

```ddd
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order { customerId: Customer id; status: OrderStatus; placedAt: datetime }
      repository Orders for Order {}
      event OrderPlaced  { order: Order id, at: datetime }   // context-level ⇒ published
      event OrderShipped { order: Order id, at: datetime }
      workflow placeOrder(customerId: Customer id, at: datetime) {
        let o = Order.create({ customerId, status: Placed, placedAt: at })
        emit OrderPlaced { order: o.id, at }                 // producer — unchanged
      }

      channel Lifecycle {                                    // context member, beside its events
        carries: OrderPlaced, OrderShipped
        delivery: broadcast           // ⇒ a UI may subscribe (live events / live reads); wire is infra
        retention: log                // durable, replayable
        key: order
      }
    }
  }
  subdomain Fulfilment {
    context Shipping {
      aggregate Shipment { order: Order id; status: ShipStatus }
      repository Shipments for Shipment {}
      on(e: OrderPlaced) via Orders.Lifecycle {             // reactor (choreography)
        let s = Shipment.create({ order: e.order, status: Pending })
      }
    }
  }

  storage eventLog { type: kafka }
  channelSource lifecycleBus { for: Orders.Lifecycle, use: eventLog }

  api SalesApi from Sales
  ui WebApp {
    api Sales: SalesApi
    channel Orders: Orders.Lifecycle
    page Board { route: "/board"
      body: For { Sales.Order.all, o => Card { o.id, o.status } } }   // cached query, auto-fresh
  }

  deployable salesApi  { platform: node; contexts: [Orders];   serves: SalesApi
                         dataSources: [ordersState]; channels: [lifecycleBus]; port: 3000 }
  deployable shipApi   { platform: dotnet; contexts: [Shipping]
                         dataSources: [shipState]; channels: [lifecycleBus]; port: 8080 }
  deployable webApp    { platform: static; targets: salesApi
                         ui: WebApp { Sales: salesApi }; port: 3002 }
}
```

What the reader gets from a single declaration: the `channel` tells you the
events, delivery, and durability (no wire protocol); the `ui` read binding tells
you the board observes it; the `channelSource` tells you it's Kafka; the
`deployable channels:` tells you who's wired in. The `webApp` names no
`realtime:`, so it defaults to SSE — and the `compose` step provisions a Kafka
service and an SSE endpoint, neither named in the contract.

## Slice plan (incremental, dispatcher-first)

Each slice is independently shippable and testable, mirroring the storage and
workflow slice trails.

1. **`channel` + `channelSource` surface** — grammar, scope, IR, the
   `loom.channel-*` / `channelsource-*` validators, `.loom/asyncapi.yaml`
   from `ChannelIR`. No runtime change. (One parse test, one negative
   validator test, one IR test.)
2. **In-process transport** — implement `DomainEventDispatcher` to route by
   the enriched routing set; `delivery: broadcast`/`ephemeral` only;
   in-process registry of `on(...)` reactors reusing the workflow handler.
   Hono + .NET. (`LOOM_TS_BUILD` / `dotnet-build` gates.)
3. **Redis transport** — `channelSource use: redis`; pub/sub (`broadcast`)
   and `BLPOP`/streams (`queue`); compose service. Per-backend driver.
4. **UI realtime delivery (the wire + edge relay)** — derived SSE/WS endpoint,
   the two-hop edge relay, room subscribe with subscribe-time admission;
   `realtimeWire` defaulting on `PlatformSurface`. The *push transport*; what a cached on-screen
   query does on receipt (refetch/patch) is slice 1 of
   the **Reads & caching** part below. (`LOOM_REACT_BUILD`.)
5. **Plane 2/3 — live view + notification** — explicit `emit`, payload-carrying,
   addressing mode resource/recipient/topic; subscribe-time scoping; delivery to
   the browser. The explicit "live dashboard"/notification feature. (Plane 1,
   invalidation, is the **Reads & caching** part below.)
6. **Phoenix-native realtime + WebSocket override** — `Phoenix.PubSub` (rooms =
   topics) + LiveView `handle_info`; the optional `deployable realtime:
   websocket` infra override. (`LOOM_PHOENIX_BUILD`.)
7. **Kafka + `retention: log`** — durable streams, partition by `key`,
   `projection` replay-from-cursor. (`LOOM_E2E`.)
8. **RabbitMQ / `queue` + `work`** — competing consumers, ack semantics.

## Deferred / out of scope

The model unifies the *programming surface*; it deliberately does **not**
paper over operational guarantees that genuinely differ between brokers —
the same honest line NATS draws.

- **Request/reply (reply-subject).** Synchronous `api` already covers RPC; an
  async `ask`/reply correlation knob is a later add if empirical pressure
  appears.
- **Exactly-once / cross-stream transactions.** Not unified. The outbox
  pattern (at-least-once + idempotent reactors) is the v1 guarantee; Kafka
  transactional EOS is a per-backend opt-in, not a portable contract.
- **Per-message leasing vs partition ordering.** Loom picks **partition-key
  ordering** (the `key:` knob) as the portable default; per-message leasing
  (SQS/PubSub-style) is exposed only when bound to a transport that offers it.
- **Schema versioning of carried events.** Inherits the BC-model's Level-1
  (convention + `.loom/asyncapi.yaml` diff) stance; Level-2/3 deferred there.

---

# Part II — Reads, freshness & caching

## Reads & caching — TL;DR

Loom is the rare system whose origin **knows exactly when data changes** (every
`repo.save` and every `emit` flow through one seam). That single fact flips
caching from **expiration-based** (TTL, guess, revalidate) to
**invalidation-based** (cache forever, purge the instant it changes) — aggressive
caching with zero staleness. The hard half of caching, *knowing when to bust*, is
already built by the messaging tier.

The whole design rides on **two keys that do different jobs** — the same split
the channels part draws for delivery:

| Key | Question | Carried by | Used for |
|---|---|---|---|
| **Interest** | "Which data does this read want?" | the **React Query key** (`["orders",42]`) | the cache key, the invalidation key, and the realtime room — *what changed* |
| **Visibility** | "May this principal see it?" | **`DataKey`** (tenant + org reachability) | the cache *partition* and the *tier* the cache may live on — *who may share* |

One derived artifact ties it together — the **save → query-keys map** (which
cached queries a change invalidates). The server cache evicts by it, the CDN
purges by it (surrogate keys / cache tags), the realtime layer routes by it, and
the React Query client invalidates by it. **One key vocabulary, four consumers,
all by prefix.**

## Background — how this design was reached

This proposal and the channels part were derived together over a long design
discussion; this section is the condensed trail so the decisions don't read as
arbitrary.

1. **Start:** a "good queueing abstraction (websockets too)." → the `channel`
   transport tier (the channels part): events already publish through a pluggable
   dispatcher; what was missing was the contract + transport + consumer.
2. **Realtime to the UI** raised "who gets which events?" → scoping. First
   attempt overloaded one `scope:` predicate.
3. **Realisation 1 — realtime is not one feature.** Cache-invalidation and a
   live dashboard are *opposites* (ticket vs payload, implicit-`save` vs
   explicit-`emit`, over-broadcast-safe vs must-be-scoped). They must not share a
   mechanism → the **planes** taxonomy (the channels part).
4. **Realisation 2 — two keys, not one.** `DataKey` is **visibility** and carries
   *no* interest; the **query key** is interest and is *also* the cache key and
   invalidation key. Conflating them was the root error.
5. **Realisation 3 — the magic-caching link.** Because interest *is* the React
   Query key, realtime cache-freshness and cache-invalidation are the **same mechanism**:
   a change publishes an invalidation ticket for the affected query keys; the
   server cache evicts them and every live client refetches through the already
   authorized read. → **invalidation rides `save`** (type+id always known), not
   events (event→aggregate isn't always derivable).
6. **Realisation 4 — the list key is a client identity, not a server room.** A
   list is a per-user, per-filter projection; the server can't enumerate which
   list keys an event touches. So the **server keys rooms/tags by *resource***;
   the client does React Query **prefix invalidation** locally. Per-user list
   filtering never enters the push/invalidation layer.
7. **Realisation 5 — invalidation-based HTTP caching.** Knowing exactly when to
   bust means surrogate-key / cache-tag purging (Fastly/Cloudflare/Varnish) at
   the edge and tag-eviction in the server cache, all on the same key.
8. **Realisation 6 — multi-source reads key by a *dependency set*.** A joined or
   25-aggregate read is tagged with the **union** of its source resource tags;
   any source's `save` busts it. Too-wide sets graduate to a **projection** (its
   own single key) — not a new cache mode.
9. **Realisation 7 — auth decides the cache *tier*.** If auth runs in the
   handler pipeline (below the controller), an HTTP/output cache *above* it would
   bypass the gate. So per-user reads must cache **below the gate**, keyed by the
   authorized effective scope; output/edge caching is a public/tenant-only
   optimization.

### Decisions that emerged (candidate D-tags)

| Tag | Decision |
|---|---|
| **interest = query key** | The cache/invalidation/realtime-routing key is the React Query key (resource + params), *not* `DataKey`. |
| **visibility = `DataKey`** | Who-may-see is `DataKey`/tenant, reused from `authorization.md`; it partitions the cache and selects the tier, never carries interest. |
| **invalidation rides `save`** | Cache freshness is driven by the implicit per-aggregate change signal, not by declared domain events. |
| **server keys by resource** | Rooms/tags are keyed by resource (type/id); clients fan out to their own query keys via prefix invalidation. |
| **two cache modes only** | `cached: none` (default) and `cached: tagged`. A projection is a *read*, not a cache mode. |
| **cache tier ← authz shape** | public/tenant → edge/output cache; per-user → in-handler read-through below the auth gate. OutputCache is not the primary mechanism. |
| **invalidation channel: total coverage, explicit binding** | Coverage of the save-derived invalidation stream is automatic/total (correctness); but it is a synthesized, *nameable* `<Context>.changes` channel bound and consumed explicitly via the normal `channelSource` / `deployable.channels` machinery. |

## Live reads vs live events — two different things

These are easy to conflate and must be kept apart; this proposal owns only the
first:

| | **Live read** (this doc) | **Live event** (the channels part, plane 2/3) |
|---|---|---|
| What's shown | *current state* — a query result that stays fresh | *the events themselves* — a feed of "Order #42 shipped", a toast |
| UI construct | **an ordinary cached query** (`cached: tagged`); no special marker | **subscribe to an event channel**, render its payloads |
| Fed by | the **invalidation stream**, derived from **`save`** (any state change) | the **event channel** (`channel { carries: OrderShipped }`), driven by **`emit`** |
| Payload | **ticket** (no data) → client refetches the authorized read | **event data** (rendered directly) |
| Backed by | **persisted** state (a table / view) | often **ephemeral** (transient notification, presence) |

A live read is therefore not a special query — it's **a cached query that's
on-screen while the client receives invalidation signals** ("live" is emergent;
see "Automatic invalidation" below). Displaying the event stream itself is the
*separate* live-event construct in the channels part (plane 2/3), which carries event
payloads and is scoped at delivery. The boundary is simply: **is the displayed
thing persisted state or an ephemeral event stream?** Persisted → a cached query
(here); ephemeral → event subscription (the channels part).

Two consequences worth stating, because the previous draft blurred them:

- **Cache invalidation is `save`-driven, not event-driven.** A `save` (any
  aggregate state change, including a projection's own read-model save) is what
  busts the cache and refreshes any cached on-screen read. Domain events (`emit`) are for
  *display* (live events) and *choreography* (reactors) — **not** a cache trigger.
- **Most "show events on the frontend" is actually a live read over a persisted
  log** (a Notifications / activity table that grows by `save`), not an ephemeral
  event subscription. The genuinely-ephemeral case (toast, presence, "X is
  typing") is the smaller, distinct plane in the channels part.

## Interest is the query key — not `DataKey`, not the channel `key:`

`DataKey` answers visibility (tenant + org reachability); it says **nothing**
about *which* order a page is looking at. That is the **query key's** job, and the
query key is *already* the React Query cache key:

| Page binding | Query key | Interest |
|---|---|---|
| `Order.all` | `["orders"]` | the collection |
| `Order.byId(42)` | `["orders", 42]` | one instance |
| `Order.mine()` | `["orders","find","mine",args]` | a named find |

The interest key is **not declared** on a channel or a read — it's the key the
frontend already emits. So nothing new is invented; the cache layer reads what's
there.

## Automatic invalidation — there is no special "live" query

There is **no per-query `.live` marker** (and React Query has no such concept —
it has `useQuery` + manual `invalidateQueries`; server-push is wired by hand).
Instead: **any `cached: tagged` read is invalidated automatically when its
resources change.** "Live" is *emergent*, not a query type:

- an **active** (mounted, on-screen) cached query refetches **immediately** on
  invalidation — React Query's default — so it updates live with no marker;
- an **inactive** (cached but unmounted) query is marked stale and refetched
  lazily on its next mount.

The one piece of derived logic is the **save → query-keys map**: *which cached
queries does a state change invalidate?* — driven by `save` (not by domain
events; those are display/choreography, see "Live reads vs live events"):

```
save(Order 42)        →  invalidates  ["orders"], ["orders", 42], (finds whose result it could change)
save(Projection P)    →  invalidates  [P's own key]   ← a projection's read-model save
```

This map (`InvalidationRuleIR`) is the single shared artifact: the server cache
evicts the keys, the CDN purges the tags, the realtime relay publishes a ticket
to each key's room, and the client `invalidateQueries` them. Derived from the
read/view AST, so it can't drift.

### How the signal reaches the client — eager vs lazy (a coarse knob, not per query)

Invalidation is automatic; the only choice is *how the "changed" signal arrives*,
and it's a single per-UI/deployment setting, not a per-query keyword:

| Delivery | Mechanism | Cost |
|---|---|---|
| **Eager (push)** | one SSE/WS connection per client, subscribed to its resource scope; a ticket → `invalidateQueries` → active queries refetch instantly | one connection per client |
| **Lazy** | revalidate on access — ETag/`If-None-Match` → `304` on next mount/focus, or `staleTime` | no socket |

Eager push is what makes on-screen reads "live"; lazy is plain
stale-while-revalidate. Default to lazy unless the app already holds a realtime
connection (e.g. for live events), then reuse it. Either way the *correctness* —
never serving knowingly-stale data — is the same; only the latency differs.

## The invalidation channel — synthesized, total, but explicitly bound

The invalidation stream is generated from **every** `repo.save`, so it *feels*
global — and at the level of *coverage* it must be. If invalidation were opt-in
per aggregate, you could cache a read whose aggregate forgot to ticket → a silent
stale-data bug; a cache you can't trust to be fresh is worse than none. **So
coverage stays automatic and total.** But the parts that are real decisions —
*which broker carries it*, *who consumes it*, *whether it reaches the browser* —
should be **explicit, exactly like any other channel.** The split mirrors Loom
everywhere: contract derived, infra declared.

| Aspect | Implicit (derived) — contract | Explicit (declared) — infra / composition |
|---|---|---|
| What it carries | every aggregate's **save-tickets** (total coverage) | — (never hand-written) |
| Transport | — | which broker (`channelSource`) |
| Consumers | — | `deployable.channels`; which UIs run the invalidation connection |
| Scope | per-tenant rooms (from `tenancy by`) | — |

So model it as **a channel Loom synthesizes** — a per-context `<Context>.changes`
carrying that context's aggregate save-tickets — whose `carries:` is *derived*
but which is **bound and subscribed through the same machinery as any declared
channel** (the channels part):

```ddd
// synthesized — you never write the carries:
//   channel Orders.changes { carries: <all Orders aggregates' save-tickets>; delivery: broadcast }

channelSource ordersChanges { for: Orders.changes, use: bus }              // EXPLICIT transport
deployable salesApi { contexts: [Orders]; channels: [ordersChanges]; … }   // EXPLICIT: who carries it
deployable webApp   { targets: salesApi; realtime: invalidation; … }       // EXPLICIT: frontend reach
```

This gives the legibility the global feel was missing — you can *see* the change
feed, where it's bound, and who consumes it — without the ceremony (and
stale-data risk) of per-aggregate change declarations. It need not be separate
infra: save-tickets and `emit` events both flow through the one
`DomainEventDispatcher` seam, so the invalidation channel can ride the **same
transport** as event channels (it's the *ticket kind* of message). A joined view
that depends on two contexts subscribes to **both** `<Ctx>.changes` — consistent
with the dependency-set tagging below.

A `cached: tagged` read therefore implies its context's `changes` channel must be
bound wherever it's served (`loom.cache-changes-unbound` if not) — the one
obligation that keeps "automatic coverage" honest across deployables.

### How it's wired on the frontend

Gated by `realtime: invalidation` on the deployable. Without it, no connection is
generated and freshness falls back to lazy ETag revalidation; with it, the
generated frontend opens **one** connection to the backend it `targets:` and
turns tickets into cache invalidation. The shape differs sharply by platform.

**React — one connection + a generated tag→queryKeys map.**

```ts
// api/realtime.ts (generated)
// Derived inverse of the dependency sets: resource tag → the query-key prefixes
// that depend on it. This is the one thing React Query can't express itself —
// its key is a single path, so a joined view's key must be invalidated by BOTH
// its sources.
const INVALIDATES: Record<string, ReadonlyArray<readonly unknown[]>> = {
  orders:    [["orders"]],
  customers: [["customers"], ["orderSummary"]],   // OrderSummary joins Order ⋈ Customer
};

export function connectRealtime(qc: QueryClient) {
  const es = new EventSource(`${API_BASE_URL}/changes`, { withCredentials: true });
  es.addEventListener("invalidate", (e) => {
    const { tag, id } = JSON.parse(e.data);                 // { tag:"orders", id:"42" }
    qc.invalidateQueries({ queryKey: [tag] });
    if (id) qc.invalidateQueries({ queryKey: [tag, id] });
    for (const k of INVALIDATES[tag] ?? []) qc.invalidateQueries({ queryKey: k });
  });
  es.addEventListener("event", (e) => dispatchLiveEvent(JSON.parse(e.data)));  // → on Param.Event
  return () => es.close();
}
// mounted once at the app root:  useEffect(() => connectRealtime(queryClient), [queryClient])
```

- **The client names no rooms.** It connects with its bearer token; the *server*
  derives the rooms from the JWT (tenant + `DataKey` scope) and subscribes the
  socket. The client just `invalidateQueries` the tickets it receives (a no-op for
  keys it doesn't currently hold — harmless). Default subscription is the user's
  whole scope; narrowing to only mounted resources is an optional fan-out
  optimization.
- **`invalidateQueries` refetches only *active* queries** (inactive ones go stale,
  refetch on next mount), so this one connection + handler is the entire "live"
  mechanism — no per-component code.
- **Auth wrinkle:** native `EventSource` can't set an `Authorization` header, so
  the `/changes` endpoint authenticates by **cookie** (`withCredentials`), or via
  a fetch-based SSE client that can send headers, or a **WebSocket** (auth in the
  first frame). Loom picks per the deployable's auth/wire; the `static`+SSE
  default uses the cookie the app already holds.

**Phoenix LiveView — no client code.** There is no React Query and no client JS:
the LiveView process holds the socket, subscribes server-side from
`socket.assigns.current_user`, and on a ticket re-runs the query and re-`assign`s;
LiveView diffs and patches the DOM over its own WebSocket.

```elixir
def mount(_p, _s, socket) do
  if connected?(socket), do: subscribe_rooms(socket.assigns.current_user)
  {:ok, assign_orders(socket)}
end
def handle_info({:invalidate, "orders", _id}, socket), do: {:noreply, assign_orders(socket)}
```

What ties it together: the **connection/wire** (SSE/WS, edge relay, server-derived
rooms) is the channels part's — *shared* by invalidation tickets and live-event
payloads on one socket; the **invalidation handler + the tag→queryKeys map** are
this proposal's; both are off unless the deployable opts into
`realtime: invalidation`.

### Is invalidation tenant-wide? — scope the notification room by the view's audience

With **type-keyed** rooms it *is*: a list page subscribes to the collection room
`tenant.orders` (it can't predict which instance ids it'll show), so every user
with any orders list open gets a ticket on **every** order save in the tenant.
That's tenant-wide fan-out — no data leak (tickets carry no payload; each client
refetches its own authorized read), but a tenant-wide *nudge* plus a faint
side-channel ("*some* order changed" leaks existence/timing to users who can't
see it).

**Why this is safe to route coarsely** — and why invalidation, unlike payload
delivery, **never needs per-ticket authorization**: a ticket carries no data, so
the routing only has to be a *superset* of the authorized set. Correctness is the
**authz'd refetch**, not the routing. So even arbitrary relationship/ACL
authorization (which can't be reduced to a room key — see the channels part §"The
limit of routing-by-key") is fine for invalidation: route to the coarse room, let
the refetch enforce per-row authz. Scoping the room (below) is therefore a pure
*optimization* (less refetch noise, tighter side-channel), never a correctness
requirement.

The optimization is to scope the notification room by the **view's audience** —
the same `DataKey`/visibility prefix used for delivery and the cache partition.
Publish the ticket at the changed aggregate's `DataKey`/owner path; each view
subscribes to
the prefix matching *its* scope:

```
save(Order 42, owner = customer X)  →  ticket room  tenant.X.orders.42
  customer X's "my orders" list     →  subscribes   tenant.X.orders.*    ← only its own
  admin "all orders" list           →  subscribes   tenant.*.orders.*    ← tenant-wide (correct: sees all)
```

So it's tenant-wide **only for tenant-wide (admin) views**, which is right —
that audience genuinely sees everything. An owner-scoped list hears only its
owner's changes, and the side-channel closes (a customer never receives a ticket
for another's order). Same prefix machinery, third use. These per-owner rooms are
**relay-registry entries, not per-user broker objects** — see the channels part §"How
rooms are realized" (the durable broker stays coarse; only the edge relay keys by
`DataKey`).

Two boundaries to be honest about:

- **Two granularities, two purposes.** The *server cache eviction* can stay
  coarse (type tag — cheap, and the read-through absorbs the re-reads); only the
  *frontend notification room* is narrowed to the audience. They needn't match.
- **Clean prefix only.** Narrowing works when the view's scope is a `DataKey`/
  owner prefix. For an arbitrary filter that isn't, fall back to the type room
  (tenant-wide, mitigated by active-only refetch + coalescing) or graduate to a
  **projection** — the same discrete-vs-continuous line as parametrized tags.

### What a "coarse room" is, and how a client joins rooms

A **coarse room** is keyed by resource *type* (+ tenant) only — `tenant:acme:orders`
— so any connection viewing any order joins it and any order save tickets it.
It's the simplest routing but its **delivery** cost is O(tenant users with that
type open) per save; cheap to implement, but it does **not** scale to large
tenants × high write rate. So coarse is the default, not the scalable answer — at
scale you move down the granularity ladder:

| Room | Key | Joined by | Over-delivery |
|---|---|---|---|
| coarse | `tenant:acme:orders` | anyone viewing any order | tenant-wide |
| owner-scoped | `tenant:acme:orders:owner:X` | viewers of X's orders | your scope only |
| instance | `tenant:acme:orders:42` | viewers of order 42 | one resource |

**How a client joins — its active React Query keys *are* its subscription set.**
The generated realtime client hooks the query cache; each active query maps to a
room, joined on mount and left when the query is GC'd:

```ts
queryClient.getQueryCache().subscribe((ev) => {
  const room = roomOf(ev.query.queryKey, claims);   // ["orders",42] → tenant:X:orders:42
  if (ev.type === "added")   relay.join(room);
  if (ev.type === "removed") relay.leave(room);
});
```

So the subscription set is **automatic and self-maintaining** — it tracks exactly
what's on screen, because React Query already tracks that; no manual `subscribe()`
calls. Concretely:

- **When** you join: on query **mount** (you access the resource), not at login;
  you leave on unmount/GC.
- **Based on what:** the **React Query key** → `roomOf(key, claims)` —
  `["orders",42]` → instance room; `["orders"]` → your owner-scope room (or coarse).
- **Join authorization** (the trilemma's subscribe-time row): a **detail** page
  already loaded order 42 through the authz'd read, so the join *rides that same
  authorization* (you read it ⇒ you may watch it); ACL cases do a one-time
  membership check at join. A **list** joins its owner-scope room and defers
  per-row authz to the refetch (the invalidation escape).

Net: **detail views → instance room, joined on mount, authorized once, zero
over-delivery; list views → scope/coarse room, per-row authz at refetch,
over-delivery bounded by scope (or tenant, for coarse).** (Live-event
subscriptions instead join via their explicit `channel` param — same relay rooms,
but authorized as payload delivery, not deferred to a refetch.)

### Owner-scoped rooms — the update flow end to end

An owner-scoped room `tenant:acme:orders:owner:X` is "orders owned by X." A "my
orders" list (the viewer *is* X) joins it and is nudged on **any change to any
order owned by X** — and nothing about other customers. The update kinds:

| Update | Tickets which room(s) |
|---|---|
| **create** order for X | `…orders:owner:X` (X's list grows) + coarse `…orders` (admins) |
| **update** order 42 (owner X) | `…orders:owner:X` + instance `…orders:42` (detail watchers) + coarse |
| **delete** order of X | `…orders:owner:X` (X's list shrinks) + coarse |
| **transition** — order 42 reassigned X→Y | **both** `…owner:X` (it left) **and** `…owner:Y` (it joined) — needs the save's before+after owner |

The transition is the subtle one: a reassign affects two owners' lists, so the
save tickets **both** owner rooms — which is *why* scoped invalidation needs the
old+new value of the scope field (a before-image on the save).

**Server (normal update):**

```
  Customer X (or staff) ──POST /orders/42/ship──▶ Order#42.ship()   [order.customerId = X]
                                                       │
                                                       ▼  repo.save(order#42)
                          DomainEventDispatcher — derive ticket from the save (no payload)
                                   ticket = { tag:"orders", id:"42" }
                  publish-to-levels  (one save → the fixed scope rooms it belongs to)
          ┌──────────────────┬──────────────────────┬───────────────────────┐
          ▼                  ▼                       ▼                       ▼
    …orders:owner:X     …orders:42            …orders (coarse)        [broker backplane,
    (owner lists)       (detail watchers)     (admin/tenant-wide)      if relay is sharded]
          │                  │                       │
          ▼                  ▼                       ▼
        RELAY (edge backend holding the sockets) — look up registry[room], push
          registry[…owner:X] = {connA(X), connC(X)}   registry[…orders:42] = {connD}
          connA ◀ ticket   connC ◀ ticket   connD ◀ ticket   connAdmin ◀ ticket
                              (O(recipients); no per-connection predicate)
```

The ticket carries **only `{tag,id}`** — the *owner* is used server-side to pick
the room, never sent to the client; and `connA` can only be in `…owner:X` where
X is its own JWT claim, so it structurally can't receive another owner's tickets.

**Client (connA = X's "my orders" list):**

```
  mount useQuery(["orders","find","mine"]) → roomOf(key,claims)=…owner:{X}
        └▶ relay.join("…orders:owner:X")   (authorized by the read that loaded the list)
  ── ticket {tag:"orders",id:"42"} ─▶ qc.invalidateQueries(["orders"])   (prefix)
        └▶ active "my orders" query stale → refetch GET /orders/mine
              (authz'd: WHERE customerId = currentUser → only X's rows)
        └▶ React Query cache updated → list re-renders (42's new status)
  unmount → relay.leave("…orders:owner:X")
```

**Transition (reassign X→Y) — both rooms fire:**

```
  repo.save(order#42)  [before owner=X, after owner=Y]
     ├─▶ …owner:Y   (joined → appears in Y's list)   ← new
     ├─▶ …owner:X   (left   → leaves X's list)        ← OLD (the transition)
     ├─▶ …orders:42 (the order changed)   └─▶ …orders (admins)

  X's list: ticket → refetch /orders/mine → order 42 GONE
  Y's list: ticket → refetch /orders/mine → order 42 APPEARS
```

Three properties this makes concrete: **the ticket is a nudge, the refetch is the
truth** (and it's authz'd, so even an over-broad nudge can't leak); **the owner
room bounds the nudge to the people who care** (X's list, not the tenant); and
**transitions fan to both old and new owner rooms** — the reason scoped
invalidation needs the save's before-image (a `cached:`-driven obligation; see
Open questions). Bursts coalesce: 50 of X's orders changing → one refetch of
`/orders/mine`.

### Precisely: "owner" is the resource's `dataKey`, and where policy applies

"Owner" above was shorthand — there is **no separate owner concept**. Every
aggregate is stamped with a **`dataKey`** (the materialized path from
`authorization.md` / tenancy) at create; for a customer-owned order that path's
*leaf* is the customer, hence "owner." The precise model:

- the **resource** carries a `dataKey` (`order#42 → t.acme.custX`, stamped on create);
- the **subscriber** carries a `dataKey` in its JWT (`currentUser.dataKey`);
- the **room a client joins is its own** `dataKey`: `t.acme.custX:orders`;
- an **update publishes to every *ancestor* `dataKey`** of the resource's:
  `t:orders`, `t.acme:orders`, `t.acme.custX:orders`;
- **match ⟺ `currentUser.dataKey` is an ancestor-or-equal of the resource's** —
  which *is* the reachability policy, compiled. (The "owner room" is just the leaf
  case where the two `dataKey`s are equal.)

**Where the policy is applied — compiled, never per-ticket:**

1. **Compile time** — the compiler reads the policy's reachability *direction*
   (`reachable when currentUser.dataKey isAncestorOf this.dataKey`) and emits the
   routing rule (`publish → ancestor rooms`; `subscribe → own room`). The policy
   *becomes* the room topology.
2. **Stamp/issue time** — the resource's `dataKey` is set on create; the user's is
   in the JWT. The policy's inputs are materialized once.
3. **Refetch time** — the same policy runs as the SQL `WHERE` on the authz'd
   refetch: the actual gate. The room match only decides *who to nudge*.

At delivery there is **no per-ticket *policy* evaluation** — but be precise about
what that buys: room-membership matching *authorizes correctly* **only** when the
visibility relation **is** the room key (the dataKey-ancestor case above). For any
other policy the room is a **coarse pre-filter, not an authorizer** — see "When
the policy isn't a clean prefix" next. (Relationship/ACL policies fall further, to
the trilemma's subscribe-/publish-time rows — the channels part §"The limit of
routing-by-key".)

**The whole flow, technically** (the clean dataKey-ancestor case):

```
① COMPILE   policy { data { Order reachable when currentUser.dataKey isAncestorOf this.dataKey } }
            → routing rule:  publish(o) → { a+":orders" | a ∈ ancestors(o.dataKey) }
                             subscribe(u) → u.dataKey+":orders"
                             match ⟺ u.dataKey ∈ ancestors(o.dataKey)        (= the policy)

② SUBSCRIBE mount useQuery(["orders"])   [JWT.dataKey = "t.acme.custX"]
            → relay.join("t.acme.custX:orders")
              (structural authz: X can only build a room from its OWN JWT dataKey,
               cannot forge "t.acme.custY")

③ WRITE     POST /orders/42/ship → save(#42)   [#42.dataKey="t.acme.custX", stamped at create]
            → ticket {tag:"orders", id:"42"}   (no payload, dataKey NOT sent to client)
            → publish to ancestor rooms of "t.acme.custX":
                 "t:orders" (platform)   "t.acme:orders" (tenant/managers)
                 "t.acme.custX:orders" (X)   + instance "orders:42"
              (O(depth) rooms — path depth ~3–5, fixed, not per-user)

④ DELIVER   relay: push ticket to registry[room]  (O(recipients))
            connX ◀ ticket → qc.invalidateQueries(["orders"])
                           → refetch GET /orders  (SAME policy as SQL WHERE → only X's rows)
                           → re-render
            connY (room "t.acme.custY:orders") was never in the publish set → no nudge, no leak
```

So: the **resource's `dataKey` drives publish-to-ancestors; the user's `dataKey`
(JWT) is the room it joins; they meet iff the user is at-or-above the resource** —
the reachability policy compiled into room topology, with the authz'd refetch as
the real gate. No per-ticket × per-connection evaluation (see "What 'no per-ticket
evaluation' means" below). **This clean matching holds only
because here the visibility relation *is* the dataKey ancestry.** When it isn't,
the next section.

### When the policy isn't a clean prefix — the refetch is the gate, rooms only pre-filter

The honest case. Say user **U** sees `Order where status == "open" AND region ∈
U.regions`, `U.regions = {A,B}` — a policy **not** reducible to dataKey ancestry.
A new order is created: how does it reach exactly the right users? It **doesn't**,
by routing alone — and there is no magic. **The room is a coarse pre-filter; the
*refetch* is where authorization actually happens** (the same SQL `WHERE` the list
endpoint always runs). Over-nudging is safe *because* the refetch re-authorizes,
so nothing is authorized "for free": every policy dimension is either a **room
key** (a cheap pre-filter that avoids wasted refetches) or a **refetch `WHERE`**
(the real gate).

The compiler splits the predicate into the part it can express as a room key (a
discrete/equality dimension) and the rest (left in the `WHERE`):

```
① COMPILE   visible when status="open" AND region ∈ currentUser.regions
            room-able = region (discrete)   → room key      |   status → refetch WHERE only
            publish(o) → "orders:region:"+o.region
            subscribe(u) → { "orders:region:"+r | r ∈ u.regions }   ← a SET of rooms

② SUBSCRIBE U (regions {A,B}) → join "orders:region:A", "orders:region:B"   (bounded by U's scope)

③ WRITE     create Order#99 { region:A, status:open } → ticket {orders,99}
            → publish to "orders:region:A"   (routed by REGION only; the room knows nothing of status)

④ DELIVER   "orders:region:A" = { connU, connW(regs{A}), connAdmin }
            connU ◀ nudge → refetch GET /orders
                            WHERE status='open' AND region IN ('A','B')   ← THE GATE (full policy)
                            → #99 appears                                       ✓
            connV (regs {C}) NOT in room → never nudged, never sees #99         ✓ (precise on region)

   over-delivery: create Order#100 { region:A, status:DRAFT } → "orders:region:A"
            connU ◀ nudge → refetch → WHERE status='open' → #100 EXCLUDED → list unchanged
                          (a wasted refetch — status wasn't a room key — but no leak; the WHERE caught it)
```

So **region** (a room key) is precise — V is never even nudged; **status** (left
in the `WHERE`) over-delivers — U is nudged for a draft it can't see, refetches,
and the `WHERE` excludes it. You *could* also room on status to kill that, but
each roomed dimension multiplies rooms and the publish fan-out. So the rule:
**room on the high-selectivity / security-relevant dimensions, refetch-filter the
rest; the refetch is always the correctness boundary.** And this is *only* safe
because tickets carry no data — over-delivery on un-roomed dimensions can't leak,
the refetch re-authorizes. (Payload delivery can't do this; it must room on every
dimension or pay per-ticket eval — the trilemma.)

#### How the compiler decides the split — equi-join key vs residual

The policy is a predicate over `(resource fields, currentUser fields)`. The
compiler walks its conjuncts and classifies each — and it is the *same* decision a
SQL planner makes choosing hash-join keys vs filter residuals:

| Conjunct shape | Becomes | Why |
|---|---|---|
| `f(resource) == g(currentUser)` — equality / membership / dataKey-prefix (an **equi-join**) | a **room dimension** | both sides independently compute a matching key |
| `resource.field == <const>` (the view's own fixed filter) | a **room dimension** (or `WHERE`) | a fixed key both sides know |
| range / computed / function — `total > 100`, `createdAt > now()-7d`, full-text | the **refetch `WHERE`** (residual) | no discrete key to match on |
| equi-join but **huge cardinality** | demoted to `WHERE` (cost) | too many rooms |

So there's no guesswork: an **equality** condition can become a hash key (the
room); an **inequality/function** condition can't, so it stays a filter. That's
why **some part must live in the `WHERE`** — a range/computed/full-text predicate
has *no* room representation (a range isn't a key, `now()` moves), so it can only
be evaluated at query time. The `WHERE` is the non-equi residual, and the
always-correct full check rooms merely pre-filter.

#### What "no per-ticket evaluation" means — it's a hash lookup, not a scan

You're right that there *is* evaluation — the precise claim is **no per-ticket ×
per-connection evaluation**. Three different evaluations happen, at three scales:

| Evaluation | Scale | What |
|---|---|---|
| resource's room key(s) from **its own fields** | **O(1) per ticket** | `order#99.region → "orders:region:A"` — tests no user |
| user's rooms from **its claims** | **O(1) per connection** (at connect) | `U.regions {A,B} → join those rooms` |
| delivery | O(recipients) per ticket | hash lookup + socket write; no predicate |
| the **`WHERE`** | once per **refetch**, at the DB | the real authorization |

What the room eliminates is the **O(tickets × connections)** nested loop — "for
each ticket, test every connection against the policy." It does so by being a
**hash index on the equi-join key**: compute the key once on each side, match by
lookup. So evaluation happens (compute `keyA(resource)` per ticket, `keyB(user)`
per connection, the `WHERE` per refetch) — but never the N×M scan. **An equi-join
is a hash lookup, not a nested-loop scan**; the room is the hash bucket, the
`WHERE` is the residual it can't express, and authorization ultimately lives in
the `WHERE`, with the room saving refetches when the equi-join part already says
"not yours."

#### Yes, residual over-delivery remains — what it is and what it costs

So tickets *do* still reach some users who can't see the resource — **over-delivery
is present for every policy dimension not encoded as a room key.** It's zero
*only* when the entire policy is equi-join-roomable (e.g. pure dataKey-ancestor);
the moment there's a non-equi residual (`total > 100`, `now()-7d`, full-text) or
an un-roomed equi dimension, some matched-but-unauthorized users get nudged. It's
a spectrum: coarse → tenant-wide; partial rooming → bounded; full equi-join
rooming → zero. What it costs:

| Aspect | Impact |
|---|---|
| **Data security** | **none** — tickets carry no payload; the refetch re-authorizes; the unauthorized user's list is unchanged |
| **Side-channel** | a faint existence/timing leak ("*something in my bucket changed*"), for a resource they can't see — negligible for most apps, a real small consideration for high-sensitivity data |
| **Cost** | **wasted refetches** by the over-delivered active users |

The cost is mitigated, not zero: a wasted refetch is a conditional GET →
`304 Not Modified` (the authorized result is unchanged, ETag matches — no DB hit,
no payload, just a round-trip); **active-only** limits it to on-screen users;
**coalescing** collapses bursts. So the practical residual is "a 304 per
over-delivered on-screen user per coalesced burst." The *side-channel* is the one
part 304s don't fix — it closes only by rooming that dimension.

**The fundamental limit:** no independent-key routing achieves zero over-delivery
for an arbitrary policy — routing *is* "compute a key from each side and match,"
which captures exactly equi-join authorization and nothing more. Zero
over-delivery for a non-equi policy requires leaving cheap routing for the
trilemma: per-ticket eval (publish-time) or per-resource membership
(subscribe-time). Which is why the ticket/payload split is load-bearing:
**invalidation** tolerates the residual (refetch re-authorizes), so tightening is
optional; **payload delivery** cannot over-deliver, so for any non-equi policy it
*must* pay the trilemma — or not push payloads under that policy and route through
invalidation + refetch instead.

## Tickets vs payloads — the default that makes scoping a non-problem

An invalidation push **does not need to carry the data** — it needs to carry "your key
changed, refetch":

- **Default — invalidation ticket (no payload).** The client refetches through
  the **normal authorized read endpoint**. Per-row/per-user visibility is enforced
  by the read path *which already does it correctly* — the push layer never
  reimplements it, and a ticket can leak only "something changed." Safe by
  construction.
- **Opt-in — payload patch.** For a hot path, push the delta and `setQueryData`
  it (no refetch). This carries data, so it must be scoped at delivery (plane 2,
  the channels part). That cost is *why* it's opt-in, not the default.

So the list-filtering problem dissolves: the server publishes a coarse "resource
changed" ticket; each client refetches its own authorized view.

## Won't broad invalidation storm the server?

Naïvely "order 42 changed → every client refetches every orders list" is a
thundering herd. Four standard mitigations make it a non-issue; the third is the
payoff of unifying caching and invalidation:

1. **Only *active* queries refetch.** React Query marks *inactive* (unmounted)
   queries stale and refetches them lazily on next mount — it does *not* refetch
   every cached list. The herd is bounded by what's *on screen now*.
2. **Coalesce tickets.** 50 saves in 200 ms → **one** refetch (debounce per
   room/key over a small window). Change streams are bursty; coalescing is
   mandatory.
3. **The read-through cache absorbs the fan-in.** N clients refetch the same
   invalidated key → the ticket already evicted the cache → first refetch is
   **one** DB read, the rest are cache hits. **N refetches → 1 query.** The storm
   hits warm cache, not the database.
4. **Cheap refetch.** ETag/`If-None-Match` → `304`, or a version/sequence in the
   ticket so an already-current client skips.

So broad invalidation is fine — bounded by active queries, coalesced, absorbed by
cache. Patch-don't-invalidate is reserved for paths where even a coalesced
cache-hit refetch is too slow.

## Invalidation-based HTTP caching — surrogate keys / cache tags

Ordinary HTTP caching is **expiration-based** (`max-age=30`, hope, revalidate)
because the origin can't know when data changed. Loom is **invalidation-based**:
long `max-age` **and** an explicit purge the instant the aggregate changes. The
mechanism exists in every CDN/proxy — **surrogate keys** (Fastly), **cache tags**
(Cloudflare), **xkey** (Varnish): tag a response with the resource keys it
depends on, **purge by tag** on change. One ticket cascades through every tier:

| Tier | Keyed by | Busted by |
|---|---|---|
| Browser HTTP cache | `ETag: orders/42@v7` (aggregate version) | conditional GET → `304` |
| CDN / reverse proxy | `Surrogate-Key: orders.42` | purge-by-tag |
| Server read-through cache | `orders.42` | evict |
| Client React Query | `["orders", 42]` | prefix invalidate |

The ETag is the aggregate's **version/sequence** — the same number wanted in the
ticket for "skip if current."

## Structuring the keys — a read carries a *set* of tags (its dependency set)

A response's key is **not one tag — it's the set of resources it depends on**,
derived from the query/view AST (the enrich-phase walk that builds
`wireShape`/`findAll`/associations). Two rules cover the hard cases:

- **List vs detail — type tag vs instance tag.** A *detail* read (`byId(42)`)
  depends on one instance → `Surrogate-Key: orders.42`. A *list* depends on the
  **type, not specific ids** (a row appearing/disappearing changes the list, and
  which id triggers it isn't known ahead) → `Surrogate-Key: orders`. A `save`
  publishes both `orders` and `orders.42` tickets, covering both.
- **Joined / multi-source views — union of dependency types.** `Order ⋈ Customer`
  changes when **either** side changes → `Surrogate-Key: orders customers`; a
  save to *either* purges it (surrogate keys are a *set*; a purge of any member
  evicts the entry). A 25-aggregate dashboard → 25 type tags. Derivation is
  mechanical: walk the read's source aggregates, one tag per type (instance tags
  only when the read is parameterized by that id).

**When the dependency set is too wide — restructure the read, not the cache.**
Tagging a dashboard with 25 high-write types means any of 25 saves busts it;
correct but churny. Past some fan-in the read should be a **maintained
`projection`** (`bounded-context-model.md`, `workflow-and-applier.md`) — updated
incrementally from the event stream, so 25 upstream types collapse to one
resource. **A projection is not a cache mode** — it's a different read whose
*output* is cached with tags like any other (one tag instead of 25). The compiler
can *warn* (`loom.cache-wide-dependency`) when a `cached: tagged` read's
dependency set exceeds a threshold, suggesting a projection.

## Parametrized reads — linking frontend params to server tags

A parametrized read (`OrdersByStatus(status)`) takes its parameter from the
**frontend**. It links to a server tag the same way the room key does — but only
when the parameter is a **discrete equality on a field the event carries**:

```
view OrdersByStatus(status)             → tag  orders.status.open
frontend ["orders","byStatus","open"]   → same tag  orders.status.open
```

Both sides render the same string independently. The subtlety: when a row's
filter field **changes**, the row *moves between partitions*, so the save must
purge **both** the old and new tag — `OrderStatusChanged{old,new}` busts
`orders.status.open` *and* `.closed`. This **transition invalidation** needs
old+new in the change signal and is derivable only for **discrete, enumerable**
params.

It does **not** work for continuous / range / full-text params
(`OrdersByTotal(min,max)`, `OrdersSearch(q)`) — you can't mint a tag per range.
Those fall back to the **type tag** (bust-all) or a **projection** (a maintained
range/search index keyed by its own identity). The honest line: **discrete param
→ tight tag; continuous param → coarse type tag or projection** — which is why
**caching is opt-in per read** and the default for hot/wide/continuous reads is
`cached: none`, not cache-and-thrash.

## Does each tier actually support tag-invalidation?

| Tier | Native tag-purge? | Mechanism |
|---|---|---|
| **CDN / proxy** | **Yes, first-class** | Fastly `Surrogate-Key` + purge; Cloudflare `Cache-Tag` + purge; Varnish `xkey`. Built for this. |
| **In-handler read-through (canonical)** | Yes | .NET `HybridCache` (.NET 9) `GetOrCreateAsync(…, tags)` + `RemoveByTagAsync`; Redis reverse-index (`SADD tag:orders <key>` → `SMEMBERS`+`UNLINK`) — exactly Symfony `RedisTagAwareAdapter` / Laravel cache-tags. Backend-uniform (Hono/.NET/Phoenix). |
| **ASP.NET OutputCache** (public only) | Engine yes, **above the gate** | `IOutputCachePolicy` (the `[OutputCache(Tags=…)]` attribute takes compile-time constants only, so the runtime `orders.{id}` tag needs a generic route-driven policy). Admissible only for public/tenant-no-gate; a CDN does it better. |
| **React Query (client)** | **No tag concept — key *is* the tag** | `invalidateQueries({queryKey})` prefix-matches a single hierarchical path; it *cannot* natively express "depends on `orders` **and** `customers`". So Loom emits a **tag → queryKeys registry** + `predicate` invalidation — the one place the compile-time dependency set genuinely earns its keep. |

Loom isn't inventing a cache; it *emits tags and purge calls* into mechanisms
that already exist. **Tags are runtime values** (instance/param come from the
request), so they're built per request in code, not in a static annotation.

## Where the cache may live — auth decides the tier, and OutputCache mostly can't

If authorization (`requires`, policy, row-filter) runs as a **pipeline behavior**
below the controller, then an HTTP/output cache *above* it is hit **before auth
runs** — serving one principal's response to another. So:

> **A cache may live above the auth boundary only if the response is identical
> for everyone who passes it.** Otherwise it lives *below* the gate, keyed by the
> authorized effective scope.

The **canonical** cache is therefore a read-through **inside the handler, below
the auth behavior** — also the one shape uniform across backends (HybridCache /
Redis). The auth behavior always runs (a cheap predicate), produces the
**effective scope** (`tenant + DataKey + relevant perms`), and that is part of
the cache key `(effectiveScope, query, params)`, evicted by the same tags.

| Read's authz | Varies by | Cache tier | Mechanism |
|---|---|---|---|
| **public** (`crossTenant`) | nothing | edge, above auth | CDN (+ optionally OutputCache) |
| **tenant, no gate** | tenant | edge, above auth, `VaryBy` tenant | CDN per-tenant / OutputCache |
| **`requires` / row-level / per-user** | `DataKey` + perms | **below auth, in-handler** | HybridCache / Redis read-through. **Not OutputCache.** |

Two invariants: the **`requires` 403 gate is never cache-served** (only the data
it admits is); and **edge caching pays off only for public + tenant reads** —
per-user reads can't be shared at the edge, their win is the in-handler cache
(one user's N requests → 1 DB read across their session).

## The `cached:` surface

```ddd
repository Orders for Order {
  find recent(): Order[] cached: tagged          // surrogate-key invalidation
}
view ActiveDashboard cached: tagged(ttl: 300)    // + a ttl backstop
view HotSearch       cached: none                // explicit opt-out (default for hot/wide/continuous)
```

```langium
// On FindDecl / View / projection output:
('cached' ':' mode=CacheMode ('(' 'ttl' ':' ttl=INT ')')?)?
CacheMode returns string: 'none' | 'tagged';
```

Default is `none`. `tagged` opts a read into surrogate-key invalidation; the
**tier** (edge vs in-handler) and the **tag set** (dependency set) are *derived*,
not declared — the author only chooses *whether* to cache. Optional `ttl` is a
safety backstop, not the primary mechanism.

**Validation** (`loom.cache-*`): `loom.cache-wide-dependency` (a `tagged` read's
dependency set exceeds a threshold → suggest a projection);
`loom.cache-uncacheable` (a `tagged` read has no stable query key — e.g. a
nondeterministic body — so it can't be keyed/invalidated);
`loom.cache-continuous-param` (a `tagged` read keys on a range/search param that
can't be tagged → falls back to type tag or projection; warn);
`loom.cache-changes-unbound` (a `tagged` read is served by a deployable that does
not bind its context's `<Context>.changes` channel — coverage would be silently
incomplete; add a `channelSource` for it to that deployable's `channels:`).

## Developer experience — safe default, progressive disclosure

The author must never see the machinery (rooms, `maySee`, the trilemma,
payload-vs-ticket, over-send) — it's the *compiler's* problem. The load-bearing
DX rule: **correctness never depends on the author's tuning.** Over-send is safe
*because the refetch is the gate*, so the simplest choice can't open a hole;
tightening only ever changes *cost*, never *correctness*. That's what lets the
default be "just over-send."

Progressive disclosure — each level optional, reached only when a real problem
pushes you there:

| Level | Author writes | Gets | When |
|---|---|---|---|
| **0. nothing** | (default) | normal reads; refetch on focus/nav | most reads — *not everything is live* |
| **1. live** | one word on a view | **safe over-send**: coarse resource-keyed tickets + authz'd refetch; zero thought about rooms/policy/payloads | the common live case |
| **2. (automatic)** | still just `live` | compiler **tightens the room for free** where the read's authz is a clean equality / `dataKey` prefix; over-send otherwise | derived — author does nothing |
| **3. payload / projection** | `live(patch)` / a `projection` | push the delta (no refetch) for hot paths; or a maintained read-model for wide/expensive views | only when a default *bites* |
| **4. escape hatch** | raw channel / relay | bespoke control | rare |

Level 1 answers almost everything: write `live`, get correct over-send, move on.
The compiler silently does Level 2; Levels 3–4 are for measured cost problems, and
the compiler *flags* when you might be there (`loom.cache-wide-dependency`,
`loom.live-on-queue`) rather than making you decide up front.

**Declared (intent) vs derived (mechanism):** the author declares only *is it
live? is it cached? push or just nudge? is it a projection?* — everything else
(the rooms, `maySee`, the dependency-set tags, the tag→queryKey map,
over-send-vs-tight, the broker wiring) is **derived**. So "sometimes it's obvious
to just over-send" *is the default behavior of `live`*, and the whole apparatus in
this proposal is what makes that default both **correct** (the refetch gates) and
**affordable** (active-only refetch + coalescing + `304`s + free room-tightening).
One-word feature; the compiler spends the design.

## IR, lowering, enrichment

```ts
// src/ir/types/loom-ir.ts  (read-side; the messaging IR lives in channels.md)

// INTEREST — the React Query key; the cache / invalidation / room-routing address.
export interface QueryKeyIR {
  aggregate: string;                       // "orders"
  shape: "collection" | "instance" | "find";
  idField?: string;                        // instance shape
  find?: { name: string; argFields: string[] };
}
// The save->query-keys map (the magic-caching rule), shared with channels' routing.
export interface InvalidationRuleIR {        // save -> the query keys it invalidates
  trigger: { kind: "save"; aggregate: string };  // SAVE-driven only; events are display/choreography
  invalidates: QueryKeyIR[];               // tags this save evicts / pushes a ticket to
}
// Per cacheable read:
export interface ReadCacheIR {
  mode: "none" | "tagged";
  ttl?: number;
  tags: string[];                          // DERIVED dependency set: type / instance / param tags
  tier: "edge" | "in-handler";             // DERIVED from authz shape
  // visibility partition reuses DataKey from authorization.md — not redefined here
}
```

- **⑥ enrich** — derive each read's **dependency set** (walk source aggregates →
  type/instance/param tags), its **tier** (from the read's authz shape), and the
  **`InvalidationRuleIR`** per `save`. Sibling of the `migrationsOwner` /
  channel-routing enrichments.
- **⑦ validate** — `loom.cache-*` checks (need the resolved dependency + authz
  graph).
- **⑧ codegen** — per backend: the in-handler read-through (HybridCache / Redis
  reverse-index) keyed by effective scope + tags; the tag headers / OutputCache
  policy for the public/tenant edge slice; the React Query **tag → queryKeys
  registry** + `predicate` invalidation on the client.
- **⑨ compose** — the eviction wiring shares the channels part's dispatcher seam: the
  same `save`/event that publishes a realtime ticket also evicts the cache by the
  same tags. Emit a `.loom/cache-tags.md` view of the dependency graph.

## Slice plan

1. **`cached:` surface + dependency-set derivation** — grammar, `ReadCacheIR`,
   `InvalidationRuleIR` from `save`, `loom.cache-*` validators,
   `.loom/cache-tags.md`. No runtime change. (parse + negative-validator + IR
   tests.)
2. **In-handler read-through, tenant tier** — Redis (Hono) / HybridCache (.NET)
   keyed by `(tenant, query, params)`, tag eviction on `save`. (`LOOM_TS_BUILD` /
   `dotnet-build`.)
3. **Per-user tier (below the gate)** — effective-scope key (`tenant + DataKey +
   perms`); depends on `authorization.md` + `multi-tenancy`. (`LOOM_E2E`, two
   principals: assert no cross-principal hit.)
4. **Client invalidation subscription** — tag → queryKeys registry + `predicate`
   invalidation; coalescing; ETag/304 refetch. Rides the channels part's realtime
   delivery. (`LOOM_REACT_BUILD`.)
5. **Edge tier** — CDN `Surrogate-Key` headers + purge; optional ASP.NET
   OutputCache policy for the public/tenant slice.
6. **Projection-backed reads** — wide dependency sets → maintained projection
   with its own key (joins with `workflow-and-applier.md`).

## Open questions / deferred

- **Field-level masking.** This covers *whether* a principal receives/refetches a
  read, not *which fields* are returned. Field masking (`authorization.md`) is a
  read-path concern; the cache key must include the masking profile if cached
  shared. Deferred.
- **Transition invalidation needs old+new** in the change signal for discrete
  param tags; requires the `save` seam to carry a before-image. Deferred (falls
  back to type tag meanwhile).
- **Reconnect/replay** for an eager invalidation subscription over a `retention: log` channel — resume from
  cursor vs rejoin live (per-room cursor). Shared with the channels part's deferred
  list.
- **Cross-aggregate consistency** of a cached read vs the events that built it
  (read-your-writes after a coalesced invalidation window). Deferred.

## See also

- [`bounded-context-model.md`](./bounded-context-model.md) — publish/subscribe
  placement, `on(e: Event)` / `projection`, `.loom/asyncapi.yaml`.
- [`workflow-and-applier.md`](./workflow-and-applier.md) — the workflow body
  (reused verbatim by reactors), appliers (reused by projections), sagas.
- [`docs/architecture.md`](../../architecture.md) — `storage` / `dataSource`
  split this proposal mirrors with `channelSource`.
- [`docs/workflow.md`](../../workflow.md) — the `emit` producer + dispatcher seam.
- [`deployable-networking.md`](./deployable-networking.md) — inter-deployable
  wiring (the synchronous peer to this proposal's async channels).
  invalidation. Owns the interest/query-key model, the event→query-keys map,
  HTTP surrogate-key cache tiers, and the `cached:` surface. Consumes this
  proposal's `save`/event stream and realtime delivery.
- [`authorization.md`](./authorization.md) + [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
  — `DataKey` / `tenancy by` / `currentUser.dataKey`: the visibility prefix the
  room **reuses** rather than redefines.
- [`production-readiness.md`](./production-readiness.md) §3.4 — the caching gap,
