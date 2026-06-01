# Channels — async messaging, queues, and realtime

> Status: **PROPOSAL** — not adopted. Depends on the publish/subscribe
> placement rules pinned by
> [`bounded-context-model.md`](./bounded-context-model.md) and the
> `on(e: Event)` / `projection` consumer surface foreshadowed there and in
> [`workflow-and-applier.md`](./workflow-and-applier.md). This proposal adds
> the **transport tier** those two leave open: the *kinds* of delivery
> (pub/sub vs work-queue vs durable stream), which broker backs each, and
> realtime push to the browser (WebSocket / SSE).

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
  projection OrderBook from Orders.Lifecycle {
    on OrderPlaced(e)   { upsert { order: e.order, status: Placed } }
    on OrderShipped(e)  { set status = Shipped where order = e.order }
  }
}
```

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
by no channel the hosting deployable binds), `loom.reactor-channel-mismatch`
(`via X` where `X` doesn't carry the event), `loom.reactor-channel-ambiguous`
(no `via` but the event is carried by more than one bound channel — name one),
plus the inherited `cross-bc-internal-event`.

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
  platform:    hono
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
| `broadcast` | `ephemeral` | `inMemory`, `redis` | yes |
| `broadcast` | `log`       | `kafka` | yes (replay-from-cursor) |
| `queue`     | `ephemeral` | `redis`, `rabbitmq` | no — competing consumers |
| `queue`     | `work`      | `redis`, `rabbitmq`, `kafka` | no — competing consumers |

`loom.channelsource-incompatible` fires on a mismatch (e.g. `retention: work`
bound to a bare `inMemory` with no durability), carrying the same
suggestion-with-alternatives shape as the existing dataSource matrix error.
Note the last column is a *semantic* property (a browser can't join a work
group) — **not** a transport choice; SSE-vs-WebSocket doesn't appear here.

## WebSockets / SSE — an infrastructural concern, not a contract knob

SSE and WebSocket are two wire formats for the same thing: pushing a
`broadcast` channel's events to a browser. The delivery semantics are
identical, so the **`channel` says nothing about which is used** — just as it
says nothing about Redis-vs-Kafka. A channel becomes UI-observable simply
because a UI *subscribes* to it; nothing is declared on the producer side.

The channels-owned UI surface is the **live-event subscription** (a `channel`
param + an `on Param.Event(...)` handler). A live *read* — a list/detail kept
fresh — needs **no marker**: an ordinary cached query is auto-invalidated (see
[`caching.md`](./caching.md)); it rides this same wire but carries tickets, not
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
    // its freshness semantics are caching.md's, it rides the wire below.
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
// (Live READS need no UI syntax — a cached query is auto-fresh; see caching.md.)
UiChannelParam: 'channel' name=ID ':' channel=[Channel:ID];
UiNotification:  'on' param=[UiChannelParam:ID] '.' event=[EventDecl:ID]
                 '(' bind=ID ')' '{' body+=Statement* '}';
```

Per-frontend lowering of the realtime wire (both planes ride it):

| Platform | Realtime mechanism | Lowers to |
|---|---|---|
| **React** (`hono`/`static` target) | `EventSource` (SSE) or `WebSocket` client in the generated `api/` client | one subscription; an **event** ticket → render via the `on` handler; an **invalidation** ticket → `queryClient.invalidateQueries([...])` (caching.md). |
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
deployable salesApi  { platform: hono;   contexts: [Orders]    // DU X — producer
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
  `tenant.orders` for admins) and pushes to `registry[room]` — a constant
  fan-out, never per-subscriber iteration. Total work = O(interested connections).

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
[`caching.md`](./caching.md).

| # | Plane | Room keyed by | Payload | Source | Home |
|---|---|---|---|---|---|
| 1 | **Cache invalidation** | resource (type / id) | **ticket** (no data) | implicit `save` | [`caching.md`](./caching.md) |
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
[`caching.md`](./caching.md). Showing the *events themselves* — a feed of
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
[`caching.md`](./caching.md). The two proposals share **one key vocabulary** (the
resource key for *what changed* + `DataKey` for *who may see it*), defined once
and reused on both sides.

> **Read-side summary** (see [`caching.md`](./caching.md) for the full design):
> a cached on-screen query is auto-invalidated: a `save` publishes an
> *invalidation ticket* (not data) for the affected query keys; the client
> refetches through the already-authorized read (so per-user filtering never
> enters the push layer); the *same* ticket evicts the server cache and purges
> CDN surrogate keys. Caching is invalidation-based (cache hard, purge exactly),
> tag sets are derived dependency sets (joins/lists key by type, wide sets
> graduate to a `projection`), and the cache tier is chosen by the read's authz
> shape (per-user reads cache in-handler below the gate, not in OutputCache).

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
//   used in caching.md (cache key = invalidation key = room-routing key). The
//   delivery side only needs the resource room; the client maps it to its query
//   keys. So `InvalidationRuleIR` / `QueryKeyIR` live in caching.md, not here.
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
  caching.md, reusing this same routing seam.) Derive, per frontend deployable,
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
| **Phoenix LiveView** | `Phoenix.PubSub.broadcast(topic)` (ephemeral) / Broadway + Ash (durable), where `topic` is the room. | an Ash reactor / `GenServer` `handle_info` running the reactor body as an Ash action. | **native** — `subscribe` to the room topic derived from `socket.assigns.current_user`; `handle_info` re-assigns the stream. Rooms are just PubSub topics. |
| **React** (consumer of realtime) | — | — | generated SSE/WS client; connects with its bearer token (server derives rooms). For *plane-1 invalidation* refetch semantics (`invalidateQueries`), see [`caching.md`](./caching.md). |

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

  deployable salesApi  { platform: hono; contexts: [Orders];   serves: SalesApi
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
   [`caching.md`](./caching.md). (`LOOM_REACT_BUILD`.)
5. **Plane 2/3 — live view + notification** — explicit `emit`, payload-carrying,
   addressing mode resource/recipient/topic; subscribe-time scoping; delivery to
   the browser. The explicit "live dashboard"/notification feature. (Plane 1,
   invalidation, is [`caching.md`](./caching.md).)
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

## See also

- [`bounded-context-model.md`](./bounded-context-model.md) — publish/subscribe
  placement, `on(e: Event)` / `projection`, `.loom/asyncapi.yaml`.
- [`workflow-and-applier.md`](./workflow-and-applier.md) — the workflow body
  (reused verbatim by reactors), appliers (reused by projections), sagas.
- [`docs/architecture.md`](../architecture.md) — `storage` / `dataSource`
  split this proposal mirrors with `channelSource`.
- [`docs/workflow.md`](../workflow.md) — the `emit` producer + dispatcher seam.
- [`deployable-networking.md`](./deployable-networking.md) — inter-deployable
  wiring (the synchronous peer to this proposal's async channels).
- [`caching.md`](./caching.md) — **the read-side companion**: reads, freshness &
  invalidation. Owns the interest/query-key model, the event→query-keys map,
  HTTP surrogate-key cache tiers, and the `cached:` surface. Consumes this
  proposal's `save`/event stream and realtime delivery.
- [`authorization.md`](./authorization.md) + [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
  — `DataKey` / `tenancy by` / `currentUser.dataKey`: the visibility prefix the
  room **reuses** rather than redefines.
- [`production-readiness.md`](./production-readiness.md) §3.4 — the caching gap,
  now addressed by [`caching.md`](./caching.md).
