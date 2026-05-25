# Type-system family — orientation

> Read this first. The full proposals total ~3000 lines; this is the
> 10-minute version. Each section points at the doc that owns the
> detailed design.

## What this body of work changes

Loom's type system is reshaped along two parallel axes — **state**
(aggregates) and **transport** (payloads) — plus a coherent
**exception-less flow** built on top, plus **specifications** for
the cross-aggregate domain rule layer (Specification Pattern).
Together these resolve five real pain points:

1. **No generic payloads** — no `T page`, no `T envelope`, no way to
   compose response shapes. Forces per-aggregate macros for every
   common pattern.
2. **Throws everywhere** — `not found`, validation, parse errors all
   throw; every backend's route emitter is a try/catch tower; error
   shape is hidden in operation signatures.
3. **No aggregate inheritance** — `Customer is-a Party` requires
   copy-paste fields across every concrete or a macro per pattern.
4. **No declarative cross-aggregate rules** — "active customer" or
   "supplier that can fulfill X" can't be expressed once and reused
   by both validation and UI; today the rule's split across workflow
   bodies (validation) and hand-written frontend code (option lists).
5. **Optional-vs-nullable confusion** — `T?` covers nullable, but
   there's no clean way to model "value or not supplied" without
   ad-hoc conventions.

## The five proposals

```
                ┌─ aggregate-inheritance.md ─┐
                │   (state layer)            │
                │   abstract aggregates       │
                │   shared / own storage      │
                └─────────────────────────────┘
                              │
                              ▼ sibling
                ┌─ payload-transport-layer.md ─┐
                │   (transport layer)          │
                │   payload + sugar keywords   │  ←┐
                │   carrier-bounded generics    │   │
                │   named + anonymous unions    │   │
                │   ML-postfix syntax           │   │
                └────────────────────────────────┘   │
                              │                      │
                              ▼ consumes             │
                ┌─ exception-less.md ──────────────┐ │
                │   error payloads (HTTP-blind)    │ │
                │   option ML-postfix sugar         │ │
                │   ? propagation operator          │ │ depends
                │   Repo.getById → T or NotFound    │ │ on
                │   aggregate / workflow / api       │ │
                │   ProblemDetails at api edge       │ │
                └──────────────────────────────────┘ │
                              │                      │
                              ▼ consumes             │
                ┌─ specification.md ────────────────┐ │
                │   specification <Name>(args) of T │─┘
                │   query / check / enumerate forms  │
                │   `from <Spec>(args)` parameter    │
                │   binding drives validation + UI    │
                │   + `private workflow` modifier     │
                │   + workflow-calls-workflow         │
                └────────────────────────────────────┘

                ┌─ partial-update.md ───────────┐
                │   pattern: command + option   │     (sits adjacent
                │   PATCH semantics from        │      to exception-
                │   keyword + position-driven    │      less; not a
                │   wire encoding                │      new type)
                └────────────────────────────────┘

                ┌─ implementation-plan.md ───────┐
                │   phases P / I / A / S         │     (owns the
                │   D1-D26 decisions table       │      delivery)
                │   ~33 weeks focused work       │
                │   ~20-24 calendar weeks        │
                └─────────────────────────────────┘
```

## The model in 90 lines

### Layers

```
┌─ API surface ───────────────────────────────────────────────┐
│  api auto-exposes aggregate CRUD + finds + workflows.       │
│  Generated route handlers translate `or`-union variants     │
│  to RFC 7807 ProblemDetails.                                 │
│  Aggregate-invariant throws → env-aware 500 fallback.       │
├─ Workflow (application layer) ──────────────────────────────┤
│  Cross-aggregate orchestration. Loads via Repo.getById      │
│  (returns T or NotFound). Calls aggregate ops + other        │
│  workflows. Optionally transactional. `private workflow`     │
│  for reusable internal orchestration not auto-exposed.        │
│  ? propagation lives here as the workhorse.                  │
├─ Specifications (cross-aggregate domain rules) ─────────────┤
│  Pure parameterised predicates / sets over T. Composes        │
│  existing views + named repo finds. Bound to parameters       │
│  via `from <Spec>(args)`. One declaration drives input        │
│  validation + UI options + OpenAPI constraints.               │
├─ Aggregate operation (domain core) ─────────────────────────┤
│  Mutates own state only. precondition throws (guard).        │
│  Returns T or BusinessError for designed-in own-domain       │
│  outcomes. CANNOT load other aggregates.                     │
└──────────────────────────────────────────────────────────────┘
```

