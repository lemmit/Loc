# Domain service — the missing third construct (options)

> Status: **SUPERSEDED by [`domain-services.md`](./domain-services.md)**
> (plural). This doc remains as the exploratory options-menu — six
> design axes and three assembled shapes (A pure-calculator, B
> coordinator, C unified function family) — that the successor pins.
> The successor adopts this doc's framework, commits to a single answer
> on every axis (v1 = Shape A; Shape B = Phase 2; Shape C deferred),
> and adds the grammar / IR / validator / emission / test spec. Read
> this doc for the *design-space*; read the successor for *what
> ships*.
>
> **Companion**: [`failure-taxonomy.md`](./failure-taxonomy.md). This
> doc fills a row that doc's error-placement table left empty: a
> cross-aggregate **domain** rule that can fail with a domain error.
> Nothing here is decided; each design axis lists alternatives with a
> lean, and the end assembles them into three concrete **shapes** to
> react to.
>
> **Relationship to existing constructs** (checked against the grammar):
> distinct from [`criterion.md`](./criterion.md) (the shipped *pure
> `bool` predicate*, queryable/inlineable — Axis 5), from the
> [`authorization.md`](./authorization.md) `policy {}` block (the
> *authorization* construct, which **claims the `policy` keyword** —
> see Axis 6), and from `workflow` ([`workflow-and-applier.md`](./workflow-and-applier.md),
> the application-layer orchestration this is explicitly *not*). The
> domain service is the error-returning, possibly-mutating sibling of
> `criterion`.

## The gap, precisely

Loom has two homes for behaviour, mapping onto two of DDD's three
service roles:

| Loom construct | DDD role | Layer | Touches |
|---|---|---|---|
| aggregate `operation` | the aggregate's own behaviour | domain, **single-aggregate** | own state only |
| `workflow` | application service / use-case orchestration | application | repos, externs, many aggregates, transactions |
| **— missing —** | **domain service** | **domain, cross-aggregate** | domain objects passed in; **no infrastructure** |

The missing middle is the classic DDD **domain service**: a stateless
domain rule that (a) genuinely spans more than one aggregate, or (b) is
a reusable policy/calculation over value objects — and crucially has
**no persistence or infrastructure concern**. The textbook example is
`transfer(from, to, amount)`: not `from`'s operation (it touches `to`),
not application orchestration ("can't overdraw" is a domain rule, not a
use-case step), yet it has nowhere honest to live today. You're forced
to either cram it into one aggregate (artificial home; operations can't
take a second aggregate or reach its state) or bury it in a workflow
(domain logic leaks into the application layer → the anemic-domain
anti-pattern).

It can also **fail with a domain error** (`InsufficientFunds`), and
that error has no authored home: `operation … or E` is single-aggregate;
`workflow … or E` is the use-case layer. The domain service is the
home for cross-aggregate *domain-rule* failures.

**The one constraint that defines it** (and makes it enforceable, not
just convention): a domain service may touch **domain objects passed in
+ their operations + other domain services — and no repository, no
extern, no persistence.** That backward edge is exactly what
`pipeline-layering.test.ts` already knows how to forbid; a `service`
importing a repository *is* an application service and should fail to
compile.

---

## The design axes (each an open choice)

### Axis 1 — Can it *mutate* the aggregates passed in?

This is the load-bearing axis; everything else follows from it.

- **(1a) Pure calculator** — cannot mutate; takes domain objects,
  returns a value or domain error (pricing, tax, eligibility,
  `applyCoupon`). Safe, composes anywhere.
- **(1b) Coordinator** — may call mutating operations on the aggregates
  passed in (`from.withdraw` / `to.deposit`); the *caller* persists.
  This is the one that actually solves `transfer`.
- **(1c) Both, classified by signature** — the compiler infers: a body
  that invokes a mutating op on an aggregate param is a coordinator
  (workflow-only caller); a pure-value body is a calculator (callable
  anywhere).

*Trade-off:* (1a) is simplest and safest but **doesn't cover the
canonical motivating case** (transfer mutates two aggregates). (1b)
covers it but needs the mutation/persistence contract pinned (who
saves, aliasing across backends). (1c) is elegant but the implicit
classification may be too magic to teach. *Lean: ship (1a) first, add
(1b) as a fast-follow; treat (1c) as the eventual unification, not v1.*

### Axis 2 — Who may call it?

- **(2a) Workflow + other services only.** Keeps the single-aggregate
  boundary hard (operations stay confined). Required if the service is
  a coordinator (mutates aggregates).
- **(2b) Also aggregate operations**, but only for *pure-calculator*
  services with no aggregate params (pricing inside an order op).
- **(2c) Anyone in domain/application.**

