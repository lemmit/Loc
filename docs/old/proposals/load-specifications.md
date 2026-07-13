# Aggregate load specifications — `loads`, default-whole, future inference

> **[2026-06-20 status audit]** Whole-aggregate default now rides retrieval emission on FIVE backends (Hono/.NET/Python/Java/Phoenix), not 'three'. Explicit-`loads` gate accurate (`query-checks.ts:~204`).

> Status: **partially implemented — see [`docs/old/plans/retrieval-implementation.md`](../plans/retrieval-implementation.md) ("PR4" + "Next phases") for what actually shipped.** The `loads:` grammar exists and the **whole-aggregate default is live on all three backends**. The explicit-`loads` *narrowing*, the operation-side `loads` clause, and the `loom.loads-incomplete` / `loom.retrieval-loads-insufficient` validators described below were **superseded** by the autoload (auto-inference) direction: explicit `loads:` is currently **gated** at IR validation (`loom.retrieval-loads-unsupported`), and per-operation autoload — which derives the load set from each body, making it sufficient by construction — is the planned replacement (Phase 5). The body below is the original proposal, retained for the v2 auto-inference + cross-aggregate-fetch design.

## TL;DR

**v1**: load the **whole aggregate by default** at every call site.
Authors who want optimisation supply an explicit `loads:` clause
(operation-side) or `loads:` argument (call-site) to **restrict**
the load (load only needed paths) or **expand** it (eager-hydrate
cross-aggregate references).

**v2 roadmap**: compiler-inferred load shapes (compiler walks the
body to derive the needed paths), interprocedural propagation,
shape-typing of aggregate values, guard narrowing (`is loaded`).
Deferred — the inference + propagation machinery is genuinely
complex; v1 ships with explicit annotations only.

**Internal realisation**: the default-whole load is the zero-value of a
derived IR structure, `LoadPlanIR` — `whole(agg)` (full owned tree,
cross-aggregate refs as ids). Every retrieval carries one; explicit
`loads:` *transforms* it (restrict ∩ / expand ∪). The default is
enrich-phase structural (like `wireShape`); v2 inference *narrows* the
same `LoadPlanIR` automatically. See
[`reified-criteria.md`](./reified-criteria.md) §"The internal seam" for
the `CriterionIR` + `LoadPlanIR` + `RetrievalIR` model, and
[`retrieval.md`](./retrieval.md) for the named-bundle keyword that
declares a load shape as part of a reusable query.

## Problem

An operation that touches `order.lines[].product.price` needs those
parts *loaded* before it runs, or it fails at runtime (lazy-load
exception, or silently wrong on a detached graph). When operations
compose, the required shape is the **union** of what each step
touches. The proposal turns a class of runtime lazy-load failures
into compile-time diagnostics, **and** keeps simple code simple
via a sensible default.

## v1 model

### Default is whole aggregate

If an author writes no `loads` clause on the operation and no
`loads:` argument at the call site, the repository loads the
**entire aggregate** — every field, every containment, the full
owned tree. Cross-aggregate references (`Customer id`,
`Supplier id[]`, etc.) are loaded as ids only; the referenced
aggregates are **not** eagerly hydrated unless requested.

This keeps simple code simple. Authors think about load specifications
only when they care about performance — usually because they want
to eagerly fetch cross-aggregate references, or strip a load down
to a subset for high-throughput read paths.

### Explicit `loads` is optional optimisation

Two forms, both opt-in:

**Operation-side `loads` clause** (declarative documentation; rare
in typical code):

```ddd
aggregate Order {
  contains lines: OrderLine[]
  customerId: Customer id

  # No `loads` clause — body uses self.lines (containment), no cross-aggregate.
  # Default-whole load covers everything; no annotation needed.
  operation total(): decimal {
    return self.lines.sum(l => l.quantity * l.unitPrice)
  }

  # `loads` clause — declares cross-aggregate expansion.
  # Without it, `l.product` would not be loaded; runtime/compile-time error.
  operation applyPricing() loads Order { lines[].product } {
    self.lines.forEach(l => l.price := l.quantity * l.product.unitPrice)
  }
}
```