### Type-system surface

- **Payload** = structured data crossing a boundary. Sugar keywords:
  `event`, `command`, `query`, `response`, `error`. Plus plain
  `payload` for everything else.
- **Carrier bound `: carrier`** = primitives + value objects +
  payloads + aggregates (via auto-synthesised wire projection).
- **ML-postfix syntax**: `int page`, `customer option`,
  `event envelope` — no angle brackets anywhere.
- **Named unions**: `payload OrderEvent = OrderPlaced | OrderCancelled`.
- **Anonymous `or` unions inline**: `OrderId or NotFound or OutOfStock`.
- **Variant-name-tagged identity**: `int option ≠ int maybe` even
  if shaped identically.
- **`option` sugar**: `string option` = `string or none`.
- **No `Result<T, E>` / `Ok` / `Err` wrappers** — anonymous `or` directly.

### Failure model

```
            invariant / precondition violation     → throws → 500
            (aggregate-internal: env-aware exposure)
                              │
                              ▼
              expected business outcome              → typed or-return
              (e.g., InsufficientCredit)             → ? propagates
                              │
                              ▼
              specification mismatch                 → InvalidSpecMember
              (parameter not in spec's set)          → ? propagates
                              │
                              ▼
              workflow precondition violation        → throws → 400
              (caller violated contract)             (rule text safe)
                              │
                              ▼
              wire boundary translation              → ProblemDetails
              (api auto-generates this)              (status from api map
                                                      + stdlib defaults)
```

### Worked end-to-end example

```
context Sales {
  # Errors are HTTP-blind. Domain types, nothing else.
  error NotFound          { what: string, id: string }
  error InsufficientCredit { requested: decimal, available: decimal }
  error SupplierUnable    { supplierId: Supplier id, orderType: OrderType }

  # Specification — pure parameterised predicate over Supplier.
  # Composes existing named repo find (Suppliers.canFulfill).
  specification SuppliersForOrderType(orderType: OrderType) of Supplier {
    query: Suppliers.canFulfill(orderType)
  }

  specification ActiveCustomers of Customer {
    query: Customers.findActive()
  }

  # Aggregate — pure domain. Cannot load other aggregates.
  aggregate Order {
    customerId: Customer id

    operation place(lines: OrderLine[]): or InsufficientCredit {
      precondition lines.length > 0          # throws (guard)
      # ... own-state logic; may return InsufficientCredit
    }
  }

  # Command — fields bound to specs via `from`.
  command PlaceOrder {
    customerId:  Customer id   from ActiveCustomers
    orderType:   OrderType
    supplierIds: Supplier id[] from SuppliersForOrderType(self.orderType)
    lines:       OrderLine[]
  }

  # Workflow — application layer. Orchestrates.
  workflow placeOrder(cmd: PlaceOrderCommand): OrderId or NotFound or InvalidSpecMember or InsufficientCredit transactional {
    precondition cmd.totalAmount > 0         # throws → 400
    let order = Order.create({ customerId: cmd.customerId })
    order.place(cmd.lines)?
    return order.id
  }

  # API — declares status mappings for non-default errors.
  api SalesApi from Sales {
    status InsufficientCredit 409
    # NotFound, InvalidSpecMember, ValidationError, ParseError
    # all get stdlib defaults (404 / 422 / 422 / 400).
  }
}
```

What runs end-to-end:

1. Client POSTs `/workflows/place_order` with the command JSON.
2. `validate for PlaceOrderCommand` (Phase 5) fires on field-level rules.
3. For each `from <Spec>(args)` binding on the command's fields,
   the synthesised wrapper checks: load entity (`Repo.getById`),
   evaluate spec's `check` against it. On mismatch → return
   `InvalidSpecMember { spec, paramName, id }`.
4. Workflow `precondition cmd.totalAmount > 0` checks; throw → 400 ProblemDetails if violated.
5. `Order.create(...)` constructs the aggregate (factory).
6. `order.place(...)` runs; aggregate-op `precondition lines.length > 0` throws if violated → 500.
7. If spec validation failed at step 3: api emits 422 ProblemDetails with `InvalidSpecMember` body identifying which field / which spec.
8. If `place` returns `InsufficientCredit`: api emits 409 ProblemDetails.
9. If `place` throws (invariant violated): api emits env-aware 500 ProblemDetails; catalog event logged.
10. On success: HTTP 200, body is the `OrderId` data directly. No `kind` envelope on success.

## Decisions table — what's pinned

The implementation plan ([`implementation-plan.md`](./implementation-plan.md))
has the full D1–D26 table with recommended answers. The
load-bearing ones for the implementing agent:

| # | Question | Pinned |
|---|---|---|
| D1 | Carrier bound name | `carrier` |
| D2 | Discriminator field on the wire | `kind` |
| D3 | Variant identity for unions | Variant-name-tagged |
| D4 | Aggregate-in-carrier semantics | Handle-in-process, wire-at-boundary |
| D6 | Propagation operator | `?` (postfix on `or`/`option` expression) |
| D9 | `option`'s empty variant naming | `none` (lowercase) |
| D11 | Phoenix `option` runtime | `T \| nil` (idiomatic Elixir) |
| D14 | Generic instantiation syntax | ML-postfix at use sites; parens at declaration |
| D17 | `error` keyword | Sugar keyword; HTTP-blind |
| D18 | Status mapping home | In the api surface as `status <Error> <Code>` lines |
| D21 | 500 body shape — dev vs prod | `LOOM_EXPOSE_INTERNAL_ERRORS` env var |
| D22 | `precondition` — typed or throw | **Throws** at both layers (different status codes) |
| D24 | Specification name | Full `specification` (no abbreviations) |
| D25 | Spec bind keyword | `from <Spec>(args)` |
| D27 | Reusable cross-aggregate mutation | `private workflow` + workflow-calls-workflow (no separate `service`) |
| D25 | `pre` slot accepts | Validators only (pure) |
| D26 | Validator auto-injection | At every call site of the protected op |

## What the implementing agent does first

Phase ordering (full detail in `implementation-plan.md`):

1. **P1** (~1.5 weeks): `payload` keyword + 5 sugar keywords (`event`/`command`/`query`/`response`/`error`).
2. **P2** (~1 week): auto-synthesised `<Agg>Wire` payloads. No emission change.
3. **P3** (~3 weeks): carrier-bounded generics; ML-postfix syntax.
4. **P4** (~3 weeks): tagged unions (named + anonymous `or`); exhaustive `match`.
5. **A1** (~2 weeks): stdlib `error` payloads + `none` + `option` + two-regime validator.
6. **A2** (~2 weeks): `?` propagation operator.
7. **A3** (~2 weeks): api-surface `status` mapping + ProblemDetails translation + env-aware 500.
8. **A4** (~1 week + fixture re-baseline): find-variant re-shape (`Repo.getById` → `T or NotFound`).
9. **A5/A6** (~3 weeks): parse + external API + `validate for X` re-shape.
10. **A7a** (~2 weeks): carrier stdlib helpers.
11. **Spec1–4** (~4.5 weeks): specifications + `from` binding.
12. **W1** (~1 week): workflow-calls-workflow + `private workflow`.
12. **I1–I4** (~7 weeks): aggregate inheritance (can run parallel with the P/A tracks).

