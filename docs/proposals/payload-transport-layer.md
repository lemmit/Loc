# Payload — a structural transport layer

> Status: proposal. Captures a design discussion about lifting "structured
> data crossing a boundary" into a first-class concept (`payload`), of
> which events, commands, queries, and responses are all subtypes. Proposes
> adding generics scoped to payloads only — sidestepping the cost of
> language-wide generics while unlocking the common patterns (envelopes,
> pagination, success/error wrappers).

## Problem

Loom today conflates several concepts under "aggregate":

- **State + identity + write surface** — what aggregate means in DDD.
- **Wire shape** — the DTO derived from aggregate fields (implicit, in
  `wireShape`).
- **Domain events** — per-aggregate fanout, concrete shape
  (`event OrderPlaced { ... }`).
- **Commands** — implicit in operations; no first-class type.
- **Queries / views** — implicit in repository finds / views; no
  first-class type.
- **API responses** — derived per aggregate / per operation / per view.

This conflation works at small scale but pressures the design as it
grows:

- Cross-cutting concerns over "anything carrying a Money field" can't
  be expressed without macros generating per-site code.
- Generic envelopes (`Envelope<T>`, `Page<T>`, `Result<T, E>`) aren't
  expressible.
- Event streams can't be modeled as discriminated unions of payloads.
- Validation / authorization rules target operations or views, not the
  payloads they carry — making cross-direction rules ("validate any
  payload with `email`") awkward.

Macros (`with audit`, `with crudish`) absorb some of this but proliferate
quickly and require TS-authoring expertise outside the DSL.

## Goals

- One concept (`payload`) for any structured data crossing a boundary
  (event, command, query, response).
- Generics scoped to payloads — sidestep the cost of language-wide
  generics while unlocking the patterns that need them.
- Discriminated unions over payloads, for event-stream / CQRS
  modeling.
- Structural typing where it matches the substrate (JSON-over-HTTP is
  structural).
- Aggregates stay nominal + concrete (DDD-faithful).

## Non-goals

- Generics on aggregates. Out of scope; aggregates stay narrow.
- Row polymorphism, higher-kinded types, type-class-like abstractions.
- Replacing the aggregate model. Payloads complement, not replace.

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

### Subtypes

Existing event/command/query/response concepts become payload subtypes:

```
event OrderPlaced extends payload { ... }
command PlaceOrder extends payload { ... }
query OrderSummary extends payload { ... }
```

The `extends payload` is intent — they share the structural shape and
the wire contract. Existing code (`event Foo { ... }`) auto-upgrades
to `event Foo extends payload { ... }` with no syntactic change.

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

Generics are bounded — `: payload` is the only bound, since the
universe is closed.

### Discriminated unions

```
payload OrderEvent = OrderPlaced | OrderCancelled | OrderShipped
```

Tagged unions over payloads. The discriminator is the variant's name
(serialized as a `kind` field on the wire by default). Frontend types
narrow on the discriminator naturally.

### Cross-cutting concerns target payloads

```
authorize for PaymentRequest {
  # any payload named PaymentRequest, regardless of which operation carries it
  requires actor has "payments.execute"
}

validate for OrderItem {
  quantity > 0
}
```

Today these rules are tied to operations / finds; lifting them to
payloads makes them composable and reusable across surfaces.

## What this unlocks

| Pattern | Today | With payload + generics |
|---|---|---|
| Success / error response wrapper | per-op duplication | `Result<T, DomainError>` once |
| Paginated lists | per-find emission | `Page<T>` once |
| Envelope (id + ts + body) | not expressible | `Envelope<P: payload>` once |
| Event stream as tagged union | per-event handler dispatch | `payload OrderEvent = OrderPlaced \| ...` |
| Validation across surfaces | per-op duplication | `validate for PaymentRequest` once |
| Cross-cutting auth | per-op | `authorize for X` |
| GraphQL union types | not expressible | falls out of discriminated unions |

## Architectural separation

The clean dual-axis design that emerges:

| Layer | Concept | Typing | Has identity | Hierarchy |
|---|---|---|---|---|
| State | aggregate | nominal | yes | abstract base + concrete subtypes (single inheritance) |
| Transport | payload | structural | no | generic type params + discriminated unions |

This mirrors what DDD purists argue for: entities and DTOs/messages,
properly separated. State machines with identity on one side; structured
data carriers on the other. The two ladders coexist without overlap.

## Migration path

- Existing `event Foo { ... }` becomes sugar for `event Foo extends
  payload { ... }`. No syntactic change required; one line in the IR
  enrichment pass to add the `extends payload` automatically.
- Existing wire-shape derivation continues unchanged. The "wire shape"
  on each aggregate is recast as the payload-of-aggregate
  (`payload <Agg>Wire extends payload`).
- No backend emission changes for projects that don't author generic
  payloads. Generics activate only when used.

## Hard parts (honest list)

- **Generics infrastructure has to land.** Bounded type parameters,
  substitution at lowering. Scoped to payloads (not language-wide), but
  still real type-system work. One-way door: once shipped, the parser,
  scope provider, lowering pass, and per-backend emitters all carry the
  cost.
- **Discriminated unions are a separate large feature.** Union types,
  narrowing rules, exhaustiveness checking in case-matches. Worth doing
  together with generics since they appear together in real use.
- **Per-backend generics emission.** TS structural → trivial.
  C# nominal → generate concrete per-instantiation records (no runtime
  generics on DTOs). Elixir / Ash → typespecs only. React / TS frontend
  gets generic types natively.
- **Two parallel ladders.** Aggregates and payloads coexist.
  Documentation has to explain when to reach for each (state vs
  transport). Risk of confusion.
- **Macro stdlib overlap.** Some current macros (pagination wrappers,
  audit-on-payload) become obsolete once `Page<T>` etc. are
  first-class. Migration story for existing user-authored macros that
  emit payloads.

## What's deferred

- **Aggregates with generics.** Out of scope. The narrow surface is the
  point.
- **Row polymorphism / structural subtyping over payloads.** Not in v1.
  Generics + bounded params cover the common cases.
- **Type-class-like abstractions (`payload with Comparable`).** Not in
  v1. The capabilities-as-marker (`implements`) story covers
  cross-cutting concerns.

## Open questions

- Should `payload` be a single concept with `kind: 'event' | 'command'
  | 'query' | 'response'` discriminator, or should the four remain
  separate keywords that all extend payload? Current proposal: keep
  keywords for clarity, treat `extends payload` as compiler-inferred.
- Naming bikeshed: `payload` vs `message` vs `dto`. `payload` reads as
  transport-neutral; `message` carries Akka/Erlang baggage; `dto` is
  Java-y. Open.
- Discriminator field name when payloads form a tagged union: `kind`?
  `type`? `_type`? Default `kind`; allow override.
- Inline generics (`Envelope<OrderPlacedEvent>`) vs named
  instantiations (`payload OrderPlacedEnvelope = Envelope<OrderPlacedEvent>`)?
  Probably both, with named instantiations as the canonical form for
  the wire shape.
- Bounded params beyond `: payload`. Likely just `: payload` for v1
  to keep the type system closed. Generalizing to "any value type"
  bounds is a v2 question.

## Related work

- #466 — macro system; macros remain the answer for cross-cutting
  concerns that don't fit the payload model.
- `docs/proposals/aggregate-inheritance.md` — sister proposal
  addressing the *state* layer. Both proposals split the type system
  into a state ladder (sister doc) and a transport ladder (this doc).
- Loom Phase 9 observability — already treats catalog events as
  payload-shaped (envelope + structured fields). Payloads would make
  this implicit shape explicit.
