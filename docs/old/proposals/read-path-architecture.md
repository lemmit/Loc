# Read-path architecture — an honest application read layer, and the repository put back in its place

> Status: **DRAFT / PROPOSED** (2026-07-14). No code yet. This is a
> vision + grammar proposal, not a plan. It reconciles a coupling the
> current default read path has that the rest of Loom's design already
> disowns: an `api` mechanically exposes every aggregate's repository
> finds as query endpoints, and the generated route handler calls the
> repository **instance directly** — no application layer, and the
> aggregate repository doing double duty as the wire-facing query
> surface.
>
> It commits to the **read/write split, one model** direction (not full
> event-sourced CQRS): reads flow `route → queryHandler | view →
> repository`, the read side returns **response contracts (DTOs)** not
> aggregates, and the `repository` narrows to its DDD job —
> reconstituting whole aggregates by identity for the write side.
>
> Depends on / composes: [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
> (the `commandHandler` / `queryHandler` / `route` seam — **already
> landed**), [`domain-services.md`](./domain-services.md) (the `reading`
> tier), [`retrieval.md`](./retrieval.md) (the named query bundle),
> [`criterion.md`](./criterion.md) (the predicate atom),
> [`projection.md`](./projection.md) (the event-folded read model — the
> opt-in *full*-CQRS escape hatch), [`views.md`](../views.md) (saved
> queries), [`payload-transport-layer.md`](./payload-transport-layer.md)
> (the contract records the read side returns), and the D-ENVELOPE wire
> rule (`Paged<T>` / bare value). It introduces **almost no new
> grammar** — the seam it needs already shipped; the proposal is about
> making that seam the *default* read path and retiring the
> auto-repository-to-route derivation.

---

## TL;DR

Today the read path is flat and directly coupled. `api SalesApi from
Sales` names a subdomain; enrichment injects an implicit `find all():
T[]` on every aggregate's repository (`src/ir/enrich/enrichments.ts:1542`);
and the generated Hono route handler is literally a repository call:

```ts
// src/generator/typescript/emit/routes.ts:60  — app wiring
app.route("/api/orders", ordersRoutes(new OrderRepository(db, events)));

// src/generator/typescript/repository-find-builder.ts (route handler body)
const result = await repo.byCustomer(customerId);    // GET /orders/byCustomer
const found  = await repo.findById(Ids.OrderId(id)); // GET /orders/:id
return c.json(repo.toWire(found));
```

Transport → repository → Drizzle. There is no application read layer,
and the aggregate `repository` is the wire-facing query surface.

The target is one read-path shape, everywhere:

```
route  →  queryHandler | view | projection  →  repository
(transport)   (application read side,           (domain: by-id
               returns response DTOs)             aggregate reconstitution)
```

- **`repository` narrows** to `getById` / `findById` / `save` — whole-aggregate reconstitution for the write side. It is **never bound to a route**.
- **The read side returns contracts**, not aggregates. `queryHandler` / `view` project to `response` records; the DTO boundary is explicit.
- **`api` binds routes to handlers**, never derives from repositories. `scaffoldApi(of: X)` keeps the one-liner ergonomics by *synthesising* the query layer as real, unfoldable source.
- **Reusable shaped queries are `retrieval`s** — the named home for what ad-hoc repository `find`s used to be, consumed by handlers via `Repo.run`.

Nothing here requires event sourcing. `projection` remains the opt-in
*full*-CQRS read model for the aggregates that want it; this proposal is
about the default for the other 90%.

---

## The problem, precisely

### The coupling is transitive and auto-derived, not declared

`ApiIR` stores only `sourceModule` (`src/ir/types/loom-ir.ts:2344`) —
there is no api→repository edge. The read surface is *recomputed* from
the subdomain's aggregates + repositories every generate:

1. `api X from Sales` → the subdomain's contexts → their repositories.
2. Enrichment's `ensureFindAll` (`enrichments.ts:1542`) find-or-creates a
   `RepositoryIR` per aggregate and prepends an implicit `find all():
   T[]`, so every aggregate is unconditionally readable.
3. Each aggregate gets a router constructed with `new
   <Agg>Repository(db, events)` as its **sole dependency**
   (`emit/routes.ts:43-63`); the router signature is `repo:
   <Agg>Repository` (`routes-builder.ts:429`) and each read handler body
   is `await repo.<find>(...)` then `repo.toWire(...)`.

To know what the api exposes for reads, you run the generators and read
their output. To interpose *anything* — an authorization projection, a
DTO that diverges from the aggregate, a cached read — you edit the
generator. There is no source-level seam on the default read path.

### Two DDD smells, with different fixes

**Smell 1 — the interface layer reaches into a domain collection.** HTTP
talks straight to the repository. In layered / hexagonal DDD the
transport talks to an application service (a use case); the repository is
a domain-layer port. Loom *already does the right thing* on the write
side (`commandHandler` / `workflow` orchestrate; the route dispatches to
them) and on the .NET / Java read side (a Mediator query /
DI'd service). Only the node/Hono default read path skips the layer.

**Smell 2 — the aggregate repository is overloaded as the query
surface.** In Evans' DDD a repository reconstitutes *whole aggregates by
identity* — a write-side concern. Using it to serve arbitrary list /
projection queries for the UI is the "repository-with-40-finders" smell:
you load full aggregate trees to render a table, read concerns accrete on
the domain collection, and the wire shape is welded to the aggregate's
internal shape (`repo.toWire`). CQRS's insight — reads return purpose-built
DTOs, decoupled from the write aggregate — is the fix, and it does **not**
require a second persistence model to get the decoupling.

These are separable: Smell 1 is "add the application seam"; Smell 2 is
"return a contract, not an aggregate, and move ad-hoc finders off the
repository." This proposal fixes both, because fixing only Smell 1
(wrap `repo.findAll` in a passthrough handler that still returns the
aggregate) buys layering with none of the decoupling.

### Why this isn't already fixed — the landed seam isn't the default

[`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) already
landed the seam: `queryHandler` / `commandHandler` context members,
`route <M> "<path>" -> Ctx.Handler` api bindings, the `HandlerRef`
cross-ref, the one-directional layering validators
(`loom.query-handler-saves`, `loom.command-handler-multi-aggregate`,
`loom.route-handler-unresolved`, `api-checks.ts:120/136`), and per-backend
codegen on all five backends. What did **not** land is step 3–4 of that
proposal: the **`scaffoldApi` stdlib** that would *synthesise* handlers +
routes from a subdomain. Absent it, `api from` falls back to the legacy
auto-derivation — routes mechanically bound to repository finds. So the
honest read path is opt-in and hand-written; the default is the coupled
one. **This proposal is the missing default.**

---

## Target architecture

### The three tiers, and what each may touch

| Tier | Construct | Reads | Returns | Wire-facing? |
|---|---|---|---|---|
| **transport** | `route` | — | — (binds a method+path to a handler) | yes |
| **application read** | `queryHandler`, `view`, `projection` | repositories, `retrieval`s, other query handlers | **`response` contract (DTO)** | no (a route surfaces it) |
| **domain** | `repository` | its store | **whole aggregate** (by id) | **no — never bound to a route** |

The edges are strictly one-directional, matching Loom's pipeline
discipline and the `pipeline-layering.test.ts` philosophy:

```
        route ─────────────► queryHandler / view / projection
      (transport)                    │
                                     ▼
                                repository  (by-id reconstitution)
                                     │
                                     ▼
                                  store
```

- A **route** may reference a handler; it must not name a repository or an aggregate.
- A **queryHandler** may call a repository / `retrieval`; it must return a `response`, never a bare aggregate.
- A **repository** exposes `getById` / `findById` / `save`; it has no route and no DTO knowledge.

### Where the ad-hoc finders go

Today's `repository Orders for Order { find byCustomer(...) }` splits:

- The **shaped query** — predicate + sort + loads — becomes a
  [`retrieval`](./retrieval.md): `retrieval OrdersByCustomer(customer:
  Customer id) of Order { where: ... sort: ... }`. This is exactly what
  `retrieval` was built for (it already ships on five backends), and it
  is *domain-layer* (returns `Order[]`).
- The **wire exposure** becomes a `queryHandler` that runs the retrieval
  and projects to a DTO:

```ddd
context Ordering {
  aggregate Order { ... }

  // domain: reconstitution only
  repository Orders for Order { }          // getById / findById / save — implicit

  // domain: the named query (was `find byCustomer`)
  retrieval OrdersByCustomer(customer: Customer id) of Order {
    where: this.customerId == customer
    sort:  [placedAt desc]
  }

  // application read side: returns a DTO, not an Order
  queryHandler ListOrdersByCustomer(q: OrdersByCustomerQuery): OrderResponse paged {
    return Orders.run(OrdersByCustomer(q.customer), page: q.page)   // project → OrderResponse
  }
}

api SalesApi {
  source: Sales
  route GET "/orders/by-customer" -> Ordering.ListOrdersByCustomer
}
```

Generated (Hono sketch — the layer is now real):

```ts
// application/list-orders-by-customer.ts
export async function listOrdersByCustomer(q: OrdersByCustomerQuery, db: Db): Promise<Paged<OrderResponse>> {
  const orders = await new OrderRepository(db).run(ordersByCustomer(q.customer), q.page);
  return paged(orders.items.map(toOrderResponse), orders.total);   // DTO projection is explicit
}
// routes: GET /api/orders/by-customer → mediator/dispatch → listOrdersByCustomer
```

The `repository` is still constructed — but *inside the application
handler*, not handed to the router. The route no longer knows the
repository exists.

### The ergonomic default — `scaffoldApi` synthesises the layer

The whole point of DDD-honest layering is undercut if it triples the
line count of a CRUD app. So the default stays a one-liner, and the
layer is *scaffolded* (macro-expanded to real, unfoldable AST — the same
contract every Loom scaffold has: macro is the tracker, unfold is the
freeze):

```ddd
api SalesApi with scaffoldApi(of: Sales)
```

`scaffoldApi` (unfoldable-api-derivation steps 3–4) walks the subdomain
and emits, per aggregate:

- a `response <Agg>Response` contract (fields filtered by the `apiRead`
  access modifier — the existing `wire-projection.ts` logic, run at
  scaffold time);
- one `queryHandler` per readable shape (`ListOrders`, `GetOrderById`,
  plus one per declared `retrieval`), each projecting to the response;
- one `route` per handler.

Unfold any leaf to take it over; the rest stays scaffolded. This is the
UI-scaffold model applied to the read path — "magic where it's obvious,
source where you need it."

---

## Grammar

The seam is landed; this proposal adds **one** narrowing rule and leans
on `scaffoldApi`. Marked NEW / EXISTING / CHANGED.

### EXISTING — leveraged unchanged (already shipped)

- `QueryHandler` (`ddd.langium:933`), `CommandHandler` (`ddd.langium:929`)
  — application-layer members, return type required on queries.
- `Route` / `HandlerRef` (`ddd.langium:505-512`) — transport binding.
- `Retrieval` (`ddd.langium:~1502`), `Criterion` (`ddd.langium:1477`) —
  the named query bundle + predicate atom.
- `View` (`ddd.langium:1443`) — saved query returning a curated shape.
- `payload | command | query | response | error` (`ddd.langium:875`) —
  the contract vocabulary the read side returns.

### CHANGED — `repository` narrows; `find` deprecates in favour of `retrieval`

The `Repository` rule stays, but the wire-facing `find` list is
**deprecated**. `repository` keeps a body only for the rare custom
reconstitution (e.g. an aggregate loaded by a natural key that isn't its
id):

```langium
Repository:
    'repository' name=ID 'for' aggregate=[Aggregate:ID]
    ('{' finds+=FindDecl* '}')?;     // body now optional; finds deprecated
```

- `getById` / `findById` / `save` stay implicit (unchanged).
- A `find` that is a **pure shaped query** (`where` + optional sort) emits
  a deprecation diagnostic (`loom.repository-find-deprecated`, warning)
  pointing at "hoist to a `retrieval`; expose via a `queryHandler`."
- A codemod (`ddd migrate reads`) rewrites `find X(...) where P` →
  `retrieval X(...) of <Agg> { where: P }` + a scaffolded `queryHandler`.

Deprecation-not-removal keeps existing `.ddd` parsing; the auto-derivation
that binds a `find` to a route (below) is what actually retires.

### CHANGED — the api read derivation retires

Legacy `api X from Sales` (no `with scaffoldApi`) currently
auto-unfolds repository finds into routes. Under this proposal `from`
still parses, but its **read derivation** changes:

- With `with scaffoldApi(of: X)`: the read layer is scaffolded (handlers
  + routes + responses). This becomes the recommended default; `ddd new`
  templates emit it.
- Bare `api X from Sales` (no `with`, no `route`s): a **transitional**
  mode — still auto-derives, but now through *synthesised* query handlers
  (a route never binds a repository directly), and emits
  `loom.api-implicit-read-derivation` (info) nudging toward
  `scaffoldApi`. Removed once every in-repo example migrates.

### NOT NEW — no new read keyword

The read side already has three constructs at three altitudes
(`queryHandler` for orchestrated reads, `view` for saved
declarative queries, `projection` for event-folded read models). Adding a
fourth "query service" keyword would be speculative generality — the
`reading` domain-service tier (`domain-services.md`) already covers the
"reusable read logic callable from a handler" case. The proposal
deliberately composes what ships.

---

## IR

Minimal — the nodes exist. Two changes:

- **`ApiIR`** stops carrying an implicit read surface. `routes: RouteIR[]`
  (`loom-ir.ts:2368`) becomes the *only* read surface; the legacy
  auto-derivation moves into the `scaffoldApi` macro (AST→AST), so no IR
  node is synthesised for an implicit route. The enrich-phase
  `ensureFindAll` (`enrichments.ts:1542`) relocates to scaffold time (it
  becomes "the scaffold emits a `findAll` query handler if the aggregate
  has none"), per unfoldable-api-derivation § "Auto-`findAll`".
- **`RepositoryIR.finds`** is retained but marked read-only-legacy; the
  backends stop emitting a route from a `FindIR` and instead emit the
  repository method for a `queryHandler` / `retrieval` to consume.

`QueryHandlerIR` (`loom-ir.ts:1341`), `RouteIR` (`loom-ir.ts:2368`),
`RetrievalIR` (`loom-ir.ts:928`) are unchanged.

### `wireShape` retirement rides along

With every wire read returning a declared `response`, the ad-hoc
`wireShape` projection (`repo.toWire`) loses its last read-path consumer.
This is exactly the retirement unfoldable-api-derivation § "wireShape
retires from the IR" specs (Phase 1: DTO emitters read contract
declarations; Phase 2: union bundles). This proposal makes that
retirement *the reason the read path is clean* rather than a separate
cleanup — the response contract **is** the decoupling.

---

## Validation

Existing (shipped) — reused:

- `loom.query-handler-saves` — a `queryHandler` must not mutate/save (`api-checks.ts:120`).
- `loom.route-handler-unresolved` — a route target resolves to a handler.
- `loom.domain-service-no-repo-write` — the `reading` tier is read-only (`domain-service-checks.ts:129`).

New:

| Code | Rule | Severity |
|---|---|---|
| `loom.query-handler-returns-aggregate` | a `queryHandler` returns a bare aggregate/`T[]` instead of a `response` contract | error |
| `loom.route-targets-repository` | a `route` binds to a repository find (transport reaching the domain collection) | error |
| `loom.repository-find-deprecated` | a wire-shaped `find` on a repository (hoist to `retrieval` + `queryHandler`) | warning |
| `loom.api-implicit-read-derivation` | bare `api X from Y` uses the transitional auto-derivation | info |

The load-bearing one is `loom.route-targets-repository` — it is the
structural statement of the whole proposal (transport may not name the
domain collection), the read-side twin of the write-side
`command-handler-multi-aggregate` layering gate.

---

## Per-backend emission

The read layer is uniform because the constructs are portable:

| Backend | Application read tier renders as |
|---|---|
| **Hono / node** | a plain exported `async function` per `queryHandler` in `application/`, dispatched from the route; repository constructed *inside* it; returns the `response` DTO. Replaces today's `repo.<find>` route handler. |
| **.NET** | *already there* — the `martinothamar/Mediator` `IQueryHandler<TQuery, TRet>` the backend emits today (`dotnet/emit/cqrs.ts`); this proposal points the route at it instead of auto-deriving from finds. Natural first backend. |
| **Java / Spring** | a `@Service` query method returning the response DTO; the `retrieval` renders as its `Specification<T>` (retrieval.md). |
| **Python / FastAPI** | a query function in the application package; repository injected; returns the pydantic response model. |
| **Elixir / Phoenix** | a context function (`Ordering.list_orders_by_customer/1`) returning the response struct; the retrieval is a composable `Ecto.Query`. |

`view` and `projection` keep their existing read endpoints
(`GET /views/*`, `GET /projections/*`) — they are *already* DTO-returning
application read tiers and need no change; they simply become
first-class citizens of the same three-tier model rather than side doors.

---

## Migration story

No flag day. Staged, each slice independently shippable:

1. **`scaffoldApi` stdlib lands** (unfoldable-api-derivation steps 3–4) —
   the ergonomic default exists. New projects use it.
2. **The transitional derivation reroutes** — bare `api from` synthesises
   query handlers instead of binding finds to routes. Byte-diff appears
   only in *how* the read route is wired (via a handler), not in the wire
   contract; conformance parity holds.
3. **`wireShape` Phase 1** — DTO emitters read `response` contracts
   (unfoldable-api-derivation step 5–6).
4. **`find`→`retrieval` codemod** — `ddd migrate reads` rewrites in-repo
   examples; the deprecation warning guides hand-written sources.
5. **Retire `ensureFindAll` from enrichment** — once every example is
   scaffolded, the enrich-phase injection is gone; `findAll` is a
   scaffold-time query handler.

Existing `.ddd` keeps parsing throughout; the only behavioural change a
user sees is that a `find` on a repository warns and a route can no
longer target one.

---

## What this deliberately is NOT

- **Not full event-sourced CQRS.** One persistence model. The read DTO is
  projected from the *same* aggregate the write side owns, in-process, at
  query time. `projection` (event-folded read models, separate table)
  stays the **opt-in** escape hatch for the aggregates that earn it — it
  is not forced on everyone. (This is the "read/write split, one model"
  decision, not "full CQRS default.")
- **Not a new query engine.** `criterion` still inlines into SQL; the
  repository still owns the store access. The change is *where the query
  is exposed* and *what shape it returns*, not how it executes.
- **Not removing repositories.** Repositories are domain-layer DDD
  citizens and stay. They stop moonlighting as the wire-facing query
  surface. That is the entire "put back in its place."

---

## Open questions

1. **Does `view` subsume the simple-read `queryHandler`?** A `view` is a
   declarative saved query returning a curated shape; a passthrough
   `queryHandler` that just projects `Orders.run(...)` → DTO is nearly a
   `view`. Lean: keep both — `view` is declarative (no body, `from … where
   … bind …`), `queryHandler` is imperative (a body that can stitch
   multiple retrievals / call a `reading` service). The line is the same
   `criterion`-vs-`service` line. Confirm the scaffold prefers `view` for
   the pure single-source case and `queryHandler` only when a body is
   needed.
2. **Repository custom reconstitution.** Some aggregates load by a natural
   key (`find bySlug`) that *is* reconstitution, not a query. Keep a
   narrow `find`-for-reconstitution (returns the aggregate, by a unique
   key) exempt from the deprecation? Lean: yes — `find` returning `T?`
   with a unique-key `where` is reconstitution and stays domain-legal; the
   deprecation targets `find` returning `T[]` (a list query).
3. **Where the DTO projection lives.** Scaffold-emitted `queryHandler`s
   project `Order → OrderResponse` with a generated `toResponse`. Is that
   projector a scaffold-time literal (unfoldable, editable) or a shared
   helper? Lean: literal in the unfolded form, shared in the macro form —
   the standard scaffold tracker/freeze contract.
4. **`reading` domain service vs `queryHandler`.** Both are read-only
   application-ish tiers. Confirm the layering: a `queryHandler` *may
   call* a `reading` service (reusable read logic), and a `reading`
   service returns domain objects (aggregates/values) while a
   `queryHandler` returns the wire DTO. The projection-to-DTO boundary is
   what distinguishes them.
5. **Pagination carrier.** `queryHandler` reads that page must return the
   D-ENVELOPE `Paged<T>` (`response … paged`), not a bare `T[]`. Confirm
   the scaffold always emits `paged` for list handlers (it has the
   information — the retrieval's cardinality).

## Cross-references

- [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) — the
  landed `queryHandler` / `route` seam and the `scaffoldApi` / `wireShape`
  retirement this proposal makes the *default*. This doc is that
  proposal's read-path half, committed to a persistence decision.
- [`retrieval.md`](./retrieval.md) — the named query bundle that becomes
  the home for ad-hoc repository finders.
- [`domain-services.md`](./domain-services.md) — the `reading` tier a
  `queryHandler` may call for reusable read logic.
- [`projection.md`](./projection.md) — the opt-in *full*-CQRS read model;
  the escape hatch this proposal deliberately does not make mandatory.
- [`views.md`](../views.md) — saved declarative queries; already a
  DTO-returning read tier, folded into the same three-tier model.
- [`payload-transport-layer.md`](./payload-transport-layer.md) — the
  `response` contract records the read side returns.
- [`criterion.md`](./criterion.md) / [`criterion-everywhere.md`](./criterion-everywhere.md)
  — the predicate atom, unchanged; still inlines into SQL.
- `docs/architecture.md` — the api-derivation table (§ derivation) this
  proposal rewrites: repository `find` → *no longer a route*; the read
  route derives from a `queryHandler`.
