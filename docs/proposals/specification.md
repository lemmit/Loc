# Specifications — parameterised predicates as the cross-aggregate domain rule

> Status: proposal. **Resolves D23** in
> [`implementation-plan.md`](./implementation-plan.md). Depends on
> [`payload-transport-layer.md`](./payload-transport-layer.md) (carrier
> generics + tagged unions) and
> [`exception-less.md`](./exception-less.md) (`or`-unions, `?`
> propagation). Adjacent to existing `docs/views.md` and
> `docs/workflow.md`.

## TL;DR

A **specification** is a named, parameterised predicate-or-set over
type `T`. One declaration; three uses (per the Specification Pattern
from DDD):

1. **Selection** — list values that match → drives UI dropdowns,
   admin list views, `<select>` options.
2. **Validation** — does this value match? → drives input checks at
   the api boundary; mismatch → typed error variant.
3. **Construction-to-order** — optional default value satisfying
   the spec → drives form-field pre-fill, default-arg synthesis.

```
specification ActiveCustomers of Customer {
  query: Customers.findActive()
}

specification SuppliersForOrderType(orderType: OrderType) of Supplier {
  query: Suppliers.canFulfill(orderType)
}

command PlaceOrder {
  customerId:  Customer id   from ActiveCustomers
  orderType:   OrderType
  supplierIds: Supplier id[] from SuppliersForOrderType(self.orderType)
}
```

The `from <Spec>(args)` binding on a parameter is what the
application layer auto-synthesises against — every value is checked
against the spec; UI options come from the spec; OpenAPI constraints
flow from the spec.

**This proposal replaces an earlier draft** that introduced a
`validator` + `service` pair. Both are subsumed:
- **Validator** (pure cross-aggregate check) → became `specification`
  with broader applicability (validation + UI + defaults from one
  declaration).
- **Service** (mutating cross-aggregate orchestration) → not a new
  construct. Loom already has `workflow`; this proposal extends it
  with **workflow-calls-workflow** and a `private workflow` modifier
  (reusing the existing `private` access modifier from
  `private operation` / `private invariant`).

## Why this matters

### The cross-aggregate domain rule problem

Many domain rules span aggregates without belonging to any single
one:

- "the listed suppliers can all fulfill this order type"
- "this customer is active"
- "the amount is within the customer's credit limit"
- "the current status allows this transition"

Today authors either:
1. Inline the rule in a workflow body — couples orchestration with
   the predicate; not reusable across workflows; can't drive UI.
2. Embed in aggregate operations — violates aggregate isolation
   (the op shouldn't load other aggregates).
3. Hand-write per-field UI options — duplicates the predicate in
   the frontend; goes out of sync.

A specification names the predicate once and the synthesised layers
(api, UI, OpenAPI) consume it consistently.

### Why this is the Specification Pattern (Evans / Vernon)

Evans's *Domain-Driven Design* and Vernon's *Implementing DDD*
both name this pattern. Evans defines a specification as
"a predicate that determines if an object does or does not satisfy
some criteria". The three uses (selection / validation /
construction-to-order) are the canonical taxonomy. Loom now has a
first-class language construct for it.

### What it composes, what it adds

A specification doesn't introduce new query primitives. It composes:
- **Views** (`docs/views.md`) — parameterless saved typed queries
- **Repository finds** — parameterised queries (`find <name>(args): T[]`)
- **`Repo.getById`** — single-aggregate lookup

The spec wraps these with: a name, an optional parameter list, and
the validation/UI metadata that turns them into a usable
domain-rule object.

## Surface

### Declaration

A specification lives in a context (alongside aggregates,
repositories, views, workflows):

```
context Sales {
  specification ActiveCustomers of Customer {
    query: Customers.findActive()
  }

  specification SuppliersForOrderType(orderType: OrderType) of Supplier {
    query: Suppliers.canFulfill(orderType)
  }

  specification ValidOrderAmount(customerId: Customer id) of decimal {
    check(amount: decimal): 0 < amount && amount <= Customers.getById(customerId).creditLimit
  }

  specification AllowedStatusTransition(currentStatus: OrderStatus) of OrderStatus {
    enumerate: match currentStatus {
      Draft     -> [Confirmed, Cancelled]
      Confirmed -> [Shipped, Cancelled]
      Shipped   -> []
      Cancelled -> []
    }
  }
}
```

Grammar shape:

