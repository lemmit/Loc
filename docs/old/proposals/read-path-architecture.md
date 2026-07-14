# Read-path architecture — the read-only repository query port

> Status: **DRAFT / PROPOSED** (2026-07-14, rev. 2). No code yet. A
> vision + grammar proposal.
>
> **rev. 2 reframes the core** (owner steer): the read path's one
> load-bearing primitive is a **read-only repository queried by
> `criterion`** — `Repo.run(<criterion>, sort?, page?)` under a
> **read-only setting** that structurally forbids writes. That single
> mechanism is *sufficient for almost every read*. The heavier machinery
> rev. 1 put on the default path (mandatory `queryHandler` + per-read
> `response` DTO + `find`→`retrieval` migration) demotes to **escape
> hatches** for the cases that actually need them.
>
> Composes, all already shipped: [`criterion.md`](./criterion.md) (the
> predicate atom — the query language), [`retrieval.md`](./retrieval.md)
> (the *named* criterion+sort+loads bundle), [`domain-services.md`](./domain-services.md)
> (the `reading` tier — **where the read-only setting already lives and
> is already enforced**), the `repo-run` / `Repo.findAll(<criterion>)`
> read builtins (`src/ir/types/loom-ir.ts:1494`, `:3173`), and
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) (the
> landed `queryHandler` / `route` seam — the orchestration escape hatch).
> `view` (saved declarative query) and [`projection.md`](./projection.md)
> (event-folded read model) are the two heavier escape hatches.

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

# A read — from a read-only position, so the compiler guarantees it can't mutate:
read activeEU: Customer[] = Customers.run(ActiveInRegion("EU"), sort: [name asc], page: page)
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
- **That is sufficient for almost everything.** Most reads are "list/one
  of aggregate X, optionally filtered." The read-only query port covers
  them. The heavier read constructs are opt-in for the minority that earn
  them:

| Need | Use | Not the default |
|---|---|---|
| list / one / filtered read of an aggregate | **read-only repository + `criterion`** | — (this *is* the default) |
| stitch several reads / diverge the wire shape from the aggregate | `queryHandler` (returns a `response` DTO) | only when a plain read won't do |
| a saved, named, declarative query with cross-aggregate `bind` | `view` | only when reused / curated |
| a denormalised read model folded from foreign events | `projection` (full CQRS) | only for event-sourced read models |

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
| **read-only** | `findById`, `run(<criterion \| retrieval>, sort?, page?)`, `findAll(sort?, page?)` | any **read position** — an api read route, a `reading` service, a `queryHandler`, a `view` |

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
- Inside an **api read route**, a `reading` service, a `queryHandler`, or
  a `view`, a repository reference is the **read-only** face. A write
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

## When the read-only port isn't enough — the escape hatches

Deliberately *not* on the default path; each earns its use:

- **`queryHandler`** (landed, unfoldable-api-derivation) — when a read
  must **orchestrate** (stitch several `run`s / call a `reading` service)
  or **diverge the wire shape** from the aggregate (return a `response`
  DTO, hide/rename/combine fields beyond the `apiRead` access filter). It
  runs the read-only port internally and projects. `loom.query-handler-saves`
  already keeps it read-only.
- **`view`** (landed) — a **saved, named, declarative** query with
  cross-aggregate `bind`-follow (`view X { … from Agg where P bind y =
  ref.name }`). Use when the shaped query is reused and worth naming
  declaratively rather than as an imperative handler.
- **`projection`** (in-flight, projection.md) — a **denormalised read
  model folded from foreign events**, its own table, `GET /projections/*`.
  The *full-CQRS* escape hatch for event-sourced read models and
  cross-aggregate denormalised reads that a query-time `run` can't serve
  efficiently. Opt-in per read model — never forced.

The ladder is legible: **`run(criterion)` for the 90%; `queryHandler`
when you orchestrate or reshape; `view` when you name it; `projection`
when you fold events.**

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
- `QueryHandler` / `Route` / `View` — the escape hatches.

### NEW — a read position for a top-level exposed read (optional sugar)

For a read that isn't inside a handler/service/view but should still be a
first-class, named, route-exposable read, a thin `read` member (sugar
over "a `queryHandler` whose body is a single `run`"):

