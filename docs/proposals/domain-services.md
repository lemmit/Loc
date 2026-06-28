# Domain services — the missing third construct (pinned design, **rev. 4: three tiers — pure / read-only / mutating**)

> Status: **proposal — revised pins, research-grounded.** v1 (Shape A,
> the pure-calculator floor) **ships today**. This revision pins a
> **three-tier** model: a domain service is **pure**, **read-only**
> (may query supporting data through a repository, never writes), or
> **mutating** (may mutate the aggregates the orchestrator passes in,
> never loads). In every tier the **application orchestrator**
> (`workflow` / `commandHandler` / Phoenix context) owns the single
> commit; the service never writes to a repository and never commits.
>
> Rev. 4 restores a `reading` tier that rev. 3 had folded away — but
> **restricted to reads**. The distinction that makes this safe: a query
> creates no dirty state, so the "who commits?" problem that sank the
> earlier read-*write* idea never arises. This is the Vernon read-only
> middle (a domain service that holds a repository to *look something up*
> — uniqueness checks, policy/reference lookups — is canonical; the
> contentious half was always the writing). Companion to
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md),
> [`workflow-and-applier.md`](./workflow-and-applier.md),
> [`lifecycle-operations.md`](./lifecycle-operations.md),
> [`criterion.md`](./criterion.md), and
> [`failure-taxonomy.md`](./failure-taxonomy.md).

## Revision history (what each pin got right / wrong)

