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
gets a transport; `projection` gets defined), and a UI `.live` subscription
ref. Realtime push to the browser needs **no** contract knob — it's derived
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

  // fire-and-forget metrics — ephemeral broadcast (a dashboard UI can go .live on it)
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
| `loom.live-uncacheable` | a `.live` binding doesn't resolve to a stable React Query key (the interest/cache key) — so there's nothing to route or invalidate by. See [Authorization vs interest](#authorization-vs-interest--two-different-keys-not-one). |

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

| `delivery` | `retention` | Compatible `storage.type` | UI-subscribable (`.live`) |
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

```ddd
ui WebApp {
  api     Sales:  SalesApi
  channel Orders: Orders.Lifecycle     // subscribe — wire format is derived, not stated

  page OrderBoard {
    route: "/board"
    // .live: the list re-fetches / patches its cache when Orders carries a
    // relevant event — instead of polling.
    body: For { Sales.Order.all.live, o => Card { o.id, o.status } }
  }

  // Explicit notification handler (toast, badge, navigate).
  on Orders.OrderShipped(e) { toast("Order " + e.order + " shipped") }
}
```

**Where the wire format is decided.** Derived from the frontend's platform,
with an optional override at the *deployable* — the same tier as `port:`, an
infra fact:

| Frontend platform | Default wire | Why |
|---|---|---|
| React (`static` target) | **SSE** | one-way server→client fits `.live` invalidation; survives proxies; no upgrade handshake. |
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
// UiMember += UiChannelParam ; plus a `.live` query suffix and `on Param.Event(p){…}` handler
UiChannelParam: 'channel' name=ID ':' channel=[Channel:ID];
UiNotification:  'on' param=[UiChannelParam:ID] '.' event=[EventDecl:ID]
                 '(' bind=ID ')' '{' body+=Statement* '}';
```

Per-frontend lowering of the *same* `.live` IR:

| Platform | Realtime mechanism | `.live` lowers to |
|---|---|---|
| **React** (`hono`/`static` target) | `EventSource` (SSE) or `WebSocket` client in the generated `api/` client | subscribe in a `useEffect`; on event → `queryClient.invalidateQueries([...])` (or a targeted `setQueryData` patch keyed by `channel.key`). |
| **Phoenix LiveView** | **native** — `Phoenix.PubSub.subscribe` + `handle_info` | a `handle_info({:order_shipped, …}, socket)` that re-`assign`s the stream; LiveView diffs and pushes over its own WebSocket. No client code. |

This is where the layering pays off: Phoenix LiveView's WebSocket fabric is
*already* a channel transport, so native WebSocket is free there, while React
gets an SSE (or WS, if the deployable overrides) client generated against the
same channel contract — all from the *same* `.live` IR. The wire format is a
`PlatformSurface` capability (`realtimeWire: "sse" | "websocket"`), defaulted
per platform and overridable on the deployable; the channel and the page body
are identical regardless.

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

> If a UI `.live`-subscribes to (or takes a `channel` param of) channel `C`,
> the UI's deployable `targets:` a backend deployable that **must** bind `C`.
> Otherwise `loom.live-target-not-subscribed` fires:
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

- **Interest (routing) is the query key**, verbatim — `Order.byId(42).live` →
  room for `["orders", 42]`; `Order.all.live` → room for `["orders"]`;
  `Order.mine().live` → room for `["orders","find","mine",…]`. The page already
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

### `.live` ⇒ subscribe to the query key's invalidations — the magic-caching link

This is the link the realtime `.live` ref leans on, made concrete. The frontend
already turns a local mutation into `queryClient.invalidateQueries(queryKey)`;
"magic caching" (`production-readiness.md` §3.4) turns a *server-side* event into
eviction of the **same** query keys ("the generated React Query keys already
form the invalidation prefixes"). The one piece of derived logic both need is the
**event → query-keys map**: *which cached queries does `OrderShipped{order:42}`
invalidate?* → `["orders"]`, `["orders", 42]`, and any `find` whose result the
event could change.

`.live` is then exactly: **"keep this query's React Query entry live; on an
invalidation ticket, refetch or patch — the same ticket the server cache evicts
by."** So three things share **one map and one key**, with `DataKey` as the
orthogonal visibility envelope around all of them (with one refinement the next
section makes: the *server* room is keyed by **resource**, and the client maps
that to its query keys via prefix invalidation — a list query key can't be a
server room):

| Consumer | Reads the **query key** as | On an event |
|---|---|---|
| **Server cache** (`production-readiness.md` §3.4) | cache-entry key | evict matching query-key prefixes |
| **Channel room** (this doc) | broker room / subject | publish a ticket to `{tenant}:{queryKey}` |
| **`.live` (client)** | React Query key | `invalidateQueries` → refetch / patch |

The event→query-key map is therefore **derived once and shared**: the publisher
computes the invalidated query keys for an emitted event (this *is* the magic-
caching rule), publishes a ticket to each `{tenant}:{queryKey}` room, the server
cache evicts those keys, and every `.live` socket admitted to those rooms
refetches. **The interest/cache/realtime key is the query key; the visibility
key is `DataKey`. Two keys, each doing its own job.**

**Validation** (`loom.live-*`):

| Code | Rule |
|---|---|
| `loom.live-uncacheable` | a `.live` binding doesn't resolve to a stable React Query key (the interest/cache key) — nothing to route or invalidate by. See [Authorization vs interest](#authorization-vs-interest--two-different-keys-not-one). |
| `loom.live-on-queue` | a UI goes `.live` on a `delivery: queue` channel — a browser can't join a competing-consumer group. Subscribe to a `broadcast` channel carrying the same event. |
| `loom.live-target-not-subscribed` | the backend the UI `targets:` doesn't bind the channel, so no edge relay exists. Add a `channelSource` to that backend's `channels:`. |

The honest boundary: this proposal *defines and emits* the event→query-key map
and routes realtime by it. Wiring it into a read-through server cache is
`production-readiness.md` §3.4's job and stays out of scope here — but that
proposal will find the map already built, not have to invent it.

### Realtime is not one feature — at least three planes

> **Design note (open).** Working through the keying above surfaced that
> "realtime" is *not* a single mechanism. Cache-invalidation and a live
> dashboard look similar but are **opposites** on every axis, and forcing them
> through one path is the root of the earlier confusion. The surface below is a
> reframe still to be ratified, not yet pinned grammar.

| # | Plane | Room keyed by | Payload | Source | Scoping / leak risk |
|---|---|---|---|---|---|
| **1** | **Cache invalidation** (freshness) | **resource** (type / id) | **ticket** — no data | implicit, from **`save`** | *none* — refetch is authz'd; over-broadcast is harmless |
| **2** | **Live view / feed** (dashboard, activity stream) | resource or topic | **event data** | explicit `emit` | **high** — data crosses to the browser; must be scoped at subscribe |
| **3** | **Targeted notification** ("your order shipped") | **recipient** (user id) | event data | explicit event w/ recipient field | inherent — the address *is* the scope |
| 4 | Presence / typing / cursors (deferred) | topic, ephemeral | ephemeral state | not events | session-scoped |
| 5 | Job / export progress (deferred) | correlation / job id | progress | extern / job | single recipient |

Planes 1 and 2 are **opposites**: #1 carries no data, tolerates over-broadcast,
is automatic and invisible, and is safe *by construction* (a ticket can leak
only "something changed"); #2 carries data, must be scoped correctly, is
explicit and designed. They should **not** share a mechanism — different
default, different source, different payload.

Two consequences that correct earlier sections:

- **The list query key is a client identity, not a server room.** `["orders"]`
  means *"my* orders" — a different authorized projection per user and per
  filter (`mine`, `status:open`, …). The server cannot enumerate which filtered
  list keys an event touches without running every user's filter (fan-out-then-
  filter again). **So the server keys rooms by *resource* (`tenant.orders`,
  optionally `tenant.orders.42`), not by query key.** The client receives
  "orders changed" and runs React Query **prefix invalidation** locally —
  `invalidateQueries(["orders"])` already covers `["orders"]`, `["orders",42]`,
  `["orders","find","mine"]` — refetching each through the **authz'd read
  endpoint**. Per-user list filtering never enters the push layer.
- **Invalidation rides `save`, not events.** Event→aggregate isn't always
  derivable (events may be context-level or cross-aggregate). But every
  `repo.save(agg)` already knows the type and id, so **"order 42 changed" is
  free from the save** — no DSL, no event→aggregate map. Explicit `emit` is the
  *richer* layer (planes 2/3) for when you want semantics, not just "it changed."

This makes **addressing mode** (resource / recipient / topic / correlation) the
realtime-layer analogue of `delivery`×`retention` for the queue layer — a small
closed set, each with its scoping discipline baked in. Build order: plane 1
first (implicit, ticket-only, no events, no per-user push logic), then plane 2/3
(explicit, payload, scoped). Planes 4–5 deferred.

### Won't broad invalidation storm the server? — the standard mitigations

Invalidating `["orders"]` on every order change *sounds* like a refetch storm.
It isn't, for four well-established reasons — and the third is exactly why
invalidation and caching are one feature:

1. **Only *active* queries refetch.** React Query's default: invalidating a key
   **marks inactive (unmounted) queries stale and refetches them lazily on next
   mount** — it does *not* refetch every cached list. The herd is bounded by
   what's *on screen right now*, not everything ever cached. The dashboard user
   refetches; the 10 000 users not looking at orders do nothing.
2. **Coalesce tickets.** A burst of 50 saves in 200 ms must yield **one**
   refetch, not 50. Debounce per-room on the relay (and/or per-key on the
   client) over a small window (50–250 ms). Change streams are bursty;
   coalescing is mandatory.
3. **The server read-through cache absorbs the fan-in.** When N clients refetch
   the same invalidated key, the same ticket already evicted the server cache,
   so the first refetch is **one** DB read and the other N−1 are cache hits.
   **N client refetches → 1 database query.** The storm hits warm cache, not
   Postgres — this is the magic-caching payoff, and the reason §3.4 and this
   proposal are the same feature.
4. **Make the refetch cheap.** Conditional GET (ETag / `If-None-Match` →
   `304 Not Modified`), or a version/sequence in the ticket so a client already
   current skips entirely. A 304 is nearly free.

The escape hatch for genuinely hot lists is **patch, don't invalidate**: push
the delta and `setQueryData` it into the cache (no refetch at all). That's
plane 2 — it costs the per-user filtering correctness (you're now pushing data,
so it must be scoped), which is *why* it's the explicit feature, not the
default. So: **broad invalidation is fine — bounded by active queries,
coalesced, absorbed by cache; reserve payload-patching for paths where even a
coalesced cache-hit refetch is too slow.**

### The same ticket caches the HTTP layer — invalidation-based, not expiration-based

> **Design note (open).** A consequence worth stating: because the origin
> **knows exactly when a resource changes** (the `save` → ticket), Loom can cache
> *aggressively* with **zero staleness** — the regime almost no system can use.

Ordinary HTTP caching is **expiration-based**: `max-age=30`, hope, revalidate —
because the origin can't know when data changed, so it guesses with a clock
(stale windows *and* wasted refetches). Loom is invalidation-based: `max-age`
long **and** an explicit purge the instant the aggregate changes. The expensive,
normally-impossible half of caching — *knowing when to bust* — is exactly what
the invalidation map already provides.

The mechanism already exists in every CDN/proxy: **surrogate keys** (Fastly),
**cache tags** (Cloudflare), **xkey** (Varnish). Tag each response with the
resource keys it depends on; **purge by tag** on change. That *is* Loom's
aggregate key + invalidation ticket, so the generator emits the tagging and the
purge for free, and **one ticket cascades through every tier**:

| Tier | Keyed by | Busted by the ticket via |
|---|---|---|
| Browser HTTP cache | `ETag: orders/42@v7` | conditional GET → `304` |
| **CDN / reverse proxy** | `Surrogate-Key: orders.42` | **purge-by-tag** |
| Server read-through cache (§3.4) | `orders.42` | evict |
| Client React Query | `["orders", 42]` | prefix invalidate |

The ETag writes itself — it's the aggregate's **version/sequence**, the same
number you already wanted in the ticket for "skip if current."

**The two keys again — surrogate key vs cache partition.** A *shared* cache must
never serve user A's response to user B, so the HTTP cache needs the *same two
dimensions* we derived for rooms: **interest** = the surrogate key (`orders.42`,
*what to purge*) and **visibility** = the cache partition (`DataKey`/tenant via
`Vary`/keyed cache, *who may share it*). Tenant-wide/public reads → shared,
high-hit, CDN-cacheable; per-user (`mine`) reads → `private` or partitioned by
the full `DataKey`. The compiler knows which, because it knows whether the
read's authz is tenant-level or row-level.

### Structuring the keys — a read carries a *set* of tags (its dependency set)

A response key is **not one tag — it's the set of resources the read depends
on**, and that set is statically derivable from the query/view AST (the same
enrich-phase walk that builds `wireShape`/`findAll`/associations). Two rules
cover the hard cases you'd hit:

- **List vs detail — type tag vs instance tag.** A *detail* read (`byId(42)`)
  depends on one instance → `Surrogate-Key: orders.42`. A *list* read depends on
  the **type, not specific ids** — a row appearing/disappearing changes the list
  and you can't know which id ahead of time → `Surrogate-Key: orders` (the
  collection tag). A save to *any* order purges every orders list; a save to
  order 42 also purges `orders.42`. (`save` publishes both `orders` and
  `orders.42` tickets, so both tiers are covered by one event.)
- **Joined / multi-source views — union of dependency types.** A view joining
  `Order ⋈ Customer` changes when **either** side changes, so its response is
  tagged with **both** type keys: `Surrogate-Key: orders customers`. A save to
  *either* purges it — surrogate keys are a *set*, and a purge of any member
  evicts the entry. A 25-aggregate dashboard read → 25 type tags; any of the 25
  saves busts it. Derivation is mechanical: walk the view/query's source
  aggregates, emit one tag per type (instance tags only when the read is
  parameterized by that id).

**When the dependency set gets too wide — restructure the read, don't add a
cache mode.** Tagging a dashboard with 25 high-write types means any of 25 saves
busts it; correct, but churny. Past some fan-in, broad invalidation is the wrong
tool: that read should be a **maintained read-model / `projection`** (plane 2;
`bounded-context-model.md`, `workflow-and-applier.md`) — updated incrementally
from the event stream so 25 upstream types collapse to one resource. **A
projection is *not* a cache mode** — it's a different read whose *output* is
cached with tags like any other (its single resource tag instead of 25). So
there are exactly **two cache modes** — `none` and `tagged` — and "graduate to a
projection" is advice about restructuring the read, not a third mode. The
compiler can *warn* (`loom.live-wide-dependency`) when a `cached: tagged` read's
dependency set exceeds a threshold, suggesting a projection.

```ddd
// The only cache surface — per read (find / view / projection output):
cached: none      // default for hot / wide / continuous-param reads
cached: tagged    // surrogate-key invalidation; optional `ttl:` as a backstop
```

### Parametrized reads — linking frontend params to server tags

A view/projection knows what it's built from, but it can also be *parametrized*
(`OrdersByStatus(status)`), and the parameter is supplied on the **frontend**.
They link the **same way the room key does**, one tier up: when the parameter is
a **discrete equality on a field the event carries**, the value is baked into
the tag, and both sides render the *same string* independently —

```
view OrdersByStatus(status)  →  response tag  orders.status.open
frontend ["orders","byStatus","open"]  →  same tag  orders.status.open
```

Neither side knows the other; they meet on the string. The correctness subtlety:
when a row's filter field **changes**, the row *moves between partitions*, so the
save must purge **both** the old and the new tag — `OrderStatusChanged{old, new}`
busts `orders.status.open` *and* `orders.status.closed`. That **transition
invalidation** needs old+new in the event, and is only derivable for **discrete,
enumerable** params.

It **does not work** for continuous / range / full-text params
(`OrdersByTotal(min,max)`, `OrdersSearch(q)`) — you can't mint a tag per range or
query string. Those fall back to the **type tag** (`orders`, bust-all) or
graduate to a **projection** (a maintained range/search index keyed by its own
identity). This is the honest line: **discrete param → tight tag; continuous
param → coarse type tag or projection.** And it confirms the instinct that *some
reads get busted constantly under aggressive caching* — which is why **caching is
opt-in per read, and the correct default for hot/wide/continuous reads is `cached:
none` (or a debounce), not cache-and-thrash.** The compiler picks the regime from
the dependency set + param shape; the author can override.

### What tag-invalidation actually looks like, per tier

The claim "one ticket busts every tier" only holds if each tier *supports*
tag/surrogate-key purging. Honest status — two tiers are first-class, the rest
use a standard pattern, and one (React Query) is where Loom's compile-time
dependency set genuinely earns its keep:

| Tier | Native tag-purge? | Mechanism Loom emits |
|---|---|---|
| **CDN / reverse proxy** | **Yes, first-class** | `Surrogate-Key:` header + purge-by-key (Fastly); `Cache-Tag` + purge (Cloudflare); `xkey` vmod (Varnish). Emit the header on reads; POST the purge on the ticket. |
| **ASP.NET Core** | **Engine yes; tags must be runtime** | Output Caching (.NET 7+) + `IOutputCacheStore.EvictByTagAsync(tag)`. But `[OutputCache(Tags=[…])]` takes **compile-time constants only** — fine for `orders`, useless for `orders.{id}`. Loom emits a custom **`IOutputCachePolicy`** that adds `{type}.{id}` + param tags from route values at request time (see below). |
| **Redis** | **No native tags** — *standard* pattern | Reverse-index set per tag: on store `SADD tag:orders <key>`; on purge `SMEMBERS tag:orders` → `UNLINK` each + the set. Exactly Symfony `RedisTagAwareAdapter` / Laravel cache-tags. |
| **Hono / Node, Phoenix** | No native | Same Redis reverse-index, or rely on the CDN / ASP.NET tier in front. |
| **React Query (client)** | **No tag concept — the key *is* the tag** | `invalidateQueries({queryKey})` prefix-matches a **single hierarchical path**. It *cannot* natively express "depends on `orders` **and** `customers`" (the joined-view case). So Loom emits a **tag → queryKeys registry** and the `.live` handler invalidates via `predicate` against it. |

The takeaway: surrogate-key invalidation is a **mature, supported pattern** at
the CDN and ASP.NET tiers and a **well-trodden** one on Redis — Loom isn't
inventing a cache, it's *emitting the tags and purge calls* into mechanisms that
already exist. The one real gap is **React Query's single-path key**, which can't
represent a multi-dependency response; that map is normally hand-maintained and
drifts, and is precisely what Loom can derive from the query/view AST for free.

**Tags are runtime values — so an attribute can't carry them.** This is general,
not an ASP.NET quirk: the instance tag `orders.42` and a param tag
`orders.status.open` come from the **request** (route values / claims), so they
must be computed *per request*, not declared statically. The type tag `orders` is
the only constant. So on every tier Loom sets tags at request time:

- **CDN**: the read handler writes `Surrogate-Key: orders orders.42` into the
  response headers (computed from route + the resolved aggregate).
- **ASP.NET Core**: **one generic** `IOutputCachePolicy` — *not* the attribute,
  and not one class per aggregate — configured per endpoint with the type tag,
  deriving the instance tag from the route in `ServeRequestAsync`:

  ```csharp
  sealed class AggregateTagPolicy : IOutputCachePolicy {           // generated ONCE, generic
    private readonly string _type;                                 // injected per endpoint: "orders"
    public AggregateTagPolicy(string type) => _type = type;
    public ValueTask ServeRequestAsync(OutputCacheContext ctx, CancellationToken ct) {
      var rv = ctx.HttpContext.Request.RouteValues;
      ctx.Tags.Add(_type);                                          // constant type tag
      if (rv.TryGetValue("id", out var id)) ctx.Tags.Add($"{_type}.{id}");  // runtime instance tag
      ctx.CacheVaryByRules.VaryByValues["tenant"] = /* currentUser.tenantId */;  // shared-cache safety
      return ValueTask.CompletedTask;
    }
    /* ServeResponseAsync / EvaluatePolicyAsync: defaults */
  }
  ```
  endpoints get `.CacheOutput(p => p.AddPolicy<AggregateTagPolicy>().Tag("orders"))`
  — per-aggregate *configuration*, one shared class; the dispatcher/ticket handler
  calls `await store.EvictByTagAsync("orders.42", ct)` on `save`.
- **Redis / Hono / Phoenix**: the reverse-index `SADD tag:orders.42 <key>` is
  likewise written at store time from the runtime tag set.

So the `[OutputCache(Tags=…)]` attribute is used (if at all) only for the bare
type tag; everything instance- or param-relative goes through the policy — which
is exactly why tags are "aggregate-relative" and live in generated code, not in a
static annotation.

### Where the cache may live — auth decides the tier, not preference

A subtle but **load-bearing** constraint: if authorization (`requires`, policy,
row-filter) runs as a **MediatR pipeline behavior** — *below* the controller —
then ASP.NET **OutputCache sits in front of it**, and a cache *hit
short-circuits the pipeline entirely*. OutputCaching a per-user read would serve
user A's response to user B and **never run the auth behavior**. That's not a
perf detail; it's a vulnerability. So:

> **A cache may live above the auth boundary only if the response is identical
> for everyone who passes that boundary.** Otherwise it must live *below* the
> gate, keyed by the authorized effective scope.

`cached: tagged` therefore resolves to a **tier the compiler picks from the
read's authz shape** (it already knows it — same analysis as the room visibility
key):

| Read's authz | Response varies by | Cache tier | Mechanism |
|---|---|---|---|
| **public** (`crossTenant`) | nothing | **above** auth | CDN + OutputCache — fully shared, the big win |
| **tenant-scoped** | tenant | **above** auth, keyed by tenant | OutputCache `VaryBy` tenant / CDN per-tenant |
| **row-level / per-user** | the principal's `DataKey` + perms | **below** auth only | server read-through *inside* the handler, keyed by effective scope |

For the row-level case the read-through cache lives **below the gate**: the auth
behavior always runs (it's a cheap predicate over claims), produces the
**effective scope** (`tenant + DataKey + relevant perms`), and *that* is part of
the cache key — `(effectiveScope, query, params)` — populated and evicted by the
same tags. Two invariants:

- **The capability gate (`requires` → 403) is never cache-served.** It re-runs
  every request; only the *data* it admits is cached. (So OutputCache, which
  caches the whole response, is admissible *only* for the public/tenant rows;
  per-user reads cache below the gate.)
- **The visibility key reappears** — the same `DataKey`/tenant split from the
  room design now decides *which tier the cache can sit on* and forms the
  per-principal key below the gate.

Honest consequence: **edge/HTTP caching pays off only for public + tenant
reads.** Per-user reads can't be shared at the edge at all — their win is the
server read-through (that user's N requests → 1 DB read, reused across their
session), not the CDN. "Cache aggressively" is true **per tier**, gated by authz
shape — not uniformly.

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

// TWO orthogonal keys (see "Authorization vs interest — two different keys"):
//
//   VISIBILITY — `DataKey` from authorization.md (tenancy = segment 0). Answers
//   "may this user see this at all?". JWT-pinned; the client cannot widen it.
//   Reused, NOT redefined here. Serves both as the room's isolation namespace
//   and as the subscribe-time admission predicate (the same read-side authz that
//   gates GET /orders/42).
//
//   INTEREST — the React Query key. Answers "which data does this page want?".
//   It is ALSO the cache key and the invalidation key — the magic-caching link.
//   Derived from the page's `.live` binding; nothing new is declared.
//
// Room address = {tenantNamespace} : {queryKey}. Realtime delivery, cache
// eviction, and client invalidateQueries are all PREFIX matches over it.
export interface QueryKeyIR {            // = React Query key; the interest/cache/invalidation address
  aggregate: string;                     // "orders"
  shape: "collection" | "instance" | "find";
  idField?: string;                      // instance shape: the aggregate id field
  find?: { name: string; argFields: string[] };
}
export interface EventInvalidationIR {   // the magic-caching rule, SHARED with production-readiness §3.4
  event: string;                         // e.g. "OrderShipped"
  invalidates: QueryKeyIR[];             // query keys this event evicts / pushes a realtime ticket to
}
// ChannelIR gains (derived in enrich):
//   visibility:      DataKeyRef            — namespace + admission, from authorization.md (reused)
//   invalidationMap: EventInvalidationIR[] — one entry per carried event
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
  `emit` goes. Build each carried event's **`EventInvalidationIR`** (the
  query keys it invalidates — the magic-caching rule) and each channel's
  **visibility** `DataKey` ref (tenant namespace + admission). The room a ticket
  is published to is `{tenant}:{queryKey}`; the room a socket joins is the same,
  with admission by the read-side authz. This map is what the room-publish
  (server), room-subscribe (relay), and (later §3.4) cache-eviction emitters all
  consume. Derive, per frontend deployable, the resolved realtime wire
  (`realtimeWire` override ?? `PlatformSurface` default) and the set of
  channels any of its pages `.live`-subscribe. This is the natural sibling of
  the existing `migrationsOwner` enrichment.
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
| **Hono** | `DomainEventDispatcher` that fans an event to each carrying channel's driver: in-proc `EventEmitter` / `ioredis` pub/sub / `kafkajs` producer / `amqplib`. Publishes an invalidation ticket to each `{tenant}:{queryKey}` room the event's `EventInvalidationIR` names (e.g. `acme:["orders"]` and `acme:["orders",42]`). | per-channel subscriber loop → reuses the generated **workflow handler** for the reactor body; `queue` ⇒ consumer-group / `BLPOP`; ack on success. | `streamSSE` / `ws` endpoint; on connect runs `requires:` (403 on fail) and joins the socket **only** to the rooms computed from `currentUser` claims — never a client-supplied room. |
| **.NET** | `IDomainEventDispatcher` → in-proc MediatR notification / MassTransit publish (Redis/RabbitMQ/Kafka transport) — DI-registered like the existing `AddScoped` repos. Rooms from the event's `EventInvalidationIR` (`{tenant}:{queryKey}`). | `IConsumer<T>` / `INotificationHandler<T>` invoking the reactor's Mediator command (same handler the workflow controller calls). | SSE (`text/event-stream`) or a SignalR hub; SignalR **Groups** *are* rooms — `Groups.AddToGroupAsync(conn, roomFromClaims)` after the `ICurrentUserAccessor` auth gate. |
| **Phoenix LiveView** | `Phoenix.PubSub.broadcast(topic)` (ephemeral) / Broadway + Ash (durable), where `topic` is the room. | an Ash reactor / `GenServer` `handle_info` running the reactor body as an Ash action. | **native** — `subscribe` to the room topic derived from `socket.assigns.current_user`; `handle_info` re-assigns the stream. Rooms are just PubSub topics. |
| **React** (consumer of realtime) | — | — | generated SSE/WS client; connects with its bearer token (server derives rooms); on a ticket, `.live` runs `invalidateQueries(queryKey)` — the same key the server cache evicts. |

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
        delivery: broadcast           // ⇒ a UI may .live-subscribe; wire format is infra
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
      body: For { Sales.Order.all.live, o => Card { o.id, o.status } } }
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
events, delivery, and durability (no wire protocol); the `ui` `.live` ref tells
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
4. **UI `.live` over SSE (React), broadcast to all** — derived SSE endpoint +
   generated client + `.live` cache invalidation; `realtimeWire` defaulting on
   `PlatformSurface`. **Single-tenant, no `scope:` yet.** (`LOOM_REACT_BUILD`.)
5. **Plane 1 — invalidation (tickets from saves)** — implicit `save` → resource
   ticket on `tenant.<type>` (+ `tenant.<type>.<id>`), `DataKey` tenant namespace
   + subscribe-time admission, ticket coalescing, and the client `.live` →
   **prefix invalidation + authz'd refetch** (no server-side list keys). Plane 1
   from the multi-plane reframe; needs no events. (`LOOM_E2E`, two tenants, a
   list page and a detail page; assert no cross-tenant ticket and one DB read
   under N refetches.)
6. **Plane 2/3 — live view + notification** — explicit `emit`, payload-carrying,
   addressing mode resource/recipient/topic; subscribe-time scoping; the
   `setQueryData` patch path for hot lists. The explicit "live dashboard"
   feature. Depends on slice 5.
7. **Phoenix-native realtime + WebSocket override** — `Phoenix.PubSub` (rooms =
   topics) + LiveView `handle_info`; the optional `deployable realtime:
   websocket` infra override. (`LOOM_PHOENIX_BUILD`.)
8. **Kafka + `retention: log`** — durable streams, partition by `key`,
   `projection` replay-from-cursor. (`LOOM_E2E`.)
9. **RabbitMQ / `queue` + `work`** — competing consumers, ack semantics.

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
- [`authorization.md`](./authorization.md) + [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
  — `DataKey` / `tenancy by` / `currentUser.dataKey`: the authz prefix the room
  key **reuses** rather than redefines.
- [`production-readiness.md`](./production-readiness.md) §3.4 — the (unwritten)
  caching proposal that consumes the *same* `EventInvalidationIR` / query-key map for prefix
  invalidation; this proposal builds the key, that one evicts by it.
