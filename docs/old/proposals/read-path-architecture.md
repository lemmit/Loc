# Read-path architecture — the read-only repository query port

> Status: **DRAFT / PROPOSED** (2026-07-14, rev. 7). No code yet. A
> vision + grammar proposal.
>
> **The core primitive** (owner steer, rev. 2): the read path's one
> load-bearing primitive is a **read-only repository queried by
> `criterion`** — `Repo.run(<criterion>, sort?, page?)` under a
> **read-only setting** that structurally forbids writes. That single
> mechanism is *sufficient for almost every read*.
>
> **The ergonomic default** (owner steer, rev. 3): the common case — a
> named, paged, filtered list read — is a **scaffold macro,
> `scaffoldPaged(of: X)`**, that emits a real (unfoldable) paged
> `queryHandler` over that primitive. Not a new construct, not a new
> keyword: the ergonomics live in the macro layer where `scaffold`
> already lives. rev. 3 **drops the rev. 2 `read` keyword** (the scaffold
> replaces it).
>
> **`view` dies; its full form moves into a generalized `projection`**
> (owner steer, rev. 6 — resolving rev. 5's open naming knot). The
> *shorthand* (`view X = Agg where P`, returns the aggregate) is redundant
> with a filtered read → `scaffoldPaged(of: criterion)`. The *full form*
> (`view X { <fields> from … bind … }`) — an inline anonymous shape +
> join-capable binds — is the *one* irreducible thing, and it **is a
> projection**: `view` and `projection` are the same read model at two
> points on one axis (`projection.md`'s own framing — always-current
> query-time vs materialized event-folded, with a shipped lint nudging
> between them). So the full form becomes a **query-time flavor of
> `projection`** (`projection X(params) { <fields> from <source> where …
> bind … }`, no `keyed by`/`on`), sitting beside the existing folded flavor
> (`projection X keyed by k { … on(e){…} }`). This resolves the naming knot
> (the survivor *is* a projection — no new word) and fully retires `view`
> (both forms). The inline anonymous shape (the `<View>Row`) is preserved.
> rev. 7: the query-time flavor is **parameterized** (params drive `where`,
> + `sort` decl / `page` call-site, like `retrieval`) — the parameterized
> read model `view` never was — and **keyed by its source aggregate's id**
> (derived, giving a by-id read), where the folded flavor keeps the explicit
> `keyed by` for event routing. The `/views` namespace dies; the follow +
> `<View>Row` synthesis **relocate** to the query-time projection path.
>
> Composes, all already shipped: [`criterion.md`](./criterion.md) (the
> predicate atom — the query language), [`retrieval.md`](./retrieval.md)
> (the *named* criterion+sort+loads bundle), [`domain-services.md`](./domain-services.md)
> (the `reading` tier — **where the read-only setting already lives and
> is already enforced**), the `repo-run` / `Repo.findAll(<criterion>)`
> read builtins (`src/ir/types/loom-ir.ts:1494`, `:3173`), and
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) (the
> landed `queryHandler` / `route` seam — the orchestration escape hatch).
> a hand-written `queryHandler` (arbitrary read logic) and
> [`projection.md`](./projection.md) (the generalised read-model construct —
> query-time *or* folded) are the heavier escape hatches. (`view` — rev. 6
> retires it; its full form is the query-time `projection` flavor, see the
> banner above.)

---

## TL;DR

The whole read path is one primitive: **a repository, accessed
read-only, queried by a criterion.**

```ddd
context Sales {
  aggregate Customer { region: string; active: bool; ... }
  repository Customers for Customer { }          // getById / save (write) + the read-only face

  criterion ActiveInRegion(region: string) of Customer = this.active && this.region == region
}

# An imperative read — from a read-only position, so the compiler guarantees it can't mutate:
#   (inside a workflow / handler / reading service)
let activeEU = Customers.run(ActiveInRegion("EU"), sort: [name asc], page: page)

# The exposed default — a paged, filtered list read, one line:
with scaffoldPaged(of: ActiveInRegion)   # → a real, unfoldable paged queryHandler + route
```

- **`run` takes a `criterion`** (inline composed predicate) or a named
  `retrieval`; `findAll` is `run` with no predicate. This collapses the
  "repository-with-40-finders" smell into one generic, specification-driven
  query — you stop minting a `find byX` method per query.
- **The read-only setting** is what makes this the *layer of indirection*
  the api was missing: the api binds to the repository's **read-only
  face** (a query port that exposes `findById` / `run` / `findAll` and
  *nothing that writes*), never to the mutating write repository. Reads
  structurally cannot mutate, and cannot accrete bespoke finders.
