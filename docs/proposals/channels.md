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
| `loom.ui-live-on-queue` | a UI goes `.live` on a `delivery: queue` channel (a browser can't join a competing-consumer group) — error: subscribe to a `broadcast` channel carrying the same event. Lives in the UI/realtime checks, not on the channel. |
| `loom.ui-channel-target-not-subscribed` | a UI subscribes to channel `C`, but the backend its frontend `targets:` does not bind `C` — so no edge relay exists. Suggestion: add a `channelSource` for `C` to that backend's `channels:`. See [Realtime topology](#realtime-topology--the-edge-relay-browser-delivery-is-two-hop). |
| `loom.live-interest-unkeyed` | a page uses an instance-scoped `.live` (`Order.byId(x).live`) on a channel whose `key:` is not that aggregate's id — there's no interest leaf to subscribe to, so it would fall back to the whole authz room. See [Authorization vs interest](#authorization-vs-interest--a-detail-page-wants-one-aggregate-not-the-firehose). |

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
> Otherwise `loom.ui-channel-target-not-subscribed` fires:
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
shouldn't see them. Real systems are multi-tenant and per-user, so the relay
must scope **before** the byte leaves the server. Loom already scopes *reads*
three ways — and the push path reuses all three verbatim:

| Scoping tier | Read-side (today) | Push-side (this proposal) |
|---|---|---|
| **Tenant** | every aggregate tenant-scoped by default, fail-closed (`tenancy by user.tenantId`, `multi-tenancy-design-note.md`) | channel auto-partitioned by tenant — one subchannel (room) per `tenantId` |
| **Row / owner** | `find mine() where customerId == currentUser.customerId` (`docs/auth.md`) | `scope:` predicate, *same shape* — one subchannel per scope-key value |
| **Capability** | `requires currentUser.permissions.contains(…)` (403) | the *same* `requires` evaluated at connect — rejects the SSE/WS handshake with 403 |

A **subchannel** is a server-derived address (a "room") within a channel. The
fan-out happens at the broker/relay by room key, so the relay never evaluates a
per-connection predicate.

```ddd
context Orders {
  // NOTE: the scope key must be IN the payload (customerId), so the relay can
  // route without a DB lookup — see the validation rule below.
  event OrderPlaced  { order: Order id, customerId: Customer id, at: datetime }
  event OrderShipped { order: Order id, customerId: Customer id, at: datetime }

  channel Lifecycle {
    carries:  OrderPlaced, OrderShipped
    delivery: broadcast
    retention: log
    key: order
    // Per-customer rooms. Equality between a carried-event field and a
    // currentUser field — identical to a `find ... where` row filter.
    scope:    customerId == currentUser.customerId
    // Capability gate at connect (optional) — same `requires` as an operation.
    requires: currentUser.permissions.contains(permissions.ordersRead)
  }
}
```

**Two properties make this safe *and* cheap:**

1. **The room key is derived from verified JWT claims, never client-supplied.**
   The browser cannot ask for tenant `acme` or customer `123`; the relay
   computes the room from `currentUser` at connect time and subscribes the
   socket to exactly that room. Scoping holds even against a hostile client.
   This is the NATS subject-token idea (`lifecycle.{tenant}.{customer}`) with
   the wildcard **pinned by the verifier**, not chosen by the subscriber.
2. **`scope:` is an equality, so it lowers to a room key — not a per-socket
   scan.** Tenancy is always the leftmost token (automatic, from `tenancy by`);
   `scope:` adds finer tokens. The broadcast fans out by hashed room; no
   predicate runs per connection. *Fan-out-then-filter never happens.*

Tenancy is implicit and fail-closed: with `tenancy by user.tenantId` declared,
**every** channel is tenant-partitioned with no `scope:` needed — a tenant's
browsers can never receive another tenant's events, exactly as a tenant's reads
can never see another tenant's rows. `scope:` is only for *intra-tenant*
narrowing (per-customer, per-team, per-owner).

#### What `currentUser` actually binds to here

`scope: customerId == currentUser.customerId` reuses the read-side syntax, but
the two sides resolve **on opposite ends of the wire, at different moments** —
this is the one place the channel meaning departs from a `find … where`, and
it's worth being exact:

| Side of `==` | Whose data | Resolved when | Lowers to |
|---|---|---|---|
| `customerId` (left — a carried-event field) | the **producer's** payload (the order's owner) | at **`emit`** time, in the backend hosting context A | the room an event is *published to* |
| `currentUser.customerId` (right — a claim) | the **subscriber** — the browser holding the socket | at **connect** time, from *its* bearer JWT | the room(s) a socket is *joined to* |

So in a `find`, `currentUser` is the single caller of that request, resolved
once → a SQL bind. In a channel `scope:`, `currentUser` is **the subscriber**,
and the equality is a *rendezvous*: the compiler splits it into two pure
projections that never evaluate together at runtime —

```
publish:    roomOf(event)        = [ event.tenantId?, event.customerId ]      // from the emitted payload
subscribe:  roomsOf(currentUser) = [ claims.tenantId, claims.customerId ]     // from the JWT at handshake
            socket gets event   ⟺  roomOf(event) ∈ roomsOf(currentUser)       // a key match, not a scan
```

That decomposition is *why* the field must be in the payload (the publish side
has only the event) and *why* the RHS must be a `currentUser` claim (the
subscribe side has only the JWT). They share no runtime context — only the room
string.

**Where the subscriber identity comes from is the existing auth plumbing**, not
anything new — the SSE/WS connect is an authenticated request like any other:

| Backend | Subscriber `currentUser` at connect | Room join |
|---|---|---|
| **Hono** | the same verifier middleware runs on the SSE/WS route; `c.get("currentUser")` is populated from the bearer token before the handler | handler computes `roomsOf(c.get("currentUser"))` and subscribes the stream to exactly those Redis/in-proc topics |
| **.NET** | `ICurrentUserAccessor.User` on the hub/SSE connection (the SignalR hub auth runs `UserMiddleware` first) | `Groups.AddToGroupAsync(connId, room)` per derived room, in `OnConnectedAsync` |
| **Phoenix LiveView** | `socket.assigns.current_user`, set in the LiveView `mount/3` from the session — identical to how a page already authenticates | `Phoenix.PubSub.subscribe(topic)` for each derived room topic |

In every case the browser presents **only its token**; the server derives the
rooms. The browser never names a room, a tenant, or a customer id — which is
the whole point (property 1 above). Anonymous/unauthenticated connections get
the tenant-or-public room only, and are rejected outright if `requires:` is set.

**The validation that makes it sound** (`loom.channel-scope-*`):

| Code | Rule |
|---|---|
| `loom.channel-scope-field-not-carried` | the `scope:` predicate references an event field absent from a carried event's **payload** (e.g. `customerId` when `OrderPlaced` only carries `order: Order id`). The relay can't route without it. Suggestion: add the field to the event, or carry only events that have it. |
| `loom.channel-scope-shape` | `scope:` is not an equality between a carried-event field and a `currentUser` field — anything requiring a per-event boolean scan (ranges, joins, negation) is rejected; it can't become a room key. |
| `loom.channel-scope-without-user` | `scope:`/`requires:` reference `currentUser` but no `user { }` block / auth is configured. |
| `loom.channel-scope-crosstenant` | a `crossTenant` channel (shared reference data) also declares a per-user `scope:` — contradictory; cross-tenant data is broadcast to all. |

So the answer to "not all browsers should get all events" is: **subchannels are
the room layer, keyed by the same tenancy + row-filter predicates Loom already
uses for reads, derived server-side from the JWT.** No new authorization model —
the push path inherits the read path's, lowered to broker rooms instead of SQL
`WHERE`.

### Authorization vs interest — a detail page wants *one* aggregate, not the firehose

The picture so far has a hole, and it's the one that matters in practice. Take
an **Order detail page** open on order `#42`. With only `scope: customerId ==
currentUser.customerId`, that socket joins room `customer:X` and receives
**every event for every order customer X owns** — then throws all but `#42`
away in the browser. That's the fan-out-then-filter leak again, one level
down, and it means `customerId` alone is answering the wrong question.

There are **two orthogonal concerns** here, and the earlier draft collapsed
them into one:

| Concern | Question | Source | Browser can change it? |
|---|---|---|---|
| **Authorization** | "May this user receive this *at all*?" | `currentUser` claims (JWT) | **No** — pinned by the verifier |
| **Interest** | "Which events does *this page* actually want?" | the page's `.live` **data binding** | Yes — it's the page's own concern |

A detail page needs **both**: it must be *allowed* to see order 42 (authz), and
it only *wants* order 42's events (interest). `customerId` is authorization;
`order == 42` is interest. They compose into the room key — and crucially the
interest half is **not declared on the channel at all**; it's read from the
page binding, the same one that already picks the React Query cache key:

| Page `.live` binding | Existing query key | Room the socket joins |
|---|---|---|
| `Order.all.live` | `["orders"]` (collection) | `orders.{tenant}.{customer}.*` — all my orders (a wildcard *within* my authz subtree) |
| `Order.byId(42).live` | `["orders", 42]` (instance) | `orders.{tenant}.{customer}.42` — exactly one |

So the room is **composed from two ends**, mirroring NATS hierarchical
subjects:

```
publish:    subjectOf(event) = orders.{event.tenant}.{event.customerId}.{event.order}   // fully-qualified, from payload
subscribe:  detail page #42  -> orders.T.X.42        // authz prefix (claims) + interest token (route param)
            list page        -> orders.T.X.*         // authz prefix (claims) + interest wildcard
```

- The **authz prefix** (`T.X`) is filled from `currentUser` claims and **cannot
  be widened** by the client — a user literally cannot construct a subject
  outside its own subtree, so authorization is structural, not a runtime check.
- The **interest token** (`42` vs `*`) is filled from the page's `.live`
  binding — `Order.byId(42)` contributes `42`; `Order.all` contributes the
  wildcard. The page already names this; nothing new is declared.

This is why **`key:` on the channel was there all along**: `key: order` *is*
the interest/partition dimension. `scope:` (authz) bounds *which* rooms you may
join; `key:` (interest) is the leaf the page selects. The detail page does
**not** receive the customer firehose — it joins exactly `…X.42`, and the
broker (Redis pattern-subscribe, Kafka key, SignalR group, PubSub topic)
delivers only matching events.

**What changes in the model:** nothing in the *channel* surface — `scope:` and
`key:` already exist. The new wiring is purely on the **UI `.live` lowering**:
a `byId(x)`-shaped binding contributes its argument as the interest token of
the room it subscribes to; an `all`-shaped binding subscribes to the wildcard
within the authz prefix. Validation `loom.live-interest-unkeyed` fires if a
page tries an instance-scoped `.live` (`byId(x)`) on a channel whose `key:`
doesn't match that aggregate's id — there'd be no leaf to subscribe to.

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
  key?: string;                      // field name common to carried events
  scope?: RoomKeyIR;                 // subchannel predicate, validated to equality → room tokens
  requires?: ExprIR;                 // capability gate evaluated at connect (reuses requires lowering)
  // NO realtime/transport field — the contract is wire-agnostic.
}
// Derived in enrich: the ordered room-token spec, in two segments.
//   authz  — pinned by the subscriber's JWT; the browser cannot widen these.
//            Tenancy is auto-prepended as the leftmost authz token when the
//            system declares `tenancy by …` (fail-closed).
//   interest — the `key:` field; the leaf the page's .live binding selects
//            (a concrete value for byId(x), a wildcard for all). Subscribe-time
//            only; the publish side always emits the concrete leaf from payload.
export interface RoomKeyIR {
  authz:    { eventField: string; claimField: string }[];  // each = `<eventField> == currentUser.<claimField>`
  interest?: { eventField: string };                        // = channel `key:`; wildcard-able by the subscriber
}
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
  `emit` goes. Build each channel's `RoomKeyIR` (prepend the system tenancy
  token when `tenancy by …` is set; append the `scope:` equality tokens),
  which is what the room-publish (server) and room-subscribe (relay) emitters
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
| **Hono** | `DomainEventDispatcher` that fans an event to each carrying channel's driver: in-proc `EventEmitter` / `ioredis` pub/sub / `kafkajs` producer / `amqplib`. Publishes to the **room** derived from the event's `RoomKeyIR` (e.g. `lifecycle:{tenant}:{customerId}`). | per-channel subscriber loop → reuses the generated **workflow handler** for the reactor body; `queue` ⇒ consumer-group / `BLPOP`; ack on success. | `streamSSE` / `ws` endpoint; on connect runs `requires:` (403 on fail) and joins the socket **only** to the rooms computed from `currentUser` claims — never a client-supplied room. |
| **.NET** | `IDomainEventDispatcher` → in-proc MediatR notification / MassTransit publish (Redis/RabbitMQ/Kafka transport) — DI-registered like the existing `AddScoped` repos. Room from `RoomKeyIR`. | `IConsumer<T>` / `INotificationHandler<T>` invoking the reactor's Mediator command (same handler the workflow controller calls). | SSE (`text/event-stream`) or a SignalR hub; SignalR **Groups** *are* rooms — `Groups.AddToGroupAsync(conn, roomFromClaims)` after the `ICurrentUserAccessor` auth gate. |
| **Phoenix LiveView** | `Phoenix.PubSub.broadcast(topic)` (ephemeral) / Broadway + Ash (durable), where `topic` is the room. | an Ash reactor / `GenServer` `handle_info` running the reactor body as an Ash action. | **native** — `subscribe` to the room topic derived from `socket.assigns.current_user`; `handle_info` re-assigns the stream. Rooms are just PubSub topics. |
| **React** (consumer of realtime) | — | — | generated SSE/WS client; connects with its bearer token (server derives rooms); `.live` refs invalidate/patch React Query cache keyed by `channel.key`. |

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
5. **Subchannels — authz rooms + interest leaf** — `RoomKeyIR` derivation
   (authz tokens from `scope:`/tenancy; interest token from `key:`), the
   `loom.channel-scope-*` validators, room-keyed publish, the connect-time
   `requires:` 403 gate, and the **`.live` interest lowering** (`byId(x)` →
   concrete leaf, `all` → wildcard) with `loom.live-interest-unkeyed`. This is
   the slice that makes both "not every browser gets every event" *and* "a
   detail page gets one aggregate, not the firehose" real; depends on the
   tenancy slice from `multi-tenancy-design-note.md`. (`LOOM_E2E`, two tenants,
   a list page and a detail page.)
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