*Lean: (2a) for coordinators (non-negotiable), (2b) for pure
calculators. I.e. the caller set is derived from Axis 1, not declared.*

### Axis 3 — How strict is "no infrastructure"?

- **(3a) Pure-domain only** — no repo, no extern. (strict; the
  definition above)
- **(3b) Read-only repo allowed** — it may *look things up* (finds) but
  never write/persist.
- **(3c) Externs allowed too** — at which point it's just a workflow.

*Lean: (3a). The moment a "domain service" reads a repository, the
load is an application concern and belongs in the workflow that then
hands the loaded objects to the service. (3b) is the slippery slope
that collapses the distinction; reject it to keep the layering crisp.*

### Axis 4 — Errors (two-regime)

Not really a choice — it should mirror aggregate operations exactly:
**throw** for invariant/precondition violations (bug regime → 500),
**return** an `or`-union for expected domain failures
(`… or InsufficientFunds`). Errors live in the same context as the
service and reuse the ambient/root kernel for shared shapes, identical
to the failure-taxonomy rules. Listed here only to pin it.

### Axis 5 — Relationship to `criterion`

Loom already ships a *degenerate* domain service: `criterion` is "a
pure domain decision returning `bool`."

- **(5a) Keep distinct, share the purity checker.** A `criterion` is
  *queryable* — it inlines into SQL/`where`; a `service` is not. That's
  a real semantic difference worth preserving.
- **(5b) Subsume** `criterion` under `service` (a service returning
  `bool`). Fewer keywords, but loses the queryable/inlineable property.
- **(5c) Unify both under one `function` family**, layer inferred from
  the dependency footprint.

*Lean: (5a). Frame `service` as "criterion's bigger sibling" for
teaching and reuse the purity machinery, but keep them separate
constructs — queryability is the line.*

### Axis 6 — Naming

`service` is overloaded (application service? microservice? a
docker-compose service / `deployable`?). Candidates:

- **`service`** — familiar to DDD readers. Note `'service'` is already
  a *soft* keyword elsewhere (the `service(...)` connection-source slot
  + the source-type enums), so a top-level `service Foo { … }`
  declaration must be admitted carefully — but it's a different
  position, so not a hard clash.
- **`policy`** — **ruled out.** `authorization.md` (PROPOSED) claims
  `policy` for its top-level authorization block (`policy Orders { data
  { allow … } allow … on Agg.Op }`). Reusing it for a domain service
  would be a direct keyword collision for a different concept (authz
  gate vs domain rule). DDD's "policy" naming is tempting for
  decision-shaped services, but the keyword is spoken for.
- **`domain service Foo` / `domainservice`** — unambiguous, verbose.
- **`function` / `def`** — generic; pairs with the (5c) unification.

*Lean: `service`, with a validator nudge clarifying it's a **domain**
service (not a deployable). Avoid `policy` (authorization owns it).*

---

## Three assembled shapes

Pick a gestalt; the axes above are the dials behind each.

> **Syntax is illustrative.** The `service` construct does not exist
> yet, so the bodies necessarily use proposed syntax. Two things in
> particular are **not** current Loom and are sketches: (a) there is no
> `if` statement (control flow is `match`) and no `save` keyword
> (workflow persistence is implicit); (b) discriminating an `or`-union
> result needs a variant-pattern `match`, which Loom lacks today (its
> `match` is boolean-guard-only — see `failure-taxonomy.md`'s open
> questions). The shipped guard keyword used below is `precondition`
> (→ 400) / aggregate `invariant` (→ 500); neither takes a message
> string.

### Shape A — "Pure calculator" (minimal floor)

*Axis 1a · 2b · 3a · 5a.* A `service` is a named bundle of pure
functions computing a value-or-error from domain objects. **No
mutation.** Callable from operations *and* workflows (it can't reach
other aggregates' mutable state, so it's always safe).

```ddd
context Sales {
  service Pricing {
    quote(cart: Cart, customer: Customer): Money {
      precondition cart.lines.count > 0      // domain-validity guard → 400
      return cart.subtotal - customer.tier.discount(cart.subtotal)
    }
    applyCoupon(price: Money, coupon: Coupon): Money or CouponExpired {  // expected failure
      match {                                 // variant-match: sketch (see disclaimer)
        coupon.isExpired => return CouponExpired { code: coupon.code }
        else => return price - coupon.discount
      }
    }
  }
}
```

- **Pros:** simplest; no mutation/aliasing questions; composes with
  `criterion`; callable from inside an aggregate operation (the common
  "reusable calculation" need); ships fast.
- **Cons:** does **not** solve `transfer` (which inherently mutates two
  aggregates). Covers the *non-mutating* cross-aggregate-error row only.