| Rev. | Pin | Outcome |
|---|---|---|
| **1** | Evans-strict: pure only; no repo, no mutation; orchestrator passes everything in. | Shipped as Shape A. Correct but narrow — couldn't express the mutating `transfer`. |
| **2** | Vernon-wide: service may **load via repository ports** *and* mutate. | Walked back. A five-backend audit found a load-**and-commit** service is, by Evans/Vernon/Cosmic-Python, the *application* layer, and can't stay stateless on the change-tracking backends. |
| **3** | Pure + **mutating** (pass-in only); no repo at all. | Right about mutation (pass-in is idiomatic everywhere) but threw out the baby with the bathwater — it dropped *read-only* repo access, which has no commit problem and is canonical. |
| **4** *(this)* | **pure / read-only / mutating.** Read-only repo queries allowed; writes/commits never (orchestrator's job); mutation is pass-in. | The principled split: the tier line is *what kind of I/O*, not guilt-by-association. |

The load-bearing realisation behind rev. 4: the two objections to
repo-in-service were **(a)** persistence ambiguity ("who commits the
writes?") and **(b)** broken statelessness ("a service that touches the
DB can't be a zero-dependency static"). A **read-only** capability
eliminates (a) entirely — a query dirties nothing, so the orchestrator
stays the sole writer/committer — and softens (b), because a read
**does not need to share the orchestrator's transaction**, so the tight
coupling that forced the write version into a DI'd bean is gone (the read
just needs *a* read handle, which on Elixir is the ambient `Repo` module —
free).

## The three tiers

A domain-service operation is classified — from its body, by the phase-⑦
validator — into a capability ladder (`mutating` ⊇ `reading` ⊇ `pure`):

| Tier | Body may… | Callable from | Touches infra? |
|---|---|---|---|
| **pure** *(Shape A — ships today)* | params only; branch, `let`, `match`, `throw`, call other pure services | **anywhere** (aggregate ops, views, workflows, services) | no |
| **reading** | the above **+ read-only repository queries** (look up supporting data) | **application orchestrators only** | read-only |
| **mutating** *(Shape B)* | the above **+ call mutating operations on the aggregates passed in** | **application orchestrators only** | read-only (writes are the orchestrator's) |

Forbidden in **every** tier: a repository **write** (`save` / `insert` /
`update` / `delete`) or any commit, `emit` an event, call an `extern`,
call an `api`, or `start` a workflow / invoke a `commandHandler` /
`queryHandler`. **Writing and all outbound I/O live in the application
layer.** Reading supporting data is the only infrastructure a service may
touch, and only in the `reading`/`mutating` tiers.

The retained one-line boundary:

> **Domain service = (optionally read supporting data), compute / decide /
> mutate-the-passed-in-aggregates, return a result. Application
> orchestrator = load the target aggregates, call the service, persist.
> Workflow = the orchestrator, plus `emit` / `extern` / `api`.**

## Surface

```ddd
module Sales {
  domainService Pricing {
    // pure tier — params only
    operation quote(cart: Cart, customer: Customer): Money {
      require cart.lines.count > 0  "cannot quote an empty cart"
      return cart.subtotal - customer.tier.discount(cart.subtotal)
    }
  }

  domainService Registration {
    // reading tier — read-only repository query, no writes
    operation isEmailAvailable(email: Email): bool {
      return Customers.findByEmail(email) == null      // look-up, no mutation
    }
  }
}

module Banking {
  domainService Transfer {
    // mutating tier — mutates the PASSED-IN aggregates; may also read
    operation run(from: Account, to: Account, amount: Money)
      : Transferred or InsufficientFunds {
      require amount > Money.zero  "amount must be positive"
      let fee = FeeSchedule.current().forTier(from.tier)    // (reading, supporting data)
      if (from.balance < amount + fee)
        return InsufficientFunds { account: from.id, shortfall: amount + fee - from.balance }
      from.withdraw(amount + fee)                            // mutate a PASSED-IN aggregate
      to.deposit(amount)                                     // via its own operation
      return Transferred { from: from.id, to: to.id, amount }
    }
  }
}
```

- A `mutating`/`reading` service may **read** supporting data via a
  repository (`Customers.findByEmail`, `FeeSchedule.current`) but never
  writes — and a `mutating` service takes the aggregates it mutates as
  **materialised parameters** (`from: Account`), which the orchestrator
  loaded and will persist.
- The return type is the **domain result**. The mutation set is implicit:
  exactly the aggregate parameters the body mutated, which the
  orchestrator already references. Nothing is returned for the caller to
  "diff."
- No `private` / `extern` / `audited` / `when` modifiers (aggregate-op-only).

## Calling one — the orchestrator load-protocol

The uniform protocol across every backend: **orchestrator loads the
target aggregates → domain service (optionally reads supporting data and)
mutates them → orchestrator persists.**

```ddd
workflow MoveMoney {
  handle move(cmd: MoveMoney): Transferred or InsufficientFunds {
    let from = Accounts.required(cmd.from)        // orchestrator LOADS the targets
    let to   = Accounts.required(cmd.to)
    let r    = Transfer.run(from, to, cmd.amount) // service reads fee + MUTATES from/to
    match r {
      Transferred t       => { save from; save to; return t }   // orchestrator PERSISTS
      InsufficientFunds e => return e
    }
  }
}
```

- A **pure** service is callable from anywhere, including an aggregate
  operation (it reaches no infrastructure):

  ```ddd
  aggregate Order {
    operation reprice(catalog: PriceList) {
      let amount = Pricing.recalculate(this, catalog)   // pure ⇒ legal inside an aggregate
      this.total := amount
    }
  }
  ```

- A **reading** or **mutating** service called from an aggregate
  operation / view is a hard error
  (`loom.domain-service.infra-call-from-aggregate`) — an aggregate must
  not reach infrastructure, even transitively through a service. Only an
  application orchestrator (which has loaded the targets and owns the
  commit) may call them.

## Persistence — orchestrator-owned, idiomatic per backend

Reads dirty nothing, so persistence concerns only the `mutating` tier,
and the neutral semantic is unchanged from rev. 3:

> The application orchestrator establishes one **transaction / unit-of-work
> scope**, loads the target aggregates, calls the (pure / reading /
> mutating) domain service, and **commits the scope once**. The service
> never writes and never commits.

Because the mutation set is **exactly the aggregates the orchestrator
passed in and still references**, "what to persist" is never in doubt.
Each `PlatformSurface` renders the commit idiomatically:

| Backend | Unit of work | How the mutated aggregates persist |
|---|---|---|
| **.NET / EF Core** | `DbContext` change-tracking (scoped) | passed-in entities are tracked → mutate in place → orchestrator `await db.SaveChangesAsync()` once |
| **Java / Spring + JPA** | persistence context | passed-in entities are managed → dirty-checking flushes at the `@Transactional` boundary (**+ explicit `repository.save(...)` for any *newly created* aggregate**) |
| **Python / SQLAlchemy** | `Session` unit of work | passed-in objects are session-tracked → orchestrator `session.commit()` once |
| **Elixir / Ecto** | `Repo.transact/2` + `with` | orchestrator (a context fn) builds changesets inline, `Repo.update`s each inside one transaction |
| **TS / Hono / Drizzle** | `db.transaction(async tx => …)` | no change-tracking → orchestrator calls **`repository.save(aggregate, tx)`** per passed-in aggregate inside the transaction |

(The audit was explicit: "return the mutated object" is **not** a
persistence strategy on a non-tracked ORM — the caller wouldn't know what
to `UPDATE`. The orchestrator, which holds the references, does the
explicit write.)

### Reading: the read-handle cost (the honest part)

A read-only query needs *a* read handle, so the `reading`/`mutating`
tiers are **not** zero-dependency statics on the OO backends — but the
read needs no transaction-sharing with the orchestrator, so the cost is
small and the coupling loose:

| Backend | Read shape inside the service | Cost |
|---|---|---|
| **Elixir / Ecto** | a context fn calling `Repo.get` / a query directly | **free** — `Repo` is a module, no injection; this is what contexts already do |
| **.NET / EF** | `AsNoTracking()` read via an injected read repo / `DbContext` | a DI'd service (or a read-port parameter) |
| **Java / JPA** | injected repo; `@Transactional(readOnly = true)` on the caller | a DI'd `@Service` bean (the `readOnly=true` flag is itself an idiom) |
| **Python / SQLAlchemy** | read via a `session` / read-port passed in | param-passed (Cosmic-Python calls this the service layer; Vernon calls it a fine domain service) |
| **TS / Hono / Drizzle** | `db.select(...)` via a read-port argument | a read-port parameter |

So the emission rule is: **pure → stateless static / module function
(no dependency, callable anywhere); reading / mutating → the declaration
gains a read handle** — an injected read-only repository on EF/JPA, a
read-port parameter on Drizzle/SQLAlchemy, the ambient `Repo` module on
Elixir. The mutation never needs a handle (it's on the passed-in
aggregate); only the read does.

### Read-your-own-writes (deferred edge case)

If a `reading` query must observe the orchestrator's *own uncommitted*
writes (it loaded and mutated `from`, then the service re-queries `from`),
the read must share the orchestrator's session/transaction — and the
tight coupling returns. **Default the `reading` tier to *independent
supporting data*** (price lists, tax tables, uniqueness checks — the
common case) and treat shared-transaction reads as a later, sharper
problem, not v1.

### Multi-aggregate transactions (the `transfer` case)

One transaction, two saves — the orchestrator loads both accounts, the
service mutates both, one commit persists both. This is what EF / Spring /
Drizzle samples do and is the pin.

> *Orthodoxy note:* the strict Cosmic-Python line is "one aggregate per
> unit of work; bridge to the second via a domain event." Loom pins the
> **pragmatic single-transaction** form for aggregates that must change
> atomically, and treats the event-driven form as the explicit-async
> alternative (workflows + `emit`), not the default.

### What the IR needs to carry

- `DomainServiceOperationIR.tier: "pure" | "reading" | "mutating"` —
  classified during lowering: calls a mutating op on an aggregate param ⇒
  `mutating`; else does a repository **read** ⇒ `reading`; else `pure`.
  Drives the caller gate (reading/mutating ⇒ orchestrator-only), the
  emission shape (read handle on the upper two), and the orchestrator's
  `save`-emission for mutated parameters.
- `OperationIR.mutating: bool` already exists — reused to classify
  whether a call into an aggregate operation makes the enclosing service
  `mutating`, and to drive the orchestrator's `save` for mutated params.

No `mutates`-set materialisation, no new `ExprIR.kind`; calls stay
`Call { callKind: "domain-service" }`.

## Criteria and retrievals — which tier

The existing predicate/query vocabulary maps onto the tiers by the same
rule (the predicate is pure; the repository access is what classifies):

| Construct | What it is | Tier when used in a service |
|---|---|---|
| **`criterion`** used *inline as a boolean* (over a passed-in aggregate/value) | pure Specification predicate | **pure** — no infra |
| **`criterion`** used to *drive a query* (`Repo.findAll(<Crit>)`, a `find … where <Crit>`) | the predicate is still pure; the `Repo.*` call is a read | **reading** — the query is the infra |
| **`retrieval`** run via `Repo.run(R(args), page?)` | a named query bundle (`where` + `sort` + `loads`) | **reading** — it *is* a repository read |
| `Repo.find` / `Repo.findAll` / `Repo.run` | the shipped read surface (today: workflow bodies) | **reading** — reused verbatim; no new query machinery |

So a criterion never moves the tier on its own — only the `Repo.*` access
does. The `reading` tier reuses the **already-shipped** `Repo.find /
findAll / run` surface (it just becomes legal inside a `reading`/`mutating`
service body, not only a workflow).

> **Surface gap to pin:** applying a criterion to a **named service
> parameter** (`HighValue` over an `order: Order` param, not an implicit
> `this` / loaded candidate) needs criterion candidate-binding —
> `criterion.md` lists `from <Criterion>(args)` parameter binding as *not
> yet shipped*. The *semantics* are pure-tier-clean; the *syntax* for
> "apply this criterion to that parameter inside a service body" is the
> small thing to land alongside the `reading` tier.

## `function` — let it do a bit more (companion change)

Today `FunctionDecl` is `function f(p): T = Expression` — a single
expression (it already admits `match`/ternary, just not statements,
`let`-bindings, or `throw`). Rev. 4 adds a **pure block body**:

```ddd
function lineTotal(l: Line): Money = l.qty * l.price        // unchanged — expression form

function shippingFor(cart: Cart, dest: Region): Money {     // new — block form
  let weight = cart.lines.sum(l => l.item.weight)
  if (dest.isDomestic) return weight * Rates.domestic
  return weight * Rates.international + cart.customsSurcharge
}
```

A block-body `function` stays **pure** — params only, no repository (not
even a read), no mutation, no `emit`/`extern`/`api`; `throw` / `require`
(bug regime) allowed. The expression form stays SQL-inlinable like a
`criterion`; the **block form is not queryable**. This keeps the ladder
crisp: `function` (pure; expression form inlinable) → `criterion` (pure,
queryable predicate) → `domainService` (reads, decides, mutates passed-in
aggregates). Full imperative statement bodies (assignment, loops) are
rejected.

## Validation (`src/ir/validate/checks/domain-service-checks.ts`)

**Kept:** `no-emit`, `no-extern`, `no-api-call`, `no-application-call`
(no workflow-start / handler call). **Revised / new:**

- `loom.domain-service.no-repo-write` — a domain service may not perform a
  repository **write** (`save`/`insert`/`update`/`delete`) or commit, in
  any tier. Reads are allowed (they classify the op as `reading`); writes
  are the orchestrator's job. *(Replaces rev. 3's blanket `no-repo`,
  which over-forbade reads.)*
- `loom.domain-service.infra-call-from-aggregate` — a `reading` or
  `mutating` service invoked from an aggregate `operation` / `create` /
  `destroy` / view body. Pure services exempt.
- `loom.domain-service.single-aggregate-warning` — unchanged soft anemic
  nudge.

The rev-1 `no-mutation` rule stays dropped (mutation of passed-in
aggregates is legal in the `mutating` tier).

## Per-backend emission

The **call** is the shared `ExprTarget` `domain-service` arm everywhere.
The **declaration** and the **orchestrator** persistence vary by tier and
backend:

| Backend | Pure declaration | Reading/mutating declaration | Orchestrator after a mutating call |
|---|---|---|---|
| **TS / Hono** | `src/domain/services/<name>.ts` namespace of pure fns | same, with a read-port arg | `repository.save(param, tx)` per mutated param in `db.transaction` |
| **.NET / EF** | `Domain/Services/<Name>.cs` `static class` | injected read repo (`AsNoTracking`) — DI'd service | one `SaveChangesAsync()` |
| **Java / JPA** | `static` utility class | `@Service` bean with injected repo | `@Transactional` flush; explicit `save` for new aggregates |
| **Python / SQLAlchemy** | bare module functions | functions taking a `session`/read-port | one `session.commit()` |
| **Phoenix / Ecto** | a context function | a context function calling `Repo` reads directly | inline changeset + `Repo.update` inside `Repo.transact` |

> **Elixir shape note (from the audit):** in plain-Ecto Phoenix the
> **context is the domain service + the repository**. A single-context
> service lowers to a *context function*, not a separate `Services`
> module; a standalone module is warranted only for *cross-context*
> orchestration. **Never wrap `Ecto.Repo` in a "repository port"** — the
> context calls `Repo` directly; tests isolate with `Ecto.Sandbox`.

## Phasing

1. **Shape A (pure)** — *shipped.* Recast the validator around the
   three-tier model (the new `no-repo-write` replaces the blanket
   `no-repo`).
2. **`reading` tier** — read-only repository access + the
   `infra-call-from-aggregate` caller gate + the read-handle emission
   (injected read repo on EF/JPA, read-port arg on Drizzle/Python, direct
   `Repo` on Elixir). No persistence wiring (read-only). Smallest blast
   radius; lands first.
3. **`mutating` tier** — the orchestrator `save`-emission for mutated
   parameters. Ship the **change-tracking** backends first (EF / JPA /
   SQLAlchemy: nearly free), then the **explicit** pair (Drizzle
   `repo.save(_, tx)`, Ecto inline-changeset + `Repo.transact`).
4. **`function` block body** — independent companion; any time.

## Research findings (five-backend idiom audit)

The pins are grounded in primary-source research per backend. The
read-only middle in particular is well-supported: a domain service that
**holds a repository to look something up** (uniqueness, policy/reference
data) is canonical — Vernon's own IDDD `AuthenticationService` is exactly
that (a repository-using domain-service *bean*); the contentious half of
Vernon was always the *writing*, which rev. 4 still forbids. Headlines:

- **Canonical line is at *writes*, not reads.** Evans/Vernon: a pure
  domain service receives materialised aggregates; a repository-holding
  one is still a domain service (as an injected bean) when it *reads* to
  decide. Cosmic Python (ch. 4) draws its stricter line at any
  repository/session use ("that's the service layer") — Loom follows
  Vernon for read-only, and notes the Cosmic-Python disagreement.
- **.NET / EF** — a repo-touching service can't be `static` (EF tracking
  needs the scoped `DbContext`); make it a DI'd service. Reads use
  `AsNoTracking`. Pure services may be static. ([MS Learn — app layer](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/microservice-application-layer-implementation-web-api),
  [EF Core persistence](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-implementation-entity-framework-core),
  [DI guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/guidelines))
