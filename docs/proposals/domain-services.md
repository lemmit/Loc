# Domain services — the missing third construct (pinned design, **rev. 3: pure service + orchestrator-owned persistence**)

> Status: **proposal — revised pins, research-grounded.** v1 (Shape A,
> the pure-calculator floor) **ships today**. This revision adds
> **mutation** (Shape B) but, after a five-backend idiom audit (see
> "Research findings" below), keeps the domain service **pure of
> infrastructure**: it receives materialised aggregates and may mutate
> them via their own operations, but it does **not** load via a
> repository and does **not** commit. The **application orchestrator**
> (`workflow` / `commandHandler` / Phoenix context) loads, passes the
> aggregates in, and owns the single commit.
>
> Rev. 3 supersedes rev. 2's "domain service may load through repository
> ports" pin — that pin did not survive the idiom audit. See "What
> changed in rev. 3." Companion to
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md),
> [`workflow-and-applier.md`](./workflow-and-applier.md),
> [`lifecycle-operations.md`](./lifecycle-operations.md),
> [`criterion.md`](./criterion.md), and
> [`failure-taxonomy.md`](./failure-taxonomy.md).

## What changed in rev. 3 (and why)

Rev. 2 widened the construct to the Vernon/hexagonal reading and let a
domain service **load through repository ports**. A five-backend research
audit (EF Core, Spring/JPA, SQLAlchemy, Ecto/Phoenix, Drizzle) found that
specific move breaks on two counts, on most targets:

1. **It's mislabeled.** By the canonical definitions — Evans, Vernon
   (IDDD), and Percival/Gregory (*Architecture Patterns with Python* /
   "Cosmic Python") — a thing that loads via a repository and owns a
   commit *is the application/service layer*, not a domain service. The
   domain service is the **pure** core that receives materialised
   aggregates. Loom already has the application orchestrator: `workflow`
   (and the planned `commandHandler` / `queryHandler`).
2. **It forces non-idiomatic emission.** Change-tracking only persists
   entities loaded by the *same* DbContext / EntityManager / Session that
   commits. A stateless `static class` / bare-function service can reach
   that context only if it's passed in — so "stateless service that loads
   via a repo" is a contradiction: real EF/Spring code makes such a thing
   a **DI'd bean** (not static), and Elixir has no separate service module
   at all (the Phoenix **context** is the domain service *and* the
   repository).

So rev. 3 keeps what the audit endorsed and drops what it rejected:

| Axis | Rev. 2 pin | Rev. 3 pin | Why |
|---|---|---|---|
| **Repository access inside the service** | Allowed via "port" (`reading` tier) | **Removed.** Loading is the orchestrator's job; it passes materialised aggregates in. | Evans/Vernon/Cosmic-Python all place loading in the application layer; a loading service can't stay stateless-static on EF/JPA/SQLAlchemy. |
| **Mutation** | Allowed (`mutating` tier) | **Kept**, but as **pass-in** mutation: the service mutates aggregates the orchestrator handed it. | The mutation set = exactly the passed-in aggregates, which the orchestrator already references — so it persists them with no change-tracking gymnastics, idiomatically, on all five backends. |
| **Who commits** | Application layer | **Application layer (unchanged).** | The one invariant every camp shares. |
| **Side effects** (`emit` / `extern` / `api` / workflow-start) | Forbidden | **Forbidden (unchanged).** | The line that keeps a domain service from collapsing into a workflow. |
| **Emission** | Stateless module/class | **Stateless module/class (unchanged) — now actually honest**, because a pure service needs no injected repo. | The purity is what *lets* the emission stay static with no DI. |
| **Callers** | Pure ⇒ anywhere; loading/mutating ⇒ app-only | Pure ⇒ anywhere; **mutating ⇒ application-orchestrator-only** | A mutating service called from inside an aggregate op would let one aggregate reach a *second* aggregate's mutable state. |

The retained one-line boundary, sharpened:

> **Domain service = receive materialised aggregates, compute / decide /
> mutate-in-memory, return a result. Application orchestrator = load,
> call the service, persist. Workflow = the orchestrator, plus `emit` /
> `extern` / `api`.**

