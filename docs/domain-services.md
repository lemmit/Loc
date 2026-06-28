# Domain services (`domainService`)

A `domainService` is a stateless, named, context-level container of
`operation`s that belong to the domain layer but to no single aggregate.
It fills the gap between an aggregate `operation` (single-aggregate,
mutates `this`) and a `workflow` (application orchestration, owns the
transaction and all outbound I/O): a **cross-aggregate domain
calculation or decision**.

> **What ships today vs. the revised direction.** The shipped construct
> is the **pure-calculator floor (Shape A)** documented in this file:
> operations take aggregates / value objects / primitives **by value**,
> return a value or an `or`-union error, may `throw` for the bug regime,
> and are **strict no-infra** — no repository, `extern`, `api`,
> workflow-start, or `emit`, and no `this` to mutate. The **revised
> design** (rev. 4 in [`proposals/domain-services.md`](proposals/domain-services.md))
> pins a **three-tier** model: **pure** (today's behavior), **read-only**
> (may query supporting data through a repository — never writes), and
> **mutating** (may mutate the aggregates the orchestrator **passes in**,
> via their own operations). In every tier the application orchestrator
> owns the single commit; the service never writes to a repository and
> never commits. A five-backend idiom audit walked back an interim "load
> *and write* via repository ports" idea (by canonical DDD that's
> application-layer work) but kept read-only access — a query dirties
> nothing, so it has no commit problem, and a repository-reading domain
> service is canonical (uniqueness checks, policy lookups). That
> direction is pinned but **not yet shipped**; the rest of *this* page
> describes current behavior.

## Surface

```ddd
module Sales {
  domainService Pricing {
    operation quote(cart: Cart, customer: Customer): Money {
      return cart.subtotal - customer.tier.discount(cart.subtotal)
    }
    operation applyCoupon(price: Money, coupon: Coupon): Money or CouponExpired {
      return price - coupon.discount
    }
  }
}
```

- **Statement bodies only** in v1 (no `= expr` shorthand — deferred).
- Cross-aggregate parameters are spelled as **plain aggregate names**
  (`cart: Cart`) — a different grammar position from a containment
  partType, so the `X id` cross-aggregate restriction is untouched.
- An `or`-union return reuses the exception-less operation-return shape.
- No `private` / `extern` / `audited` / `when` modifiers (those are
  aggregate-operation-only).

## Calling one

A member call resolves the receiver to the `domainService` declaration
and lowers to a `Call` with `callKind: "domain-service"` (carrying a
structured `serviceRef: { service, op }`), so every backend renders a
real call without re-resolving:

```ddd
aggregate Order {
  operation reprice(catalog: PriceList) {
    let amount = Pricing.recalculate(this, catalog)
    this.total := amount
  }
}
```

Callable from anywhere a pure expression is legal — aggregate operations,
workflows, other domain services.

## The no-infra contract (phase ⑦ IR validator)

| Forbidden in a body | Diagnostic |
|---|---|
| `emit` an event | `loom.domain-service-no-emit` |
| Write to state (`:=` / `+=` / `-=`) — there is no `this` | `loom.domain-service-no-mutation` |
| Call a repository in the same context | `loom.domain-service-no-repo` |
| Start a workflow in the same context | `loom.domain-service-no-workflow-start` |

Plus an **anemic-domain warning** (`loom.domain-service-single-aggregate`)
when every operation takes exactly one aggregate parameter — the
behaviour could be an `operation` on that aggregate instead.

> Parameter-operation mutation (`from.withdraw(x)`) and `extern` / `api`
> call rejection are deferred to Phase 2 (Shape B), which needs
> target-resolution of the method callee that v1 does not attempt.

## Per-backend emission

| Backend | Shape | Call syntax |
|---|---|---|
| **TS / Hono** | `domain/services.ts` — `export namespace Pricing { export function quote(...) }` | `Pricing.quote(cart, customer)` |
| **.NET** | `public static class Pricing` | `Pricing.Quote(cart, customer)` |
| **Java** | static utility class | `Pricing.quote(cart, customer)` |
| **Python** | bare module functions | `quote(cart, customer)` |
| **Phoenix** | `App.Domain.Services.Pricing` plain module | `App.Domain.Services.Pricing.quote(cart, customer)` |

Both the call rendering (the shared `ExprTarget.domainServiceCall` arm)
and the declaration emitters ship on all five backends today
(`src/generator/{typescript,dotnet,java,python,elixir}/…/domain-service*`).

## Direction (revised — not yet shipped)

The pinned next step ([`proposals/domain-services.md`](proposals/domain-services.md),
rev. 4) pins a three-tier capability ladder (`mutating` ⊇ `reading` ⊇
`pure`):

| Tier | May… | Callable from |
|---|---|---|
| **pure** *(ships today)* | params only; branch, `let`, `match`, `throw` | anywhere |
| **reading** | the above **+ read-only repository queries** (look up supporting data) | application orchestrators only |
| **mutating** | the above **+ call mutating operations on the aggregates passed in** | application orchestrators only |

A repository **write** / commit, `emit`, `extern`, `api`, and
workflow-start stay forbidden in **every** tier. Reading supporting data
is the only infrastructure a service may touch (and only in the upper two
tiers); writing the *target* aggregates and the single commit live in the
application orchestrator (**orchestrator loads → service reads + mutates
the passed-in aggregates → orchestrator persists**). That's the line that
keeps a domain service from collapsing into a workflow.

**Persistence is orchestrator-owned, rendered idiomatically per backend.**
The orchestrator opens one transaction, loads the aggregates, calls the
service, and commits once. The mutation set is exactly the passed-in
aggregates (the orchestrator already holds them), so nothing is returned
for the caller to diff. The `.ddd` is identical everywhere:

| Backend | Unit of work | How the mutated aggregates persist |
|---|---|---|
| .NET / EF, Java / JPA, Python / SQLAlchemy | ORM change-tracking | **implicit** — passed-in entities are tracked; mutate in place; orchestrator's single `SaveChanges` / flush / `commit` (JPA: explicit `save` for *new* aggregates) |
| Phoenix / Ecto | `Repo.transact` + `with` | orchestrator (a context fn) builds inline changesets and `Repo.update`s each in one transaction |
| TS / Hono / Drizzle | `db.transaction` | no change-tracking → orchestrator calls `repository.save(aggregate, tx)` per mutated aggregate |

A companion change lets `function` take a **pure block body**
(`let` + branch + bug-regime `throw`) instead of only a single
expression — staying non-queryable, so the
`function` → `criterion` → `domainService` tiers stay crisp.

This direction is grounded in a five-backend idiom audit (EF Core,
Spring/JPA, SQLAlchemy/Cosmic-Python, Ecto/Phoenix, Drizzle) — see the
proposal's "Research findings" section for the per-backend citations.