Phases P3+P4 (~6 weeks) are the foundation; A1+A2+A3 (~6 weeks) are the
minimum coherent exception-less ship; A4 is the user-visible turning
point (one coordinated PR; do not split).

## Where each design call is documented

| To learn... | Read |
|---|---|
| Why payload separately from aggregate | `payload-transport-layer.md` §"The architectural separation (key insight)" |
| Why ML-postfix instead of angle brackets | `payload-transport-layer.md` §"Syntax — ML-postfix for type positions" |
| Why no `Result<T, E>` wrapper | `payload-transport-layer.md` §"Alt 6"; `exception-less.md` §"Why no `Result<T, E>` wrapper" |
| How `?` works on `or` unions | `exception-less.md` §"The `?` propagation operator" |
| Why preconditions throw (both layers) | `exception-less.md` §"Preconditions throw — at both layers" |
| Where status codes live (and don't) | `exception-less.md` §"API-edge ProblemDetails translation" |
| Dev vs prod 500 body | `exception-less.md` §"Env-aware internals exposure" |
| What can be auto-derived from `from <Spec>(args)` bindings | `specification.md` §"What the synthesised application layer does" |
| When to use specification vs workflow | `specification.md` §"What this collapses" + `docs/workflow.md` |
| `private workflow` + workflow-calls-workflow | `specification.md` §"Workflow-calls-workflow (related extension)" |
| PATCH-style commands | `partial-update.md` |
| Abstract aggregates / storage strategies | `aggregate-inheritance.md` |

## Open questions still waiting for human input

Several decisions in the plan have recommended answers but invite override.
Highest impact:

- **D14** (postfix vs prefix) — affects every type annotation.
- **D17** (`error` as sugar keyword) — affects parsing surface.
- **D18** (status mapping in api surface vs elsewhere) — affects layer separation.
- **D22** (precondition throws) — affects every workflow body migration.
- **D27** (`private workflow` + workflow-calls-workflow vs separate `service` keyword) — affects domain modelling clarity.

The implementing agent should confirm each before the phase that depends on it lands. The plan's "Workflow" section lists which decisions block which phases.

## What's deferred to v2

Out of v1 scope:

- Aggregates with generics (deliberate; nominal stays narrow)
- Row polymorphism / structural subtyping over payloads
- Type-class abstractions (`Functor`, `Monad`, etc.)
- User-declarable carrier-generic functions (A7b)
- Multi-success applicative error accumulation beyond `T or E[]`
- Async / `IO<T>` / `Task<T>` effect types
- `?.`-style chained access on `option`
- Per-error customisation of ProblemDetails `type` / `title` / `detail` templates
- UI / queue / CLI surface error-mapping syntax (UI consumes ProblemDetails as a payload)
- Cross-aggregate precondition field annotations (`field id requires { ... } else E`)
- Per-aggregate override of find's default error type
- Validator visibility / access modifiers (public/private)

If any of these turn out to be common pain after v1 ships, they slot in as additive proposals.

## Where the docs live in the repo

```
docs/proposals/
├─ README.md                     ← index
├─ type-system-overview.md       ← this doc (orientation)
├─ aggregate-inheritance.md      ← state layer
├─ payload-transport-layer.md    ← transport layer
├─ exception-less.md             ← error/option/?/api-edge translation
├─ specification.md              ← cross-aggregate domain rules + private workflow
├─ partial-update.md             ← PATCH pattern
├─ implementation-plan.md        ← delivery plan
├─ provenance.md                 ← (existing) value provenance
├─ audit-and-logging.md          ← (existing) audit + logging
├─ execution-context.md          ← (existing) scope frames
├─ sensitivity-and-compliance.md ← (existing) sensitivity tagging
├─ encrypted-at-rest.md          ← (existing) column encryption
├─ load-specifications.md        ← (existing) aggregate load specs
├─ observability.md              ← (existing) catalog
└─ policies-supplementary-note.md ← (existing) auth model intersection
```

The type-system family is the first six entries; the rest are
provenance/governance proposals that pre-date this work.