- **The exposed read is a scaffold, not a keyword.** A named, paged,
  filtered list read — the overwhelming common case — is
  `scaffoldPaged(of: X)`, a macro (§ "The ergonomic default") that emits
  a real `queryHandler` over the read-only-repo primitive. It composes
  what ships; it does not add a construct.
- **That is sufficient for almost everything.** Most reads are "list/one
  of aggregate X, optionally filtered." The read-only query port +
  `scaffoldPaged` cover them. The heavier read constructs are opt-in for
  the minority that earn them:

| Need | Use | Not the default |
|---|---|---|
| list / one / filtered read of an aggregate | **read-only repository + `criterion`** (via `scaffoldPaged`) | — (this *is* the default) |
| stitch several reads / arbitrary read logic | `queryHandler` | only when a plain read won't do |
| a **custom-shaped read model** (inline shape, projected fields, cross-aggregate follow) | **`projection`** — query-time flavor (always-current) | when the aggregate's own shape won't do |
| a **materialized denormalised read model** folded from events | **`projection`** — folded flavor (indexed, eventual) | when query-time refold is too costly |

(`view` was a fifth row here through rev. 3; rev. 6 retires it entirely —
its full form is the query-time `projection` flavor. See § "`view` dies".)

This is the Ardalis `IReadRepository<T>` + Specification pattern, mapped
onto Loom's existing `criterion`/`retrieval`/`reading`-tier machinery.
Almost nothing here is new — the proposal is to make the read-only
query port the **named, enforced, default** shape of a read.

---

## The problem, precisely

Today the read path is the *mutating* repository, exposed directly, with
finders accreting on it:

1. `api SalesApi from Sales` names a subdomain; `ApiIR` stores only
   `sourceModule` (`loom-ir.ts:2344`). The read surface is re-derived
   from the subdomain's repositories every generate.
2. Enrichment injects an implicit `find all(): T[]` on every aggregate's
   repository (`enrichments.ts:1542`).
3. The generated Hono route handler *is* a repository call, and the
   repository handed to the router is the **full read/write** object:

```ts
// src/generator/typescript/emit/routes.ts:60
app.route("/api/orders", ordersRoutes(new OrderRepository(db, events)));  // full repo — can save()

// route handler body — repository-find-builder.ts
const result = await repo.byCustomer(customerId);    // a bespoke finder method
return c.json(repo.toWire(found));
```

### Two DDD smells

- **Smell 1 — the interface layer reaches into the *mutating* domain
  collection.** The router gets `new OrderRepository(db, events)` — the
  same object a command uses to `save`. Nothing structural stops a read
  path from mutating; the split is by convention, not by capability.
- **Smell 2 — the repository accretes finders.** Every distinct query
  becomes a `find byX(...)` method on the domain collection, welded to
  the aggregate's wire shape via `repo.toWire`. This is the classic
  "repository-with-40-methods."

The fix for **both** is the same one primitive: expose a **read-only**
repository face, and express queries as **criteria** passed to a generic
`run`, not as finder methods. Read-only kills Smell 1 (the api can't
mutate through a query port). Specification-by-criterion kills Smell 2
(no per-query method to accrete).

### The mechanism already half-exists

- `Repo.run(<retrieval>, page?)` (retrieval.md, shipped 5 backends) and
  `Repo.findAll(<criterion>)` (lowered to a `repo-run` riding a synthetic
  `findAllBy<Criterion>` retrieval — `loom-ir.ts:1494`, `:3173`) are the
  read builtins.
- The **read-only setting is already a shipped, enforced concept**: the
  `reading` domain-service tier permits `repo-read` calls and rejects
  writes — `loom.domain-service-no-repo-write` says verbatim *"a domain
  service may run read-only queries (the 'reading' tier), but persistence
  writes … belong to the orchestrator"* (`domain-service-checks.ts:129`).

What's missing is making this the **default and only** way the api
reads — instead of the mutating-repository-with-finders auto-derivation.

---

## Target — the read-only query port

### A repository has two faces

| Face | Exposes | Callable from |
|---|---|---|
| **write** | `save`, and `getById` for the load→mutate→save cycle | orchestrator tier only — `workflow`, `commandHandler` |
| **read-only** | `findById`, `run(<criterion \| retrieval>, sort?, page?)`, `findAll(sort?, page?)` | any **read position** — an api read route, a `reading` service, a `queryHandler` |

The read-only face **is** the layer of indirection the original
complaint asked for. It is not a separate service class; it is a
capability-narrowed view of the repository. The api binds to it; the
mutating face is unreachable from a read.

```
   api read route ──► repository (read-only face) ──► store
                          run(criterion), findById, findAll
                          — no save, structurally

   workflow / commandHandler ──► repository (write face) ──► store
                          getById → mutate → save
```

### The read-only setting