**Call-site `loads:` argument** (on built-in repo methods from
[`criterion.md`](./criterion.md)):

```ddd
workflow priceOrders() {
  # Default-whole load — covers all containments + own fields:
  let orders = Orders.findAll(HighValueOrder)
  for o in orders {
    # ERROR (compile-time) if op needs cross-aggregate path not loaded:
    o.applyPricing()    # operation declares `loads Order { lines[].product }`
                        # but workflow's default-whole doesn't include cross-aggregate.
                        # Either add `loads:` arg or let compiler infer (v2).
  }
}

# Fix v1 — explicit `loads:` arg at retrieval:
workflow priceOrdersV1(): Order[] {
  let orders = Orders.findAll(
    HighValueOrder,
    loads: [self.lines[].product]   # eager-load the cross-aggregate path
  )
  for o in orders {
    o.applyPricing()    # OK — load shape covers applyPricing's needs
  }
}
```

### Three use cases for explicit `loads:`

| Use case | Form | Why |
|---|---|---|
| Eager-fetch cross-aggregate refs | `loads: [self.customer.address, self.lines[].product]` | Avoid lazy-load runtime errors; compiler catches missing paths at retrieval call site |
| Restrict to subset (perf) | `loads: [self.id, self.status]` | High-throughput read path; load only the displayed columns |
| Documentation contract on operation | `operation foo() loads Order { lines[].product } { ... }` | Reader sees the requirement at the signature; reviewers ask "why?" |

In typical code, no `loads` annotations appear. The default-whole
covers everything that's part of the aggregate itself. Cross-aggregate
expansions are the most common opt-in.

### Compile-time checking in v1

When operations declare a `loads` clause and a body accesses paths
beyond that clause: validator error
(`loom.loads-incomplete` — author didn't declare a path the body
uses).

When a retrieval supplies fewer paths than a subsequent operation
needs (the workflow does `Orders.findAll(criterion, loads: [self.id])`
and then calls `o.applyPricing()` which needs `[self.lines[].product]`):
validator error
(`loom.retrieval-loads-insufficient` — call site needs to supply
more).

When `loads:` paths reference fields that don't exist:
`loom.invalid-path`.

These checks are **structural** — straightforward path-set checking.
They don't require inference; they compare what was declared at
each site.

### Path-expression syntax

Reuses Loom's existing containment vocabulary:

```
self.field                    # own field
self.field.subfield           # nested field
self.contained[]              # containment collection
self.contained[].subfield     # collection elements' field
self.referenced               # cross-aggregate reference (loads the related aggregate)
self.referenced.field         # cross-aggregate path
```

`[]` marks "across the collection". Same as `contains` syntax. No
arbitrary filters or lambdas in path expressions — just structural
paths.

## v2 roadmap (NOT in v1)

The original proposal's vision — compiler-inferred load shapes,
interprocedural propagation, shape-typing, guard narrowing — lands
as a v2 follow-up. Sketch of what comes later:

### Auto-inference (compiler walks the body)

Compiler analyses operation bodies + workflow bodies + the operations
they call. Derives the minimal load shape. Auto-injects `loads:` at
retrieval call sites. Author writes nothing; compiler synthesises.

**Why deferred**: the inference is genuinely complex — interprocedural
fixpoint over the call graph, loops/recursion, aliasing, polymorphic
operations over inherited aggregates. Lots of edge cases. Useful but
not necessary for correctness — v1's explicit annotations cover the
correctness need; inference is an ergonomic improvement.

### Shape typing (internal IR)

Aggregate values carry their loaded shape as an IR-level attribute:
`Order { lines[].product }` vs `Order { * }`. The compiler tracks
the shape through assignments, parameter passing, return values.
Subsequent operations are checked against the shape.

**Why deferred**: requires a real type-system extension. The path
lattice (subsumption, normalisation) is straightforward but
implementing it across every IR pass is real work.

### Guard narrowing (`is loaded` predicate)

```
if order.lines is loaded then
  let total = order.lines.sum(l => l.subtotal)
else
  # alternative path
```

Branch-sensitive shape narrowing — occurrence-typing style. The
true branch has `lines` loaded; the false branch doesn't.

