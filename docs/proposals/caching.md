# Reads, freshness & caching

> Status: **PROPOSAL** — not adopted. The read-side companion to
> [`channels.md`](./channels.md) (the messaging/transport tier). Fills the
> "Caching & invalidation" gap named in
> [`production-readiness.md`](./production-readiness.md) §3.4. Consumes:
> `channels.md`'s event/`save` stream and realtime delivery; `authorization.md`
> (`DataKey`); `multi-tenancy-design-note.md` (`tenancy by`). Reuses, never
> redefines, the keys those pin.

## TL;DR

Loom is the rare system whose origin **knows exactly when data changes** (every
`repo.save` and every `emit` flow through one seam). That single fact flips
caching from **expiration-based** (TTL, guess, revalidate) to
**invalidation-based** (cache forever, purge the instant it changes) — aggressive
caching with zero staleness. The hard half of caching, *knowing when to bust*, is
already built by the messaging tier.

The whole design rides on **two keys that do different jobs** — the same split
`channels.md` draws for delivery:

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

This proposal and `channels.md` were derived together over a long design
discussion; this section is the condensed trail so the decisions don't read as
arbitrary.

1. **Start:** a "good queueing abstraction (websockets too)." → the `channel`
   transport tier (`channels.md`): events already publish through a pluggable
   dispatcher; what was missing was the contract + transport + consumer.
2. **Realtime to the UI** raised "who gets which events?" → scoping. First
   attempt overloaded one `scope:` predicate.
3. **Realisation 1 — realtime is not one feature.** Cache-invalidation and a
   live dashboard are *opposites* (ticket vs payload, implicit-`save` vs
   explicit-`emit`, over-broadcast-safe vs must-be-scoped). They must not share a
   mechanism → the **planes** taxonomy (`channels.md`).
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

| | **Live read** (this doc) | **Live event** (`channels.md`, plane 2/3) |
|---|---|---|
| What's shown | *current state* — a query result that stays fresh | *the events themselves* — a feed of "Order #42 shipped", a toast |
| UI construct | **an ordinary cached query** (`cached: tagged`); no special marker | **subscribe to an event channel**, render its payloads |
| Fed by | the **invalidation stream**, derived from **`save`** (any state change) | the **event channel** (`channel { carries: OrderShipped }`), driven by **`emit`** |
| Payload | **ticket** (no data) → client refetches the authorized read | **event data** (rendered directly) |
| Backed by | **persisted** state (a table / view) | often **ephemeral** (transient notification, presence) |

A live read is therefore not a special query — it's **a cached query that's
on-screen while the client receives invalidation signals** ("live" is emergent;
see "Automatic invalidation" below). Displaying the event stream itself is the
*separate* live-event construct in `channels.md` (plane 2/3), which carries event
payloads and is scoped at delivery. The boundary is simply: **is the displayed
thing persisted state or an ephemeral event stream?** Persisted → a cached query
(here); ephemeral → event subscription (`channels.md`).

Two consequences worth stating, because the previous draft blurred them:

- **Cache invalidation is `save`-driven, not event-driven.** A `save` (any
  aggregate state change, including a projection's own read-model save) is what
  busts the cache and refreshes any cached on-screen read. Domain events (`emit`) are for
  *display* (live events) and *choreography* (reactors) — **not** a cache trigger.
- **Most "show events on the frontend" is actually a live read over a persisted
  log** (a Notifications / activity table that grows by `save`), not an ephemeral
  event subscription. The genuinely-ephemeral case (toast, presence, "X is
  typing") is the smaller, distinct plane in `channels.md`.

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
channel** (`channels.md`):

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
rooms) is `channels.md`'s — *shared* by invalidation tickets and live-event
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
authorization (which can't be reduced to a room key — see `channels.md` §"The
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
**relay-registry entries, not per-user broker objects** — see `channels.md` §"How
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
  `channels.md`). That cost is *why* it's opt-in, not the default.

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
- **⑨ compose** — the eviction wiring shares `channels.md`'s dispatcher seam: the
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
   invalidation; coalescing; ETag/304 refetch. Rides `channels.md`'s realtime
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
  cursor vs rejoin live (per-room cursor). Shared with `channels.md`'s deferred
  list.
- **Cross-aggregate consistency** of a cached read vs the events that built it
  (read-your-writes after a coalesced invalidation window). Deferred.

## See also

- [`channels.md`](./channels.md) — the messaging/transport tier this consumes:
  `channel`, `channelSource`, reactors/projections, realtime delivery + the
  planes, delivery-side visibility scoping.
- [`authorization.md`](./authorization.md) — `DataKey` (the visibility key reused
  here) + the auth gate that decides the cache tier.
- [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) — `tenancy by`,
  the leftmost `DataKey` segment / cache partition.
- [`production-readiness.md`](./production-readiness.md) §3.4 — the gap this fills.
- [`bounded-context-model.md`](./bounded-context-model.md),
  [`workflow-and-applier.md`](./workflow-and-applier.md) — `projection`, the
  graduation target for wide dependency sets.