Read-only-ness is conferred by **position**, exactly as the `reading`
tier already does it — no per-call ceremony:

- Inside a `workflow` / `commandHandler`, a repository reference is the
  **write** face (may `save`).
- Inside an **api read route**, a `reading` service, or a `queryHandler`,
  a repository reference is the **read-only** face. A write
  builtin there is a validation error (generalise the shipped
  `loom.domain-service-no-repo-write` from the `reading` tier to *every*
  read position → `loom.read-context-repo-write`).

This keeps the common case free of markers: you write `Customers.run(...)`
and the compiler already knows, from where you wrote it, whether that
repository can save.

> **Open (the one real fork):** should read-only also be spellable
> **explicitly** — a `read` marker on a repository handle
> (`read Customers` / `Customers: read Customer`) — for authors who want
> the capability visible at the reference site, or is implicit-by-position
> enough? Lean: **implicit-by-position** (matches the shipped `reading`
> tier; zero new syntax), with an explicit `read` marker as a later
> nicety if empirical pressure appears. See Open questions.

### `run` takes a criterion — the query language

`run` accepts an **inline composed criterion** (predicate) or a **named
retrieval**; both already lower through the same `repo-run` /
`findAllBy<Criterion>` path (`loom-ir.ts:1494`):

```ddd
Customers.run(ActiveCustomer && InRegion("EU"), sort: [name asc], page: page)  # inline criterion
Customers.run(ActiveInRegion("EU"), page: page)                                 # named retrieval (adds sort/loads)
Customers.findAll(page: page)                                                   # run with no predicate
Customers.findById(id)                                                          # by-identity reconstitution
```

- **`page` is call-site only** (retrieval.md's decision, unchanged — it's
  request state, not part of the rule).
- Returns the aggregate (`T` / `T[]` / `Paged<T>`). For the common CRUD
  read, that's the wire shape you want — no separate DTO required. When
  the wire shape must *diverge* from the aggregate, reach for a
  `queryHandler` returning a `response` (escape hatch, below).

This is why "sufficient for almost everything": list, one, and filtered
reads of an aggregate — the overwhelming majority — are exactly
`run(criterion)` / `findById`, with the read-only setting doing the
architectural work for free.

### The default api read derivation, re-pointed

`api X from Sales` keeps its terseness but its read routes now derive
onto the **read-only face**:

- `GET /customers` → `Customers.findAll(page)` (the auto-`findAll`
  becomes a read-only-face call, not a mutating-repo call).
- `GET /customers/{id}` → `Customers.findById(id)`.
- A declared `criterion` / `retrieval` marked exposable →
  `GET /customers?<params>` → `Customers.run(<criterion>(params), page)`.

The wire is byte-identical to today for the CRUD case; what changes is
that the router receives a **read-only handle**, and query surface comes
from criteria, not accreted finder methods. `scaffoldApi` (unfoldable-api-derivation)
remains the unfold path when you want the routes as literal source.

---

## The ergonomic default — `scaffoldPaged(of: X)`

The read-only-repo + criterion primitive is the *floor*. But a
named, paged, filtered list read exposed on the wire — the single most
common read — should be **one line**, not a hand-written
`query` + `response` + `queryHandler` + `route` quartet. That one line is
a **scaffold macro**, the criterion-driven sibling of
unfoldable-api-derivation's `scaffoldQuery(of: <Find>)`:

```ddd
context Sales {
  aggregate Order { region: string; status: OrderStatus; placedAt: datetime; ... }
  repository Orders for Order { }
  criterion InRegion(region: string) of Order = this.region == region

  with scaffoldPaged(of: InRegion)          // ← the whole exposed read, one line
}
```

It expands (AST→AST, at macro time — real, unfoldable source) to the
honest application read path over the read-only primitive:

```ddd
  query    OrdersInRegionQuery { region: string, page: int = 1, pageSize: int = 25 }
  response OrderResponse       { ... }                     // apiRead projection of Order
  queryHandler ListOrdersInRegion(q: OrdersInRegionQuery): OrderResponse paged {
    return Orders.run(InRegion(q.region), page: q.page)    // read-only repo + criterion
  }
  // + route GET "/orders/in-region" -> Sales.ListOrdersInRegion
```

### One polymorphic macro — reads its argument's kind

`scaffoldPaged` reads the IR kind of its `of:` target and picks the query
body — the same "scaffold reads its input to decide" rule the
`scaffoldApi` family uses. This collapses what could be
`scaffoldPaged` + `scaffoldPagedView` + a per-aggregate variant into one:

