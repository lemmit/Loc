# Domain services (`domainService`)

A `domainService` is a stateless, named, context-level container of
`operation`s that belong to the domain layer but to no single aggregate.
It fills the gap between an aggregate `operation` (single-aggregate,
mutates `this`) and a `workflow` (application orchestration, owns the
transaction and all outbound I/O): a **cross-aggregate domain
calculation or decision**.

Operations are classified — by the phase-⑦ validator, derived from the
body (`classifyDomainServiceTier`, never a stamped field) — into a
three-tier capability ladder (`mutating` ⊇ `reading` ⊇ `pure`):

| Tier | The body may… | Callable from |
|---|---|---|
| **pure** | params only; branch, `let`, `match`, `throw`, call other pure services | **anywhere** (aggregate ops, views, workflows, services) |
| **reading** | the above **+ read-only repository queries** (`Accounts.byHolder(h)`, `Repo.find/findAll/run`) | application orchestrators only |
| **mutating** | the above **+ call mutating operations on the aggregates passed in** (`src.withdraw(amount)`) | application orchestrators only |

In every tier the **application orchestrator** (a `workflow`) loads the
target aggregates and owns the single commit; the service never writes to
a repository and never commits. Reading *supporting* data is the only
infrastructure a service touches, and only in the upper two tiers.

> **Why read-only but not read-write?** A repository *read* dirties
> nothing, so it has no "who commits?" problem, and a repository-reading
> domain service is canonical DDD (uniqueness checks, policy lookups —
> Vernon). *Loading-and-writing*, by contrast, is application-layer work
> (Evans / Vernon / Cosmic-Python all agree) and can't stay stateless on
> the change-tracking backends — so it lives in the orchestrator. The
> design rationale + the five-backend idiom audit are in
> [`proposals/domain-services.md`](old/proposals/domain-services.md).

## Surface

```ddd
module Sales {
  domainService Pricing {
    // pure — params only
    operation quote(cart: Cart, customer: Customer): Money {
      return cart.subtotal - customer.tier.discount(cart.subtotal)
    }
  }

  domainService Registration {
    // reading — a read-only repository query
    operation isHolderFree(holder: string): bool {
      return Accounts.byHolder(holder) == null
    }
  }
}

module Banking {
  domainService Transfer {
    // mutating — mutates the PASSED-IN aggregates via their own ops
    operation run(src: Account, dst: Account, amount: Money)
      : Transferred or InsufficientFunds {
      if (src.balance.amount < amount.amount)
        return InsufficientFunds { account: src.id, shortfall: amount }
      src.withdraw(amount)
      dst.deposit(amount)
      return Transferred { src: src.id, dst: dst.id, amount: amount }
    }
  }
}
```

- Statement bodies; an `or`-union return reuses the exception-less
  operation-return shape.
- Cross-aggregate parameters are **plain aggregate names** (`cart: Cart`)
  — a different grammar position from a containment partType, so the
  `X id` cross-aggregate restriction is untouched.
- No `private` / `extern` / `audited` / `when` modifiers (aggregate-op-only).

## Calling one — the orchestrator load-protocol

A member call resolves to a `Call` with `callKind: "domain-service"`
(carrying `serviceRef: { service, op }`), so every backend renders a real
call without re-resolving. A **pure** service is callable from anywhere,
including an aggregate operation:

```ddd
aggregate Order {
  operation reprice(catalog: PriceList) {
    let amount = Pricing.recalculate(this, catalog)   // pure ⇒ legal here
    this.total := amount
  }
}
```

