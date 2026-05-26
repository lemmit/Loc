# Aggregate load specifications — `loads`, inferred shape typing

> Status: proposal. Not in `ddd.langium`.

## Problem

An operation that touches `order.lines[].product.price` needs those
parts *loaded* before it runs, or it fails at runtime (lazy-load
exception, or silently wrong on a detached graph). When operations
compose, the required shape is the **union** of what each step touches.
Loom should let the compiler **infer the required load shape** from how
an operation (and everything it calls) uses the aggregate, verify that
the repository load actually fetched it, and turn a class of runtime
lazy-load failures into compile-time diagnostics.

This is a static **effect system for loadedness**, not a query
optimiser. Because an aggregate is a finite tree and the property is
just "which paths are loaded", it is a structural path-lattice problem —
**not** a full dependent/refinement-type checker.

## Surface

The default is **inference**: the author writes nothing, and the
compiler derives the shape from member accesses. An explicit `loads`
clause is available to state (or tighten) the requirement and to
document intent. It reuses Loom's existing path/containment vocabulary:

```ddd
aggregate Order {
  contains lines: OrderLine[]
  customerId: Customer id

  // Explicit form — declares the shape this operation needs loaded.
  // `[]` denotes "across the collection", mirroring containment syntax.
  operation applyPricing()
    loads Order { lines[].product, customer.address }
  {
    // compiler verifies every access below is covered by `loads`
    lines.sum(l => l.quantity * l.product.price)
  }

  // No `loads` clause → the compiler infers the shape from the body.
  operation total() {
    lines.sum(l => l.quantity * l.product.price)   // infers: lines[].product
  }
}
```

When operations compose, specs **merge**:

```
operation a()  needs  Order { customer.address }
operation b()  needs  Order { lines[].product }
workflow  ab() ⇒ requires  Order { customer.address, lines[].product }
```

The repository load is then checked (or synthesised) against the merged
shape, so the call site is guaranteed to fetch what the body uses.

### Shape (loadedness) typing — optional witness

The refined-type idea from the source thread (`Loaded<Order, Spec>`,
`Order<Loaded(lines.product)>`) is kept as an **internal IR witness**,
not a user-facing generic — Loom has no generics surface today. The
language stays declarative (`loads { … }`); the compiler tracks
loadedness as a path-set attribute on the value and narrows it across
guards (`if order.lines is loaded then …`).

## Language additions

| Addition | Form |
|---|---|
| `loads` clause | on `Operation` / `Workflow`: `('loads' shape=ShapeSpec)?` after the parameter list |
| `ShapeSpec` | `AggName '{' path (',' path)* '}'`; `path` is dotted with `[]` for collections — same vocabulary as `contains` |
| guard narrowing | `… is loaded` predicate usable in `if`/precondition position to narrow the shape in-branch |
| inferred specs | no surface; the validator computes them when `loads` is omitted |

## Lowering & generation

An interprocedural, flow-sensitive shape inference with a structural
path lattice:

1. **access-path extraction** — collect every member/containment path
   the body reads (including inside called operations).
2. **guard narrowing** — `is loaded` guards add paths in the true
   branch, occurrence-typing style.
3. **per-operation summary** — `requires` / `ensures` / `accesses` /
   `calls`.
4. **interprocedural fixpoint** — propagate and merge summaries across
   the call graph.
5. **shape algebra** — union / subsumption / normalisation over the
   aggregate's path tree (`customer.address` + `customer.address.city`
   → one normalised subtree).
6. **load synthesis** — map the normalised shape to a backend fetch
   plan: EF Core `.Include().ThenInclude()`, a SQL join tree, or an API
   expansion clause.
7. **verification** — every downstream access must be covered; on
   failure, emit a diagnostic pointing at the offending access, the
   operation that requires it, and the missing path — at compile time,
   instead of a runtime lazy-load failure.

The hard parts are interprocedural summaries, loops/recursion,
aliasing, and good diagnostics — *not* the type theory.

## Defaults and call-site `loads:` (added)