This delivers the three things that motivated rev. 2 — the application
layer owns `save`, domain services may mutate aggregates, and they carry
no infrastructure concerns — while staying idiomatic on every backend.
The only thing it gives up is repositories *literally inside* the
service, which the audit showed is application-layer work the
orchestrator already does (with the same `Accounts.required(id)` loading
syntax).

## The two tiers

| Tier | Body may… | Callable from | Persistence |
|---|---|---|---|
| **pure** *(Shape A — ships today)* | params only; branch, `let`, `match`, `throw`, call other pure services | **anywhere** (aggregate ops, views, workflows, services) | none |
| **mutating** *(Shape B — this revision)* | the above **+ call mutating operations on the aggregates passed in** | **application orchestrators only** | the orchestrator persists the passed-in (now-mutated) aggregates |

Forbidden in **both** tiers: load via a repository, `emit` an event,
call an `extern`, call an `api`, or `start` a workflow / invoke a
`commandHandler` / `queryHandler`. Loading and all outbound I/O live in
the application layer.

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
    operation run(from: Account, to: Account, amount: Money)
      : Transferred or InsufficientFunds {
      require amount > Money.zero  "amount must be positive"
      if (from.balance < amount)
        return InsufficientFunds { account: from.id, shortfall: amount - from.balance }
      from.withdraw(amount)                                // mutate a PASSED-IN aggregate
      to.deposit(amount)                                   // via its own operation
      return Transferred { from: from.id, to: to.id, amount }
    }
  }
}
```

- The service takes **materialised aggregates** (`from: Account`), not
  ids — the orchestrator loaded them. Cross-aggregate parameters are
  plain aggregate names (a different grammar position from a containment
  partType, so the `X id` cross-aggregate restriction is untouched).
- The return type is the **domain result** (`Transferred or
  InsufficientFunds`). The mutation set is implicit: it is exactly the
  aggregate parameters the body mutated, which the orchestrator already
  holds. Nothing is returned for the caller to "diff."
- No `private` / `extern` / `audited` / `when` modifiers (aggregate-op-only).

## Calling one — the orchestrator load-protocol

The Evans load-protocol, uniform across every backend: **orchestrator
loads → domain service receives materialised aggregates and mutates them
→ orchestrator persists.**

```ddd
workflow MoveMoney {
  handle move(cmd: MoveMoney): Transferred or InsufficientFunds {
    let from = Accounts.required(cmd.from)        // orchestrator LOADS
    let to   = Accounts.required(cmd.to)
    let r    = Transfer.run(from, to, cmd.amount) // service MUTATES from/to
    match r {
      Transferred t       => { save from; save to; return t }   // orchestrator PERSISTS
      InsufficientFunds e => return e
    }
  }
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

A **mutating** service called from an aggregate operation is a hard error
(`loom.domain-service.mutating-call-from-aggregate`) — only an
application orchestrator may call it, because only the orchestrator has
loaded the aggregates and owns the commit.

## Persistence — orchestrator-owned, idiomatic per backend

The neutral semantic the DSL/IR pins, backend-agnostic:

> The application orchestrator establishes a single **transaction /
> unit-of-work scope**, loads the aggregates, calls the (pure or
> mutating) domain service, and **commits the scope once**. The domain
> service never loads and never commits.

Because the mutation set is **exactly the aggregates the orchestrator
passed in and still references**, "what to persist" is never in doubt and
never needs reconstructing from a returned value. Each `PlatformSurface`
renders the commit idiomatically — exactly as `MigrationsIR` is one
neutral concept rendered per backend, never a forced uniform shim:

| Backend | Unit of work | How the mutated aggregates persist |
|---|---|---|
| **.NET / EF Core** | `DbContext` change-tracking (scoped) | passed-in entities are tracked → mutate in place → orchestrator `await db.SaveChangesAsync()` once |
| **Java / Spring + JPA** | persistence context | passed-in entities are managed → dirty-checking flushes at the `@Transactional` boundary (**+ explicit `repository.save(...)` for any *newly created* aggregate** — dirty-checking only flushes already-managed ones) |
| **Python / SQLAlchemy** | `Session` unit of work | passed-in objects are session-tracked → orchestrator `uow.commit()` / `session.commit()` once |
| **Elixir / Ecto** | `Repo.transact/2` + `with` | orchestrator is a context function: build changesets inline, `Repo.update`/`insert` each inside one `Repo.transact` (`Ecto.Multi` only when the step set is dynamic) |
| **TS / Hono / Drizzle** | `db.transaction(async tx => …)` | no change-tracking → orchestrator calls **`repository.save(aggregate, tx)`** for each passed-in aggregate inside the transaction |

Two families fall out, and the split is the natural one:

- **Change-tracking backends (EF / JPA / SQLAlchemy)** get an *implicit*
  unit of work: the orchestrator loaded the aggregates, so they're
  already tracked; the service mutates them in place; the single
  commit/flush persists them. (JPA caveat: a *new* aggregate the service
  constructs is unmanaged and still needs an explicit `save`.)
- **Explicit backends (Ecto / Drizzle)** have no change tracker, so the
  *orchestrator* issues explicit writes inside one transaction —
  `repository.save(aggregate, tx)` on Drizzle, an inline changeset +
  `Repo.update` on Ecto. The service still only mutates in memory; the
  orchestrator, which holds the references, does the writing. (The audit
  was explicit: "return the mutated object" is **not** a persistence
  strategy on a non-tracked ORM — the caller wouldn't know what to
  `UPDATE`. Explicit `repo.save` is the idiom.)

The `.ddd` is byte-identical across all five backends; the divergence
lives entirely in how the **orchestrator** renders its commit.

### Multi-aggregate transactions (the `transfer` case)

The two-account transfer is **one transaction, two saves** — the
orchestrator loads both accounts, the service mutates both, one commit
persists both. This is what EF / Spring / Drizzle samples actually do and
is the pin.

> *Orthodoxy note:* the strict Cosmic-Python line is "modify one aggregate
> per unit of work; bridge to the second via a domain event (eventual
> consistency)." Loom pins the **pragmatic single-transaction** form for
> aggregates that must change atomically, and treats the event-driven
> form as the explicit-async alternative (workflows + `emit`), not the
> default. Recorded as a deliberate deviation, not an oversight.

### What the IR needs to carry

- `DomainServiceOperationIR.mutating: bool` — true iff the body calls a
  mutating operation on an aggregate parameter. Drives the caller
  restriction (mutating ⇒ orchestrator-only) and tells the orchestrator
  emitter which parameters to persist after the call.
- `OperationIR.mutating: bool` already exists — reused to classify
  whether a call into an aggregate operation makes the enclosing service
  `mutating`, and (at the call site) to drive the orchestrator's `save`
  emission for the mutated parameters.

No repository tier, no `mutates`-set materialisation, no new
`ExprIR.kind`; calls stay `Call { callKind: "domain-service" }`.

## `function` — let it do a bit more (companion change)

Today `FunctionDecl` is `function f(p): T = Expression` — a single
expression (it already admits `match`/ternary, just not statements,
`let`-bindings, or `throw`). Rev. 3 adds a **pure block body**:

```ddd
function lineTotal(l: Line): Money = l.qty * l.price        // unchanged — expression form

function shippingFor(cart: Cart, dest: Region): Money {     // new — block form
  let weight = cart.lines.sum(l => l.item.weight)
  if (dest.isDomestic) return weight * Rates.domestic
  return weight * Rates.international + cart.customsSurcharge
}
```

Boundaries that keep `function` from swallowing `domainService`:

- A block-body `function` stays **pure** — params only, no repository, no
  mutation, no `emit`/`extern`/`api`. `throw` / `require` (bug regime) is
  allowed (it makes the function partial, not impure).
- **Inlinability is the trade.** The expression form (`= Expression`)
  stays a candidate for SQL inlining the way a `criterion` is; a
  **block-body function is not queryable**. This keeps the tiers crisp:
  `function` (pure; expression form inlinable) → `criterion` (pure,
  queryable predicate) → `domainService` (decides, mutates passed-in
  aggregates).

Full *imperative* statement bodies (assignment, loops) are rejected —
that erases the function/domainService line.

## Validation (`src/ir/validate/checks/domain-service-checks.ts`)

Revised set. **Kept:** `no-emit`, `no-extern`, `no-api-call`,
`no-application-call` (no workflow-start / handler call). **Re-added as a
hard rule:** `loom.domain-service.no-repo` — a domain service may not
call a repository; loading is the orchestrator's job. **New:**

- `loom.domain-service.mutating-call-from-aggregate` — a mutating service
  invoked from an aggregate `operation` / `create` / `destroy` / view
  body. (Pure services are exempt — callable anywhere.)
- `loom.domain-service.single-aggregate-warning` — unchanged soft anemic
  nudge: every operation taking exactly one aggregate ⇒ "consider an
  `operation` on that aggregate instead."

**Dropped vs. rev. 2:** the `reading` tier and its
`impure-call-from-aggregate` code (no repository access to gate). The
rev-1 `no-mutation` rule stays dropped — mutation of passed-in aggregates
is now legal in the `mutating` tier.

## Per-backend emission

The **declaration** is a stateless module of functions on every backend
(no DI — the service is pure, so it needs no injected repository). The
**call** is the shared `ExprTarget` `domain-service` arm. The new work is
the **orchestrator** persisting the mutated parameters after a mutating
call:

| Backend | Service declaration | Orchestrator persistence after a mutating call |
|---|---|---|
| **TS / Hono** | `src/domain/services/<name>.ts` namespace of pure fns | `repository.save(param, tx)` per mutated param, inside `db.transaction` |
| **.NET / EF** | `Domain/Services/<Name>.cs` `static class` | one `SaveChangesAsync()` (params are tracked) |
| **Java / JPA** | `static` utility class | `@Transactional` flush; explicit `save` for newly-created aggregates |
| **Python / SQLAlchemy** | bare module functions | one `session.commit()` (params are session-tracked) |
| **Phoenix / Ecto** | a **context function** (standalone `App.Domain.Services.<Name>` module **only** when the op crosses context boundaries) | inline changeset + `Repo.update`/`insert` inside `Repo.transact` |

> **Elixir shape note (from the audit):** in plain-Ecto Phoenix the
> **context is the domain service + the repository**. A single-context
> domain service lowers to a *context function*, not a separate
> `Services` module; a standalone module is warranted only for
> *cross-context* orchestration. **Never wrap `Ecto.Repo` in a
> "repository port"** — that is a community anti-pattern; the context
> calls `Repo` directly and tests isolate with `Ecto.Sandbox`.

## Phasing

1. **Shape A (pure)** — *shipped.* Only change: re-confirm the `no-repo`
   gate and recast the validator around the two-tier model.
2. **Shape B (mutating, pass-in)** — the caller gate
   (`mutating-call-from-aggregate`) + the orchestrator `save`-emission
   for mutated parameters. Ship the **change-tracking** backends first
   (EF / JPA / SQLAlchemy: nearly free — they already commit at the
   orchestrator). Then the **explicit** pair (Drizzle `repo.save(_, tx)`,
   Ecto inline-changeset + `Repo.transact`).
3. **`function` block body** — independent companion; can land any time.

## Research findings (five-backend idiom audit)

The rev-2 → rev-3 correction is grounded in primary-source research per
backend. Headlines and citations:

- **Canonical DDD draws the line at infrastructure.** Evans/Vernon: the
  pure domain service receives materialised aggregates; the application
  service loads and owns the transaction. Vernon, *Implementing DDD*
  (Aggregates): "look up dependencies before … and pass them in";
  "inject Repository and Domain Service references into Application
  Services." Cosmic Python (ch. 4): a thing that loads via a
  repository/session **is the service layer**, not a domain service.
- **.NET / EF Core** — a loading service can't be `static`; EF change
  tracking needs the same scoped `DbContext`, and MS DI guidance says
  "avoid stateful static classes … DI is an alternative to static/global
  access." Pure services *may* be static. ([MS Learn — app layer /
  command handlers](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/microservice-application-layer-implementation-web-api),
  [EF Core persistence (DbContext = UnitOfWork)](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-implementation-entity-framework-core),
  [DI guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/guidelines))