```
specification <Name>(<Param>*) of <T> {
  query?:     <expression returning T[] — typed against repo finds / views>
  check?:     ( <var>: T ) : <bool expression>
  enumerate?: <expression returning T[] — literal list / match table>
  default?:   <expression returning T or none>
}
```

- At least one of `query`, `check`, `enumerate` must be present.
- `default` is optional; if absent, no default-value synthesis.
- Parameters use the same type vocabulary as anywhere else in Loom.

### The three forms

Three ways to describe a spec; pick whichever fits the rule:

| Form | When to use | UI consequence |
|---|---|---|
| `query:` | Set drawn from storage (parameterised find or view) | `<select>` populated by executing the query |
| `check(x):` | Continuous range / computed predicate / expensive enumeration | Field-level validation; UI renders freeform input with constraint hints in OpenAPI |
| `enumerate:` | Discrete set without storage backing (e.g., status-transition table from a `match`) | `<select>` populated from the literal expression |

Derivation rules — the validator infers missing forms when possible:

- Have `query` only → derive `check(x) = (x ∈ query.map(.id))` for
  aggregates, `(x ∈ query)` for primitives/VOs.
- Have `enumerate` only → derive `check(x) = (x ∈ enumerate)`.
- Have `check` only → enumeration is not derivable from an
  arbitrary predicate; UI renders freeform input.
- Multiple forms provided → compiler validates consistency
  (`loom.specification-inconsistent` if `check(x)` returns false
  for an element in `enumerate`).

### Binding to a parameter

The `from <Spec>(args)` syntax binds a parameter or field to a
specification:

```
command PlaceOrder {
  customerId:  Customer id    from ActiveCustomers
  supplierIds: Supplier id[]  from SuppliersForOrderType(self.orderType)
  amount:      decimal        from ValidOrderAmount(self.customerId)
}

operation transition(newStatus: OrderStatus from AllowedStatusTransition(self.status)): or InvalidTransition {
  self.status := newStatus
}
```

Rules:
- The bound parameter's type must match the spec's `of T` type
  (exact match; no implicit conversions).
- For array parameters (`Supplier id[] from <Spec> of Supplier`),
  the check runs per element.
- Spec args may reference other fields of the same command/op via
  `self.<field>`. Forward references are validator-checked
  (`loom.from-binding-cycle` if circular).

### Composition

A specification's body can reference other specifications:

```
specification PremiumCustomers of Customer {
  query: ActiveCustomers.query.filter(c => c.tier == Premium)
}

specification ApprovedSupplierForOrderType(orderType: OrderType) of Supplier {
  check(s: Supplier):
    SuppliersForOrderType(orderType).check(s) && ApprovedSuppliers.check(s)
}
```

Standard call semantics. Validator: cycle detection
(`loom.specification-cycle`).

## What the synthesised application layer does

For an api-auto-exposed operation (CRUD or workflow), the wrapper
runs:

```
1. Deserialise the command DTO from the request body.
2. Run `validate for X` on the payload (Phase 5 — field-level rules).
3. For each parameter / field with a `from <Spec>(args)` binding:
     a. Evaluate the spec's args (using the command/op's other fields).
     b. For each value of the bound parameter:
          - If the parameter type is an aggregate-id, load via Repo.getById
            (existing surface) — propagate NotFound if missing.
          - Evaluate the spec's `check` (derived or explicit) against the value.
          - On mismatch → return InvalidSpecMember { spec, paramName, id }.
4. Load any other aggregates implied by id-typed params (FK auto-derivation).
5. Call the aggregate operation / workflow.
6. Save.
7. Translate result variant to ProblemDetails (api-edge step).
```

Step 3 is what specifications add to the wrapper.

### Per-element loop for array parameters

`supplierIds: Supplier id[] from SuppliersForOrderType(orderType)`
lowers to:

```
for id in supplierIds:
  let s = Suppliers.getById(id)?    # NotFound if missing
  if !SuppliersForOrderType(orderType).check(s):
    return InvalidSpecMember {
      spec: "SuppliersForOrderType",
      paramName: "supplierIds",
      id: id
    }
```

`InvalidSpecMember` is a stdlib `error` payload — see "Error
shape" below.

### Where the validation injection runs

Specifications run **inside the synthesised wrapper** at the api
boundary. Workflow bodies that call other workflows or operations
**do not** re-run specs (already checked at the api boundary);
inside a workflow, the values are trusted.