**Why deferred**: niche; most code doesn't need it. Adds occurrence-typing
machinery for a small ergonomic win.

### Composition of `loads:` across composed criteria

When `Customers.findAll(ActiveCustomers && InRegion("EU"))` is
written, today's model treats the two criteria as a single
boolean. With shape-typing, each criterion could contribute its
own load hints (e.g., a criterion that references
`customer.recentOrders[]` declares it as a load dependency). The
union would compose into the retrieval's effective load shape.

**Why deferred**: speculative — no clear use case yet. Revisit when
inference (above) lands.

## Open questions

- **Whether the synthesised load plan is always inferred or can be
  hand-written too** (v1: hand-written via explicit `loads`; v2:
  inference auto-derives + supplements).
- **Loops, recursion, aliasing, dynamic path construction** — v2
  concerns for inference.
- **Polymorphic operations over many aggregate shapes** — interacts
  with aggregate inheritance; needs careful design.
- **Interaction with data-policy row/field filtering**, since both
  wrap `Repo.load` — see the supplementary note.

## Per-backend eager-fetch realisation

A `loads:` shape is each backend's eager-fetch configuration. The
idiomatic mapping — *not* a hand-rolled query fragment:

| Backend | Owned collection fetch | Cross-aggregate to-one expansion |
|---|---|---|
| **Hono / Drizzle** | the existing `findById` / `findManyByIds` bulk-load-by-ids pattern (already emitted) | an extra keyed load following the `X id` ref |
| **.NET / EF Core** | `Query.Include(x => x.Children)` on the spec | `.Include(...).ThenInclude(...)` |
| **JPA / Hibernate** | **`@BatchSize`** (or global `hibernate.default_batch_fetch_size`) on the `@OneToMany` — paginate roots cleanly, batch-load collections as `… where parent_id in (?,?,…)`; turns N+1 into N/batch+1 **without** breaking SQL pagination | **`@EntityGraph(attributePaths = …)`** on the repository method, **one annotated method per source-known load shape** (the `loads:` set is closed at compile time → static enumeration, no dynamic CriteriaBuilder) |

**JPA gotchas this avoids by design:**

- **No load shape ⇒ lazy.** A `@OneToMany` with no graph is not fetched;
  accessing it either N+1s (session open) or throws
  `LazyInitializationException` (session closed). `loads:` exists to make
  that deterministic — `whole(agg)` fetches the owned tree.
- **Collection-fetch + pagination.** An `@EntityGraph` that pulls a
  *collection* together with a `Pageable` forces Hibernate to paginate
  **in memory** (`HHH000104`). `@BatchSize` on owned collections sidesteps
  it (page the roots, batch the children); reserve `@EntityGraph` for
  to-one expansion where no in-memory-pagination penalty applies.
- **restrict vs expand** maps to the graph *type*: `loads:` that restricts
  → `jakarta.persistence.fetchgraph` (strict — unlisted attrs lazy);
  `loads:` that expands → `jakarta.persistence.loadgraph` (listed eager,
  rest follow mapped defaults).

## Feeds provenance

This layer is designed to interoperate with
[value provenance](./provenance.md): the repository-load trace
records *what shape was requested*, the evaluation trace records
*what paths were actually used*, so Explain can show both the
declared requirement and the realised access path.

## Cross-references

- [`criterion.md`](./criterion.md) — built-in repository methods
  (`getById` / `findById` / `find` / `findAll`) take `loads:` as
  an optional argument using the path-expression syntax defined
  here.
- [`exception-less.md`](./exception-less.md) — `?` propagation
  composes with `loads:` shape failures (compile-time diagnostic).
- [`retrieval.md`](./retrieval.md) — a `retrieval` declaration carries a
  `loads:` slot as part of the named bundle; `Repo.run` executes it.
- [`reified-criteria.md`](./reified-criteria.md) — the `LoadPlanIR`
  structure (default `whole(agg)`) this policy is realised by.
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — load
  shapes over abstract aggregates: `loads Party { contact.email }`
  applies to every concrete subtype that shares the `contact` path.
