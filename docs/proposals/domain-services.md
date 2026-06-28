# Domain services — the missing third construct (pinned design, **rev. 2: Vernon camp**)

> Status: **proposal — revised pins.** v1 (Shape A, the pure-calculator
> floor) **ships today**; this revision widens the construct to the
> Vernon/hexagonal reading — a domain service **may load through
> repository ports and mutate the aggregates it touches**, while the
> application orchestrator keeps the single commit point. It supersedes
> the rev-1 Evans-strict pins below (and the singular-form
> [`domain-service.md`](./domain-service.md) options-menu draft from
> #1041). Companion to
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
> (the four-layer **domain / contract / application / api** map —
> `domainService` is a *domain*-layer construct, called from the
> *application*-layer orchestrators), [`workflow-and-applier.md`](./workflow-and-applier.md),
> [`lifecycle-operations.md`](./lifecycle-operations.md),
> [`criterion.md`](./criterion.md) (reusable predicates — the queryable
> sibling), and [`failure-taxonomy.md`](./failure-taxonomy.md).

## What changed in rev. 2 (and why)

Rev. 1 pinned the **Evans-strict** reading: a domain service was a pure
calculator — no repository, no mutation, the application orchestrator
loaded everything and passed materialised aggregates in. That shipped as
the v1 floor (Shape A) and stands as a valid *subset*. Rev. 2 widens it:

| Axis | Rev. 1 pin (shipped Shape A) | Rev. 2 pin | Why |
|---|---|---|---|
| **1 — mutation** | Forbidden (`no-mutation`) | **Allowed** — a domain service mutates aggregates via their own operations | The textbook `transfer(from, to, amount)` *is* a mutating domain service; forbidding it amputated the construct's reason to exist. |
| **2 — repository access** | Hard error (`no-repo`) — orchestrator loads, passes in | **Allowed via the repository *port*** (the domain-owned interface), never the infra adapter | The Vernon/hexagonal reading. "Repos without infra concerns" = the service depends on `Orders` the abstraction; the infra layer supplies the implementation. |
| **3 — who commits** | Application layer | **Application layer (unchanged)** | The one invariant rev. 2 keeps verbatim. The transaction boundary stays in the orchestrator. |
| **4 — side effects** | `emit` / `extern` / `api` forbidden | **Still forbidden** | Outbound I/O and event-attribution remain application-/aggregate-bound. This is the line that keeps a domain service from collapsing into a workflow. |
| **5 — callers** | Pure ⇒ callable anywhere | **Pure ⇒ anywhere; loading/mutating ⇒ application-orchestrator-only** | A loading/mutating service called from an aggregate operation would let one aggregate reach a repository (infra) or a *second* aggregate's mutable state — the boundary the construct exists to protect. |
| **6 — errors** | `throw` (bug) / `or`-union (domain) | **Unchanged** | Per `failure-taxonomy.md`. Not a choice. |

The line that keeps a domain service distinct from a workflow survives,
just redrawn:

> **Domain service = read + compute + mutate-in-memory.
> Workflow = that, plus commit, `emit`, `extern`, and HTTP.**

The transaction boundary and *all* outbound I/O stay in the application
layer. That is a teachable, enforceable boundary — and it is squarely
within mainstream DDD (Vernon, *Implementing Domain-Driven Design*,
ch. 7: domain services may depend on repository interfaces and operate on
multiple aggregates; the application service owns the transaction).

## The three purity tiers (the teachable core)

A `domainService` operation is classified — from its body, by the phase-⑦
validator — into exactly one of three tiers. The tier decides who may
call it and how it persists:

| Tier | Body may… | Callable from | Persistence |
|---|---|---|---|
| **pure** | params only; branch, `let`, `match`, `throw`, call other pure services | **anywhere** (aggregate ops, views, workflows, other services) | none |
| **reading** | the above **+ load via repository ports** | application orchestrators only | none (read-only) |
| **mutating** | the above **+ call mutating operations on aggregates** | application orchestrators only | orchestrator's unit-of-work commits it (see below) |

Still forbidden in **every** tier: `emit` an event, call an `extern`,
call an `api`, or `start` a workflow / invoke a `commandHandler` /
`queryHandler` (that last would invert the layer arrow — domain reaching
application).

`pure` is exactly the shipped Shape A. `reading` and `mutating` are the
rev-2 widening.

## Surface

```ddd
module Sales {
  domainService Pricing {                                  // pure tier
    operation quote(cart: Cart, customer: Customer): Money {
      require cart.lines.count > 0  "cannot quote an empty cart"   // bug regime
      return cart.subtotal - customer.tier.discount(cart.subtotal)
    }
  }
}

module Banking {
  domainService Transfer {                                 // mutating tier
    operation run(fromId: AccountId, toId: AccountId, amount: Money)
      : Transferred or InsufficientFunds {
      require amount > Money.zero  "amount must be positive"
      let from = Accounts.required(fromId)                 // load via PORT (reading)
      let to   = Accounts.required(toId)
      if (from.balance < amount)
        return InsufficientFunds { account: fromId, shortfall: amount - from.balance }
      from.withdraw(amount)                                // mutate via the aggregate's OWN op
      to.deposit(amount)
      return Transferred { from: fromId, to: toId, amount }
    }
  }
}
```

- The DSL return type is the **domain result only** (`Transferred or
  InsufficientFunds`). The *mutation set* — which aggregates were
  touched — is carried by lowering, never by the author (see
  "Persistence" — it materialises differently per backend, but the `.ddd`
  is identical everywhere).
- Cross-aggregate parameters are plain aggregate names (`cart: Cart`) — a
  different grammar position from a containment partType, so the `X id`
  cross-aggregate restriction is untouched.
- No `private` / `extern` / `audited` / `when` modifiers (aggregate-op-only).

## Calling one

A member call resolves the receiver to the `domainService` declaration
and lowers to a `Call` with `callKind: "domain-service"` (carrying a
structured `serviceRef: { service, op }`), so every backend renders a
real call without re-resolving:

```ddd
workflow MoveMoney {
  handle move(cmd: MoveMoney): Transferred or InsufficientFunds {
    return Transfer.run(cmd.from, cmd.to, cmd.amount)   // orchestrator opens the UoW;
  }                                                      // the single commit happens here
}
```

A **pure** service is also callable from an aggregate operation:

```ddd
aggregate Order {
  operation reprice(catalog: PriceList) {
    let amount = Pricing.recalculate(this, catalog)   // pure ⇒ legal inside an aggregate
    this.total := amount
  }
}
```

A **mutating** or **reading** service called from an aggregate operation
is a hard error (`loom.domain-service.impure-call-from-aggregate`) — that
is the caller restriction of tier-5.

## Persistence — one neutral semantic, idiomatic per backend

This is the crux of rev. 2, and the answer to "use a unit-of-work, but
let each backend stay idiomatic."

**The neutral semantic Loom pins (backend-agnostic):**

> The application orchestrator (`workflow` / `commandHandler`) establishes
> a single **unit-of-work / transaction scope**. The domain service runs
> *inside* that scope — loading through ports, mutating aggregates via
> their own operations — and the orchestrator **commits the scope once**,
> atomically. The domain service never commits.

That is the only thing the DSL and IR commit to. **How the scope and its
dirty set are realised is each `PlatformSurface`'s call** — exactly the
way `MigrationsIR` is one neutral concept rendered idiomatically per
backend, never a uniform emitted shim forced onto every target.

Two rendering families fall out, by whether the backend's ORM tracks
changes:

| Backend | UoW mechanism | Mutation set reaches the commit by… | Emitted idiom |
|---|---|---|---|
| **.NET / EF Core** | `DbContext` change-tracking | **implicit** — tracked entities are dirty | service mutates in place; orchestrator `await db.SaveChangesAsync()` once |
| **Java / Spring + JPA** | persistence context | **implicit** — managed entities flush at commit | `@Transactional` handler; flush on return |
| **Python / SQLAlchemy** | `Session` unit-of-work | **implicit** — session tracks dirty | service mutates in place; orchestrator `session.commit()` |
| **Elixir / Ecto** | `Ecto.Multi` (no change-tracking) | **explicit** — service returns **`Ecto.Changeset`(s)** | orchestrator composes them into one `Ecto.Multi`, runs `Repo.transaction/1` |
| **TS / Hono / Drizzle** | `db.transaction` (no change-tracking) | **explicit** — service returns the mutated aggregate state | orchestrator applies it inside `db.transaction(async tx => …)` |

The split is the natural one: the three ORM-with-identity-map backends
(EF / JPA / SQLAlchemy) get a real **implicit** unit of work for free —
the service mutates managed objects and the orchestrator's single
commit/flush persists them, with the service returning only its domain
result. The two explicit backends (Ecto, Drizzle) have no change tracker,
so Loom **materialises the mutation set into the service's lowered
return** and the orchestrator applies it within one transaction — and for
Ecto that materialisation is precisely the idiomatic `Ecto.Changeset`
composed into an `Ecto.Multi`, which is how a plain-Ecto/Phoenix context
module is *supposed* to be written. Drizzle's is the mutated row values
applied inside `db.transaction`.

**The author never sees this.** The `.ddd` for `Transfer.run` is
byte-identical across all five backends; the divergence lives entirely in
lowering + the per-backend emitter, behind the `serviceRef` call seam.

### What the IR needs to carry

- `DomainServiceOperationIR.tier: "pure" | "reading" | "mutating"` —
  classified during lowering from the body (calls a repo ⇒ at least
  `reading`; calls a mutating aggregate op ⇒ `mutating`). Drives the
  caller-restriction validator and the persistence-family branch.
- `DomainServiceOperationIR.mutates: AggregateRef[]` — the mutation set
  (which aggregate types the body mutates). Empty for `pure`/`reading`.
  Consumed only by the **explicit** backends to shape the materialised
  return; the **implicit** backends ignore it.
- `OperationIR.mutating: bool` already exists (the rev-1 enabling change)
  — reused to classify whether a call into an aggregate operation makes
  the enclosing service `mutating`.

No new `ExprIR.kind`; calls stay `Call { callKind: "domain-service" }`.

## `function` — let it do a bit more (companion change)

Today `FunctionDecl` is `function f(p): T = Expression` — a **single
expression** (it already admits `match`/ternary, just not statements,
`let`-bindings, or `throw`). Rev. 2 adds a **block body** so a function is
no longer one-liner-only:

```ddd
function lineTotal(l: Line): Money = l.qty * l.price        // unchanged — expression form

function shippingFor(cart: Cart, dest: Region): Money {     // new — block form
  let weight = cart.lines.sum(l => l.item.weight)
  if (dest.isDomestic) return weight * Rates.domestic
  return weight * Rates.international + cart.customsSurcharge
}
```

Deliberate boundaries that keep `function` from swallowing
`domainService`:

- A block-body `function` stays **pure** — params only, **no repository,
  no mutation, no `emit`/`extern`/`api`** (it's a `function`, not a
  service). `throw` / `require` for the bug regime is allowed (it only
  makes the function partial, not impure).
- **Inlinability is the trade.** The expression form (`= Expression`)
  stays a candidate for SQL inlining the way a `criterion` is; a
  **block-body function is not queryable** — once it branches and binds
  locals it cannot lower into a `where`. The validator that lets a
  `criterion`/expression `function` inline simply doesn't admit the block
  form. This keeps the three-tier story crisp:

  `function` (pure; expression form inlinable) → `criterion` (pure,
  queryable predicate) → `domainService` (loads, decides, mutates).

The alternative considered — full *imperative* statement bodies in
`function` (assignment, loops) — is rejected: that erases the
function/domainService line entirely and gives `function` powers no pure
helper should have. "A bit more" means **let-bindings + branching +
bug-regime throw in a block**, not statements.

## Validation (`src/ir/validate/checks/domain-service-checks.ts`)

Revised from the rev-1 set. **Dropped:** `loom.domain-service.no-repo`,
`loom.domain-service.no-mutation` (both now legal). **Kept:**

1. `loom.domain-service.no-emit`
2. `loom.domain-service.no-extern`
3. `loom.domain-service.no-api-call`
4. `loom.domain-service.no-application-call` — no `start` workflow /
   `commandHandler` / `queryHandler` (the layer-arrow inversion)

**New:**

5. `loom.domain-service.impure-call-from-aggregate` — a `reading` or
   `mutating` service invoked from an aggregate `operation` / `create` /
   `destroy` / view body. (Pure services are exempt — they're callable
   anywhere.)
6. `loom.domain-service.single-aggregate-warning` — unchanged soft
   anemic-domain nudge: every operation taking exactly one aggregate ⇒
   "consider an `operation` on that aggregate instead."

## Per-backend emission

Each backend already emits the **declaration** (a stateless module of
functions) and the **call** (the shared `ExprTarget` `domain-service`
arm) for the pure tier today. Rev. 2 adds the persistence wiring per the
family table above:

| Backend | Declaration home | Mutating-tier wiring |
|---|---|---|
| **TS / Hono** | `src/domain/services/<name>.ts` namespace | service returns mutated aggregate values; orchestrator applies in `db.transaction` |
| **.NET / EF** | `Domain/Services/<Name>.cs` static class | mutate tracked entities in place; handler `SaveChangesAsync()` |
| **Java / JPA** | static utility class | mutate managed entities; `@Transactional` flush |
| **Python / SQLAlchemy** | bare module functions | mutate session-tracked objects; `session.commit()` |
| **Phoenix / Ecto** | `App.Domain.Services.<Name>` module | service returns `Ecto.Changeset`(s); orchestrator composes `Ecto.Multi` + `Repo.transaction/1` |

The repository **port** the `reading`/`mutating` tiers call is the same
interface the orchestrators already use — no new injection surface on the
implicit backends; on the explicit backends the port is the existing
context/repo module.

## Phasing

1. **Shape A (pure)** — *shipped.* No change needed beyond the validator
   rename (drop `no-repo`/`no-mutation` from the "always forbidden" list,
   recast as the tier classifier).
2. **`reading` tier** — repository-port access + the
   `impure-call-from-aggregate` caller gate. No persistence wiring (read
   only). Lands first; smallest blast radius.
3. **`mutating` tier** — the persistence families. Ship the **implicit**
   backends first (EF / JPA / SQLAlchemy: nearly free — they already
   commit at the orchestrator). Then the **explicit** pair (Ecto
   changeset+Multi, Drizzle return+transaction), which carry the
   `mutates` materialisation.
4. **`function` block body** — independent companion; can land any time.

## Open questions

1. **Explicit-backend return materialisation.** For Drizzle, is the
   mutated-aggregate return a full row value or a typed change-set? (Ecto
   is settled — `Ecto.Changeset`.) Affects only the two explicit backends.
2. **Nested transaction scopes.** If a `workflow` already opens a
   transaction and calls a `mutating` service, the service must *join*
   the ambient scope, not open its own. Implicit backends handle this
   natively; the explicit pair needs the orchestrator to thread the
   `tx` / `Multi` — pin the threading convention.
3. **`audited` on service operations.** Still probably yes in a follow-up;
   same lowering as `operation audited`.
4. **Composition.** Stateless services just call `B.op(...)` directly; no
   constructor injection in v1. Revisit only if testing demands it.

## Decision summary

- **Widen to the Vernon/hexagonal reading**: domain services may **load
  via repository ports** and **mutate aggregates via their own
  operations**; the application orchestrator keeps the **single commit
  point**. `emit` / `extern` / `api` / workflow-start stay forbidden.
- **Three tiers** — `pure` (callable anywhere) / `reading` / `mutating`
  (application-orchestrator-only) — classified by the validator from the
  body.
- **Persistence is one neutral semantic** (orchestrator-owned UoW)
  **rendered idiomatically per backend**: implicit change-tracking on
  EF / JPA / SQLAlchemy; explicit materialisation on Ecto (`Ecto.Changeset`
  + `Ecto.Multi`) and Drizzle (`db.transaction`). The `.ddd` is identical
  everywhere.
- **`function` gains a pure block body** (let + branch + bug-regime
  throw), staying non-queryable; full imperative statements rejected.
- Reuse `Call` + `callKind: "domain-service"`; add
  `DomainServiceOperationIR.tier` + `.mutates`.
