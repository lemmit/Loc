# Domain services — the missing third construct (pinned design)

> Status: **proposal — pinned axes, v1 scope = Shape A.** Supersedes
> [`domain-service.md`](./domain-service.md) (the singular-form
> options-menu draft from #1041): keeps that doc's six-axis framework
> and three-shape vocabulary, but commits to a single answer on every
> axis and adds the grammar / IR / validator / emission / test spec the
> prior draft deferred. Companion to
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
> (the four-layer **domain / contract / application / api** map —
> `domainService` is a *domain*-layer construct, called from the
> *application*-layer orchestrators; see §"Layer placement" below),
> [`workflow-and-applier.md`](./workflow-and-applier.md) (workflows
> are one of three application-layer orchestrators),
> [`lifecycle-operations.md`](./lifecycle-operations.md)
> (aggregate-bound actions), [`criterion.md`](./criterion.md) (reusable
> predicates — see Axis 5), [`failure-taxonomy.md`](./failure-taxonomy.md)
> (error-placement; this proposal fills the row that doc left empty),
> and [`policies-supplementary-note.md`](./policies-supplementary-note.md)
> (which earmarks `policy` for authorization — see Axis 6).

## What changed vs. the superseded draft

The prior doc lays out the problem and the design space well — I'm not
re-litigating any of that here, only pinning answers and adding spec.

| Axis | Prior lean | This proposal | Why |
|---|---|---|---|
| 1 — mutation | A first, B fast-follow | **A in v1. B deferred to Phase 2 with explicit persistence contract.** | Confirmed. Shape B's mutation-by-reference + "who saves" contract deserves its own slice. |
| 2 — callers | Derived from Axis 1 | **Confirmed.** Pure calculators (v1) are callable from operations *and* workflows. Coordinators (v2) workflow-only. | Falls out of Axis 1. |
| 3 — infra strictness | 3a (strict) | **Confirmed.** No repo, no extern, no persistence. Hard error. | The slippery slope is real; (3b) collapses the construct into a short workflow. |
| 4 — errors | Mirrors operation/workflow two-regime | **Confirmed.** `throw` for bugs, `or`-union return for expected domain failures. Per `failure-taxonomy.md`. | Not really a choice. |
| 5 — criterion relationship | (5a) keep distinct, share the purity checker | **Confirmed**, with the rationale named: **criterion is queryable (inlines to SQL `where`); a domain service is not.** That's the line. | Surfacing the *why* makes the boundary teachable. |
| 6 — naming | leans `service` + validator nudge | **`domainService`** (multi-word keyword). | See §"Naming" below — disagrees with prior lean, narrowly, on cultural-overload + collision grounds. |

Two things the prior doc raised that this proposal adopts unchanged:

- **Anemic-domain guardrail** — validator *warning* on a
  single-aggregate domain service (it could just be an `operation` on
  that aggregate). The prior doc proposed this; I keep it. Domain
  services are the most over-used tactical DDD pattern; the nudge keeps
  people honest.
- **Shape C as the eventual north star, not v1.** The dependency-footprint-
  derives-the-layer move is the right *long-term* model, but adopting
  it prematurely would erode the operation/workflow clarity the rest of
  the language leans on. Recorded; not built.

## Layer placement (per `unfoldable-api-derivation.md`)

[`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
pins Loom on a four-layer model: **domain / contract / application /
api**, strictly one-directional. `domainService` is unambiguously a
**domain-layer** construct, alongside `aggregate`, `repository`,
`valueobject`, and `enum`. It is called from the **application
layer**, which under that proposal has three orchestrator kinds:

| Application orchestrator | Shape | Calls a `domainService`? |
|---|---|---|
| `commandHandler` | single-aggregate, mutating, sync | Yes |
| `queryHandler` | no mutation, sync | Yes (Shape A only — query handlers never persist) |
| `workflow` | cross-aggregate or stateful, may be async | Yes |

The Evans-style load-protocol — *orchestrator loads → domain service
receives materialised aggregates → orchestrator persists* — applies
uniformly across all three. This proposal's running examples use
`workflow` (the construct that exists today), but everywhere the
text says "workflow loads" / "workflow persists," read "the
application-layer orchestrator." Nothing in v1 changes when the new
`commandHandler` / `queryHandler` declarations land.

## The gap (recap for self-containedness)

| Loom construct | DDD role | Layer | Touches |
|---|---|---|---|
| `function` (expr-bodied) | helper | domain (pure) | params only |
| `criterion` | reusable predicate | domain (queryable) | params only |
| `invariant` | aggregate-local rule | domain | `this` |
| `operation` / `create` / `destroy` | aggregate behaviour | domain, **single-aggregate** | `this` (+ params) |
| `workflow` / `commandHandler` / `queryHandler` | use-case orchestration | application | repos, externs, many aggregates, transactions |
| **— missing —** | **domain service** | **domain, cross-aggregate** | domain objects passed in; **no infrastructure** |

The textbook case is `transfer(from, to, amount)`: not `from`'s
operation (touches `to`), not application orchestration (the rule
"can't overdraw" is *domain*), and `InsufficientFunds` has no authored
home today. The reusable-calculation case is `priceOrder(order,
customer, catalog)`: branches, throws, can't fit `function`'s
expression body. Both are what the new construct exists for.

## v1 scope: Shape A — the pure calculator floor

A `domainService` is a **module-level**, **stateless**, **named**
container of one or more **non-mutating** `operation`s. The operations
take domain objects (aggregates, value objects, criteria, primitives),
return a value or an `or`-union error, and may throw for bug-regime
violations. They cannot mutate the aggregates they receive.

```ddd
module Sales {
  domainService Pricing {

    operation quote(cart: Cart, customer: Customer): Money {
      require cart.lines.count > 0  "cannot quote an empty cart"   // bug regime
      return cart.subtotal - customer.tier.discount(cart.subtotal)
    }

    operation applyCoupon(price: Money, coupon: Coupon): Money or CouponExpired {
      if (coupon.isExpired)
        return CouponExpired { code: coupon.code }
      return price - coupon.discount
    }
  }
}
```

Callable from anywhere a pure expression is legal: aggregate
operations, workflows, other domain services, view bodies. It's safe
to put inside an aggregate `operation` because it cannot reach a *second*
aggregate's mutable state — the v1 contract forbids mutation outright.

### What v1 domain services **cannot** do (validator-enforced, phase ⑦)

| Forbidden | Diagnostic | Why |
|---|---|---|
| Call a repository (`findById`, `findAll`, `find where …`) | `loom.domain-service.no-repo` | Loading is the application's job (Evans, not Vernon). The orchestrator loads and passes in. |
| Call an `extern` function | `loom.domain-service.no-extern` | I/O is application's job. |
| Call an `api` (HTTP) endpoint | `loom.domain-service.no-api-call` | Same. |
| `start` a workflow / call a `commandHandler` / `queryHandler` | `loom.domain-service.no-application-call` | Inverts the layer arrow — domain cannot reach application. |
| `emit` an event | `loom.domain-service.no-emit` | Events are aggregate-bound or workflow-bound facts; a stateless service has no identity to attribute them to. |
| **Mutate an aggregate parameter** | `loom.domain-service.no-mutation` | v1 is Shape A. Calling a mutating `operation` on a parameter (one declared without `private?`, or whose body writes to `this`) is a hard error. Phase 2 (Shape B) lifts this with a persistence contract. |
| Declare fields | grammar-rejected | Stateless by definition. |

What it **can** do that `function` cannot: branch, bind locals,
`if`/`match`, throw domain errors, call other domain services, call
**non-mutating** operations on parameters (read accessors,
calculations).

The "no-mutation" check needs the lowered IR's classification of
operations as mutating vs read-only. That classification already exists
implicitly (operations whose body writes to `this`); making it explicit
on `OperationIR` is a small enabling change called out under
"Lowering" below.

### Errors

Mirrors aggregate operations exactly, per `failure-taxonomy.md`:

- **Bug regime** (`require`, invariant violation, impossible state):
  `throw`. Maps to 500 at the edge.
- **Expected domain failure**: return an `or`-union (`Money or
  CouponExpired`). Same shape as operation/workflow handlers.

No `Result<T, E>` wrappers; no new error machinery.

### Invocation

From an application-layer orchestrator (the common path — workflow
today, `commandHandler` / `queryHandler` once
[`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
lands):

```ddd
workflow PlaceOrder {
  create(cmd: PlaceOrder) {
    let customer = Customers.findById(cmd.customerId)
    let cart     = Carts.findById(cmd.cartId)
    let total    = Pricing.quote(cart, customer)             // ← service call
    let final    = Pricing.applyCoupon(total, cmd.coupon)?   // ? propagates CouponExpired
    let order    = Order.create(customer, cart, final)
    Orders.save(order)
  }
}
```

The shape is identical inside a `commandHandler` or `queryHandler`:
the orchestrator loads, hands materialised aggregates to the domain
service, the service decides/computes, the orchestrator persists (or
returns, for queries).

From an aggregate operation (also legal because v1 is pure):

```ddd
aggregate Order {
  operation reprice(catalog: PriceList) {
    let amount = Pricing.recalculate(this, catalog)   // ← service call, returns value
    this.total := amount
  }
}
```

## Phase 2 sketch: Shape B — coordinator (the `transfer` case)

Not v1. Captured here so the v1 design is forward-compatible.

A coordinator service may invoke mutating operations on the aggregates
it receives; the **calling workflow persists** them. Sketch:

```ddd
module Banking {
  domainService Transfer {
    operation run(from: Account, to: Account, amount: Money)
      : Transferred or InsufficientFunds {
      require amount > Money.zero  "amount must be positive"
      if (from.balance < amount)
        return InsufficientFunds { account: from.id, shortfall: amount - from.balance }
      from.withdraw(amount)   // mutates each aggregate via its OWN operation
      to.deposit(amount)
      return Transferred { from: from.id, to: to.id, amount }
    }
  }

  workflow MoveMoney {
    handle move(cmd: MoveMoney): Transferred or InsufficientFunds {
      let from = Accounts.required(cmd.from)
      let to   = Accounts.required(cmd.to)
      let r    = Transfer.run(from, to, cmd.amount)
      match r {
        Transferred t       => { save from; save to; return t }
        InsufficientFunds e => return e
      }
    }
  }
}
```

The **persistence contract** Phase 2 must pin (the question the prior
doc flagged and v1 sidesteps by forbidding mutation):

1. **Explicit-save (sketched above)** — the workflow names which
   aggregates to `save`. Clear; requires the workflow to know what the
   service mutated.
2. **Auto-save by signature** — mark mutated params (`from: Account
   mut`); the workflow auto-`save`s them. Terser; introduces a new
   parameter modifier.

This is a real decision, deserves its own slice, and gates Shape B
landing. v1 doesn't need it resolved.

Phase 2 also lifts the "callers" rule (Axis 2a): coordinator services
become **application-orchestrator-only** callers (workflow /
`commandHandler`) — calling one from inside an aggregate operation
would let an aggregate reach into a *different* aggregate's mutable
state, which is exactly the boundary domain services exist to
preserve. (`queryHandler` stays excluded — queries never mutate.)

## Naming — why `domainService` (disagreeing narrowly with the prior lean)

The prior doc leans `service` with a validator nudge. I land elsewhere.

| Candidate | Verdict |
|---|---|
| `function` | Already a pure expression-bodied calculation. Overloading loses the "no statements, no throw" invariant of `function`. (Axis 6 in prior doc — same conclusion.) |
| `policy` | Earmarked for authorization — see [`policies-supplementary-note.md`](./policies-supplementary-note.md). Also narrower than the concept needs. (Prior doc — same conclusion.) |
| `service` | **Prior lean.** Two problems with shipping it. *(a)* The keyword `service` is already used at `ddd.langium:366` for `ServiceConnectionSource` in deployable blocks; Langium can context-disambiguate by position, but the cost is a non-trivial grammar that makes a casual reader stop and check which `service` they're looking at. *(b)* In 2026 the bare word is culturally overloaded — microservices, app services, service workers, k8s services, dependency-injection "services." A domain service is none of those. The prior doc's "validator nudge" is, essentially, an admission that readers will guess wrong without help. |
| `domainService` | What this proposal picks. Multi-word-as-one-keyword is precedented (`valueobject`). Names the *layer* at the declaration site, which is half the point. No collision. The verbosity is the feature. |

This is genuinely a coin-flip; I'd not block on it. If the consensus
ends up being `service` + a `loom.service.naming-hint` validator, the
rest of this proposal is unaffected — change one token in the grammar
and one IR field name.

## Anemic-domain validator warning

Per the prior doc's open question #3: a `domainService` whose every
operation takes exactly one aggregate parameter is a code smell — the
behaviour could live on the aggregate itself. Validator emits
`loom.domain-service.single-aggregate-warning`: *"This service operates
on a single aggregate; consider declaring `operation <name>` on `<Agg>`
instead."*

Warning, not error — there are legitimate exceptions (a service whose
parameter list is a single aggregate plus several value-object policies
that you want grouped by service name rather than scattered on the
aggregate). The nudge defaults users toward the cleaner placement.

## Grammar additions (`src/language/ddd.langium`)

```
DomainService:
    'domainService' name=ID '{'
        operations+=DomainServiceOperation*
    '}';

DomainServiceOperation:
    'operation' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')'
    (':' returnType=TypeRef)?
    ( '=' body=Expression                     // expression shorthand
    | '{' stmts+=Statement* '}' );            // statement body
```

Module body rule gains `| domainServices+=DomainService`.

Member-call resolution (`Pricing.quote(...)`) is already covered by the
existing `MemberCall` rule; only the scope provider needs to know about
the new declaration kind (see "Lowering" below).

## IR additions (`src/ir/types/loom-ir.ts`)

```ts
export interface DomainServiceIR {
  kind: "domainService";
  name: string;
  module: string;
  operations: DomainServiceOperationIR[];
}

export interface DomainServiceOperationIR {
  name: string;
  params: ParamIR[];
  returnType: TypeRefIR;        // void if absent
  body: StmtIR[];                // expression shorthand lowers to `return expr`
  throws: ErrorRefIR[];
  mutating: false;               // v1 invariant; Phase 2 may flip
}
```

`BoundedContextIR` (and `LoomModel`) gains `domainServices:
DomainServiceIR[]`.

A new `ExprIR.kind` is **not** required — domain-service calls are
ordinary `Call` nodes with a new `callKind: "domain-service"`. Each
backend's `ExprTarget` (`src/generator/_expr/target.ts`) adds one arm.

**Enabling change:** `OperationIR` gains an explicit `mutating: bool`
flag (already implicit in the IR — set to true iff the body writes to
`this`). The "no-mutation" validator needs this surfaced; computing it
on the fly inside the validator is fine for v1, but exposing it cleans
up the eventual Phase 2 contract and is cheap.

## Lowering (`src/ir/lower/`)

A new sibling leaf `lower-domain-service.ts` per the per-declaration-
kind split (`lower-platform`, `lower-requirements`, `lower-capabilities`,
`lower-members`, …). Body lowering reuses `lower-stmt.ts` / `lower-expr.ts`
unchanged.

Call lowering: `MyService.opName(args)` resolves to `Call { callKind:
"domain-service", target: { service, op }, args }` in `lower-expr.ts`.
Resolution at lower time means backends never re-resolve (the
architectural payoff for phase ⑤'s complexity, called out in
`CLAUDE.md`).

Scope provider (`src/language/ddd-scope.ts`) gains a clause exposing
`DomainService` names at module scope, the same way `function` /
`criterion` names are exposed.

## Validation (`src/ir/validate/checks/`)

A new check leaf `domain-service-checks.ts` enforces the layering
invariant. Diagnostic codes match the table in §"What v1 cannot do":

1. `loom.domain-service.no-repo`
2. `loom.domain-service.no-extern`
3. `loom.domain-service.no-api-call`
4. `loom.domain-service.no-workflow-start`
5. `loom.domain-service.no-emit`
6. `loom.domain-service.no-mutation` — visiting the body, any `Call`
   whose `callKind` is `"operation"` *and* whose resolved target
   `OperationIR.mutating === true` is a hard error.
7. `loom.domain-service.single-aggregate-warning` — soft warning.

Existing checks (type checking, criterion typing, error-class
resolution, all-paths-return for typed bodies) apply unchanged — they
walk `StmtIR` and don't care about the enclosing construct.

## Per-backend emission

Slots into existing `PlatformSurface`; no backend sees a new IR
vocabulary, only a new owner of familiar shapes.

| Backend | Emission |
|---|---|
| **TS / Hono** | `src/generator/typescript/emit/domain-service.ts` emits `src/domain/services/<name>.ts` as an exported namespace of pure functions. `TS_TARGET.callKind["domain-service"]` → `${Service}.${op}(...args)`. |
| **.NET / EF** | `src/generator/dotnet/emit/DomainService.cs.ts` emits `Domain/Services/<Name>.cs` as `public static class <Name>`. `CS_TARGET` gets the same arm. No constructor (no repo injection — the absence is the layering, made physical). |
| **Phoenix** | `src/generator/elixir/domain-service-emit.ts` emits `defmodule App.Domain.Services.<Name>` — plain stateless module, no GenServer. `ELIXIR_TARGET` gets the same arm. |
| **React** | None. The frontend doesn't run domain logic. |

Byte-identical-output gate extends per `_expr/target.ts` convention
(PR #843): a new fixture under `test/generator/_expr/domain-service-call.test.ts`
pins each target's output for a fixed `Call` node.

## Tests (per `CLAUDE.md` §"Adding a language feature")

| Suite | Gates |
|---|---|
| `test/language/parsing/domain-service.test.ts` | Grammar parses both body forms; rejects fields. |
| `test/language/validators/domain-service.test.ts` | Negative tests for each of the six hard rules above + the soft warning. |
| `test/ir/lower/domain-service.test.ts` | Structural lowering + call-site `callKind` resolution. |
| `test/generator/typescript/emit-domain-service.test.ts` | Hono fixture. |
| `test/generator/dotnet/emit-domain-service.test.ts` | .NET fixture. |
| `test/generator/elixir/domain-service-emit.test.ts` | Phoenix fixture. |
| `test/platform/pipeline-layering.test.ts` | Existing — must continue to pass. |

Plus one `LOOM_TS_BUILD=1` and one `LOOM_REACT_BUILD=1` run.

## Open questions (carried over + new)

1. **Naming.** `domainService` vs `service` (Axis 6 — see §"Naming").
   Coin-flip. Whichever wins, the rest of the proposal stands.
2. **Phase 2 persistence contract.** Explicit-save (sketched) vs
   auto-save-by-`mut`-marker. Gates Shape B landing.
3. **`audited` modifier.** Aggregate operations and workflow handles
   support `audited`. Should `domainService` operations? Probably yes
   in v1.5 — cheap, same lowering as `operation audited`.
4. **Macros.** Worth confirming whether `stdlib/` macros (audit,
   softDelete, scaffold, crudish) want to emit domain services. Most
   likely not; leave the macro API surface alone in v1.
5. **Wire-shape relevance.** None. Domain services have no wire shape
   and are not addressable from outside. The `.loom/` bundle gains
   nothing.
6. **Composition.** Can `domainService A` declare a `domainService B`
   as a constructor-parameter for testability? v1 says no — they're
   stateless, just call `B.op(...)` directly. Revisit if testing
   patterns demand it.

## Decision summary

- **Adopt** the prior doc's six-axis framework. Pin axes 1, 2, 3, 4, 5
  per the table at the top.
- **Ship v1 = Shape A** (pure calculator, no mutation). Solves the
  reusable-calculation case immediately; sidesteps the persistence
  contract.
- **Defer Shape B** (coordinator, mutates passed aggregates) to Phase
  2; sketch its contract here so v1 is forward-compatible.
- **Defer Shape C** (unified function family, layer-inferred) as the
  north star; do not build.
- **Name it `domainService`** (narrowly disagreeing with the prior
  lean toward `service`).
- **Reuse `Call` + `callKind: "domain-service"`**; no new `ExprIR.kind`.
- **Surface `OperationIR.mutating`** as the enabling IR change for the
  no-mutation validator (cleans up Phase 2 contract too).
- **Add the anemic-domain warning** for single-aggregate services.