Aggregate operations don't see specs at all — they only see
already-validated parameter values.

Authors who want to run a spec check explicitly (e.g., inside a
workflow body, against a value computed after the api wrapper ran)
can call the spec's `check` directly:

```
workflow updateOrder(cmd: UpdateOrderCommand) {
  let order = Orders.getById(cmd.orderId)?
  if !AllowedStatusTransition(order.status).check(cmd.newStatus) {
    return InvalidSpecMember { spec: "AllowedStatusTransition",
                               paramName: "newStatus",
                               id: cmd.newStatus }
  }
  order.transition(cmd.newStatus)?
}
```

But this is rare — usually the `from`-binding on the command field
covers it.

## Error shape

Spec mismatches lower to a single stdlib `error` payload:

```
# src/stdlib/payloads/errors.ddd
error InvalidSpecMember {
  spec: string         # spec name, e.g., "SuppliersForOrderType"
  paramName: string    # the bound parameter, e.g., "supplierIds"
  id: string?          # the offending id (if the value is an aggregate)
  value: string?       # the offending value's string form (if primitive)
}
```

Default status: 422 (validation-shaped). Authors override at the
api surface as with any other error:

```
api SalesApi from Sales {
  status InvalidSpecMember 400   # if you prefer 400 over 422
}
```

### Why one generic error, not per-spec

Per-spec error variants (`InvalidSuppliersForOrderType { id,
orderType }`) would be more specific but explode the variant count
linearly with spec count. The stdlib `InvalidSpecMember` carries
enough metadata for both the api client (knows which spec / which
field) and the UI (can display localised message keyed on spec
name).

Per-spec custom errors deferred to v2 if real use shows that the
generic form is insufficient.

## Constraints on specification bodies

| Form | Allowed | Not allowed |
|---|---|---|
| `query:` expression | Reference a parameterless view, a named repo find, or another spec's query | Inline aggregate construction; mutation forms; `emit` |
| `check(x):` expression | Read aggregate state (`x.field`, `x.method()` where method is read-only); call other specs' `check`; arithmetic; comparisons; `match`; `Repo.getById` for cross-aggregate state checks | Mutation; aggregate-op calls that mutate; `emit`; calls to workflows |
| `enumerate:` expression | Literal expression evaluating to `T[]`; `match` table; constant lookup | Mutation; non-deterministic expressions |
| `default:` expression | Read-only computation returning `T or none` | Mutation |

Validator: `loom.specification-impure` (ERROR) on any forbidden
form. Specifications are read-only by construction.

## Operation guards — the `when` clause (canCommand pattern)

A very common DDD pattern: every state-changing operation has a
paired pure predicate answering "can this run *right now* against
the current aggregate state?" Examples: `approve()` / `canApprove`,
`cancel()` / `canCancel`, `ship()` / `canShip`. Three consumers:

1. **Server-side guard** — gate the operation; on false, return a
   typed error instead of running.
2. **API query** — expose the predicate as a GET endpoint so the
   UI can ask without invoking the side-effecting operation.
3. **UI affordance** — the response drives button enabled/disabled
   state, tooltips ("Cannot approve: already shipped"), conditional
   rendering.

Today authors duplicate the predicate across the operation body
(as `precondition`) and a hand-written query method (for the UI).
They drift; the UI guesses at the rules. NakedObjects pioneered
the unified surface for this pattern (Pawson's framework was
generating button states from server-side predicates back in 2004);
Loom now has a first-class language construct for it.

### Surface — `when <predicate>` on operations

```
aggregate Order {
  status: OrderStatus
  rejected: bool

  # (1) Inline boolean expression — `self.` implicit (like invariants):
  operation cancel()
    when status != Shipped && status != Cancelled
  { status := Cancelled }

  # (2) Aggregate function — pure, reusable:
  function canApprove(): bool = status == Submitted && !rejected
  operation approve()
    when canApprove
  { status := Approved }

  # (3) Specification — with self auto-passed (see §"How `self`
  #     resolves in specifications" below):
  operation forceClose()
    when canApprove && CanForceClose
  { status := Closed }
}

specification CanForceClose of Order {
  check: self.status != Closed && currentUser.role == "manager"
}
```

The `when <expr>` clause sits after the operation's parameter list,
before the body. The compiler uses it in three places: the
synthesised api wrapper's server-side gate, the auto-exposed
can-query endpoint, and the UI form-generator's button-state hook.

### How `self` resolves in specifications