- **Java / Spring + JPA** — `@Transactional` on the handler + Hibernate
  dirty-checking is the idiomatic UoW; a repo-loading service is a
  `@Service` **bean**, not a static util; **new** aggregates still need
  explicit `save`. ([Drotbohm — DDD & Spring](http://static.odrotbohm.de/lectures/ddd-and-spring/),
  [Vernon IDDD AuthenticationService](https://github.com/VaughnVernon/IDDD_Samples/blob/master/iddd_identityaccess/src/main/java/com/saasovation/identityaccess/domain/model/identity/AuthenticationService.java),
  [Baeldung — dirty checking](https://www.baeldung.com/java-hibernate-entity-dirty-check))
- **Python / SQLAlchemy** — Cosmic Python: domain service = pure
  (`calculate_tax`); the loading/committing thing is the **service
  layer**, which takes the UoW/session **as an explicit argument**;
  application owns `commit()`. ([Ch. 4 — Service Layer](https://github.com/cosmicpython/book/blob/master/chapter_04_service_layer.asciidoc),
  [Ch. 6 — Unit of Work](https://github.com/cosmicpython/book/blob/master/chapter_06_uow.asciidoc))
- **Elixir / Ecto** — the Phoenix **context** is the domain service +
  repository; a standalone service module is for **cross-context** ops
  only; **wrapping `Ecto.Repo` is an anti-pattern**; prefer
  `Repo.transact` + `with` over `Ecto.Multi` for static pipelines.
  ([Jurić — Maintainable Elixir core module](https://medium.com/very-big-things/towards-maintainable-elixir-the-anatomy-of-a-core-module-b7372009ca6d),
  [Konidas — the case against Ecto.Multi](https://tomkonidas.com/repo-transact/),
  [ElixirForum — Repo outside contexts](https://elixirforum.com/t/using-repo-functions-outside-of-context-modules-anti-pattern/50314))
- **TS / Drizzle** — no change-tracking, so "mutate-in-memory and return"
  is **not** a persistence story; the idiom is `repository.save(entity,
  tx)` inside `db.transaction`, with `tx` threaded as an argument (no DI
  container needed). ([Drizzle transactions](https://orm.drizzle.team/docs/transactions),
  [Sentry — atomic repositories in clean-architecture TS](https://blog.sentry.io/atomic-repositories-in-clean-architecture-and-typescript/),
  [Stemmler — persisting aggregates](https://khalilstemmler.com/articles/typescript-domain-driven-design/aggregate-design-persistence/))

## Open questions

1. **Drizzle `save` shape.** Full-row `UPDATE … SET` from the aggregate's
   `wireShape` (simplest, deterministic for generated code) vs.
   existence-check create-or-update (Stemmler). Lean full-row.
2. **`audited` on service operations.** Probably yes in a follow-up; same
   lowering as `operation audited`.
3. **Elixir single- vs cross-context classification.** The emitter needs
   to decide context-function vs standalone-module from the operation's
   parameter modules — pin the rule (single context ⇒ context fn).
4. **Composition.** Stateless services just call `B.op(...)` directly; no
   constructor injection. Revisit only if testing demands it.

## Decision summary

- **Domain services are pure of infrastructure**: they receive
  materialised aggregates and may **mutate them via their own
  operations** (Shape B), but **do not load via a repository** and **do
  not commit**. Loading + the commit live in the **application
  orchestrator** (`workflow` / `commandHandler` / Phoenix context).
- **Two tiers** — `pure` (callable anywhere) and `mutating`
  (application-orchestrator-only).
- **Persistence is orchestrator-owned, rendered idiomatically per
  backend**: implicit change-tracking on EF / JPA / SQLAlchemy (single
  commit/flush; explicit `save` for new aggregates on JPA); explicit
  `repository.save(_, tx)` on Drizzle and inline-changeset +
  `Repo.transact` on Ecto. The mutation set is the passed-in aggregates;
  nothing is returned for the caller to diff.
- **Multi-aggregate writes** use one transaction / multiple saves
  (pragmatic), with the one-aggregate-per-UoW-plus-events form as the
  explicit-async alternative.
- **`function` gains a pure block body** (let + branch + bug-regime
  throw), staying non-queryable.
- Reuse `Call` + `callKind: "domain-service"`; the only new IR field is
  `DomainServiceOperationIR.mutating`.