| `of:` target | Body it emits | Handler params from |
|---|---|---|
| an **aggregate** (`of: Order`) | `Orders.findAll(page)` | `page` only |
| a **criterion** (`of: InRegion`) | `Orders.run(InRegion(args), page)` | the criterion's params + `page` |
| a **retrieval** (`of: HighValueInRegion`) | `Orders.run(HighValueInRegion(args), page)` — its `sort` / `loads` ride along | the retrieval's params + `page` |

- The aggregate is **inferred** from a criterion/retrieval's `of T`, so
  one argument suffices (no `scaffoldPaged(of: Order, by: InRegion)`
  redundancy).
- The criterion/retrieval's **parameters become the route's query params**
  and the handler signature (`scaffoldPaged` reads `InRegion.params`).
- `page` is call-site (query params), per retrieval.md's page-is-call-only
  decision.
- Returns the aggregate's `apiRead` projection (`OrderResponse paged`) by
  default — the DTO boundary is scaffolded, not hand-written. When the read
  needs a *custom* shape (renamed/combined fields, a cross-aggregate
  follow), that is a `projection` (query-time flavor) — § "`view` dies".

### Why a macro, not a new construct

The shared job the macro covers (a named, paged, filtered *passthrough*
read) is a *macro output*, not a new read keyword. The primitives stay
orthogonal and each keeps its one job:

- `criterion` — the filter atom (composes, inlines to SQL).
- `retrieval` — the *named* filter+sort+loads bundle a handler/macro runs.
- `queryHandler` — the imperative read the macro *emits* (and the escape
  hatch when you hand-write arbitrary read logic).
- `projection` — the custom-shaped read model (query-time or folded); where
  a divergent shape + cross-aggregate follow lives (ex-`view` full form).

`scaffoldPaged` *composes* these; it does not replace any. Naming follows
the `scaffold<Thing>(of: X)` stdlib convention (named `of:` arg); whether
it is spelled `scaffoldPaged` or folded into `scaffoldQuery(of:, paged:)`
is cosmetic (Open questions).

---

## When the read-only port isn't enough — the escape hatches

Deliberately *not* on the default path; each earns its use:

- **`queryHandler`** (landed, unfoldable-api-derivation) — when a read
  must **orchestrate** (stitch several `run`s / call a `reading` service)
  or **diverge the wire shape** from the aggregate (a `response` DTO that
  hides/renames/combines fields, or **follows a cross-aggregate `X id`
  ref** — the ex-`view` capability, see below). It runs the read-only port
  internally and projects. `loom.query-handler-saves` already keeps it
  read-only.
- **`projection`** (projection.md, generalised here) — a **derived read
  model with a custom inline shape**, in two flavors: **query-time**
  (`from … where … bind …`, was `view`'s full form — always-current,
  join-capable, no extra storage) and **folded** (`keyed by … on(e){…}` —
  materialized from events, indexed, eventual). The escape hatch whenever
  the read needs a shape other than the aggregate's own. Opt-in per read
  model — never forced.

The ladder is legible: **`scaffoldPaged` / `run(criterion)` for the 90%;
`queryHandler` when you orchestrate or reshape; `projection` when you need a
custom-shaped read model (query-time or folded).**

### `view` dies — its full form becomes a `projection` flavor

rev. 4 deprecated `view` and folded its custom shape into a `response`;
rev. 5 kept the inline shape but left the survivor's *name* open. **rev. 6
closes it: the surviving thing is a `projection`** — `view` and `projection`
are the same read model at two points on one axis, so the full form becomes
a query-time *flavor* of `projection` rather than a new construct.

- **Shorthand** (`view X = Agg where P`, returns the aggregate's wire
  shape) — redundant with a filtered read. **Dies**, → `scaffoldPaged(of:
  criterion)`.
- **Full form** (`view X { <fields> from Agg where P bind … }`) — an inline
  anonymous shape + join-capable binds — **is a projection**. It moves into
  `projection` as the **query-time flavor** (below), keeping its inline
  shape and follow verbatim.

`view` retires **completely** — no recast keyword, no `/views` namespace.

#### `projection` generalises — one read model, two population modes

A **projection is a derived read model**: a declared inline shape, read-only,
disposable/rebuildable, **not a source of truth** (`projection.md`'s own
defining criterion — a query-time view satisfies it exactly as a folded one
does). *How it is populated* is a flavor the body selects:

```ddd
// QUERY-TIME flavor (was view's full form, now PARAMETERIZED) — always-current,
// computed per request, no extra storage; binds may follow X id refs (app-side join).
projection OrdersInRegion(region: string) {
  orderId:      Order id
  lineCount:    int
  customerName: string
  from Order where this.region == region        // params drive the filter (retrieval-style)
  sort [placedAt desc]                          // sort in the declaration; page is call-site
  bind orderId = id, lineCount = lines.count, customerName = customerId.name
}

// FOLDED flavor (today's projection) — materialized at write time, indexed, eventual.
projection OrderBook keyed by order {
  order:  Order id
  status: OrderStatus
  on(e: OrderPlaced) { order := e.order; status := Placed }
}
```