Specifications come in two declaration shapes, distinguished by
what `of <T>` names:

**Form A — spec over an aggregate type** (`of <Aggregate>`).
Inside the `check:` body, `self` is the aggregate instance being
checked. This mirrors how `invariant` / `function` / `derived` on
an aggregate see `self`:

```
specification CanForceClose of Order {
  check: self.status != Closed && currentUser.role == "manager"
}
```

At the `when` callsite, `self` is auto-passed — no parens needed
when the spec is used directly:

```
operation forceClose() when CanForceClose { ... }
```

For Form A specs that need additional explicit args, they sit
after `self` in the parameter list:

```
specification CanForceCloseBy(role: string) of Order {
  check: self.status != Closed && currentUser.role == role
}

operation forceClose()
  when CanForceCloseBy("manager")    # self implicit; "manager" explicit
{ ... }
```

**Form B — spec over a value type** (`of bool`, `of <Primitive>`,
`of <ValueObject>`). No implicit `self`; all args explicit:

```
specification HasManagerRole of bool {
  check: currentUser.role == "manager"
}

operation forceClose() when canApprove && HasManagerRole { ... }
```

Or with explicit args:

```
specification HasPermission(perm: Permission) of bool {
  check: currentUser.permissions.contains(perm)
}

operation forceClose()
  when canApprove && HasPermission(permissions.ordersForceClose)
{ ... }
```

**Value-specs with explicit `check(x: T)`** (the existing `from
<Spec>(args)` use case) use whatever parameter name the author
gives — no `self` involved, since those specs aren't bound to an
aggregate:

```
specification ValidOrderAmount(customerId: Customer id) of decimal {
  check(amount: decimal): 0 < amount && amount <= Customers.getById(customerId).creditLimit
}
```

### What can appear in a `when` expression

| Source | Example | Notes |
|---|---|---|
| Aggregate fields via `self` | `status == Submitted` | Bare names resolve to `self.<field>` (same as in `invariant`). |
| Aggregate functions | `canApprove` | Parameterless `function` on the same aggregate. |
| Aggregate `derived` fields | `isActive` | Same as field access. |
| Ambient context | `currentUser.role == "manager"` | Per `docs/auth.md`. |
| Form A specification | `CanForceClose` | `self` auto-passed. |
| Form B specification | `HasManagerRole` | No `self` arg. |
| Spec with extra args | `CanForceCloseBy("manager")` | Args supplied at callsite. |
| Composition | `canApprove && HasManagerRole` | `&&`, `\|\|`, `!` over any of the above. |

**Not allowed** in a `when` expression:

- ✗ Operation parameters (`when amount > 0` where `amount` is an op param). For arg-aware checks, use `from <Spec>(args)` on the parameter.
- ✗ Inline `Repo.getById(...)` calls. Keep cross-aggregate loads inside named functions or specs so the `when` expression stays declarative.
- ✗ Mutating expressions or side effects.

Validator: `loom.when-references-op-param` (ERROR);
`loom.when-inline-repo-load` (WARNING — discouraged but not banned).

### Auto-derived API endpoints