```langium
// ContextMember += ReadDecl  (soft keyword, like `criterion` / `channel`)
ReadDecl:
    'read' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')?
    ':' returnType=TypeRef
    '=' query=Expression ;      // an expression in read position: Repo.run(...) / findById / findAll
```

`read` bodies are validated **read-only** (`loom.read-context-repo-write`)
and route-exposable directly (`route GET "/customers" -> Sales.activeEU`).
It is the declarative twin of `queryHandler` for the single-`run` case —
so the 90% path has a one-liner and only the orchestrating/​reshaping
minority reaches for the full `queryHandler` body. (If review prefers
*zero* new keywords, drop `read` and let the scaffold emit a
single-expression `queryHandler`; `read` is ergonomic sugar, not
load-bearing.)

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
- `ReadDecl` (if adopted) lowers to the same `QueryHandlerIR` shape with a
  single-expression body — or its own thin `ReadIR` that reuses the
  `repo-run` lowering. Reuses, not reinvents.
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
| `loom.read-context-repo-write` | a write builtin (`save`/mutation) called from a read position (api read route / `read` / `queryHandler` / `view`) — the generalisation of the shipped `reading`-tier gate | error |
| `loom.route-targets-write-repository` | a route reaches the mutating repository face | error |
| `loom.repository-find-deprecated` | a wire-shaped list `find` on a repository (pass a `criterion` to `run` / name a `retrieval`) | warning |

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
   the `reading`-tier check to api read routes / `queryHandler` / `view` /
   `read`. Pure validation; no emit change.
3. **Read routes bind the read-only handle** — the router receives the
   read subset; `save` becomes unreachable from a read. Wire byte-identical.
4. **`read` member** (if adopted) + route-exposability.
5. **`find`→`run(criterion)` / `retrieval`** — deprecation warning + a
   `ddd migrate reads` codemod over in-repo examples.

Existing `.ddd` keeps parsing throughout; the visible change is that a
list `find` warns and a read can no longer `save`.

---

## What this deliberately is NOT

- **Not full event-sourced CQRS by default.** One model. A read returns
  the aggregate queried by criterion at query time. `projection` (event
  folded, separate table) stays the opt-in escape hatch.
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

1. **Explicit `read` marker vs implicit-by-position.** Is the read-only
   setting purely positional (recommended — matches the `reading` tier, no
   new syntax), or should a `read`-marked repository handle make the
   capability visible at the reference site? Positional covers the
   semantics; explicit is a readability nicety. Lean positional.
2. **`read` member: worth a keyword, or fold into `queryHandler`?** A
   single-`run` read is nearly a bodyless `queryHandler`. `read X: T[] =
   Customers.run(...)` is a nicer 90%-path one-liner; the cost is a
   keyword. Lean: ship `read` as sugar; it's the declarative twin of
   `criterion`/`view`. Confirm.
3. **Unique-key reconstitution `find`.** A `find bySlug(slug): T?` with a
   unique-key `where` is reconstitution, not a list query — stays exempt
   from `loom.repository-find-deprecated`? Lean: yes; the deprecation
   targets list finders (`T[]`) only.
4. **Does `run` supersede `findAll`?** `findAll(page)` is `run` with no
   predicate. Keep `findAll` as the readable no-filter spelling, or make it
   `run()` with an empty criterion? Lean: keep `findAll` (reads better;
   already shipped).
5. **Criterion exposability → route.** Which declared `criterion` /
   `retrieval` auto-exposes as a `GET` with its params as query params, vs
   staying internal? Lean: an explicit `exposed`/`from`-style marker (the
   `criterion` `from <Criterion>` auto-exposure was already sketched in
   criterion.md's deferred set) rather than exposing every criterion.

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
- [`views.md`](../views.md) — the saved-declarative-query escape hatch.
- [`projection.md`](./projection.md) — the event-folded read-model
  (full-CQRS) escape hatch; deliberately opt-in, not the default.
- `docs/architecture.md` — the api-derivation table this rewrites:
  repository `find` → a `criterion`-driven read on the read-only face, not
  a bespoke route-bound finder.
