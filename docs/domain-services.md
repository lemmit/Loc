# Domain services (`domainService`)

A `domainService` is a stateless, named, context-level container of
**non-mutating** `operation`s — the pure-calculator floor (v1 Shape A).
Operations take aggregates / value objects / primitives **by value**,
return a value or an `or`-union error, and may `throw` for the bug
regime. They are **strict no-infra**: a domain service may not reach a
repository, an `extern`, an `api`, a workflow, or `emit` an event, and it
has no `this` to mutate.

It fills the gap between an aggregate `operation` (single-aggregate,
mutates `this`) and a `workflow` (application orchestration, touches
infrastructure): a **cross-aggregate domain calculation** that belongs to
the domain layer but to no single aggregate. The design is pinned in
[`proposals/domain-services.md`](proposals/domain-services.md).

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
| **.NET** | `public static class Pricing` (planned) | `Pricing.Quote(cart, customer)` |
| **Java** | static utility class (planned) | `Pricing.quote(cart, customer)` |
| **Python** | bare module functions (planned) | `quote(cart, customer)` |
| **Phoenix** | `App.Domain.Services.Pricing` plain module (planned) | `App.Domain.Services.Pricing.quote(cart, customer)` |

The call rendering for all five backends ships today (the shared
`ExprTarget.domainServiceCall` arm); the TS declaration emitter ships
with v1, the other four declaration emitters land per-backend.