A **reading**/**mutating** service is **application-orchestrator-only**.
The protocol is uniform — *orchestrator loads → service reads/mutates the
passed-in aggregates → orchestrator persists*. The `or`-union result is
consumed by **`return`-in-tail-position** (the edge maps the error
variant → RFC-7807 ProblemDetails); persistence is the workflow's
**auto-save-at-exit** of the mutated args:

```ddd
workflow MoveMoney transactional {
  create(source: Account id, dest: Account id, amount: Money): Transferred or InsufficientFunds {
    let src = Accounts.getById(source)            // orchestrator LOADS
    let dst = Accounts.getById(dest)
    return Transfer.run(src, dst, amount)         // service MUTATES src,dst; they auto-save at exit
  }
}
```

(`from`/`to` are reserved words — params are `source`/`dest`.)

## The contract (phase ⑦ IR validator)

| Forbidden in any tier | Diagnostic |
|---|---|
| `emit` an event | `loom.domain-service-no-emit` |
| A `this`-rooted write (`:=` / `+=` / `-=`) — there is no `this` | `loom.domain-service-no-mutation` |
| A repository **write** (`save`/`insert`/`update`/`delete`/`add`/`remove`/`commit`) | `loom.domain-service-no-repo-write` |
| Start a workflow in the same context | `loom.domain-service-no-workflow-start` |
| Calling a **reading**/**mutating** service from an aggregate op / view body | `loom.domain-service-infra-call-from-aggregate` |

Repository **reads** are allowed (they lower to a `repo-read` Call, not a
write); mutation of a **passed-in aggregate** via its own operation is
allowed in the `mutating` tier (it's a method-call, never the
`no-mutation` statement gate). Plus an **anemic-domain warning**
(`loom.domain-service-single-aggregate`) when every operation takes
exactly one aggregate parameter — the behaviour could be an `operation`
on that aggregate instead.

## Per-backend emission

One neutral IR (`repo-read` / `classifyDomainServiceTier` /
`domain-service-call`), five idiomatic renderings. The **pure** tier is a
stateless static/module function on every backend (byte-identical to the
v1 floor); the **reading**/**mutating** tiers diverge by idiom:

| Backend | Pure | Reading (read handle) | Mutating (persistence) |
|---|---|---|---|
| **TS / Hono** | `export namespace Pricing` | read-port **parameter** (`accounts: AccountRepository`) | orchestrator `repository.save(arg, tx)` in `db.transaction` |
| **.NET / EF** | `public static class` | **DI'd** service (`sealed class` + injected `IAccountRepository`, `AsNoTracking`) | tracked entities flush at `SaveChangesAsync` |
| **Java / Spring** | static utility class | **`@Service` bean** (`@Transactional(readOnly = true)`) | managed entities flush at `@Transactional` |
| **Python / FastAPI** | bare module functions | read-port **parameter** (`accounts`/`session`) | session UoW `commit()` |
| **Elixir / Phoenix** | `App.Domain.Services.Pricing` module | a **context function** (ambient `Repo`) | inlines into the workflow's `with`-chain; each mutated arg routes to its context mutating fn (`Repo.update`), atomic via `Repo.transaction` |

All three tiers ship on all five backends
(`src/generator/{typescript,dotnet,java,python,elixir}/…/domain-service*`,
the shared `src/ir/util/domain-service-{tier,read-ports}.ts`, and the
`computeSaves` mutated-arg derivation in `src/ir/lower/lower-members.ts`).

## Companion: `function` block body

A `function` may now take a **pure block body** (statements) instead of
only a single `= Expression`:

```ddd
function lineTotal(l: Line): Money = l.qty * l.price        // expression form (SQL-inlinable)
function shippingFor(cart: Cart, dest: Region): Money {     // block form
  let weight = cart.lines.sum(l => l.item.weight)
  if (dest.isDomestic) return weight * Rates.domestic
  return weight * Rates.international + cart.customsSurcharge
}
```

A block-body `function` stays **pure** — params only, no repository
(not even a read), no mutation/`emit` (`loom.function-block-impure`);
`throw`/`require` for the bug regime are allowed. The expression form
stays **SQL-inlinable** (queryable like a `criterion`); the **block form
is not queryable** (a block-function call is rejected in a `where` /
`criterion` / view-filter position, the same as any call). This keeps the
ladder crisp: `function` (pure; expression form inlinable) → `criterion`
(pure, queryable predicate) → `domainService` (reads, decides, mutates
passed-in aggregates).