- **Distinguisher:** `from <source> where … bind …` (query-time) vs
  `keyed by <k>` + `on(e){…}` (folded). Both declare the shape inline (the
  anonymous `<Proj>Row`, preserved from `view`'s `<View>Row`). A body must
  pick exactly one mode; mixing is a validate error.
- **Parameters + sort/page (query-time).** A query-time projection is a
  read, so it **takes parameters** that drive its `where` (fixing `view`'s
  biggest gap — no params — which forced callers back to repository `find`s),
  plus `sort` in the declaration and `page` at the call, exactly like
  `retrieval`. This makes it the parameterized read model `view` never was.
  It bundles filter + shape by design; `retrieval` (query → *aggregates*,
  for imperative bodies) stays a distinct, composable thing — the bundling
  is right for a *named read model*, and the orthogonal `response` +
  `queryHandler` path remains for shapes reused across queries.
- **Keying differs by flavor — and both are keyed.** *Folded:* `keyed by`
  is explicit + required (events must route to a row; the schema often holds
  several foreign ids). *Query-time:* no events, so no correlation key to
  declare — but it is **1:1 with its source aggregate**, so each row is
  **keyed by the source's id, derived not declared**, which is what gives it
  a by-id read (`GET …/{id}`) for free (as `view`'s `bind orderId = id`
  did). No `keyed by` clause on the query-time flavor — it would be
  redundant with the source id. So the key is *declared* (folded) vs
  *derived from source identity* (query-time).
- **Same identity, different consistency/cost:** query-time is
  always-current, O(query)/read, no table; folded is eventual, O(1)/read,
  its own table. The choice is the read-side twin of an aggregate's
  `state`-vs-`eventLog` — same construct, a population knob.
- **The existing `loom.view-source-eventsourced-refold` lint becomes an
  *intra-`projection`* nudge:** "this query-time projection over an ES source
  refolds the whole stream per request → switch it to a folded projection."
  Same read model, change the mode.
- **Exposure** unifies under the projection read surface (the `/views`
  namespace folds into it); the folded flavor keeps its by-key route.

**The two `view` capabilities are preserved by the move:**

- **The follow** stays a property of the **query-time projection's binds**:
  a bind may traverse an `X id` ref, batch-loaded. The `collectIdFollows` /
  `auxiliaries` machinery **relocates** from the view lowerer to the
  query-time projection path — moved, not rewritten. (The same follow is
  also available in a hand-written `queryHandler` body's projection.)
- **The inline anonymous shape** is intrinsic to `projection` already — a
  projection declares its `<Proj>Row` inline (the folded flavor does today);
  the query-time flavor does the same. No hand-declared `response` is forced;
  a named `response` stays the opt-in for a shape reused across reads.

#### The follow is an app-side join — which is why it's a projection concern, not a query one

The follow is genuinely a **join**, but *not* a SQL one. `customerId:
Customer id` is a cross-aggregate reference, and Loom **never SQL-joins
across aggregate roots** (aggregates are consistency/storage boundaries;
the `X id` rule links them by id, never by FK). So `customerId.name`
compiles to an **application-side, batched, aggregate-respecting join** —
each aggregate loaded through *its own* repository, stitched in memory:

```ts
const orders       = await orderRepo.run(...);                    // source aggregate
const customerById = await customerRepo.findManyByIds(            // ONE batch, not N per row
  orders.map(o => o.customerId));
return orders.map(o => ({ ..., customerName: customerById.get(o.customerId)!.name }));
```

This pins *where* the follow belongs, and answers **"should `retrieval`
hold the `bind`?" — no:**

- A **filter** (`criterion` / `retrieval.where`) is **single-aggregate,
  pushed to SQL** — you cannot `where customer.tier == Gold` (that needs
  the join *at filter time*, which Loom doesn't do across aggregates;
  filtering by a foreign field is a `projection`'s job). So the join
  **never appears in the query** — only in the projection.
- `retrieval` is the *query* ("which rows, order, hydration"). Giving it
  `bind` re-fuses query + projection (that *is* `view`), forces the output
  shape to be redeclared per query, and adds a **second** cross-aggregate
  knob next to its existing `loads:` (which fetches for *hydration*, not
  projection) — two overlapping mechanisms.
- Keeping query and projection split is the SQL insight done right:
  `retrieval` = `WHERE`/`ORDER BY` (one table); the projection = `SELECT`
  (where a join-derived column belongs). Orthogonal ⇒ **N queries × M
  output shapes without N×M constructs** — the reuse `view` (one shape
  welded to one query) can't offer.

The follow therefore lives on the **projection**, never on `criterion` or
`retrieval`. For true SQL-join-level or hot denormalized reads
(filter-by-foreign-field, cross-aggregate aggregation), the tool is
`projection` (a materialized read model) — the app-side batched follow
covers moderate cardinality; `projection` covers the rest.

**Migration.** `view` stays parsing through a deprecation window
(`loom.view-deprecated`, warning), with `ddd migrate reads` rewriting the
two shapes differently: the **shorthand** `view X = Agg where P` →
`with scaffoldPaged(of: <criterion(P)>)`; the **full form**
`view X { fields from Agg where P bind … }` → a read whose query is the
`criterion(P)` and whose projection is the fields+binds kept **inline**
(the shape is *not* forced into a named `response` — its `<View>Row`
becomes the inferred inline-projection row). The `/views` routers retire
(the read mounts on the normal route scheme) and the vague-`view` shorthand
emitters + gates delete; the full-form projection + follow machinery
(`collectIdFollows` / `auxiliaries`, the `<View>Row` synthesis) **relocate**
to the projection path — the largest slice, and it *moves* code more than
it deletes it, so it lands last, behind the primitive + `scaffoldPaged` +
the projection-clause surface.

---

## Grammar

Very little is new — the primitive exists; the proposal *positions* it.

### EXISTING — leveraged unchanged (shipped)

- `criterion` (`ddd.langium:1477`), `retrieval` (`ddd.langium:~1502`) —
  the query language.
- `Repo.run` / `Repo.findAll(<criterion>)` read builtins
  (`loom-ir.ts:1494`, `:3173`).
- `reading` domain-service tier + `loom.domain-service-no-repo-write`
  (`domain-service-checks.ts:129`) — the read-only setting, already
  enforced.
- `QueryHandler` / `Route` — the escape hatch + the `queryHandler` +
  `route` `scaffoldPaged` emits into. (`View` — deprecated, § "`view`
  deprecates".)

### NO NEW KEYWORD — the exposed read is a scaffold

rev. 2 floated a `read` context member as sugar for a single-`run`
exposed read. **rev. 3 drops it.** The named, paged, exposed read is
`scaffoldPaged(of: X)` (§ "The ergonomic default"), which emits an
ordinary `queryHandler` — no new declaration kind, no `ReadDecl` rule.
The scaffold stdlib is the right home for "assemble the common quartet
from primitives"; a keyword would duplicate what the macro already does,
and the `view`/`retrieval` merge (also considered) was declined for the
same reason — the shared job is a macro *output*, not a new construct.

### CHANGED — `run` accepts a criterion; repository finders deprecate

- `run`'s argument widens from "named retrieval only" to
  **`criterion | retrieval`** (the inline-criterion path already lowers;
  this makes it first-class and documented).
- A wire-shaped repository `find byX(...)` (a list query as a bespoke
  method) warns `loom.repository-find-deprecated` → "pass a `criterion`
  to `run`, or name it a `retrieval`." A `find` returning `T?` by a
  **unique key** is *reconstitution*, not a list query, and stays legal
  (see Open questions). Deprecation, not removal — existing `.ddd` parses.

### CHANGED — the api read derivation targets the read-only face

Unchanged surface (`api X from Y`); the derived read routes bind to the
read-only face and query via criteria (above). The load-bearing rule:
`loom.route-targets-write-repository` — a route may not reach the
mutating face.

---

## IR

Minimal:

- The **read-only face** is a resolution/validation fact, not a new node:
  a `RepoReadCall` (`readKind: "run" | "find" | "findAll" | "named"`,
  `loom-ir.ts:3173`) in a read position is read-only; a write builtin in a
  read position is rejected. No IR shape change — the existing `repo-run`
  path already carries inline criteria via `findAllBy<Criterion>`
  (`loom-ir.ts:1494`).
- `scaffoldPaged` lowers to nothing new — it *emits* existing nodes
  (`QueryHandlerIR` + a `query`/`response` payload + `RouteIR`) at macro
  time, then lowers as ordinary AST. Reuses, not reinvents.
- The **follow** (ex-`view`): the `collectIdFollows` / `auxiliaries` planner
  (`lower-view.ts:96`) relocates from the view lowerer to the **query-time
  `projection`** lowering, so a query-time projection's binds can follow an
  `X id` ref (batch-loaded). Not a new node — a relocated pass onto the
  generalised `ProjectionIR`.
- `ApiIR` read routes derive onto read-only-face calls (a `scaffoldApi` /
  enrich-relocation concern, per unfoldable-api-derivation).

`wireShape` retirement (unfoldable-api-derivation) is **no longer central**
to this proposal: a plain `run` read returns the aggregate wire shape,
which is correct for the CRUD default. The DTO/`response` boundary only
enters via the `queryHandler` escape hatch, where it's explicit anyway.

---

## Validation

Shipped, reused:

- `loom.query-handler-saves` (`api-checks.ts:120`) — read escape hatch stays read-only.
- `loom.domain-service-no-repo-write` (`domain-service-checks.ts:129`) — the `reading` tier's read-only gate.

New:

| Code | Rule | Severity |
|---|---|---|
| `loom.read-context-repo-write` | a write builtin (`save`/mutation) called from a read position (api read route / `queryHandler`) — the generalisation of the shipped `reading`-tier gate | error |
| `loom.route-targets-write-repository` | a route reaches the mutating repository face | error |
| `loom.repository-find-deprecated` | a wire-shaped list `find` on a repository (pass a `criterion` to `run` / name a `retrieval`) | warning |
| `loom.view-deprecated` | a `view` declaration (fold into `scaffoldPaged` + `response`; `ddd migrate reads`) | warning |

`loom.read-context-repo-write` is the load-bearing one — it *is* the
read-only setting, made structural, extended from the `reading` tier to
every read position.

---

## Per-backend emission

Uniform, because the primitive is portable and mostly already emitted:

| Backend | Read-only port renders as |
|---|---|
| **Hono / node** | the router receives a **read-only repository handle** (the read subset — `findById` / `run` / `findAll`), not the full `new OrderRepository(db, events)`; `run(<criterion>)` renders the existing Drizzle predicate + `orderBy`/`limit`/`offset` (retrieval.md path). |
| **.NET** | the read-only `IReadRepository<T>` / `AsNoTracking` query the `reading` tier already emits (`domain-services.md:137`); `run(<criterion>)` is the Ardalis `Specification<T>` (retrieval.md). |
| **Java / Spring** | a read-only repository / `Specification<T>` executed via `findAll(spec, Pageable)`. |
| **Python / FastAPI** | a read-only repository object; `run` → the SQLAlchemy predicate. |
| **Elixir / Phoenix** | a context read function; `run(<criterion>)` → a composable `Ecto.Query`. |

The `.NET`/`reading`-tier `AsNoTracking` read repository is the existing
proof this shape emits cleanly; the change is making it the **api's** read
handle, not only a domain-service dependency.

---

## Migration story

No flag day; each slice independent:

1. **`run` accepts an inline `criterion`** first-class + documented (the
   lowering path exists; surface + validation + one test per backend).
2. **The read position gate** — `loom.read-context-repo-write` generalises
   the `reading`-tier check to api read routes / `queryHandler`. Pure
   validation; no emit change.
3. **Read routes bind the read-only handle** — the router receives the
   read subset; `save` becomes unreachable from a read. Wire byte-identical.
4. **`scaffoldPaged(of: X)` stdlib macro** — the polymorphic scaffold
   (aggregate / criterion / retrieval → paged `queryHandler` + `response`
   + `route`), joining the `scaffoldApi` family. This is the ergonomic
   default; ship it before deprecating the legacy derivation.
5. **`projection` query-time flavor** — add the `from … where … bind …`
   body to `projection` (beside the folded `keyed by … on`), with the
   relocated `X id` follow / batch-load (`collectIdFollows`, `auxiliaries`)
   moved from the view lowerer. This is the target `view`'s full form folds
   into; ship it before the view deprecation.
6. **`find`→`run(criterion)` / `retrieval`** — deprecation warning + a
   `ddd migrate reads` codemod over in-repo examples.
7. **`view` retirement (last, largest)** — `loom.view-deprecated` warning +
   `ddd migrate reads` rewrites the two shapes (shorthand → `scaffoldPaged`;
   full form → a query-time `projection`); then delete the 5-backend view
   emitters, the `/views` routers, the `loom.view-*` gates, and the view UI
   scaffold. Lands last: biggest change, and depends on slices 4–5 (the fold
   targets — `scaffoldPaged` + the query-time projection flavor) existing.

Existing `.ddd` keeps parsing throughout; the visible changes are that a
list `find` and a `view` warn, and a read can no longer `save`.

---

## What this deliberately is NOT

- **Not full event-sourced CQRS by default.** One write model. The default
  read returns the aggregate queried by criterion at query time. A custom
  read model is a `projection` — and even its *folded* (materialized,
  event-sourced) flavor is opt-in per read model, never forced; the
  query-time flavor needs no events at all.
- **Not a mandatory DTO layer.** A plain `run` read returns the aggregate
  wire shape — right for the CRUD majority. The `response` DTO boundary is
  the `queryHandler` escape hatch, not a tax on every read. *(This is the
  main rev. 1 → rev. 2 change: rev. 1 forced a DTO + handler per read; the
  owner steer is that the read-only criterion port is enough for almost
  everything.)*
- **Not removing repositories or all finders.** The repository stays; it
  gains an enforced read-only face and stops accreting list-finders in
  favour of criteria. Unique-key reconstitution finds stay.

---

## Open questions

1. **`scaffoldPaged` naming.** Its own word (`scaffoldPaged(of: X)`), or
   folded into `scaffoldQuery(of: X, paged: true)` (the
   unfoldable-api-derivation leaf)? Lean: a distinct `scaffoldPaged` — the
   paged-list read is the common case and deserves the short name — but
   confirm against the `scaffold<NodeKind>(of: X)` family (paged-list isn't
   a node kind). Cosmetic; either works.
1a. **Two `projection` bodies under one keyword — coherent?** rev. 6
   resolves the naming knot (the survivor *is* a `projection`), but at the
   cost of `projection` carrying two quite different bodies (`from … where …
   bind …` query-time vs `keyed by … on(e)` folded) and two emitters
   (repository-query-at-read vs table+fold-at-write). The claim is they are
   one construct — a *derived, non-authoritative read model* — differing
   only in population strategy (the read-side twin of aggregate
   `state`-vs-`eventLog`). **This is the main thing to pressure-test.** If
   the two bodies feel like two constructs sharing a name, the fallback is a
   distinct keyword for the query-time flavor (`readModel` / `select`); the
   folded `projection` is untouched either way.
2. **Explicit read-only marker vs implicit-by-position.** Is the read-only
   *setting* purely positional (recommended — matches the `reading` tier,
   no new syntax), or should a marker make the capability visible at the
   reference site? Positional covers the semantics; explicit is a
   readability nicety. Lean positional. *(Distinct from the dropped `read`
   member — this is about how the read-only face is spelled at a call, not
   a new declaration.)*
3. **What `scaffoldPaged` returns.** The aggregate's `apiRead` projection
   (`OrderResponse paged`) by default. When a caller needs a divergent
   shape, do they (a) unfold and edit the emitted `queryHandler` (its
   `response` binds may follow `X id` refs), or (b) pass a `response:`
   override to the macro naming a declared `response`? Lean: (a) for
   one-offs, a named `response` + override for reused custom shapes; this
   is where `view`'s custom-projection job now lives.
4. **Unique-key reconstitution `find`.** A `find bySlug(slug): T?` with a
   unique-key `where` is reconstitution, not a list query — stays exempt
   from `loom.repository-find-deprecated`? Lean: yes; the deprecation
   targets list finders (`T[]`) only.
5. **Does `run` supersede `findAll`?** `findAll(page)` is `run` with no
   predicate. Keep `findAll` as the readable no-filter spelling, or make it
   `run()` with an empty criterion? Lean: keep `findAll` (reads better;
   already shipped).
6. **Which criteria does `scaffoldPaged` get pointed at?** The macro is
   explicit (`with scaffoldPaged(of: InRegion)`) — the author names the
   criterion/retrieval/aggregate to expose. An `exposed`-style
   auto-exposure of *every* criterion is rejected (too much surface); the
   `scaffoldApi` composer may fan `scaffoldPaged` across an aggregate's
   declared exposable retrievals, but per-criterion opt-in stays the rule.

## Cross-references

- [`criterion.md`](./criterion.md) — the predicate atom; the query
  language `run` consumes. Its deferred `from <Criterion>` auto-exposure
  is open question 5 here.
- [`retrieval.md`](./retrieval.md) — the *named* criterion+sort+loads
  bundle; `run`'s other argument form.
- [`domain-services.md`](./domain-services.md) — the `reading` tier: where
  the read-only setting already lives and is already enforced. This
  proposal generalises that gate to every read position.
- [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) — the
  `queryHandler` / `route` orchestration escape hatch (landed) and
  `scaffoldApi` unfold path.
- [`views.md`](../views.md) — the `view` construct this proposal **retires
  entirely** (§ "`view` dies"): shorthand → `scaffoldPaged(of: criterion)`;
  full form → the **query-time flavor of `projection`** (inline shape +
  join-capable binds, moved verbatim).
- [`projection.md`](./projection.md) — the read-model construct this
  proposal **generalises**: it already frames `view` and `projection` as one
  read model at two consistency points (always-current query-time vs
  materialized folded) and ships the refold lint between them. rev. 6 makes
  that literal — `projection` gains the query-time flavor and absorbs
  `view`'s full form; the folded flavor is unchanged.
- `docs/architecture.md` — the api-derivation table this rewrites:
  repository `find` → a `criterion`-driven read on the read-only face, not
  a bespoke route-bound finder.
