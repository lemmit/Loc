# Payload — a structural transport layer

> Status: proposal. **Sister proposal**:
> [`aggregate-inheritance.md`](./aggregate-inheritance.md) — they together
> split the type system along two axes (state vs transport). Read both
> before implementing either.

## TL;DR

Today Loom conflates five concepts under "aggregate": state, identity,
wire shape, events, and (implicitly) commands/queries. Generic
patterns like `Envelope<T>` or `Page<T>` aren't expressible. Each new
cross-cutting pattern needs another TS-authored macro.

**Proposed**: lift "structured data crossing a boundary" into a
first-class concept `payload`. Events, commands, queries, and
responses become payload subtypes. Generics are added, **bounded by
`: payload`** (scoped — not language-wide). Discriminated unions on
payloads enable tagged event streams and CQRS modeling.

| Today (per-aggregate, per-site) | Proposed (payload + generics) |
|---|---|
| Wire shape implicit in aggregate | `payload <AggName>Wire extends payload` (explicit) |
| `event OrderPlaced { ... }` | `event OrderPlaced extends payload { ... }` (auto-upgrade) |
| Commands implicit in operations | `command PlaceOrder extends payload { ... }` |
| Queries implicit in finds | `query OrderSummary extends payload { ... }` |
| No success/error wrappers | `payload Result<T: payload, E: payload> = Ok<T> \| Err<E>` |
| No pagination type | `payload Page<T: payload> { items: T[], total: int, cursor: string? }` |
| No envelope | `payload Envelope<P: payload> { id: string, ts: datetime, body: P }` |
| Event streams as ad-hoc types | `payload OrderEvent = OrderPlaced \| OrderCancelled \| ...` |

Aggregates stay nominal + concrete (no generics). Payloads add
generics + unions. **Two parallel ladders, by design.**

## Why this matters (the problem)

### Today's pain — concretely

Loom today conflates several concepts under one umbrella:

| Concept | How it's modeled today | Pain |
|---|---|---|
| State + identity + write surface | `aggregate Customer { ... }` | Correct |
| Wire shape (DTO crossing the boundary) | Implicit `wireShape` derived from aggregate | Can't refer to "the wire shape" as a type, can't compose it |
| Domain events | `event OrderPlaced { ... }`, per-aggregate fanout | Can't form a tagged union over events |
| Commands | Implicit in `operation foo(...)` signatures | No first-class type to validate / authorize / log against |
| Queries | Implicit in `find`s and views | Same |
| API responses | Derived per operation, per view, per find | Each response type is bespoke |

**Five concrete consequences in production code today**:

1. **Pagination is per-aggregate.** `find allCustomers limit: N` and
   `find allOrders limit: N` each emit their own per-aggregate
   pagination shape on every backend. No single `Page<T>` exists.
2. **No success/error response wrapper.** Operations either return
   the wire shape directly (on success) or raise an exception (on
   failure). Cross-cutting `Result<T, DomainError>` for explicit
   error channels isn't expressible — users either embrace
   exception-driven flow or hand-roll discriminated returns
   per-operation.
3. **Event streams aren't first-class types.** Reading "all the
   events for an Order" today means knowing which event types apply
   and writing per-type handlers. No `OrderEvent = OrderPlaced |
   OrderCancelled | OrderShipped` for exhaustive case matching.
4. **Cross-cutting validation lives at the operation site.** Want to
   validate that any payload containing an `email` field has a valid
   format? Today: copy the rule into every relevant operation. With
   payloads-as-first-class: `validate for X` once.
5. **Macros absorb the gap.** `with crudish` generates per-aggregate
   CRUD payloads (today implicit, no name); `with audit` injects
   audit fields at multiple sites. Each new cross-cutting pattern
   means another macro in the stdlib. Five so far. The trajectory is
   not sustainable.

### The deeper issue: there's no name for "the thing that crosses a boundary"

Domain-Driven Design and CQRS literature treat **commands**,
**events**, **queries**, and **DTOs** as related concepts — all
"structured data carriers" that move between bounded contexts /
across the wire / through queues. They share:
- Immutable shape (no mutation methods, just data).
- Serializability (must survive JSON / protobuf / binary).
- No identity beyond their content (two PlaceOrder payloads with
  identical fields ARE the same command, semantically).
- Lifecycle of "exists briefly to convey intent, then is gone."

Aggregates, by contrast, are state machines with identity, lifecycle,
invariants, and operations that mutate them.