- **Java / Spring + JPA** — repo-loading service is a `@Service` bean;
  `@Transactional(readOnly = true)` is the idiom for read-only;
  dirty-checking flushes managed entities at commit; **new** aggregates
  still need explicit `save`. ([Drotbohm — DDD & Spring](http://static.odrotbohm.de/lectures/ddd-and-spring/),
  [Vernon IDDD AuthenticationService](https://github.com/VaughnVernon/IDDD_Samples/blob/master/iddd_identityaccess/src/main/java/com/saasovation/identityaccess/domain/model/identity/AuthenticationService.java),
  [Baeldung — dirty checking](https://www.baeldung.com/java-hibernate-entity-dirty-check))
- **Python / SQLAlchemy** — Cosmic Python: the loading thing takes the
  UoW/session **as an explicit argument**; application owns `commit()`.
  ([Ch. 4 — Service Layer](https://github.com/cosmicpython/book/blob/master/chapter_04_service_layer.asciidoc),
  [Ch. 6 — Unit of Work](https://github.com/cosmicpython/book/blob/master/chapter_06_uow.asciidoc))
- **Elixir / Ecto** — the Phoenix **context** is the domain service +
  repository; read directly via `Repo`; standalone service module only
  for cross-context ops; **wrapping `Ecto.Repo` is an anti-pattern**;
  prefer `Repo.transact` + `with` over `Ecto.Multi` for static pipelines.
  ([Jurić — core module](https://medium.com/very-big-things/towards-maintainable-elixir-the-anatomy-of-a-core-module-b7372009ca6d),
  [Konidas — against Ecto.Multi](https://tomkonidas.com/repo-transact/),
  [ElixirForum — Repo outside contexts](https://elixirforum.com/t/using-repo-functions-outside-of-context-modules-anti-pattern/50314))
- **TS / Drizzle** — no change-tracking, so the orchestrator persists via
  `repository.save(entity, tx)` inside `db.transaction`, `tx` threaded as
  an argument (no DI container needed); reads are `db.select` via a read
  port. ([Drizzle transactions](https://orm.drizzle.team/docs/transactions),
  [Sentry — atomic repositories in TS](https://blog.sentry.io/atomic-repositories-in-clean-architecture-and-typescript/),
  [Stemmler — persisting aggregates](https://khalilstemmler.com/articles/typescript-domain-driven-design/aggregate-design-persistence/))

## Open questions

1. **Read-port shape vs. ambient handle.** For EF/JPA/SQLAlchemy/Drizzle,
   is the read exposed as an injected read-only repository / explicit
   read-port parameter, or an ambient request-scoped accessor (like the
   Python `ContextVar` already used for the current principal)? Lean
   read-port parameter for explicitness; ambient for the actor-style case.
2. **Drizzle `save` shape.** Full-row `UPDATE … SET` from `wireShape`
   (simple, deterministic) vs. existence-check create-or-update. Lean
   full-row.
3. **Read-your-own-writes.** Deferred (see above) — pin whether a
   `reading` query ever needs the orchestrator's session.
4. **`audited` on service operations.** Probably yes in a follow-up.
5. **Elixir single- vs cross-context classification.** Context-function
   vs standalone-module decided from the operation's parameter modules
   (single context ⇒ context fn).

## Decision summary

- **Three tiers** — `pure` (no infra, callable anywhere), `reading`
  (read-only repository queries, application-orchestrator-only),
  `mutating` (mutates the aggregates the orchestrator **passes in**,
  application-orchestrator-only). The tier line is *what kind of I/O*.
- **Writes and commits are never the service's** — `no-repo-write` in
  every tier; loading the *target* aggregates and the single commit live
  in the application orchestrator.
- **Read-only is the Vernon middle**: it has no commit problem and is
  canonical; its only cost is a read handle (a DI'd read repo on EF/JPA,
  a read-port arg on Drizzle/Python, the ambient `Repo` module on Elixir
  — free).
- **Persistence is orchestrator-owned, rendered idiomatically per
  backend**: implicit change-tracking on EF / JPA / SQLAlchemy; explicit
  `repository.save(_, tx)` on Drizzle and inline-changeset + `Repo.transact`
  on Ecto. The mutation set is the passed-in aggregates; nothing is
  returned to diff.
- **Multi-aggregate writes** use one transaction / multiple saves.
- **`function` gains a pure block body** (let + branch + bug-regime
  throw), staying non-queryable.
- Reuse `Call` + `callKind: "domain-service"`; the only new IR field is
  `DomainServiceOperationIR.tier`.