### Shape B — "Coordinator" (the transfer case)

*Axis 1b · 2a · 3a · 5a.* A `service` may take 2+ aggregates and mutate
them via their own operations; returns result-or-error; the **calling
workflow persists**. Workflow-only callers.

```ddd
context Banking {
  service Transfer {
    run(from: Account, to: Account, amount: Money): Transferred or InsufficientFunds {
      precondition amount > Money.zero       // domain-validity guard → 400
      match {                                 // variant-match: sketch (see disclaimer)
        from.balance < amount =>
          return InsufficientFunds { account: from.id, shortfall: amount - from.balance }
        else => {}
      }
      from.withdraw(amount)            // mutates each aggregate via its own op
      to.deposit(amount)
      return Transferred { from: from.id, to: to.id, amount }
    }
  }

  workflow MoveMoney {
    handle move(cmd: MoveMoney): Transferred or InsufficientFunds {
      let from = Accounts.required(cmd.from)   // workflow LOADS (application concern)
      let to   = Accounts.required(cmd.to)
      // service DECIDES + mutates in-memory; the workflow persists `from`/`to`
      // implicitly on the success arm (no `save` keyword — see disclaimer).
      return Transfer.run(from, to, cmd.amount)
    }
  }
}
```

- **Pros:** solves the canonical DDD domain service; clean split —
  *service decides + mutates, workflow loads + saves*; the workflow
  stays thin, the aggregates stay rich.
- **Cons:** mutation-by-reference semantics must be pinned (the service
  mutates objects the workflow will save); can't be called from an
  aggregate operation; the "who saves what" contract is implicit unless
  we make it explicit.

### Shape C — "Unified function family" (elegant, deferred)

*Axis 1c · 5c.* One construct (`function`/`def`); the **layer is
derived** from what the body touches — no infra ⇒ domain service;
returns `bool` and is queryable ⇒ criterion; touches a repo ⇒ it's a
workflow and must be declared as one. Matches the failure-taxonomy
instinct of *inferring* the layer rather than declaring it.

- **Pros:** conceptually minimal; fewest keywords; the dependency
  footprint *is* the classification.
- **Cons:** blurs the deliberate operation/workflow distinction; the
  implicit classification is hard to teach and error-prone ("why is my
  function suddenly an application service?"); big change. *Too clever
  for v1 — record as the north star, don't build it yet.*

---

## Recommendation

**Ship Shape A first, Shape B as the fast-follow, keep C as the north
star.** Rationale:

1. Shape A is high-value and low-risk: reusable domain calculations
   (pricing, tax, eligibility) are common, it composes with `criterion`,
   and it has no mutation semantics to argue about. It also lands the
   *non-mutating* slice of the missing taxonomy row immediately.
2. Shape B is the canonical domain service and the reason the construct
   exists at all — but it carries the one genuinely hard question
   (mutation + persistence contract), so it deserves its own slice once
   A has settled the surface.
3. Shape C is the right *eventual* model but trades teachability for
   elegance; adopting it prematurely would erode the operation/workflow
   clarity the rest of the design leans on.

Generated placement is identical across shapes and *is* the proof of
the constraint: a stateless unit in the **Domain** layer with **no
injected infrastructure** —
`Banking/Domain/TransferService.cs` (returns `OneOf<…>`, throws
`DomainInvariantException`, **no repo in its constructor**),
`banking/domain/services/transfer.ts` (pure exported fn),
`Banking.Transfer` (pure Elixir module). The workflow handler, by
contrast, *does* get repos injected — that asymmetry is the layering,
made physical.

## Open questions

1. **Axis 1 cut for v1** — A-only, or A+B together? (Lean: A first.)
2. **Shape B persistence contract** — does the workflow `save` the
   mutated aggregates explicitly (as sketched), or does the service
   signature mark which params it mutates so the workflow auto-saves
   them? Explicit is clearer; auto is terser.
3. **Anemic-domain guardrail** — validator *warning* on a
   single-aggregate `service` ("could be an `operation` on `X`")?
   Domain services are the most over-used tactical pattern; a nudge
   keeps people honest. (Lean: yes, warn.)
4. **Naming** — `service` vs `domainservice` (`policy` is ruled out —
   `authorization.md` owns it). Confirm the soft-keyword
   `service(...)` connection-source slot doesn't block a top-level
   `service Foo { … }` declaration. (Lean: `service` + a clarifying
   validator message.)
5. **`criterion` boundary** — confirm keep-distinct (5a); document
   "criterion = queryable bool decision, service = general value/error
   over domain objects."
6. **Calling from operations** — allow for pure calculators (2b),
   forbid for coordinators (2a)? Confirm the caller set is *derived*
   from Axis 1 rather than declared.