**Default is whole aggregate.** If an author writes no `loads`
clause and no `loads:` argument at the call site, the repository
loads the **entire aggregate** — every field, every containment,
the full owned tree. Cross-aggregate references (`Customer id`,
`Supplier id[]`, etc.) are loaded as ids only; the referenced
aggregates are not eagerly hydrated unless requested.

**`loads` is optimisation, not requirement**: an explicit `loads`
clause / argument either restricts (load less than the whole for
read-only scenarios) or expands (eager-hydrate cross-aggregate
references the body will traverse).

This default keeps simple code simple. Authors only think about
load specifications when they care about performance — usually
expanding to cross-aggregate references they want to eagerly fetch,
or stripping down to a subset for high-throughput read paths.

### Call-site `loads:` argument

`loads:` is available as a runtime argument to the built-in
repository methods introduced by [`criterion.md`](./criterion.md):

```
# Whole aggregate (default):
let order = Orders.getById(orderId)?
# order's shape: Order { * } — all fields, all containments

# Restricted shape (read-only optimisation):
let summary = Orders.getById(orderId, loads: [self.id, self.customerId, self.status])?
# summary's shape: Order { id, customerId, status } — only those paths

# Expanded shape (eager-load related aggregates):
let order = Orders.getById(orderId, loads: [self.lines[].product, self.customer.address])?
# order's shape: Order { *, lines[].product, customer.address }
```

`Repo.list` accepts the same argument:

```
workflow listForPricing(): Order[] {
  return Orders.list(
    HighValueOrder,
    sort: [createdAt desc],
    page: { offset: 0, limit: 50 },
    loads: [self.lines[].product, self.customer.address]
  )
}
```

The path-expression syntax (`self.lines[].product`,
`self.customer.address`) is the same vocabulary as the operation-side
`loads` clause defined in the previous sections. The retrieval side
just adds explicit call-site supply.

### Composition with operations

When a body calls operations that have their own `loads` clauses
declared, the compiler ensures the load shape from the retrieval
covers the operations' requirements:

```
aggregate Order {
  operation applyPricing() loads Order { lines[].product } { ... }
  operation finalize()     loads Order { lines[].product, customer.address } { ... }
}

workflow priceOrders() {
  # Default-whole load (no `loads:`) — covers everything; OK:
  let orders = Orders.list(HighValueOrder)
  for o in orders { o.applyPricing()  /* OK */ ; o.finalize()  /* OK */ }

  # Restricted load — must cover what's called:
  let summaries = Orders.list(HighValueOrder, loads: [self.id, self.status])
  for s in summaries {
    s.applyPricing()  # ERROR: requires lines[].product, not loaded
  }

  # Expanded load — eagerly fetches cross-aggregate for finalize():
  let fullOrders = Orders.list(HighValueOrder, loads: [self.lines[].product, self.customer.address])
  for o in fullOrders { o.finalize()  /* OK */ }
}
```

### Auto-derivation (v2 — flagged)

The proposal already describes inference for operation-level
`loads` clauses (compiler walks the body, derives the shape). A
future v2 extension applies the same inference to **call-site**
`loads:` arguments: the compiler analyses the result's downstream
usage (operations called, paths accessed) and synthesises the
optimal `loads:` arg automatically. v1 ships with explicit
`loads:` where optimisation matters; default-whole otherwise.

Naming for this v2 step: "load-shape inference at retrieval sites"
or "automatic eager-loading optimisation". Authors who don't care
get correct (whole) loads; authors who do care annotate explicitly.

## Feeds provenance

This layer is designed to interoperate with
[value provenance](./provenance.md): the repository-load trace records
*what shape was requested*, the evaluation trace records *what paths
were actually used*, so Explain can show both the declared requirement
and the realised access path.

## Open questions

- Concrete keyword spelling: `loads` (chosen here to avoid colliding
  with the existing `requires` authorization gate) vs `require loaded`
  from the source thread.
- Whether the synthesised load plan is always inferred or can be
  hand-written too (both implied).
- Loops, recursion, aliasing, dynamic path construction, and
  polymorphic operations over many aggregate shapes.
- Interaction with data-policy row/field filtering, since both wrap
  `Repo.load` — see the supplementary note.
