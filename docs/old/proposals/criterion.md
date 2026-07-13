# Criterion — predicates for filtering, validation, and operation gates

> Status: **PARTIAL** — the core (`criterion` declaration + body
> validation + inline use in every existing boolean-expression position:
> `view`/`find` `where`, invariants, operation preconditions) is shipped;
> see [`docs/criterion.md`](../../criterion.md). **`when <pred>` + the
> auto-exposed `can-<op>` query (use site 2, the canCommand pattern) are
> SHIPPED on all five backends** (node / .NET / python / elixir / java): the
> route/handler evaluates the predicate against the loaded aggregate (false →
> 409 "Disallowed" ProblemDetails via `DisallowedError`/`DisallowedException`),
> and a side-effect-free `GET /{id}/can_<op>` returns `{ allowed }`; op-param
> references are rejected at validation; `loom.when-unsupported` is now latent.
> **`Repo.findAll(<Criterion>, page?)` from workflow bodies is SHIPPED on every
> backend** — it desugars to a synthetic `findAllBy<Criterion>` retrieval (the
> enrich pass materialises it from `ctx.criteria`), riding the existing
> retrieval/`Repo.run` pipeline.  The remaining surfaces (`from
> <Criterion>(args)`, findAll `sort:`/`loads:` + single-result
> `Repo.find(<Criterion>)`, `private workflow`) stay on paper. **Resolves D23**.
> Depends on
> [`payload-transport-layer.md`](./payload-transport-layer.md) (carrier
> generics + tagged unions) and
> [`exception-less.md`](./exception-less.md) (`or`-unions). Composes with
> [`load-specifications.md`](./load-specifications.md) for retrieval
> shape. Adjacent to existing `docs/views.md` and `docs/workflow.md`.

## TL;DR

A `criterion` is a named, parameterised, pure predicate over a type
`T` — the Specification Pattern in Eric Evans's original sense
(`isSatisfiedBy(t) → bool`), with composition via `&&` / `||` / `!`.
The same construct also serves as the Spring Data JPA Specification
analog: criteria translate to SQL (the queryable subset), can
reference cross-aggregate state via repository lookups, and feed
into a generic `Repo.findAll(criterion, sort?, page?, loads?)` method
on every repository.

Three consumers, one declaration:

1. **Input validation + UI affordances** — `from <Criterion>(args)`
   on a parameter or command field. The api wrapper validates the
   value against the criterion; the UI form-generator auto-derives
   dropdown options from the criterion's truth-set.
2. **Operation guards (canCommand)** — `when <Criterion>` on an
   aggregate operation. The api wrapper gates the operation against
   the criterion server-side; an auto-exposed
   `GET /can-<operation>` endpoint lets the UI query the predicate
   without invoking the side-effecting operation.
3. **Repository list queries** — `Repo.findAll(<Criterion>, sort?,
   page?, loads?)` from workflow bodies. The criterion drives the
   SQL `WHERE` clause; sort, page, and loads are call-site arguments.

**This proposal replaces an earlier `specification` design** that
bundled criteria + query shaping (sort / page / loads) into one
named construct. Per the Spring Data split, criterion stays pure
predicate; query shaping is per-call. Naming criteria + composition
+ call-site shaping covers the "repository with 40 methods"
problem without a separate Specification keyword.

**For reusable mutating cross-aggregate orchestration**, we use
the existing `workflow` construct with two extensions: `private
workflow` (reusing the `private` modifier from
`private operation` / `private invariant`) and workflow-calls-workflow.

## Why this matters

### The cross-aggregate domain rule problem

