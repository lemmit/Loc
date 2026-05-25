# Domain services and validators

> Status: proposal. **Resolves D23** in
> [`implementation-plan.md`](./implementation-plan.md) ("auto-derivation
> of more application-layer behaviour"). Depends on the upstream
> [`payload-transport-layer.md`](./payload-transport-layer.md) (carrier
> generics + tagged unions) and
> [`exception-less.md`](./exception-less.md) (`or`-unions, `?`
> propagation, ProblemDetails translation). Sits alongside the existing
> `docs/workflow.md`.

## TL;DR

Loom today has aggregates (own-state mutation), workflows (cross-aggregate
orchestration with mutation, HTTP-exposed), and api auto-exposure (CRUD
wrappers). There's no clean place for **cross-aggregate domain logic that
isn't orchestration** — specifically:

- "Does this domain rule hold across these aggregates?" (a pure check)
- "Run this multi-aggregate domain logic" (mutating, but not a use-case
  worth exposing as a workflow)

This proposal adds two related constructs (one a subtype of the other):

- **`validator <name>(...): or <Error>`** — pure cross-aggregate
  domain rule check. Can load aggregates (read-only) and call other
  validators. Referenced from aggregate operations via `pre` clauses;
  inline-callable in workflows.
- **`service <name>(...): or <Result>`** — full domain service. Can do
  everything a validator can plus call aggregate operations (mutate)
  and emit events. Called from workflow bodies; not eligible for `pre`
  clauses (would mutate before potential op failure).

Both lift into the synthesised application layer (api CRUD wrappers
and explicit workflow bodies) via the existing `?` propagation
machinery. **Validator is a subtype of service** in the type-theoretic
sense — it satisfies every contract a service does, plus extra
constraints (pure, no mutation, no events).

The net effect: cross-aggregate domain rules become declarative
(`pre suppliersCanFulfill(orderType, supplierIds)` on the op), and
authors only write an explicit workflow when orchestration genuinely
needs control flow + transactions across multiple operations.

## Why this matters

### Today's pain

When an aggregate operation's correctness depends on a domain rule
spanning other aggregates ("the listed suppliers can fulfill the
order type", "the customer is active", "the warehouse has capacity"),
authors have three options today, all bad:

1. **Inline the check in a workflow.** Mixes orchestration (load, save,
   transaction) with domain logic (the rule itself). The rule isn't
   reusable across operations that need it; copy-paste between
   workflows.
2. **Pre-load and pass primitives to the aggregate.** The workflow
   pre-computes booleans / values and passes them; the aggregate just
   trusts them. The domain rule is implicit and easy to bypass.
3. **Pass other aggregates as parameters.** Aggregate-isolation
   violation; the receiving aggregate can mutate the parameter, call
   its operations, etc.

None of these are DDD-clean. Evans's *Domain-Driven Design* introduces
**Domain Services** for exactly this case: domain logic that doesn't
fit inside a single aggregate. Loom needs the construct.

### The validator subset

Within domain services, the **pure, read-only** subset (validators)
has a distinct role: it's safe to invoke as a precondition on an
operation. A non-pure service can't be — running a mutating service
"before" an operation that then fails leaves partial state.

So both constructs earn their place:
- Validators for declarative `pre` clauses (the common case).
- Services for "domain logic that mutates but isn't a HTTP-exposed
  use-case".

## Validator — the pure case

### Declaration

```
context Sales {
  validator suppliersCanFulfill(orderType: OrderType, supplierIds: Supplier id[]): or SupplierUnable {
    let suppliers = Suppliers.getMany(supplierIds)?    # NotFound propagation up to caller
    for s in suppliers {
      if !s.canFulfill(orderType) {
        return SupplierUnable { supplierId: s.id, orderType: orderType }
      }
    }
    # implicit success — no return statement reaches the end
  }
}
```

### Constraints (validator-enforced inside the body)

| Allowed | Not allowed |
|---|---|
| Read aggregate state (`s.canFulfill(...)`, `s.fieldName`) | ✗ `s.opThatMutates(...)` |
| `Repo.getById` / `Repo.getMany` / `Repo.<find>` (read-only) | ✗ `Repo.save(...)` (no save surface in repos anyway) |
| Call other validators (`?`-propagable) | ✗ Call services |
| Compose with `if` / `for` / `let` / `match` / arithmetic | ✗ Call aggregate operations |
| Return success implicitly or a typed `error` variant | ✗ `self.field := value` (validators don't have `self` anyway) |
| Pattern-match on payload unions | ✗ `emit Event { ... }` |

Validator: `loom.validator-impure` (ERROR) on any forbidden form. Pure
in the FP sense — same inputs, same output, no side effects.

### Parameter shape

Validators take primitives, ids, value objects, and payloads —
anything the carrier bound (`: carrier`) admits. They do **not** take
loaded aggregate handles (that would tempt callers to mutate via the
handle):

```
# OK:
validator x(orderType: OrderType, supplierIds: Supplier id[]): or Foo { ... }
validator y(amount: Money, currency: Currency): or Bar { ... }

# Allowed but unusual — validator takes the loaded aggregate as `self`
# for own-state inspection (no mutation; the aggregate is read-only here):
validator z(self: Order): or InvalidLineCount {
  if self.lines.length == 0 {
    return InvalidLineCount { orderId: self.id }
  }
}
```

The `self` form is the one case where a loaded aggregate enters a
validator. Useful for validators tightly bound to a single aggregate's
shape but still cross-cutting (e.g., reused across multiple operations
on the same aggregate).

### Calling validators

Three call sites, all using the same expression syntax:

```
# (1) Inside another validator body — composition:
validator orderInputsValid(orderType: OrderType, supplierIds: Supplier id[], customerId: Customer id): or SupplierUnable or CustomerInactive {
  suppliersCanFulfill(orderType, supplierIds)?       # ?-propagable
  customerActive(customerId)?
}

# (2) Inside a workflow body:
workflow placeOrder(cmd: PlaceOrderCommand): OrderId or NotFound or SupplierUnable or OutOfStock {
  suppliersCanFulfill(cmd.orderType, cmd.supplierIds)?    # inline call
  let order = Order.create({...})
  order.place(cmd.orderType, cmd.supplierIds, cmd.lines)?
  return order.id
}

# (3) Via `pre` clause on an aggregate operation (declarative):
aggregate Order {
  operation place(orderType: OrderType, supplierIds: Supplier id[], lines: OrderLine[]): or OutOfStock
    pre suppliersCanFulfill(orderType, supplierIds)
  { ... }
}
```

In (3), the `pre <validator>(args)` is a **call expression** with the
operation's parameters in scope (and `self` if the op is on an
existing aggregate instance). The synthesised application layer
injects the call at every call site of the op — see "Synthesis"
below.

### Reusability via parameter shape

The validator's parameter types are the **canonical domain shape**
for the rule. Operations that want the validator just need to name
their parameters compatibly:

```
# Multiple operations across different aggregates can reuse the same validator:
aggregate Order {
  operation place(orderType: OrderType, supplierIds: Supplier id[], lines: OrderLine[]): or OutOfStock
    pre suppliersCanFulfill(orderType, supplierIds)
  { ... }
}

aggregate Quote {
  operation generate(orderType: OrderType, supplierIds: Supplier id[]): or PricingFailed
    pre suppliersCanFulfill(orderType, supplierIds)
  { ... }
}
```

Standard function-call semantics. If parameter names differ, the call
expression makes the mapping explicit:

```
aggregate Order {
  operation reissue(newType: OrderType, suppliers: Supplier id[]): or ReissueFailed
    pre suppliersCanFulfill(newType, suppliers)     # name mapping in call
  { ... }
}
```

## Service — the full case

### Declaration

```
context Sales {
  service distributeOrderLines(orderId: Order id, splits: SupplierSplit[]): or NoSplitAvailable {
    let order = Orders.getById(orderId)?
    for split in splits {
      let supplier = Suppliers.getById(split.supplierId)?
      if !supplier.canReserve(split.lines) {
        return NoSplitAvailable { supplierId: supplier.id, lines: split.lines }
      }
      let allocation = Allocation.create({orderId, supplierId: supplier.id, lines: split.lines})
      supplier.reserveCapacity(split.lines)?       # mutates Supplier via op
    }
  }
}
```

### Constraints (looser than validator)

| Allowed | Not allowed |
|---|---|
| Everything a validator can do | — |
| Call aggregate operations that mutate (`supplier.reserveCapacity(...)`) | ✗ Direct `self.field := value` (services don't have `self`) |
| Call other services (`?`-propagable) | ✗ Call workflows |
| Emit events | ✗ Have own `transactional` semantics — see below |
| Construct new aggregate instances (`Allocation.create(...)`) | ✗ Be HTTP-exposed directly (wrap in workflow) |

Validator: `loom.service-cannot-call-workflow` (ERROR) if a service
calls a workflow. Cyclic dependency hazard; workflows orchestrate
services, not the other way around.

### Transaction semantics

Services don't have their own `transactional` annotation — the
**enclosing workflow** owns the transaction scope (per `docs/workflow.md`).
If a workflow is `transactional`, every aggregate operation and
service call inside it participates in the workflow's transaction.
Services declared independently of any workflow execute under
whatever transaction the caller establishes (or none, if non-transactional).

This keeps the transaction surface in one place: workflows. Services
are domain logic, not technical wiring.

### Calling services

```
# (1) Inside another service body:
service applyTaxAndDistribute(orderId: Order id, taxRate: decimal, splits: SupplierSplit[]): or NoSplitAvailable or InvalidTaxRate {
  applyTaxToOrder(orderId, taxRate)?
  distributeOrderLines(orderId, splits)?
}

# (2) Inside a workflow body:
workflow placeOrder(cmd: PlaceOrderCommand): OrderId or NotFound or NoSplitAvailable or OutOfStock or SupplierUnable {
  suppliersCanFulfill(cmd.orderType, cmd.supplierIds)?    # validator call
  let order = Order.create({...})
  order.place(cmd.orderType, cmd.supplierIds, cmd.lines)?
  distributeOrderLines(order.id, cmd.splits)?              # service call
  return order.id
}
```

Services are **not** eligible for `pre` clauses on operations — see
next section.

## `pre` clauses — validators only, never services

The `pre <name>(args)` slot on an aggregate operation is a declarative
"run this before the operation; if it fails, propagate the typed
error; otherwise run the operation". Sequencing is only safe if the
pre-check is **side-effect-free**:

```
aggregate Order {
  operation place(orderType: OrderType, supplierIds: Supplier id[], lines: OrderLine[]): or OutOfStock
    pre suppliersCanFulfill(orderType, supplierIds)    # ✓ validator — pure, safe
    pre customerActive(self.customerId)                # ✓ another validator
    pre applyTaxToOrder(self.id, ...)                  # ✗ service — would mutate even if op fails
  { ... }
}
```

Validator: `loom.pre-requires-validator` (ERROR) if a service appears
in a `pre` slot.

Services that need to run before an operation belong in a workflow
body, where the author can sequence them with explicit transactional
semantics and rollback on failure:

```
workflow placeOrderWithTax(cmd: PlaceOrderCommand): OrderId or ... transactional {
  applyTaxToOrder(cmd.orderId, cmd.taxRate)?    # service — explicit, transactional rollback if subsequent fails
  let order = Order.create({...})
  order.place(...)?
  return order.id
}
```

The transaction scope guarantees the service's mutations roll back if
the subsequent `place` fails.

## Synthesis — what the application layer derives

For an aggregate operation with one or more `pre <validator>(args)`
clauses, the synthesised application-layer wrapper (api auto-exposed
CRUD route) does:

```
1. Deserialise command DTO
2. Run `validate for X` on the payload  (upstream Phase 5 — field-level)
3. Load aggregate (Repo.getById, propagate NotFound)
4. Load related aggregates implied by Customer id-typed params (FK auto-derivation)
5. For each `pre <validator>(args)` on the op, IN DECLARATION ORDER:
     - Evaluate `args` (mix of cmd-derived params, self fields)
     - Invoke validator
     - If error variant, propagate to wrapper's signature; stop here
6. Call the aggregate operation
7. Save
8. Translate result variant to ProblemDetails (api-edge step from exception-less.md)
```

The wrapper's signature is the union of:
- `NotFound` (from FK auto-derivation)
- Every validator's error variants (each `pre` contributes)
- The op's own typed return

ProblemDetails translation at the api edge then maps each error
variant to its HTTP status via the api's `status` mapping +
generator-side stdlib defaults.

### Auto-injection at every call site

The synthesised wrapper isn't the only place a `pre` clause's
validator runs. **The validator is injected at every call site of
the op**, including:

- Workflow bodies that call `order.place(...)` directly.
- Other aggregate operations that call sibling operations.
- Any future call surface that invokes the op.

This makes the `pre` clause part of the operation's contract, not
just a wrapper-side adornment. Authors can't bypass the precondition
by calling the op via a different code path. The lowering pass
expands every `agg.op(args)` call to:

```
# Source:
order.place(orderType, supplierIds, lines)?

# Lowered (when `place` has `pre suppliersCanFulfill(orderType, supplierIds)`):
suppliersCanFulfill(orderType, supplierIds)?
order.place(orderType, supplierIds, lines)?
```

Idempotent and predictable. If multiple call sites bind the validator
slot to the same arguments, the validator runs once per call (no
memoisation in v1).

## Interaction with the rest of the stack

### Aggregate operations

Aggregate ops keep their existing constraints: own-state only, no
cross-aggregate loads. The `pre` slot is the only path for an op to
reference a cross-aggregate domain rule. Inside the op body, only
own-state checks (via `precondition Expr` for guards / `if !X return
E` for designed business outcomes) apply.

### `validate for X` (Phase 5 — field-level)

Distinct construct. Two complementary roles:

| | `validate for X { ... }` | `validator <name>(...)` |
|---|---|---|
| Scope | Single-instance, field-level | Cross-aggregate domain rule |
| Loads other aggregates? | No | Yes (read-only) |
| Return | `X or ValidationError[]` (accumulating) | `or <DomainError>` (typically one variant) |
| Trigger | Implicit at command/payload deserialisation | Explicit `pre` on op or inline call in workflow |
| Example | `quantity > 0`, `email matches regex` | "suppliers can fulfill this order type" |

Both run in the synthesised application layer (steps 2 and 5 above);
they don't replace each other. `validate for X` is the
"well-formedness sieve" at the wire boundary; `validator` is the
"domain rule" check inside the domain.

### Workflows

Existing workflows (per `docs/workflow.md`) gain two additional
forms in their body vocabulary:

| Form | Meaning |
|---|---|
| `<validator>(args)?` | Inline validator call; `?`-propagates the error variant |
| `<service>(args)?` | Inline service call; `?`-propagates the error variant; the service may mutate via its aggregate-op calls |

No new keywords in the workflow surface — both are regular
function-call expressions. The validator/service marker on the
declaration determines what's legal inside the body.

### API auto-exposure

The api layer auto-exposes:
- Aggregate CRUD (existing): now consults `pre` clauses on each op.
- Repository finds (existing): unchanged.
- Workflows (existing): unchanged.
- **Validators / services — NOT auto-exposed**. Authors who want
  HTTP-callable domain logic wrap it in a workflow. This keeps the
  HTTP-vs-domain layering clean.

### Macros

Macros that inject cross-cutting concerns (`audit`, `softDelete`, etc.)
can now also inject `pre <validator>` clauses on operations. E.g., an
`authorize` macro adding `pre actorHasPermission(actor, "x.write")`
to every operation in its scope. The macro stdlib + new `pre` slot
compose cleanly; no changes needed to the macro mechanism (see #466).

### Views

Views are read-only queries. They could reference validators (also
read-only), e.g., a view that filters customers based on a domain
rule. Out of scope for v1 — flag as v2 if the use case surfaces.

## Migration — from "all in workflows" to declarative `pre`

Common pattern today:

```
workflow placeOrder(cmd: PlaceOrderCommand) {
  precondition cmd.lines.length > 0
  let customer = Customers.getById(cmd.customerId)
  if !customer.active { raise CustomerInactive }
  let suppliers = Suppliers.getMany(cmd.supplierIds)
  for s in suppliers {
    if !s.canFulfill(cmd.orderType) { raise SupplierUnable }
  }
  let order = Order.create({...})
  order.place(cmd.lines)
}
```

After this proposal — the validators carry the cross-aggregate
checks, the workflow becomes trivial (or the api auto-exposure
covers it entirely):

```
# Extract validators:
validator customerActive(customerId: Customer id): or CustomerInactive {
  let c = Customers.getById(customerId)?
  if !c.active {
    return CustomerInactive { customerId: customerId }
  }
}

validator suppliersCanFulfill(orderType: OrderType, supplierIds: Supplier id[]): or SupplierUnable {
  ...
}

# Attach via pre:
aggregate Order {
  operation place(orderType: OrderType, customerId: Customer id, supplierIds: Supplier id[], lines: OrderLine[]): or OutOfStock
    pre customerActive(customerId)
    pre suppliersCanFulfill(orderType, supplierIds)
  { ... }
}

# Workflow shrinks to orchestration; api auto-exposure may not even need it:
workflow placeOrder(cmd: PlaceOrderCommand): OrderId or NotFound or CustomerInactive or SupplierUnable or OutOfStock {
  let order = Order.create({customerId: cmd.customerId, supplierIds: cmd.supplierIds, orderType: cmd.orderType})
  order.place(cmd.orderType, cmd.customerId, cmd.supplierIds, cmd.lines)?
  return order.id
}
```

The validators are reusable (across operations, across aggregates).
The workflow body is trivial enough that the api auto-exposed
`Order.place` route might cover the use case entirely without the
explicit workflow.

## Hard parts

- **Auto-injection at every call site**. The lowering pass must
  expand `agg.op(args)?` into `validator1(args)?; validator2(args)?;
  ...; agg.op(args)?` at every call site, in declared order.
  Threads through `src/ir/lower.ts` operation-call lowering.
- **Argument expression scope**. `pre <validator>(args)` lives at the
  operation declaration; its argument expressions must resolve
  against the op's parameter scope + `self` (for instance ops). Scope
  resolver needs to handle this.
- **Validator purity enforcement**. The validator-body walker must
  reject every disallowed form (`loom.validator-impure`). Includes
  detecting mutating expression shapes via the IR's existing
  mutation-tracking.
- **Service-vs-workflow cyclic dependencies**. Services can't call
  workflows, but can call services. Validator: detect cycles in the
  service-call graph and reject (`loom.service-cycle`).
- **`pre`-clause ordering matters** (each gates the next). Reflect
  this in the lowering and document for authors.

## Phasing

Single phase: **Phase S — Services and validators**. Lands after
exception-less A6 (validators-as-return-types in upstream Phase 5).

**S1 — Grammar + IR (~1 week)**
- `validator` and `service` keywords; declaration syntax.
- IR: `ValidatorDeclIR`, `ServiceDeclIR` (or a unified
  `CallableDeclIR` with a `purity: 'pure' | 'mutating'` flag).
- `pre <name>(args)` clause on `AggregateOperationDecl`.

**S2 — Body lowering (~1 week)**
- Walker checks the purity constraints for validator bodies.
- Service body allows everything a workflow body allows except
  workflow calls and `transactional`.
- `?` propagation rules from exception-less.md apply unchanged.

**S3 — Synthesis (~1.5 weeks)**
- Lowering pass: at every call site of `agg.op(args)`, inject the
  op's `pre <validator>(args)` calls in order.
- Auto-exposed api wrappers consume the injected validators.
- Workflow bodies that inline-call validators / services work
  unchanged (already supported as function calls).

**S4 — Cross-backend emission (~1 week)**
- TS / .NET / Phoenix all already render function-shaped declarations
  for workflows. Validators and services are similar — render as
  named functions with the same parameter / return-type machinery.
- Auto-injection at call sites: per-backend; mechanical.

Total: ~4.5 weeks. Independent of the find-variant migration (A4);
can ship before or after.

## Open questions

1. **Naming**: `validator` and `service` are clear; alternatives
   considered (`check`/`rule`/`policy`) were less precise. **Lean
   keep**.
2. **Should validators accept `self: Aggregate` for own-aggregate
   inspection?** Lean **yes** — useful for "validator tied to one
   aggregate's shape, reused across that aggregate's ops". Read-only.
3. **Should `pre` clauses also accept inline boolean expressions
   (not just validator calls)?** E.g., `pre amount > 0 else
   BadAmount`. Lean **no** — that's what `precondition` (throws) or
   the existing aggregate-op `requires X is E` sugar (typed) are for.
   `pre` reserved for named validators.
4. **Cyclic validator/service calls**: detected and rejected
   (`loom.service-cycle`)? Lean **yes** — keep call graphs DAG-shaped.
5. **HTTP exposure of validators / services**: any path? Lean
   **no** — wrap in a workflow for HTTP. Keeps domain-vs-application
   layering crisp.
6. **Visibility / access modifiers (public/private)**: today
   workflows are all-public via api auto-exposure. Validators / services
   are domain-internal by default; not exposed. **Lean public for
   intra-context use, no HTTP path**. v2 adds `public` / `private`
   markers if needed.
7. **Macro composition with `pre` clauses**: macros can inject `pre`
   slots. Order between macro-injected and author-written: macros
   inject *before* author clauses (so `audit` runs even if a
   subsequent author validator fails). Confirmation needed; the
   alternative (after) means `audit` doesn't fire when an earlier
   validator rejects, which might be the intended behaviour.

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  carrier generics + tagged unions; the `error` keyword used by
  validator/service return types.
- [`exception-less.md`](./exception-less.md) — `?` propagation;
  ProblemDetails translation at api edge consumes validators'
  error variants.
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — state
  layer; validators can read across inheritance hierarchies (a
  validator on `Party id` works for `Customer`, `Supplier`, etc.
  variants).
- [`implementation-plan.md`](./implementation-plan.md) — Phase S
  fits between A6 and A7a in the exception-less track.
- `docs/workflow.md` — workflow body vocabulary extended (inline
  validator + service calls). No breaking change to existing
  workflows.
- `docs/architecture.md` — context-level domain layer now contains:
  aggregates, repositories, workflows, views, **validators**,
  **services**.
- #466 — macro system; macros can now inject `pre` clauses.