Conflating the two (which Loom does today) means:
- DDD modeling discipline is harder (everything looks like an
  aggregate, even when it shouldn't be).
- Generic patterns are blocked (you can't make all aggregates
  generic because most shouldn't be; you can't make some aggregates
  generic because there's no scoping).

### What this proposal solves

Give a name to "the thing that crosses a boundary": `payload`.
Generic patterns become first-class within that name. Aggregates
stay narrow.

### What this proposal explicitly does NOT solve

- **Generics on aggregates.** Out of scope. Aggregates stay nominal
  + concrete. The scoping is the point: generics live only where
  backends can implement them uniformly (transport / JSON).
- **Row polymorphism, higher-kinded types.** Not in v1. Bounded
  parametric polymorphism (`<T: payload>`) is the limit.
- **Type-class-like abstractions.** `payload with Comparable` —
  not v1. The `implements "capability"` story stays for cross-cutting.
- **Replacing the aggregate model.** Payloads complement aggregates.
  Existing aggregate code keeps working.

## The architectural separation (key insight)

Two parallel type-system ladders, by design:

| Axis | State layer | Transport layer |
|---|---|---|
| Concept | `aggregate` (sister proposal: + `abstract aggregate`) | `payload` (this proposal) |
| Typing | Nominal | Structural |
| Identity | Yes (`id`) | No (content-equivalent payloads are equal) |
| Hierarchy | Single inheritance (abstract base + concrete) | Generic params + discriminated unions |
| Lifecycle | Long-lived state machine | Ephemeral message |
| Backend mapping | Tables, constraints, ORM machinery | JSON serialization (uniform across backends) |
| Why generics fit | They don't — backends handle nominal storage differently | They do — every backend serializes JSON the same way |

**This is the design choice that makes generics tractable.** Adding
generics to aggregates would require every backend to handle
parameterized storage types (TS structural, C# nominal with reified
generics, Ash typespecs, Drizzle schemas) — a much larger
undertaking. Adding generics to payloads is mostly a wire-shape
problem; backends already serialize uniformly. Scoping is the win.

## Proposal

### Payload as the unit of structured data crossing a boundary

```
payload OrderPlacedEvent {
  orderId: Order id
  total: Money
  placedAt: datetime
}

payload PlaceOrderCommand {
  items: OrderItem[]
  shipTo: Address
}

payload OrderSummaryQuery {
  id: Order id
  total: Money
  lineCount: int
}
```

### Subtypes (existing keywords become sugar)

Existing event/command/query/response concepts become payload
subtypes:

```
event OrderPlaced extends payload { ... }
command PlaceOrder extends payload { ... }
query OrderSummary extends payload { ... }
```

The `extends payload` is intent — they share the structural shape and
the wire contract. **Migration**: existing code (`event Foo { ... }`)
auto-upgrades to `event Foo extends payload { ... }` in the IR
enrichment pass. No syntactic change required in user .ddd files.

### Wire shape becomes an explicit payload

Today the wire shape of an aggregate is implicit (derived in
`wireShape` enrichment, named `<Agg>Wire` by convention but not
referenceable as a type). Proposed:

```
# Today: implicit
aggregate Customer { name: string, email: string }
# Generates wire shape ~{ id, name, email } in TS / C# / Phoenix DTOs
# But no DSL-level type to reference

# Proposed: explicit payload, auto-derived
aggregate Customer { name: string, email: string }
# IR enrichment additionally synthesizes:
payload CustomerWire extends payload {
  id: Customer id
  name: string
  email: string
}
# Now referenceable: `response: CustomerWire`, `Page<CustomerWire>`, etc.
```

This is the bridge between today's implicit shape and the explicit
`payload` concept. No user-facing change for existing aggregates —
the wire shape continues to derive automatically, just now with a
named payload type.

### Generics on payloads

```
payload Envelope<P: payload> {
  id: string
  ts: datetime
  body: P
}

payload Page<T: payload> {
  items: T[]
  total: int
  cursor: string?
}

payload Result<T: payload, E: payload> = Ok<T> | Err<E>
payload Ok<T: payload> { value: T }
payload Err<E: payload> { error: E }
```

**Bounded by `: payload` only.** The universe is closed — every type
parameter is itself a payload. This avoids the "what is a value type?"
question that opens up full structural subtyping.

### Discriminated unions on payloads

```
payload OrderEvent = OrderPlaced | OrderCancelled | OrderShipped
```

**Tagged unions.** The discriminator is the variant's name
(serialized as a `kind` field on the wire by default). Frontend
TypeScript narrows on the discriminator naturally. C# emits using
`JsonDerivedType` polymorphic JSON. Phoenix/Ash uses Ash's
`tagged_unions` feature.

Case-matching on a tagged union:
```
match event {
  OrderPlaced -> { ... }
  OrderCancelled -> { ... }
  OrderShipped -> { ... }
}
```
Validator enforces exhaustiveness (every variant must be matched
unless `_` fallback used).

### Cross-cutting concerns target payloads

```
authorize for PaymentRequest {
  # Any payload of type PaymentRequest, regardless of which operation carries it
  requires actor has "payments.execute"
}

validate for OrderItem {
  quantity > 0
}
```

Today these rules are tied to operations / finds; lifting them to
payloads makes them composable across surfaces (REST endpoint,
GraphQL mutation, queue consumer, internal call).

## What this unlocks — concrete table

For each of today's pain points (above), how payload + generics fixes
it:

| Today's pain | With payload + generics |
|---|---|
| Pagination is per-aggregate | `payload Page<T: payload>` once; every find returns `Page<XWire>` |
| No success/error wrapper | `payload Result<T, DomainError>` once; operations declared as returning Result |
| Event streams aren't typed | `payload OrderEvent = OrderPlaced \| OrderCancelled` with exhaustive matching |
| Cross-cutting validation per-op | `validate for X` once; applies wherever X flows |
| GraphQL union types not expressible | Falls out of discriminated unions |
| Per-aggregate macros for envelope shapes | `Envelope<XWire>` instantiated where needed |
| Event sourcing requires hand-rolled types | `payload <Agg>Event = <variant list>` first-class |
| Multi-aggregate response shapes | Compose with generic payloads, no per-site DTO |

## Alternatives considered (and why they're worse)

### Alt 1: Just add generics to aggregates

Reject. Generics on aggregates force every backend ORM to handle
parameterized storage types:
- TS / Drizzle: structural — relatively easy.
- C# / EF Core: nominal with reified generics, but storage mapping
  needs per-instantiation tables (TPC-style for every generic
  param). Quickly becomes "how do we store `Wrapper<Customer>` vs
  `Wrapper<Order>`?"
- Phoenix / Ash: Ash resources aren't designed for generic
  parameterization at the resource level.

The cost is much higher AND the benefit is lower (aggregates rarely
need generic shape; they're nominal state machines).

### Alt 2: Lift only events to first-class, keep commands/queries implicit

Reject. Half-measure. Events become typed but commands and queries
remain ad-hoc. Cross-cutting rules (`authorize`, `validate`) still
have nowhere uniform to attach. Discriminated unions on events alone
miss the broader CQRS use case.

### Alt 3: Add a `record` or `dto` keyword separately for each direction

Reject. `command`, `event`, `query`, `response` × `dto` × `record` —
keyword bloat. Conceptually they're all the same thing (structured
data crossing a boundary). One concept (`payload`), four sugar
keywords, is cleaner.

### Alt 4: Don't add anything; let macros grow

Reject. Forecasted trajectory: ~15 macros within 12 months at the
current pace, each new cross-cutting pattern (pagination,
soft-update, optimistic concurrency, idempotency keys) needing
TS-authored generator code. Users with their own patterns are
locked out unless they learn the macro authoring system. The
macro stdlib becomes a maintenance burden and a learning cliff.

This proposal is the "ship the abstraction" answer to the
"abstraction pressure is real, where do we put it" question.

## Migration path

Step-by-step compatibility:

1. **Phase 1**: introduce `payload` keyword + the four sugar
   keywords (`event`, `command`, `query`, `response`) all becoming
   `extends payload` automatically in IR enrichment. **No user .ddd
   file changes required.**
2. **Phase 2**: introduce explicit named wire shapes
   (`payload <Agg>Wire extends payload`) auto-synthesized per
   aggregate. **No user code change**; backend emission unchanged.
3. **Phase 3**: introduce generics on payloads. Authors can now
   declare `Page<T: payload>`, `Envelope<P: payload>`, etc.
   **Opt-in**; existing code doesn't use generics, unchanged.
4. **Phase 4**: introduce discriminated unions. **Opt-in**.
5. **Phase 5**: introduce `validate for X` / `authorize for X`
   targeting payload types. **Opt-in**; existing operation-level
   rules continue to work.

Each phase is independently shippable. Phase 1+2 deliver naming
(immediate clarity win); Phase 3 is the type-system lift; Phase 4+5
add the surface for cross-cutting.

## Hard parts (honest list)

- **Generics infrastructure has to land.** Bounded type parameters,
  substitution at lowering. Scoped to payloads (not language-wide)
  but still real type-system work. **One-way door**: once shipped,
  the parser, scope provider, lowering pass, and per-backend emitters
  all carry the cost. Estimate: 2-3 weeks for the type-system core,
  plus per-backend emission work.
- **Discriminated unions are a separate large feature.** Union
  types, narrowing rules, exhaustiveness checking in case-matches.
  Worth doing together with generics since they appear together in
  real use. Estimate: 2-3 weeks.
- **Per-backend generics emission has different costs**:
  - TS: structural, native. Trivial.
  - C# nominal: generate concrete per-instantiation records (no
    runtime generics on DTOs). Per generic + per instantiation = one
    emitted record class. Moderate work.
  - Elixir / Ash: typespecs only (Elixir has no compile-time
    parametric polymorphism). Easy.
  - React / TS frontend: gets generic types natively. Trivial.
- **Two parallel ladders.** Aggregates and payloads coexist.
  Documentation has to explain when to reach for each (state vs
  transport). Risk of user confusion — mitigated by clear examples
  in `docs/language.md`.
- **Macro stdlib overlap.** Some current macros become obsolete
  once `Page<T>` etc. are first-class. Migration story for existing
  user-authored macros that emit payload-like shapes.

## What's deferred

- **Aggregates with generics.** Out of scope. Narrow surface stays.
- **Row polymorphism / structural subtyping over payloads.** v2
  conversation. Bounded params (`<T: payload>`) cover common cases.
- **Type-class-like abstractions (`payload with Serializable`).**
  v2 conversation. Capabilities-as-marker (`implements`) handles
  cross-cutting today.
- **Bounds beyond `: payload`.** Just `: payload` for v1 to keep the
  type system closed. Generalizing to "any value type" bounds is v2.

## Open questions (need human input)

- **Single `payload` concept vs four keywords?** Current proposal:
  keep `event` / `command` / `query` / `response` keywords for
  clarity, treat `extends payload` as compiler-inferred. Alternative:
  drop the sugar keywords; force authors to write `payload Foo {
  ... }` and use a `kind: 'event' | 'command' | ...` discriminator.
  Lean toward keeping sugar — keyword semantics carry intent.
- **Naming**: `payload` vs `message` vs `dto`. `payload`
  transport-neutral; `message` carries Akka/Erlang baggage; `dto`
  reads Java-y. Open.
- **Discriminator field name for tagged unions**: default `kind`?
  `type`? `_type`? Default `kind`; allow override.
- **Inline generics vs named instantiations**:
  `Envelope<OrderPlacedEvent>` inline vs
  `payload OrderPlacedEnvelope = Envelope<OrderPlacedEvent>` named.
  Probably both, with named as the canonical form for wire shapes.
- **Bounds beyond `: payload`** for v2 — what's the next bound that
  matters? Likely `: payload with id` (anything with an id field) to
  support generic CRUD wrappers.
- **Phase 5 placement**: `validate for X` / `authorize for X` could
  ship without payload-as-first-class (target operations as
  today). But the abstraction is much stronger when payloads exist
  as named referenceable types. Tie them together.

## Cross-references

- [`aggregate-inheritance.md`](./aggregate-inheritance.md) —
  **sister proposal**. Splits the type system into two axes:
  - Sister doc (state layer): aggregates, inheritance, nominal
    typing, **no generics**.
  - This doc (transport layer): payloads, structural typing,
    **generics**, discriminated unions.

  The split is deliberate. Read both before implementing either.
  Aggregates stay narrow precisely so payloads can grow.

- #466 — macro system. Macros remain the answer for cross-cutting
  concerns that don't fit the payload model (e.g. injecting fields
  into aggregates).

- Loom Phase 9 observability (`docs/observability.md`) — already
  treats catalog events as payload-shaped (envelope + structured
  fields). Payloads would make this implicit shape explicit and
  remove the per-backend renderer indirection that exists because
  the wire envelope isn't a first-class type.

- `src/ir/loom-ir.ts` — `wireShape` enrichment. This is the
  bridge: today's `wireShape` becomes Phase 2's auto-synthesized
  `<Agg>Wire payload`.