Cross-aggregate domain rules ("active customer", "supplier that can
fulfill X", "amount within credit limit", "valid status transition")
have nowhere clean to live today. Authors either inline them in
workflow bodies (couples orchestration with the predicate; no UI
generation), or duplicate them between server-side validation and
client-side UI logic.

A criterion names the predicate once and the synthesised layers
(api, UI, OpenAPI) consume it consistently.

### The "repository with 40 methods" problem

Without criteria + composition, repository finds combinatorial-explode:
- `findActive()`, `findInRegion(r)`, `findActiveInRegion(r)`,
  `findActiveOrderedByName()`, `findActivePaged(p)`, …

With criteria + `Repo.findAll`:

```
criterion ActiveCustomer of Customer = self.active
criterion InRegion(region: string) of Customer = self.region == region

Customers.list(ActiveCustomer && InRegion("EU"), sort: [name asc], page: { offset: 0, limit: 50 })
```

Forty methods collapse to a handful of composable criteria + a
single generic `list` method.

### Spring Data / Hibernate / Ardalis precedents

- **Eric Evans (DDD, 2003)** — `Specification<T>.isSatisfiedBy(T)` as a pure predicate; composable `and`/`or`/`not`.
- **Hibernate Criteria API** — `Criterion` = predicate fragment, `Criteria` = full query.
- **Spring Data JPA** — `Specification<T>.toPredicate(...)` = predicate; sort + pagination are runtime arguments via `Sort` / `Pageable`.
- **Ardalis.Specification (.NET)** — bundles criteria + ordering + paging + includes into one named class.

Loom adopts the Spring Data split: `criterion` for the predicate
(Evans's pure pattern), runtime args for shaping. This minimises
constructs while solving the same problems Ardalis solves with its
bundle approach.

## Surface — declaration

```
context Sales {
  # Predicate over an aggregate type. `self` is the candidate (implicit).
  criterion ActiveCustomer of Customer = self.active

  # Parameterised predicate.
  criterion InRegion(region: string) of Customer = self.region == region

  # Multi-line body via `where:` slot — equivalent to single-line `= ...` form.
  criterion CanForceClose of Order {
    where: self.status != Closed && currentUser.role == "manager"
  }

  # Predicate over a primitive type. Explicit candidate parameter (no `self`).
  criterion ValidOrderAmount(customerId: Customer id) of decimal {
    where: 0 < self && self <= Customers.getById(customerId).creditLimit
  }

  # Predicate over an enum. Match table inside the where.
  criterion AllowedStatusTransition(currentStatus: OrderStatus) of OrderStatus =
    self in (match currentStatus {
      Draft     -> [Confirmed, Cancelled]
      Confirmed -> [Shipped, Cancelled]
      Shipped   -> []
      Cancelled -> []
    })

  # Predicate over bool — pure ambient check, no `self`.
  criterion HasManagerRole of bool = currentUser.role == "manager"
}
```

Grammar shape:

```
criterion <Name>(<Param>*) of <T> {
  where: <bool expression>
}

# Single-line shorthand (when no other slots):
criterion <Name>(<Param>*) of <T> = <bool expression>
```

Only one slot: the predicate. Composition + parameters are the only
other concepts.

## `self` resolution

`self` is the implicit candidate inside the `where:` body. Its type
is `T` (the criterion's `of <T>` annotation):

- For `criterion X of <Aggregate>`: `self` is the aggregate instance
  being checked. Bare names resolve to `self.<field>` (same convention
  as `invariant`, `function`, `derived` declarations on aggregates).
- For `criterion X of <Primitive | ValueObject>`: `self` is the
  candidate value. Bare references to `self` access the value.
- For `criterion X of bool`: no `self`; the body is a pure predicate
  over the criterion's parameters and ambient context.

```
# Aggregate — `self` is the Order:
criterion CanForceClose of Order = self.status != Closed

# Primitive — `self` is the decimal candidate:
criterion ValidAmount of decimal = self > 0 && self < 10000

# Bool — no `self`:
criterion IsAdminContext of bool = currentUser.role == "admin"
```

## What `where` expressions can reference

The criterion's body is a **pure expression** in the queryable
subset (same restrictions as view `where` clauses today, per
`docs/views.md`):

| Allowed | Example |
|---|---|
| `self.<field>` (or bare `<field>`) | `self.active` |
| Criterion parameters | `region` (from `criterion X(region: string)`) |
| Aggregate functions on `self` | `self.canApprove()` (where `canApprove` is a pure `function`) |
| Cross-aggregate read via `Repo.getById` | `Customers.getById(customerId).creditLimit` |
| Other criteria | `ActiveCustomer.where && InRegion("EU").where` (or just composition, see below) |
| Ambient context | `currentUser.role`, `currentUser.permissions.contains(...)` |
| Collection ops in the queryable subset | `.any(p)`, `.all(p)`, `.count`, `.sum(...)`, `.where(p)`, `.contains(...)` |
| Arithmetic, comparisons, boolean operators | `0 < self && self <= max` |
| `match` over enums or tagged unions | `match status { ... }` |

**Not allowed** in a criterion body:

| Forbidden | Diagnostic |
|---|---|
| Mutation (`:=`, `+=`, `-=`) | `loom.criterion-impure` |
| Calls to aggregate operations that mutate | `loom.criterion-impure` |
| `emit Event { ... }` | `loom.criterion-impure` |
| `Repo.findAll` or other non-getById repo methods | `loom.criterion-impure` |
| Workflow calls | `loom.criterion-impure` |
| Closures / lambdas outside the queryable subset | `loom.criterion-not-queryable` |
| Op parameter references (when used in `when` clauses) | `loom.when-references-op-param` (at use site) |

Criteria are pure. Predicates only.

## Composition

```
ActiveCustomer && InRegion("EU")           # AND
ActiveCustomer || NewCustomer              # OR
!Banned                                    # NOT
(ActiveCustomer || NewCustomer) && InRegion("EU")    # grouping with parens
```

Standard boolean operators on criteria. Result is always another
criterion. Composition is associative for `&&` and `||`; `!` is
unary.

Composed criteria translate to SQL the obvious way (`WHERE
predicate1 AND predicate2`, etc.). The backend ORM handles JOINs
needed to evaluate cross-aggregate path references.

Named compositions:

```
# Compose at declaration time:
criterion EligibleEuCustomer of Customer = ActiveCustomer && InRegion("EU")

# Or compose at use site:
Customers.list(ActiveCustomer && InRegion("EU"))
```

Both forms produce the same lowered shape.

## Use site 1 — `from <Criterion>(args)` on parameters

Bind a parameter or command field to a criterion. The synthesised
api wrapper validates the parameter's value against the criterion;
UI form-generator auto-derives input options from the criterion's
truth-set.

```
command PlaceOrder {
  customerId:  Customer id   from ActiveCustomer
  orderType:   OrderType
  supplierIds: Supplier id[] from SuppliersForOrderType(self.orderType)
}

# Default values via the existing field-default syntax (= <expr>):
command UpdateCustomer {
  customerId: Customer id from ActiveCustomer = currentUser.lastCustomerId
}
```

### What auto-derives from the binding

| Concern | Auto-derived from criterion |
|---|---|
| Server-side validation | Wrapper executes the criterion's predicate against the incoming value. Mismatch → `CriterionFailed` typed error variant (default 422). |
| UI dropdown options | Form-generator translates the predicate to a query (`Customer where active`), executes, populates the `<select>` element. Cached when the criterion is parameterless and stable. |
| Per-form-field live filter | Criteria parameterised by other command fields re-evaluate as the form changes. |
| OpenAPI schema | Criterion contributes constraints (e.g., `enum:` for finite predicates, `min`/`max` for ranges). |
| Default value | Comes from the `= <expr>` clause at the binding site (existing parameter syntax). Not on the criterion itself. |

### Per-element loop for array parameters

`supplierIds: Supplier id[] from SuppliersForOrderType(orderType)`
lowers to:

```
for id in supplierIds:
  let s = Suppliers.getById(id)?   # NotFound if missing
  if !SuppliersForOrderType(orderType).where(s):
    return CriterionFailed {
      criterion: "SuppliersForOrderType",
      paramName: "supplierIds",
      id: id
    }
```

### Error variant

Stdlib `error` payload — same shape as the previous
`InvalidSpecMember` but renamed to match the new construct name:

```
# src/stdlib/payloads/errors.ddd
error CriterionFailed {
  criterion: string         # criterion name
  paramName: string         # bound parameter name
  id: string?               # offending id if aggregate
  value: string?            # offending value if primitive
}
```

Default status 422 (validation-shaped). API-surface override available.

## Use site 2 — `when <Criterion>` on aggregate operations (canCommand pattern)

Bind a criterion as the operation's pre-execution gate. The api
wrapper gates the operation server-side; an auto-exposed
`GET /can-<operation>` endpoint lets the UI query the predicate
without invoking the side-effecting operation.

```
aggregate Order {
  status: OrderStatus
  rejected: bool

  # Inline expression in `when`:
  operation cancel()
    when status != Shipped && status != Cancelled
  { status := Cancelled }

  # Reference an aggregate function:
  function canApprove(): bool = status == Submitted && !rejected
  operation approve()
    when canApprove
  { status := Approved }

  # Reference a named criterion (with implicit self):
  operation forceClose()
    when canApprove && CanForceClose
  { status := Closed }
}
```

### Auto-derived API endpoints

For each operation with a `when` clause:

| Endpoint | Behaviour |
|---|---|
| `POST /aggregates/<agg>/{id}/<op>` | (existing — augmented) Loads aggregate; evaluates `when` predicate; on false → 409 ProblemDetails (`Disallowed`); on true → runs op + saves + returns result. |
| `GET /aggregates/<agg>/{id}/can-<op>` | (new) Loads aggregate; evaluates `when` predicate; returns `{ allowed: bool, reason?: string }`. No mutation. Same authorisation as the op. |

### Response shape for `can-X`

```json
{ "allowed": true }
```

```json
{ "allowed": false, "reason": "CanForceClose" }
```

`reason` carries the name of the failing criterion (or "inline" for
inline expressions; for composite predicates, the first failing
operand).

### `Disallowed` error variant

```
# src/stdlib/payloads/errors.ddd
error Disallowed {
  operation: string         # "approve"
  aggregate: string         # "Order"
  id: string                # the aggregate id
  reason: string?
}
```

Default status **409 Conflict** (resource state mismatch). API-surface
override available.

### What `when` can reference

| Allowed | Example |
|---|---|
| `self.*` (aggregate fields/functions/derived) | `self.status == Submitted` |
| `currentUser.*` (ambient context) | `currentUser.role == "manager"` |
| Aggregate `function` (parameterless, pure) | `canApprove` |
| Named criterion (with implicit `self` if `of <Aggregate>`) | `CanForceClose` |
| Composition of any of the above with `&&` / `||` / `!` | `canApprove && HasManagerRole` |

**Not allowed**:

- Operation parameters (per the NakedObjects-style split: arg-aware checks go through `from <Criterion>(args)` on the parameters, not through `when`). `loom.when-references-op-param`.
- Inline `Repo.findAll` calls (use a named criterion / function). `loom.when-inline-list` warning.

### Interaction with `requires` (authorization) clauses

An operation can have both `requires` (auth.md authorization gate)
and `when` (criterion-based state gate). Order of evaluation in
the synthesised wrapper:

1. **`requires` first** — authorization check (`currentUser.permissions.contains(...)`).
   On failure → 403 ProblemDetails (per docs/auth.md).
2. **`when` second** — state-based gate (criterion).
   On failure → 409 ProblemDetails (`Disallowed`).
3. **Operation body** — runs only if both gates pass.

Rationale: auth must come first (don't reveal state info to unauthorised
callers). If a caller doesn't have permission, they get 403 without
learning whether the state would have allowed the op.

The auto-exposed `can-<op>` query mirrors the same order: `requires`
auth-check first; on failure → 403. `when` check second; result
returned as `{ allowed, reason? }`.

### Inheritance and `when` clauses

For aggregate-inheritance (`docs/old/proposals/aggregate-inheritance.md`):
a `when` clause declared on an abstract aggregate's operation
applies to every concrete subtype. The predicate's `self`
references resolve against the concrete's fields at runtime via
standard inheritance dispatch (TPH discriminator / TPC table /
TPT join).

Override semantics (concrete subtype redeclares `when` with
different predicate) deferred to v2. v1: inherited `when` is
final.

### Server-side auto-injection at every operation call site

The `when` clause is part of the operation's contract. Wherever
`agg.op(args)` is called (api wrapper, workflow body, sibling op),
the lowering pass injects the gate check:

```
# Source:
order.approve()?

# Lowered (when `approve` has `when canApprove`):
if !order.canApprove { return Disallowed { operation: "approve", aggregate: "Order", id: order.id } }
order.approve()?
```

Authors can't bypass the gate by calling through a non-api path.

## Use site 3 — `Repo.find` / `Repo.findAll` (and other repository methods)

Every repository gets generic built-in methods that take criteria
and runtime shaping arguments:

```
# Built-in on every repository (no explicit declaration needed):

# Single result by criterion (returns T or NotFound):
Repo.find(
  criterion: <Criterion of T>,
  loads?: PathExpression[]
): T { <load-shape> } or NotFound

# Multi-result by criterion (returns T[]):
Repo.findAll(
  criterion: <Criterion of T>,
  sort?: SortClause[],
  page?: Page,
  loads?: PathExpression[]
): T { <load-shape> } []

# (existing — augmented with loads:):
Repo.getById(id: T id, loads?: PathExpression[]): T { <load-shape> } or NotFound
Repo.findById(id: T id, loads?: PathExpression[]): T { <load-shape> } option

# (existing) Named finds with their declared return types — see below:
Repo.<name>(args): ...
```

`find` / `findAll` are criterion-based (general). `getById` /
`findById` are id-based (existing). Different surfaces; both
coexist.

**Warning when `findAll` is called without explicit `page:`**:
unbounded list reads risk DOSing the system. The validator emits
`loom.findAll-no-page` (warning, not error — some legitimate
use cases need full lists). Suggested fix: supply an explicit
`page: { offset: 0, limit: N }` argument.

### Repository finds can also use criteria

Named repository finds extend with criterion `where` clauses + the
same shaping clauses as `findAll`:

```
repository Orders for Order {
  # Existing: simple where with inline boolean
  find mine(): Order[] where customerId == currentUser.customerId

  # New: where accepts a criterion (composable):
  find latestActive(top: int): Order[]
    where ActiveOrder
    orderBy createdAt desc
    take top

  # Composed criteria + paging + loads:
  find activeInRegion(region: string, top: int): Order[]
    where ActiveOrder && InRegion(region)
    orderBy [createdAt desc, customer.name asc]
    take top
    loads { customer.address, lines[].product }
}

# Called from workflows like any other find:
Orders.latestActive(20)
Orders.activeInRegion("EU", 50)
```

Named finds are NOT a substitute for `findAll` — they're the
**named** form for stable repeatable queries. Use cases:

- Reusable named query that appears in many places (`Orders.latestActive(20)`
  vs writing the full `findAll(ActiveOrder, sort: [createdAt desc], page: { limit: 20 })`
  at every call site).
- Queries that read more naturally as a named verb on the repo.

`findAll` is the **ad-hoc** form for one-off queries composed at
the call site.

Both compose with the same criterion vocabulary. Authors pick
based on whether the query has a stable named identity or varies
per-call.

### Built-in shape types

| Type | Shape | Example literal |
|---|---|---|
| `SortClause` | `<field-path> (asc \| desc)` | `name asc`, `createdAt desc` |
| `Sort` | `SortClause[]` | `[name asc, createdAt desc]` |
| `Page` | `{ offset: int, limit: int }` (or `{ cursor: string, limit: int }` for cursor paging — v2) | `{ offset: 0, limit: 50 }` |
| `PathExpression` | path through aggregate (per `load-specifications.md` syntax) | `self.lines[].product` |

These are part of the toolchain's stdlib / built-ins, not user-declared.

### Worked example

```
workflow processHighValue(): Order[] {
  let highValue = Orders.findAll(
    HighValueOrder && InRegion("EU"),
    sort: [createdAt desc, total desc],
    page: { offset: 0, limit: 50 },
    loads: [self.lines[].product, self.customer.address]
  )
  for o in highValue {
    o.applyPricing()    # OK — load shape covers what applyPricing needs
  }
  return highValue
}
```

### Load shape — see `load-specifications.md` §"Defaults and call-site loads"

**Default** (no `loads:` arg): the **whole aggregate** is loaded —
all own fields, all containments. Cross-aggregate references are
loaded as ids only; the related aggregates are not eagerly
hydrated.

**Explicit `loads:`** = optimisation: load **less** (subset of own
fields/containments for read-only scenarios) **or** load **more**
(eager-hydrate cross-aggregate references the body will traverse).
Per `load-specifications.md`, the result is shape-typed: subsequent
operations are checked against the loaded shape.

**Auto-derivation** (compiler infers `loads:` from how the result
is used): v2. v1 ships with explicit `loads:` where optimisation
matters; default-whole otherwise.

## Use site 4 — `view from <Criterion>` (composes with views)

Views project to declared output shapes. A view can use a criterion
as its source filter (replacing or in addition to today's inline
`where`):

```
criterion ActiveCustomer of Customer = self.active

view ActiveCustomerSummary {
  customerId: Customer id
  name: string
  totalSpent: decimal

  from ActiveCustomer        # use criterion as the filter
  bind customerId = id, name = name, totalSpent = orders.sum(o => o.total)
}
```

The view's filter is the criterion; the view's projection is the
`bind` clause. Reusable filter, projection layered on top.

(Today's `view X = Aggregate where ...` syntax with inline `where`
still works — criterion-as-source is additive.)

## Named complex queries — workflow or repository find

For named bundles of "criterion + sort + page + loads" (the
Ardalis-style use case), Loom uses existing constructs:

### Via workflow (most common)

```
private workflow latestActiveOrders(top: int): Order[] {
  return Orders.list(
    ActiveOrder,
    sort: [createdAt desc],
    page: { offset: 0, limit: top },
    loads: [self.customer.address]
  )
}

# Callers:
let recent = latestActiveOrders(20)?
```

### Via extended repository find

(Requires the small grammar extension: repository finds gain
`orderBy` / `take` / `skip` / `loads` clauses — flagged as a separate
mini-proposal in the implementation plan. Without that extension,
workflows are the only naming mechanism.)

```
repository Orders for Order {
  find latestActive(top: int): Order[]
    where active
    orderBy createdAt desc
    take top
    loads { customer.address }
}

# Callers:
Orders.latestActive(20)
```

Either path names the bundle. No `specification` construct needed.

> **Update:** the named-bundle role is now filled by a dedicated
> keyword, `retrieval` (a composed `criterion` + `sort` + `loads`, run
> via `Repo.run(R(args), page?)`) — see
> [`retrieval.md`](./retrieval.md). It deliberately avoids the name
> "Specification" (which means the *atom* on JPA but the *bundle* on
> .NET/Ardalis); `criterion` stays the predicate, `retrieval` is the
> bundle. The ad-hoc `Repo.findAll(criterion, sort?, page?, loads?)`
> above remains the anonymous form of the same mechanism.

## Workflow-calls-workflow + `private workflow` (related extension)

For reusable cross-aggregate orchestration that *mutates* — what
my earlier drafts called a `service` — Loom reuses existing
constructs: workflows can call other workflows, and `private`
modifies a workflow to not be auto-exposed.

### Workflow body gains a call form

```
workflow placeOrderWithTax(cmd: PlaceOrderWithTaxCommand): OrderId or NotFound or InvalidTax transactional {
  let orderId = placeOrder(cmd.placeOrderInputs)?    # workflow call
  applyTax(orderId, cmd.taxRate)?                     # workflow call
  return orderId
}

private workflow applyTax(orderId: Order id, rate: decimal): or InvalidTax {
  let order = Orders.getById(orderId)?
  order.applyTax(rate)?
}
```

Workflow calls are `?`-propagable expressions like any other
`or`-returning call. Standard `?` semantics from
[`exception-less.md`](./exception-less.md).

### `private workflow` modifier

Loom already has `private` as an access modifier (`docs/language.md`
§"Aggregate body"):

| Construct | Without `private` | With `private` |
|---|---|---|
| `operation` | Callable from any workflow + within aggregate | Callable only from within the same aggregate root |
| `invariant` | Runs in domain + exposed to wire layers | Runs only in domain `AssertInvariants()` |
| **`workflow`** (new) | Auto-exposed by `api X from M` at `POST /workflows/<name>` | Not auto-exposed; callable only from other workflows in the same context |

Same word, parallel intuition.

### Transactional semantics for workflow-calls-workflow

| Caller | Callee declares `transactional`? | Result |
|---|---|---|
| Non-transactional | No | Callee saves per-aggregate (today's non-transactional default). |
| Non-transactional | Yes | Callee's own `transactional` activates: its body + saves run in one DB transaction. |
| `transactional` | No | Callee inherits the caller's transaction; all its operations + saves participate in the caller's atomic scope. |
| `transactional` | Yes | Callee's own `transactional` is a no-op (caller's transaction is already active). |

No nested-savepoint magic; single-level transaction lifetime per
top-level workflow call.

## What this collapses

Mapping of patterns from various ecosystems onto Loom constructs:

| Pattern | Loom construct |
|---|---|
| Eric Evans Specification Pattern (`isSatisfiedBy`) | `criterion` + composition |
| Spring Data JPA `Specification<T>` | `criterion` |
| Hibernate `Criterion` (deprecated) | `criterion` |
| Hibernate `Criteria` (full query, deprecated) | `Repo.findAll(criterion, sort?, page?, loads?)` — call-site composition |
| Ardalis Specification (.NET) — bundled query object | Workflow or extended repository find wrapping `Repo.findAll(criterion, ...)` |
| NakedObjects/Causeway `disable<Action>()` | `when <Criterion>` (with auto-exposed `can-<op>`) |
| NakedObjects/Causeway `validate<Action>(arg)` (per-arg) | `from <Criterion>(args)` on parameter |
| NakedObjects/Causeway `choices<N><Action>()` (per-arg) | Auto-derived from criterion at the binding site |
| NakedObjects/Causeway `default<N><Action>()` (per-arg) | Field-level `= <expr>` at the binding site |
| Domain Service (Evans, mutating) | Workflow (existing) — `private workflow` for not-auto-exposed |
| Domain Service (Evans, pure cross-aggregate predicate) | `criterion` (with cross-aggregate `Repo.getById` lookups in body) |

One keyword (`criterion`) covers the predicate domain. Existing
constructs (`workflow`, `find`, `view`) cover orchestration, named
queries, and projections.

## Hard parts

- **Queryable-subset enforcement for criterion bodies.** The
  validator must reject expressions that don't translate to SQL
  cleanly. Same restrictions today's view `where` clauses face;
  shared enforcement code path.
- **`from <Criterion>` per-element validation loop.** For array
  parameters, the wrapper loops; per-element typed errors must be
  collected (single-error v1, accumulated `[]` deferred to v2 if
  needed for UX).
- **Auto-injection at every operation call site for `when`.** The
  lowering pass must inject the gate check at every `agg.op(args)?`
  expansion. Threads through `src/ir/lower.ts` operation-call
  lowering.
- **UI form-generator's auto-derivation.** Form-generator queries
  the criterion's predicate against the underlying repository to
  populate `<select>` elements. Caching strategy + revalidation
  rules need to be decided (per-render? per-session? on-demand?).
- **Per-backend `Repo.findAll` emission.** TS / Drizzle, .NET / EF Core,
  Phoenix / Ecto each need the generic `list(criterion, sort, page,
  loads)` translation. Existing find emission machinery extends.
- **Sort and Page literal syntax in the grammar.** `[name asc,
  createdAt desc]` for Sort; `{ offset, limit }` for Page. New
  literal forms in the type system; need parser support.
- **Composition rules for criteria.** Boolean operators on criteria
  yield criteria. SQL translation merges the underlying WHEREs.
  Standard; documented in the grammar.
- **`private workflow` validator rule.** Workflows marked `private`
  must not be referenced by `api X from M`'s auto-exposure walk.
  Validator emits `loom.private-workflow-exposed` if referenced.

## Phasing

Single phase: **Phase Crit — Criterion + Repo.findAll + workflow-calls-workflow**.
Lands after exception-less A6 (`?` propagation + `validate for X`
stable).

### Crit1 — Grammar + IR (~1 week)

- Grammar: `criterion <Name>(<Param>*) of <T> = <expr>` and
  `criterion <Name>(<Param>*) of <T> { where: <expr> }` declarations.
- `from <Criterion>(args)` clause on parameter / command-field types.
- `when <expr>` clause on `OperationDecl`.
- IR: `CriterionDeclIR`; `FromBindingIR`; `WhenClauseIR`.
- Built-in shape types: `SortClause`, `Sort`, `Page`, `PathExpression`.

### Crit2 — Body purity + composition (~1 week)

- Walker checks `where:` body constraints; rejects mutation,
  aggregate-op calls that mutate, `emit`, workflow calls, non-queryable
  forms (`loom.criterion-impure`, `loom.criterion-not-queryable`).
- Composition operators `&&` / `||` / `!` produce criterion IR nodes
  by AST-level merge.
- Cycle detection on criteria that reference each other
  (`loom.criterion-cycle`).

### Crit3 — `from` / `when` auto-injection at api wrappers (~1.5 weeks)

- Wrapper-synthesis lowering: per `from <Criterion>(args)` binding,
  inject load + check loop; on failure, return
  `CriterionFailed`.
- Per `when <Criterion>` clause, inject the gate before op invocation;
  on failure, return `Disallowed`.
- Auto-expose `GET /aggregates/<agg>/{id}/can-<op>` endpoint per `when`
  clause.
- Operation-call lowering: at every `agg.op(args)?` expansion, inject
  the `when` gate (consistency).
- Stdlib: `error CriterionFailed`, `error Disallowed`.
- OpenAPI emission: criterion constraints surface as schema extensions.

### Crit4 — `Repo.findAll` per-backend (~1.5 weeks)

- Per-backend translation: criterion → SQL WHERE; sort → ORDER BY;
  page → LIMIT/OFFSET; loads → JOINs / SELECT-includes / EntityGraph.
- TS / Drizzle: typed query builder.
- .NET / EF Core: IQueryable chain.
- Phoenix / Ecto: `Ecto.Query` DSL.
- UI form-generator: auto-derives options from criterion's predicate
  + repository at the binding site.

### Crit5 — Workflow-calls-workflow + `private workflow` (~1 week)

Independent; can ship before or after Crit3/4.

- Grammar: workflow-call expression (`OtherWorkflow(args)`) in
  workflow body; `private` modifier on workflow declaration.
- IR: `WorkflowCallStmtIR`; `isPrivate: boolean` on `WorkflowIR`.
- Validator: workflow-call cycle detection (`loom.workflow-cycle`);
  visibility check — private workflows skipped from api auto-exposure
  (`loom.private-workflow-exposed`).
- Transactional inheritance: lowering pass implements the caller-callee
  transaction shape per "Transactional semantics" above.

**Phase Crit total: ~6 weeks.** Independent of A4; can ship before
or after the find-variant re-shape.

## Open questions

1. **Criterion + composition operator parsing.** `criterion ` body
   uses `&&` / `||` / `!`. Today's grammar uses `&&` for boolean
   AND in expressions; reusing it for criterion composition is
   natural but the validator distinguishes "criterion composition"
   from "boolean expression in body" by surrounding context.
2. **Sort literal syntax.** `[name asc, createdAt desc]` — is the
   bare `asc`/`desc` keyword admissible inside array literal context?
   Grammar refinement.
3. **Page literal syntax.** `{ offset: 0, limit: 50 }` is record
   literal — already in Loom's grammar?
4. **`Sort` and `Page` as built-in types** vs stdlib payloads. Lean
   built-in (compile-time-known shapes; no need for declaration
   in user .ddd).
5. **Cursor-based pagination** (`{ cursor: string, limit: int }`
   form of Page) — v2. Offset/limit only for v1.
6. **Auto-derived UI options caching strategy.** Per-render
   fetches the criterion's options live; per-session caches once.
   Decision: per-render for parameterised criteria, optional caching
   for parameterless ones. UI hint: criterion declares `cacheable: true`?
   Defer — v2 detail.
7. **Extending repository `find` declarations with `orderBy` /
   `take` / `skip` / `loads`** for the named-complex-query case
   (alternative to wrapping in a workflow). Small separate mini-proposal;
   lean **yes** as part of this work or shortly after.

## File-level work breakdown

### Crit1 — Grammar + IR

- `src/language/ddd.langium`: `criterion` declaration; `from
  <Criterion>(args)` clause on Parameter / CommandField; `when
  <expr>` on Operation; literal shapes for `Sort` and `Page`.
- `src/ir/loom-ir.ts`: `CriterionDeclIR`, `FromBindingIR`,
  `WhenClauseIR`, `SortClauseIR`, `PageIR`.

### Crit2 — Body purity + composition

- `src/language/ddd-validator.ts`: `loom.criterion-impure`,
  `loom.criterion-not-queryable`, `loom.criterion-cycle`,
  `loom.when-references-op-param`, `loom.when-inline-list`.
- `src/ir/lower-expr.ts`: criterion-body lowering;
  composition-operator lowering.

### Crit3 — Auto-injection at api wrappers

- `src/ir/enrichments.ts`: api-wrapper synthesis pass —
  per-`from`-binding validation loop; per-`when`-clause gate;
  per-operation can-X endpoint emission.
- `src/stdlib/payloads/errors.ddd`: add `CriterionFailed`,
  `Disallowed`.
- `src/system/error-defaults.ts`: add `CriterionFailed:
  422`, `Disallowed: 409`.
- `src/generator/<platform>/`: emit can-X routes + ProblemDetails
  translation.
- `src/ir/lower.ts`: operation-call lowering — inject `when` gate
  at every call site.

### Crit4 — Repo.findAll per-backend

- `src/generator/ts/`: criterion → Drizzle query builder; Sort/Page/loads
  translation.
- `src/generator/dotnet/`: criterion → EF Core IQueryable;
  Sort/Page/loads translation.
- `src/generator/elixir/`: criterion → `Ecto.Query` DSL;
  Sort/Page/loads translation.
- UI: React form-generator reads criterion metadata; populates
  `<select>` from predicate-query results.

### Crit5 — Workflow-calls-workflow + `private workflow`

- `src/language/ddd.langium`: `private` modifier on Workflow;
  workflow-call expression in body statement grammar.
- `src/ir/loom-ir.ts`: `isPrivate` on WorkflowIR; `WorkflowCallStmtIR`.
- `src/language/ddd-validator.ts`: `loom.workflow-cycle`,
  `loom.private-workflow-exposed`.
- `src/generator/<platform>/`: workflow-call rendering;
  transactional-inheritance lowering.

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  carrier generics + tagged unions; criterion's `or`-typed return
  variants use the same machinery.
- [`exception-less.md`](./exception-less.md) — `?` propagation;
  `CriterionFailed` / `Disallowed` translate to ProblemDetails
  at the api edge.
- [`load-specifications.md`](./load-specifications.md) — `loads:`
  argument to `Repo.findAll` and `Repo.getById` uses path syntax from
  that proposal; result types are shape-parameterised per its
  shape-typing rules. **Default is whole aggregate; `loads:` is
  optimisation.**
- [`retrieval.md`](./retrieval.md) — the named bundle keyword
  (`retrieval` + `Repo.run`) that hoists `criterion` + `sort` + `loads`
  into a reusable declaration; this proposal's `findAll` is its
  anonymous form.
- [`reified-criteria.md`](./reified-criteria.md) — makes backends
  consume `CriterionIR` directly (the predicate becomes a constructed
  object, not an inlined body); defines the `RetrievalIR` / `LoadPlanIR`
  seam.
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — state
  layer; criteria over abstract aggregates resolve to concrete
  types via the polymorphic id reference rule.
- [`implementation-plan.md`](./implementation-plan.md) — Phase Crit
  + Crit5 (workflow-calls + private workflow) fit after A6 /
  parallel to A7a.
- `docs/views.md` — views may use a criterion as their `from`
  source (additive to today's inline `where`).
- `docs/workflow.md` — gains workflow-call expression + `private`
  modifier (Crit5); body vocabulary extended.
- `docs/language.md` §"Aggregate body" — `private operation` /
  `private invariant`; `private workflow` follows the same pattern.
- #466 — macro system; macros can inject `from <Criterion>(args)`
  bindings on parameters and `when <Criterion>` clauses on operations.
