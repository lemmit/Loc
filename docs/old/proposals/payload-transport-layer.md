# Payload — a structural transport layer

> **[2026-06-20 status audit]** Two sub-claims advanced: `or`-unions now emit on FIVE backends (`structural-checks.ts:~414`); the union-find producer path is no longer 'stubbed on .NET and Hono' (`dotnet/find-emit.ts:~35`, `typescript/repository-find-builder.ts:~398`).

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** The "Phoenix / Ash" and "Ash resources/typespecs" mentions below describe the removed Ash foundation; the Phoenix backend now emits plain Ecto/Phoenix.

> Status: **PARTIAL — most of P1–P4 shipped** (code-verified 2026-06-10):
> **P1** — the `payload` umbrella with all six kinds
> (`payload | event | command | query | response | error`) parses,
> lowers (`PayloadKind` in `loom-ir.ts`), and is declarable at file
> scope (root-level payload declarations, A1, #1024); per-error
> `httpStatus` overrides live on the api body. **P2** — compiler-
> synthesised `<Agg>Wire` payloads exist (`PayloadIR.synthesized`).
> **P3b** — the `Paged<T>` carrier + functional **paged finds** emit
> across all four backends (#898 React, #916 .NET, #925 Phoenix, #933
> wire-parity closeout; see
> [`pagination-design-note.md`](./pagination-design-note.md)).
> **P4** — named (`payload Foo = A | B`) and anonymous (`A or B`)
> unions lower to a tagged `type` wire and emit on node/dotnet/elixir
> (`SUPPORTED_UNION_BACKENDS` in `structural-checks.ts`; see
> [`../payloads.md`](../../payloads.md)). **Remaining:** P3 full (nested
> carriers `P<Q<T>>` — gated `loom.generic-arg-not-carrier`), P5
> (`validate for X` / `authorize for X` — no surface at all), the
> union-returning **find** producer path (stubbed on .NET and Hono),
> and the `unpaged` opt-out. **Sister proposal**:
> [`aggregate-inheritance.md`](./aggregate-inheritance.md) — they together
> split the type system along two axes (state vs transport). Read both
> before implementing either.
>
> **Downstream proposal**: [`exception-less.md`](./exception-less.md)
> consumes this proposal's generic-payload mechanism (Phase 3+4) to
> introduce native `Result` / `Option` and an exception-less flow story.
> The carrier-bound widening in §"Bounds — the `carrier` universe" of
> this doc is required by exception-less; read both together before
> implementing either.

## TL;DR

Today Loom conflates five concepts under "aggregate": state, identity,
wire shape, events, and (implicitly) commands/queries. Generic
patterns like `envelope<T>` or `T page` aren't expressible. Each new
cross-cutting pattern needs another TS-authored macro.

**Proposed**: lift "structured data crossing a boundary" into a
first-class concept `payload`. Events, commands, queries, responses,
and errors become payload subtypes (sugar keywords). Generics are
added, **bounded by `: carrier`** (a closed set: primitive | value
object | payload | aggregate-via-wire-projection). Two type-level
constructs sit on top:
- **Named unions**: `payload OrderEvent = OrderPlaced | OrderCancelled`
  (per-decl, reusable, identity by name).
- **Anonymous `or` unions inline in type positions**:
  `OrderId or NotFound or OutOfStock` (no separate declaration; same
  tagged-wire semantics).

ML-style postfix syntax for the carrier types: `string option`,
`customer page`, `event envelope`. Generic instantiation never uses
angle brackets — Loom is ML-flavoured for type positions
(consistent with `Customer id` from #477).

For the exception-less flow that builds on these primitives, see
[`exception-less.md`](./exception-less.md).

| Today (per-aggregate, per-site) | Proposed (payload + generics + `or`) |
|---|---|
| Wire shape implicit in aggregate | `payload <AggName>Wire extends payload` (explicit) |
| `event OrderPlaced { ... }` | `event OrderPlaced extends payload { ... }` (auto-upgrade) |
| Commands implicit in operations | `command PlaceOrder extends payload { ... }` |
| Queries implicit in finds | `query OrderSummary extends payload { ... }` |
| Errors implicit (throws) | `error NotFound { ... }` (sugar keyword; status mapping lives in the api surface, see exception-less.md) |
| No success/error wrappers | `OrderId or NotFound or OutOfStock` (anonymous `or` union; see exception-less.md) |
| No pagination type | `customer page` (postfix; payload `page<T: carrier> { items: T[], total: int, cursor: string? }`) |
| No envelope | `event envelope` (postfix; payload `envelope<P: carrier> { id: string, ts: datetime, body: P }`) |
| No "option" type | `string option` (postfix; sugar for `string or none`) |
| Event streams as ad-hoc types | `payload OrderEvent = OrderPlaced \| OrderCancelled \| ...` (named) OR `OrderPlaced or OrderCancelled or ...` (inline) |

Aggregates stay nominal + concrete (no generics). Payloads add
generics + unions + anonymous-or-unions. **Two parallel ladders, by
design.**

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
   per-operation. See [`exception-less.md`](./exception-less.md) for
   the full treatment.
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
  parametric polymorphism (`<T: carrier>`) is the limit.
- **Type-class-like abstractions.** `payload with Comparable` —
  not v1. The `implements "capability"` story stays for cross-cutting.
- **Replacing the aggregate model.** Payloads complement aggregates.
  Existing aggregate code keeps working.

## The architectural separation (key insight)

Two parallel type-system ladders, by design:

| Axis | State layer | Transport layer |
|---|---|---|
| Concept | `aggregate` (sister proposal: + `abstract aggregate`) | `payload` (this proposal) |
| Typing | Nominal | Structural for **records**; **nominal** for unions + variants (see §"Identity of payload types" below) |
| Identity | Yes (`id`) | No (content-equivalent payloads are equal) |
| Hierarchy | Single inheritance (abstract base + concrete) | Generic params + discriminated unions |
| Lifecycle | Long-lived state machine | Ephemeral message |
| Backend mapping | Tables, constraints, ORM machinery | JSON serialization (uniform across backends) |
| Why generics fit | They don't — backends handle nominal storage differently | They do — every backend serializes JSON the same way |

**This is the design choice that makes generics tractable.** Adding
generics to aggregates would require every backend to handle
parameterized storage types (TS structural, C# nominal with reified
generics, Elixir typespecs, Drizzle schemas) — a much larger
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
subtypes; the new `error` keyword joins the family:

```
event   OrderPlaced extends payload { ... }
command PlaceOrder  extends payload { ... }
query   OrderSummary extends payload { ... }
response CustomerResponse extends payload { ... }
error   NotFound { what: string, id: string }
error   OutOfStock { sku: string }
```

The `extends payload` is intent — they share the structural shape and
the wire contract. **Migration**: existing code (`event Foo { ... }`)
auto-upgrades to `event Foo extends payload { ... }` in the IR
enrichment pass. No syntactic change required in user .ddd files.

`error` is the new keyword. Beyond being a payload, it carries one
extra signal: **the variant participates in `?` propagation** (the
operator short-circuits on values of `error`-marked types).

`error` declarations are HTTP-blind — they carry no status code, no
URI, no transport-layer information at all. Status mapping is the
api surface's job (see [`exception-less.md`](./exception-less.md)
§"API-edge ProblemDetails translation"). The domain layer just
declares the failure types and their data.

See `exception-less.md` for the full semantics of `error` payloads
and propagation; the keyword itself lives at this layer because
errors are payloads.

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
# Now referenceable: `response: CustomerWire`, `CustomerWire page`, etc.
```

This is the bridge between today's implicit shape and the explicit
`payload` concept. No user-facing change for existing aggregates —
the wire shape continues to derive automatically, just now with a
named payload type.

### Bounds — the `carrier` universe

> **Update from v0 of this proposal** (which used `: payload`).
> Bounding generic parameters to `: payload` is too narrow: it locks
> out `int option`, `customer option`, `money page`, anonymous
> `T or E` unions where `T` / `E` are primitives or value objects,
> etc. The bound is widened to `: carrier`. The
> closed-universe argument (every parameter has uniform JSON
> encoding) still holds — primitives and value objects already have
> uniform wire encoding via `src/ir/enrichments.ts`' `wireShape`.

The `carrier` bound admits a closed set:

```
carrier := primitive
         | valueobject
         | payload                                 (incl. unions of payloads)
         | aggregate (via its auto-synthesized wire projection)
```

What this buys, concretely (in ML-postfix syntax — see §"Syntax —
ML-postfix for type positions" below):

- `int page` — primitive carrier.
- `money option` — value-object carrier.
- `CustomerWire or NotFound` — anonymous `or`-union with a payload
  and an error variant.
- `customer option` — aggregate carrier, via the projection rule
  below.

**Aggregates as carriers — the projection rule.** When an aggregate
`A` appears as a carrier argument, its identity inside a process is
the aggregate handle (the rich type, with methods, the full state
machine). At any **process boundary** (HTTP response, queue message,
file IO, persisted snapshot, log payload), the encoder uses `A`'s
auto-synthesized wire projection (`AWire`). This is the same
projection today's `wireShape` enrichment already performs for
top-level operation returns — we name the rule and let it apply
through generics.

So `customer option`:
- Inside a function body where the value originated from
  `customers.findOne(...)`, the `Some`-side value is typed as
  `Customer` (the aggregate handle; you may call its methods).
- Crossing the wire it serializes as if it were `CustomerWire option`.
- An author who wants to be explicit about transport (e.g., a payload
  field whose static type *is* the wire form) writes
  `CustomerWire option` directly. Both forms coexist; on the wire
  they're equivalent.

The two views are connected by the carrier projection — they don't
collapse into the same type, and the aggregate's nominal identity is
preserved inside the domain.

**No new IR shape required.** `wireShape` already exists per
aggregate. Generic instantiation for carrier types stamps the
projection into the union arms at lowering time. Backends consume the
union just as they consume any payload union.

**Inheriting aggregates as carriers** (see
[`aggregate-inheritance.md`](./aggregate-inheritance.md)): an abstract
aggregate `Party` with concretes `Customer` / `Supplier` projects to
a union of concrete wire shapes when used as a carrier argument.
`party option` on the wire is `CustomerWire or SupplierWire or none`
— i.e., the discriminator carries the concrete type. Implementation
note: the projection enriches at lowering time using each concrete's
`wireShape`; no new IR needed beyond a small change to the carrier
arm-stamping pass to detect abstract aggregates and expand them.
`Party id` (the polymorphic id reference type) is itself a primitive
carrier — `Party id option` works unmodified.

### Syntax — ML-postfix for type positions

Carrier types in Loom use **ML-style postfix syntax** in type
positions, consistent with `Customer id` from #477. No angle
brackets anywhere in the language:

| Form | Reads as |
|---|---|
| `string option` | "optional string" — sugar for `string or none` |
| `customer option` | "optional customer" — carrier holding an aggregate (handle inside process, wire projection at boundary) |
| `customer page` | "page of customers" — paginated result |
| `event envelope` | "envelope around an event" |
| `string option page` | nested: "page of optional strings" (postfix associates left) |
| `(string or int)` (in type positions) | anonymous union; grouping parens only when ambiguous |

`option`, `page`, `envelope` are single-arg postfix type
constructors. Anonymous unions use the **`or` connective** (see
§"Discriminated unions on payloads" below) and can chain associatively:
`A or B or C or D`. No special multi-arg-generics syntax is needed
because `or` already gives compositional sum types — and the
historically two-arg `Result<T, E>` is just `T or E` in this model.

For named generic declarations (declaring a new payload that takes
type parameters), the parameter list at the **declaration site**
uses parens:

```
payload page(T: carrier) {       # declares the page payload taking one carrier T
  items: T[]
  total: int
  cursor: string?
}

payload envelope(P: carrier) {
  id: string
  ts: datetime
  body: P
}
```

The instantiation site uses ML-postfix (`customer page`, not
`page(customer)`). Declarations face the type-system author;
instantiations face every author. The asymmetric syntax mirrors
OCaml's `'a list` / `type 'a list = ...`.

### Relationship to `T?` (nullable suffix)

Loom has **two** absence concepts after this proposal lands:

| Concept | Form | States | Purpose | Lives in |
|---|---|---|---|---|
| `T?` (nullable suffix) | Type-level annotation | value \| null | Field nullability — "this column may hold null" | Today's grammar (kept) |
| `T option` (carrier) | ML-postfix sugar for `T or none` | `none` \| `some(T)` | Optional values that may be absent | This proposal (new) |

The two coexist because they answer different questions:
- `T?` is a storage / wire concern (nullable column / nullable JSON
  value at the field level).
- `T option` is a control-flow / type-level concern (a function may
  have no result; a command field may not have been supplied).

They **compose**: `string? option` is "an optional value whose inner
type allows null" — three states (absent / cleared / value). Used in
PATCH-style commands; see [`partial-update.md`](./partial-update.md).

The previously-proposed `Optional<T>` named type **is subsumed** by
`T option` plus the `command`-keyword PATCH semantic. The
`partial-update.md` proposal replaces the old `optional-and-partial-update.md`
and describes the pattern, not a new type.

**`find` returns**: see [`exception-less.md`](./exception-less.md)
§"Find-variant alignment". The return-type *declaration* determines
which absence shape applies: `: X` becomes `X or NotFound` (no
implicit nullability); `: X?` becomes `X option` (carrier).
`: X[]` stays an array (empty is the absence signal).

### Stdlib payload home

The blessed carrier types (`option`, `page`, `envelope`, plus the
`none` unit type, plus stdlib `error` payloads like `NotFound`,
`ParseError`, `ApiError`, `ValidationError`) live in
**`src/stdlib/payloads/`** as embedded `.ddd` source bundled with
the toolchain, parsed once at startup and made available to every
user program without an import. They are not user-visible source
files (no addition to `examples/` or playground); they're a
compile-time preamble, the way primitive type names are pre-known
to the parser.

Authors **can** declare their own generic payloads (e.g., a custom
`payload wrapper(T: carrier) { ... }`), use them postfix
(`customer wrapper`), and use `or` unions inline as well as named
unions. The stdlib types are special only in being pre-declared.

There is no separate `Result<T, E>` type in the stdlib. Its job is
done by the inline `T or E` union form: any function returning
`OrderId or NotFound` participates in `?` propagation through the
`error`-marker mechanism. See [`exception-less.md`](./exception-less.md)
for the full propagation semantics.

### Identity of payload types (structural vs nominal — pinned)

This is the rule the v0 proposal left implicit. It is **load-bearing**
for [`exception-less.md`](./exception-less.md)'s carrier stdlib
phase, so it is pinned here:

- **Payload records are structurally typed** (field-by-field). Two
  declarations with identical field lists are the same type.
- **Payload unions and their variants are nominally tagged.** Two
  unions with the same shape but different variant names are
  different types.

Concretely:

```
payload option(T: carrier) = some(T) | none
payload maybe(T: carrier)  = just(T) | nothing

# int option ≠ int maybe  (different variant names)
# option.map cannot be called on an int maybe value.
```

Three positions were considered:

1. Structurally identical (`Option<int>` ≡ `Maybe<int>`). Maximally
   structural; closest to row-typed languages. Rejected — collides
   with the wire encoding's `kind` discriminator (which uses the
   variant name) and forces structural-equivalence search at
   monomorphization.
2. **Variant-name-tagged, structurally distinct** (the chosen rule).
   Closest to Rust / .NET sealed records / Phoenix tagged tuples.
   Matches every backend's idiom, matches the wire discriminator,
   keeps monomorphization mechanical.
3. Structural up to variant positions, ignoring names. Awkward
   middle ground; rejected.

This means **payload typing is "structural for records, nominal for
unions"** — a coherent hybrid. The structural-ness still earns its
keep: two declarations of `payload Address { street: string, city:
string }` *are* the same type (no nominal registry); but `option`
and a user-declared `maybe` are distinct (the variant tag is part
of the identity).

### Generics on payloads

Generic payloads are declared with a parenthesised type-parameter
list at the declaration site, instantiated with ML-postfix at use
sites:

```
payload envelope(P: carrier) {
  id: string
  ts: datetime
  body: P
}

payload page(T: carrier) {
  items: T[]
  total: int
  cursor: string?
}

# Use sites — ML-postfix:
let env: order_placed envelope = ...
let p:   customer page         = ...
```

**Bounded by `: carrier` only.** The universe is closed — every type
parameter is itself a carrier. This avoids the "what is a value type?"
question that opens up full structural subtyping.

There is **no built-in `Result<T, E>`** type. The role of Result is
covered by anonymous `or` unions; see below.

### Discriminated unions on payloads

Two forms, both compile to the same IR shape:

**Named unions** — declared up-front, identity by name, reusable:

```
payload OrderEvent = OrderPlaced | OrderCancelled | OrderShipped
```

**Anonymous `or` unions** — inline in type positions, no declaration
needed, identity structural-on-variants (associative-commutative):

```
operation placeOrder(...): OrderId or NotFound or OutOfStock {
  ...
}
```

`A or B or C` is exactly equivalent to a named union
`payload Foo = A | B | C` at the type-system level — same tagged
wire encoding, same exhaustiveness checking. The choice is
ergonomic: named for reuse and documentation; anonymous when the
union appears once in a return type and naming it would be
ceremony.

**Tagged wire.** The discriminator is the variant's name
(serialized as a `kind` field on the wire by default — see open
question on discriminator field name). Frontend TypeScript narrows
on the discriminator naturally. C# emits using `JsonDerivedType`
polymorphic JSON. Phoenix uses a tagged map on the wire (plain Ecto/Phoenix).

For HTTP operation returns specifically, the api surface translates
error variants into RFC 7807 ProblemDetails responses (status code
from the per-api status mapping or stdlib defaults; body is a
ProblemDetails JSON object). Success responses carry the success
variant's data directly with HTTP 200 — no `kind` envelope. See
[`exception-less.md`](./exception-less.md) §"API-edge
ProblemDetails translation" for the lowering.

Case-matching on a union (named or anonymous):
```
match event {
  OrderPlaced -> { ... }
  OrderCancelled -> { ... }
  OrderShipped -> { ... }
}
```
Validator enforces exhaustiveness (every variant must be matched
unless `_` fallback used).

**Constraint on variants**: each variant must be a distinct type.
`string or string` is rejected (`loom.union-duplicate-variant`).
This keeps the discriminator unambiguous on the wire.

**Associativity / commutativity of `or`**: `(A or B) or C` ≡
`A or (B or C)` ≡ `A or B or C`. Order is significant for *reading*
(authors typically list success variants first, error variants last,
just as a convention) but not for *typing*. The variant set is what
matters; `A or B` and `B or A` are the same type.

### Cross-cutting concerns target payloads

```
authorize for PaymentRequest {
  # Any payload of type PaymentRequest, regardless of which operation carries it
  requires currentUser.permissions.contains(permissions.paymentsExecute)
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

| Today's pain | With payload + generics + `or` |
|---|---|
| Pagination is per-aggregate | `payload page(T: carrier) { ... }` once; every find returns `XWire page` |
| No success/error wrapper | Operations return `OrderId or NotFound or OutOfStock` directly; no Result envelope. See exception-less.md |
| Event streams aren't typed | `payload OrderEvent = OrderPlaced \| OrderCancelled` (named) OR `OrderPlaced or OrderCancelled` (inline) |
| Cross-cutting validation per-op | `validate for X` once; applies wherever X flows |
| GraphQL union types not expressible | Falls out of discriminated unions (named or inline) |
| Per-aggregate macros for envelope shapes | `XWire envelope` instantiated where needed |
| Event sourcing requires hand-rolled types | `payload <Agg>Event = <variant list>` first-class |
| Multi-aggregate response shapes | Compose with generic payloads + `or`, no per-site DTO |
| `Optional<T>` as a separate type | Subsumed by `T option` + `command`-keyword PATCH semantic (see partial-update.md) |

## Alternatives considered (and why they're worse)

### Alt 1: Just add generics to aggregates

Reject. Generics on aggregates force every backend ORM to handle
parameterized storage types:
- TS / Drizzle: structural — relatively easy.
- C# / EF Core: nominal with reified generics, but storage mapping
  needs per-instantiation tables (TPC-style for every generic
  param). Quickly becomes "how do we store `Wrapper<Customer>` vs
  `Wrapper<Order>`?"
- Phoenix: Elixir has no compile-time parametric polymorphism at the
  struct/schema level.

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

### Alt 5: Use `: payload` as the generic bound (v0 of this proposal)

Reject. Locks out the most ergonomic instantiations — `int option`,
`money option`, `int page`. Forces authors to wrap primitives in
payload boxes (`payload IntBox { value: int }`) just to satisfy
the bound. The widening to `: carrier` covers every ergonomic case
without opening the type universe up to full structural subtyping
(the bound is still a closed set; "any value type" / row-poly bounds
remain deferred to v2).

### Alt 6: Keep `Result<T, E>` as a named carrier in the stdlib (v1 of this proposal)

Reject. With anonymous `or` unions in the language, `Result<T, E>`
is just `T or E` directly. The Ok/Err variant wrapping is pure
ceremony — it double-tags values on the wire and forces authors
to write `Ok { value: ... }` / `Err { error: ... }` constructors
when the type itself already carries the variant. Dropping the
Result envelope:

- Removes one stdlib type and two helper variants (`Ok<T>`, `Err<E>`).
- Drops wire weight (no `{ "kind": "Ok", "value": ... }` wrapping;
  just the variant directly).
- Generalises trivially to multi-error returns
  (`OrderId or NotFound or OutOfStock or Forbidden`) without
  Either-style nesting.

The cost is dropping a familiar name. Worth it.

## Migration path

Step-by-step compatibility:

1. **Phase 1**: introduce `payload` keyword + the **five** sugar
   keywords (`event`, `command`, `query`, `response`, `error`) all
   becoming `extends payload` automatically in IR enrichment. **No
   user .ddd file changes required** for the first four; `error`
   is new.
2. **Phase 2**: introduce explicit named wire shapes
   (`payload <Agg>Wire extends payload`) auto-synthesized per
   aggregate. **No user code change**; backend emission unchanged.
3. **Phase 3**: introduce generics on payloads, bounded by
   `: carrier`. Authors can declare `payload page(T: carrier)`,
   `payload envelope(P: carrier)`, etc. ML-postfix at use sites
   (`customer page`, `event envelope`). **Opt-in**; existing code
   doesn't use generics, unchanged. Includes the variant-name-tagged
   identity rule (see §"Identity of payload types").
4. **Phase 4**: introduce discriminated unions — both **named**
   (`payload Foo = A | B`) AND **anonymous `or` unions** (`A or B`
   inline in type positions). Validator enforces exhaustive
   matching (or `_` fallback) for both forms. **Opt-in**.
5. **Phase 5**: introduce `validate for X` / `authorize for X`
   targeting payload types. **Opt-in**; existing operation-level
   rules continue to work.

Each phase is independently shippable. Phase 1+2 deliver naming
(immediate clarity win); Phase 3 is the type-system lift; Phase 4
adds the union surface (both forms); Phase 5 adds cross-cutting.
**Phase 3 + 4 are the prerequisites for
[`exception-less.md`](./exception-less.md)**, which defines phases
A1–A7 on top.

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
  - Elixir: typespecs only (Elixir has no compile-time
    parametric polymorphism). Easy.
  - React / TS frontend: gets generic types natively. Trivial.
- **Aggregate-as-carrier projection.** Phase 3 must thread the
  projection from `T = Aggregate` to `T's wire shape` through every
  union arm during lowering. Net change is small (one IR enrichment
  hook), but the rule has to be uniform across backends.
- **Two parallel ladders.** Aggregates and payloads coexist.
  Documentation has to explain when to reach for each (state vs
  transport). Risk of user confusion — mitigated by clear examples
  in `docs/language.md`.
- **Macro stdlib overlap.** Some current macros become obsolete
  once `page` etc. are first-class. Migration story for existing
  user-authored macros that emit payload-like shapes.
- **`or` precedence with `option`.** `string option` (postfix) must
  bind tighter than `or` (sum), so `string option or none` parses
  as `(string option) or none` — but that's just `string option`
  with redundancy. The real ambiguity is `string or int option`:
  parses as `string or (int option)`, NOT `(string or int) option`.
  Pin: postfix type constructors bind tighter than `or`. Author
  uses parens for the rare other reading.

## What's deferred

- **Aggregates with generics.** Out of scope. Narrow surface stays.
- **Row polymorphism / structural subtyping over payloads.** v2
  conversation. Bounded params (`(T: carrier)`) cover common cases.
- **Type-class-like abstractions (`payload with Serializable`).**
  v2 conversation. Capabilities-as-marker (`implements`) handles
  cross-cutting today.
- **Bounds beyond `: carrier`.** Just `: carrier` for v1 to keep the
  type system closed. Generalising to "any value type" bounds is v2.
- **Carrier-generic user-authored functions** (writing your own
  `page` helpers). Tracked as A7b in
  [`exception-less.md`](./exception-less.md). v1 ships only the
  blessed closed set of carrier helpers (A7a there).
- **Multi-parameter postfix type constructors.** ML-postfix scales
  trivially for one parameter (`T option`); multi-parameter cases
  (a hypothetical `(K, V) map`) would require either tuple-prefix
  syntax or named-args. v1 has no multi-parameter carriers (since
  `or` covers the `Result<T, E>` two-arg case directly). Defer.

## Open questions (need human input)

- **Single `payload` concept vs five keywords?** Current proposal:
  keep `event` / `command` / `query` / `response` / `error` keywords
  for clarity, treat `extends payload` as compiler-inferred.
  Alternative: drop the sugar keywords; force authors to write
  `payload Foo { ... }` and use a `kind: 'event' | 'command' | ...`
  discriminator. Lean toward keeping sugar — keyword semantics carry
  intent, and `error`'s additional behaviour (`?` propagation
  participation) earns its keyword.
- **Naming**: `payload` vs `message` vs `dto`. `payload`
  transport-neutral; `message` carries Akka/Erlang baggage; `dto`
  reads Java-y. Open.
- **Carrier bound name**: `carrier` vs `value` vs `data`. Lean
  `carrier` because it reads transport-neutral and doesn't collide
  with DDD's "value type" (which already means VO). Open for naming
  bikeshedding.
- **Aggregate-in-carrier semantics**: handle-inside-process,
  wire-across-boundary (this proposal's pinned choice), vs
  always-wire (simpler, but every domain-code consumer of `some`
  must re-hydrate via `repo.load`). Pinned to the former here;
  revisit if the projection rule turns out to be ambiguous at
  non-HTTP boundaries (queues, persisted snapshots).
- **Discriminator field name for tagged unions**: default `kind`?
  `type`? `_type`? Default `kind`; allow override.
- **Anonymous `or` vs named unions**: when should authors reach
  for which? Recommendation: anonymous `or` for one-off return
  types (the common case in exception-less flow); named unions for
  reusable event/command catalogues that appear in multiple
  positions. Document as a guidance section, not a rule.
- **Naming `none`** — is `none` the right name for the unit type
  used in `T option = T or none`? Alternatives: `unit`, `nothing`,
  `void`, `null` (collides with nullable). Lean `none` because it
  reads naturally in `string option = string or none`. Open.
- **Bounds beyond `: carrier`** for v2 — what's the next bound that
  matters? Likely `: carrier with id` (anything with an id field) to
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
  - This doc (transport layer): payloads, structural records +
    tagged unions, **generics bounded by `: carrier`**.

  The split is deliberate. Read both before implementing either.
  Aggregates stay narrow precisely so payloads can grow.

- [`exception-less.md`](./exception-less.md) — **downstream
  proposal**. Uses Phase 3+4 of this proposal (carrier-bounded
  generics + tagged unions, both named and `or`-anonymous) plus the
  `: carrier` bound widening pinned here, plus the `error` sugar
  keyword introduced here, to deliver the exception-less flow: `?`
  propagation operator, wire-edge status mapping, and re-shaped find
  variants. The carrier-bound widening, the aggregate-as-carrier
  projection rule, the variant-name-tagged identity rule, and the
  anonymous-`or`-unions construct are all load-bearing for
  exception-less; this is why they're pinned in this doc rather than
  left open.

- [`partial-update.md`](./partial-update.md) — **adjacent**.
  Documents the PATCH-style command pattern using `command` +
  `option`-typed fields. Replaces the old `optional-and-partial-update.md`
  which proposed a separate `Optional<T>` type. With this proposal's
  `option` + position-driven wire encoding, `Optional<T>` is
  subsumed; no new type is needed.

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
  `<Agg>Wire payload`, and the projection rule for `customer option`
  → `CustomerWire option` at the wire reuses it directly.