For each operation with a `when` clause, the api auto-exposes
two endpoints (in addition to today's `POST /aggregates/<agg>/{id}/<op>`):

| Endpoint | Behaviour |
|---|---|
| `POST /aggregates/<agg>/{id}/<op>` | (existing — augmented) Loads aggregate; evaluates `when` predicate; on false → 409 ProblemDetails (`NotAllowed`); on true → runs op + saves + returns result. |
| `GET /aggregates/<agg>/{id}/can-<op>` | (new) Loads aggregate; evaluates `when` predicate; returns `{ allowed: bool, reason?: string }`. No mutation. Same authorisation as the op. |

The kebab-case derivation: `approve` → `can-approve`, `forceClose`
→ `can-force-close`. Predictable.

### Response shape for `can-X`

```json
{ "allowed": true }
```

```json
{ "allowed": false, "reason": "CanForceClose" }
```

The `reason` field (when `allowed: false`) carries the **name of
the failing predicate sub-expression** — function name (`canApprove`),
spec name (`CanForceClose`), or `"inline"` for an inline expression.
For composed predicates (`canApprove && HasManagerRole`), reason is
the name of the first failing operand.

v1 keeps reason as a short identifier (string). UI consumers map it
to localised messages via their own catalogue. Richer per-predicate
reasons (e.g., explicit "rejected by manager" instead of
"HasManagerRole") deferred to v2 — author returns a structured
type instead of bool.

### Server-side error when the guard fails

When the operation is invoked and the `when` predicate is false,
the wrapper returns a typed error instead of running:

```
# Stdlib payload — src/stdlib/payloads/errors.ddd
error NotAllowed {
  operation: string         # e.g., "approve"
  aggregate: string         # e.g., "Order"
  id: string                # the aggregate id
  reason: string?
}
```

Default status: **409 Conflict** (resource state mismatch — REST
canonical for "system understood your request but the current
state doesn't allow it"). Authors override at the api surface as
usual:

```
api SalesApi from Sales {
  status NotAllowed 422   # if 422 reads better in this context
}
```

`NotAllowed` is distinct from:
- `precondition` violations → 500 (bug-shaped, env-aware exposure).
- `from <Spec>` mismatches → 422 (`InvalidSpecMember`, per-input).
- `requires` authorization failure → 403 (per `docs/auth.md`).

Different layers, different concerns. `NotAllowed` is "the
aggregate state doesn't allow this transition right now".

### UI form-generator integration

The React form-generator (and other UI generators) consume the
operation's `when` declaration:

- On render: fetch `GET /aggregates/<agg>/{id}/can-<op>`; bind the
  action button's `disabled` to `!allowed`; show `reason` as
  tooltip when disabled.
- On state change: re-fetch (optionally) to reflect updated
  aggregate state; e.g., after another field changes that the
  predicate depends on.
- For list views (table of N orders, each with action buttons):
  the can-query is parameterless w.r.t. op params, so one GET per
  row gives the button state. No per-cell form-filling needed.

This is the "list view of actions with greyed-out buttons" UX
that NakedObjects taught the field. Loom inherits the pattern
for free from one `when` declaration.

### What it composes with elsewhere

Mapping NakedObjects' canonical action-companion patterns to Loom:

| NakedObjects | Loom |
|---|---|
| `hide<Action>()` — should action appear? | v2 — defer (v1 UI defaults to render+disable); will likely be `when shown: <predicate>` if added |
| `disable<Action>()` — is action available right now? | **`when <predicate>`** (this section) |
| `validate<Action>(args)` — are these args valid? | `from <Spec>(args)` on each parameter (existing) |
| `default<Action>(args)` — what value pre-fills this arg? | `default:` clause on the bound spec (existing) |
| `choices<Action>(args)` — what values are allowed for this arg? | `query:` / `enumerate:` clause on the bound spec (existing) |

Action-level gate is new (`when`); per-arg facets were already
covered by spec bindings. The `when` clause is the missing piece
that completes the NakedObjects-style action affordance story.

### Constraints summary

- `when` runs *before* the operation body, *after* `validate for X`
  and per-arg spec checks, in the api wrapper's pipeline.
- `when` is **parameterless** w.r.t. op parameters — per
  NakedObjects' split. Per-arg checks use `from <Spec>(args)` on
  the parameters themselves.
- `when` reads `self` (aggregate fields/functions), `currentUser`
  (ambient), and any spec/function in scope.
- Form A specs (`of <Aggregate>`) auto-pass `self` at the `when`
  callsite; Form B specs (`of bool`) need explicit args.
- The auto-exposed `can-<op>` endpoint uses the same predicate —
  single source of truth across server-side gate, UI affordance,
  and OpenAPI documentation.

## Workflow-calls-workflow (related extension)

For reusable cross-aggregate orchestration that *mutates*,
specifications don't apply — they're read-only. The answer: a
workflow can call another workflow. Two extensions to today's
`docs/workflow.md` body vocabulary:

### New body form: workflow call expression

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

### `private workflow` modifier — reuse the existing convention

Loom already has `private` as an access modifier (per
`docs/language.md`):
- `private operation`: callable only from within the same aggregate
  root.
- `private invariant`: runs only in the domain `AssertInvariants()`
  floor.

Reusing the same modifier for workflows:
- `workflow X { ... }` (no modifier): public — auto-exposed by
  `api X from M` as `POST /workflows/<name>` (today's behaviour).
- `private workflow X { ... }`: not auto-exposed; callable only
  from other workflows in the same context.

Parallel to `private operation`: same word, same intuition.

### Transactional semantics for workflow-calls-workflow

| Caller | Callee declares `transactional`? | Result |
|---|---|---|
| Non-transactional | No | Callee saves per-aggregate (today's non-transactional default). |
| Non-transactional | Yes | Callee's own `transactional` activates: its body + saves run in one DB transaction. |
| `transactional` | No | Callee inherits the caller's transaction; all its operations + saves participate in the caller's atomic scope. |
| `transactional` | Yes | Callee's own `transactional` is a no-op (caller's transaction is already active); semantics unchanged. |

No nested-savepoint magic; single-level transaction lifetime per
top-level workflow call. Documented in `docs/workflow.md` extension.

## Auto-derivation summary — what authors don't write

For a command with three spec-bound parameters, the synthesised
api wrapper is ~30-40 lines (depending on backend). Authors write:

- The aggregate (own-state ops + invariants) — ~15 lines.
- The specifications — ~10 lines total for three specs.
- The `from` bindings on command parameters — 3 lines.
- The workflow (if any) — ~5 lines.

Synthesised by the generator (invisible to author):
- Per-spec validation loop per parameter (~6 lines per binding).
- FK existence checks (~2 lines per id-typed param).
- ProblemDetails translation at the api edge (~5 lines).
- OpenAPI schema fragments from each spec (~5 lines).
- UI input metadata (per-spec enumerate / range / default).

Net: ~30-40 lines of plumbing become 3 `from` lines + 3 spec declarations.

## Migration — from "validation inlined in workflow"

Common pattern today:

```
workflow placeOrder(cmd: PlaceOrderCommand) {
  precondition cmd.lines.length > 0
  let customer = Customers.getById(cmd.customerId)
  if !customer.active { raise CustomerInactive }
  let suppliers = []
  for id in cmd.supplierIds {
    let s = Suppliers.getById(id)
    if !s.canFulfill(cmd.orderType) { raise SupplierUnable }
    suppliers.push(s)
  }
  let order = Order.create({...})
  order.place(cmd.lines)
}
```

After this proposal — specifications carry the cross-aggregate
checks, the workflow shrinks dramatically (or disappears if api
auto-exposed CRUD covers the case):

```
# Extract specifications:
specification ActiveCustomers of Customer {
  query: Customers.findActive()
}

specification SuppliersForOrderType(orderType: OrderType) of Supplier {
  query: Suppliers.canFulfill(orderType)
}

# Bind on command fields:
command PlaceOrder {
  customerId:  Customer id   from ActiveCustomers
  orderType:   OrderType
  supplierIds: Supplier id[] from SuppliersForOrderType(self.orderType)
  lines:       OrderLine[]
}

# Workflow shrinks to orchestration (or disappears entirely):
workflow placeOrder(cmd: PlaceOrderCommand): OrderId or NotFound or InvalidSpecMember or OutOfStock {
  let order = Order.create({customerId: cmd.customerId, ...})
  order.place(cmd.lines)?
  return order.id
}
```

The specifications are reusable across operations on different
aggregates. The workflow body is trivial. The auto-exposed api
covers the case without explicit workflow if the orchestration is
"just create + call op + save".

## Hard parts

- **`query` expression typing**. Spec's `query:` references a view
  or named find — the compiler must resolve the return type and
  match against `of T`. Cross-context references go through scope.
- **`from <Spec>(args)` arg resolution**. Args bind from other
  command/op fields via `self.X`. Forward-reference cycle detection
  needed (`loom.from-binding-cycle`).
- **`enumerate:` for match-table specs**. Match expressions in
  Loom (per `docs/page-metamodel.md`) work over enums; the spec's
  enumerate clause uses the same shape.
- **Spec composition + cycles**. Spec A's body calls spec B's
  check. Validator detects cycles (`loom.specification-cycle`) at
  the IR level.
- **`check` against an aggregate's read-only state**. The
  predicate may load other aggregates via `Repo.getById`. Lowering
  pass injects these loads into the synthesised wrapper.
- **UI generator integration**. The Builder + generated React/Mantine
  forms read spec metadata (form, parameters, result type) to
  render the appropriate input. Touches the page-metamodel layer.

## Phasing

Single phase: **Phase Spec — Specifications + workflow-calls-workflow**.
Lands after exception-less A6 (validators-as-return-types in
upstream Phase 5; `?` propagation stable).

### Spec1 — Grammar + IR (~1 week)

- Grammar: `specification <Name>(<Param>*) of <T> { ... }` declaration;
  `from <Spec>(args)` clause on parameter and command-field types.
- IR: `SpecificationDeclIR`, `FromBindingIR` (on `Parameter` and
  `CommandFieldDecl`).

### Spec2 — Body lowering + purity (~1 week)

- Walker checks `query` / `check` / `enumerate` / `default` body
  constraints; rejects mutation, aggregate-op calls that mutate,
  emit, workflow calls (`loom.specification-impure`).
- Derivation rules: query↔check; enumerate↔check.
- Spec composition + cycle detection (`loom.specification-cycle`).

### Spec3 — Auto-injection at api wrappers (~1.5 weeks)

- Wrapper-synthesis lowering: per `from <Spec>(args)` binding,
  inject the loop + check + InvalidSpecMember return.
- Stdlib: `error InvalidSpecMember { spec, paramName, id, value }`.
- OpenAPI emission: include spec constraints as schema extensions.
- UI metadata: per-spec, expose enumerate/range/default for the
  Builder + form-generator.

### Spec4 — Per-backend emission (~1 week)

- TS / .NET / Phoenix render specification declarations as named
  functions (parameter list + return type + body).
- Auto-injection at api wrappers: per-backend, mechanical.
- UI consumer integration: React form-generator reads spec
  metadata; renders inputs accordingly.

**Spec total: ~4.5 weeks.**

### Workflow-calls-workflow extension (W1 — ~1 week)

Independent of Spec1-4; can ship before or after.

- Grammar: workflow-call expression in workflow body; `private`
  modifier on workflow declaration.
- IR: `WorkflowCallStmtIR` (sibling to existing workflow body
  statements); `isPrivate: boolean` on `WorkflowIR`.
- Validator: workflow-call cycle detection
  (`loom.workflow-cycle`); private-vs-public visibility checks.
- API auto-exposure: skip private workflows.
- Transactional inheritance: lowering pass handles the
  caller-callee transaction shape per the table in
  "Transactional semantics".

## Open questions

1. **Spec naming**: `specification` (full) vs `spec` (terse).
   **Pinned: `specification`** (matches Loom's "no abbreviations
   in keywords" convention; `view` / `aggregate` / `workflow`
   are all full).

2. **Spec body — can it call workflows?** Lean **no** — specs are
   pure-read-only; workflows mutate. Validator:
   `loom.specification-impure`.

3. **`from <Spec>(args)` syntax**: `from` vs alternatives
   (`in`, `via`, `: T satisfies Spec`). **Pinned: `from`** —
   reads naturally as "this parameter is drawn from the
   specified set".

4. **Per-spec custom error variants** (instead of generic
   `InvalidSpecMember`)? Deferred to v2.

5. **Specifications over composite types** (e.g., a spec over
   `(Customer id, decimal)` for "valid (customer, amount) pairs")?
   Probably yes via tuples or named records; left for spec syntax
   detail. v1 covers single-type spec.

6. **Spec invocation directly from workflow bodies** (not just
   via `from` bindings)? Yes — `Spec.check(value)` is a regular
   call expression. Useful for occasional checks against
   workflow-local values. Already supported by the general
   expression machinery; no special syntax.

7. **Auto-derivation of `default` from `query`** (first element,
   etc.)? Lean **no** — too many sensible defaults to pick;
   explicit `default:` clause when wanted.

8. **`private workflow` semantics for testing** — can tests
   directly invoke private workflows? Lean **yes** — testing surface
   is broader than api exposure; tests can call any workflow in
   the context. Same as `private operation` today.

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  carrier generics + tagged unions; spec's `check` returns `or
  InvalidSpecMember`.
- [`exception-less.md`](./exception-less.md) — `?` propagation;
  spec-mismatch error variant translates to ProblemDetails at the
  api edge.
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — specs
  may have `of Party` (an abstract aggregate) for polymorphic
  domain rules; resolution follows the aggregate-as-carrier
  projection rule.
- [`implementation-plan.md`](./implementation-plan.md) — Phase
  Spec + W1 fit after A6 / parallel to A7a.
- `docs/views.md` — specs reference views as their `query:` source.
- `docs/workflow.md` — gains workflow-call expression + `private`
  modifier (W1). Body vocabulary extended.
- `docs/language.md` §"Aggregate body" — `private operation` /
  `private invariant`; `private workflow` follows the same pattern.
- #466 — macro system; macros can inject `from <Spec>(args)`
  bindings on parameters (e.g., an `audited` macro adding a spec
  that checks `currentUser.permissions`).
