# Aggregate inheritance and storage strategies

> **[2026-06-20 status audit]** Backend count understated — TPC/TPH now on FIVE DB backends: `TPH_CAPABLE = {node, dotnet, elixir, python, java}` (`system-checks.ts:~1230`); Python `python/emit/schema.ts`, Java `java/emit/entity.ts` emit TPH.

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only, and `foundation: ash` is now a validation error. The Phoenix/Ash emission details below — `Ash.Domain`, Ash shared-table multi-resource — describe output that no longer exists; the elixir backend now emits the equivalent over plain Ecto.)**

> Status: **I1–I3 shipped** — surface, both storage strategies, and the
> polymorphic read path.  This proposal is now reference-documented in
> [`../inheritance.md`](../../inheritance.md); the design discussion below is
> retained for rationale and the deferred patterns.
>
> - **I1** — `abstract aggregate`, `extends <Base>`, and the
>   `inheritanceUsing(sharedTable | ownTable)` header modifier parse, lower, and
>   validate (`loom.extends-non-abstract`, `loom.extends-self`,
>   `loom.inheritance-modifier-misplaced`, `loom.abstract-aggregate-behavior`,
>   `loom.abstract-repository`, D-ES-TPH `loom.es-tph-forced-own-table`).
> - **I2 foundation** — enrichment merges a concrete's inherited base fields
>   into its `wireShape` (base fields after `id`, then own; own shadows a
>   like-named base field), so every backend DTO carries the shared shape.
> - **I3 — `ownTable`/TPC, all five backends** — abstract base dropped from each
>   backend's table emission; each concrete a standalone table carrying the
>   merged fields.  Polymorphic `find all <Base>` read home on node/Hono, .NET
>   (abstract C# base + `Ignore<Base>()` + delegating reader → `IReadOnlyList<Base>`),
>   and Phoenix (`list_<bases>!/0` on the Ash.Domain).  `Base id` refs rejected
>   (`loom.polymorphic-id-ref-unsupported`).
> - **I2 — `sharedTable`/TPH, all five backends** — one shared table + `kind`
>   discriminator + nullable per-concrete columns; `Base id` refs + base reader
>   supported.  Emits on node/Hono (`kind` column), .NET (EF Core
>   `HasDiscriminator`), and Phoenix (Ash shared-table multi-resource +
>   `base_filter`, see [`phoenix-tph-emission.md`](./phoenix-tph-emission.md)).
>   A TPH hierarchy with no node/.NET/Phoenix host is an IR-validate error.
> - **Gated corners** — mixed strategy (Pattern 3:
>   `loom.tph-own-override-unsupported` / `loom.polymorphic-id-ref-mixed-strategy`)
>   and `contains` on a TPH concrete (Pattern 4: `loom.tph-contains-unsupported`)
>   are rejected, not emitted.
>
> **Deferred**: Patterns 3 and 4. (TPH now ships on all five backends; React is
> N/A — the frontend consumes the concrete wire shapes, not storage.)
>
> **Sister proposal**:
> [`payload-transport-layer.md`](./payload-transport-layer.md) — they together
> split the type system along two axes (state vs transport). Read both
> before implementing either.

> **Pinned-decision alignment** (see [`docs/decisions.md`](../../decisions.md)):
> **D-RENAME**, as amended by **D-DOCUMENT-AXIS §4**, supersedes the
> `storage: shared | own` header clause used throughout this doc. Read
> every `storage: shared` / `storage: own` below as the paren header
> modifier **`inheritanceUsing(sharedTable)`** / **`inheritanceUsing(ownTable)`**
> (key renamed `inheritanceStrategy` → `inheritanceUsing`; colon → paren;
> values respelled `shareTable` → `sharedTable`). The event-sourcing
> marker is **`persistedAs(eventLog)`** (D-DOCUMENT-AXIS), so D-ES-TPH
> reads: a `persistedAs(eventLog)` concrete of a `sharedTable` base is
> forced to `inheritanceUsing(ownTable)`.

## TL;DR

Today aggregates are flat. There's no first-class way to say "Customer
is-a Party". The macro stdlib (`with audit`, `with softDeletable`) is
the current escape hatch but doesn't scale.

**Proposed**: ship **abstract aggregates** with two storage strategies
(`shared` and `own`), an optional per-concrete override, and a
documented pattern for the TPT-shape using existing composition
(`contains`) primitives. Generics stay out — they live on payloads
(see sister proposal).

| Pattern | When to use | New primitive? |
|---|---|---|
| Abstract aggregate + `shared` | "Customer is-a Party", base-type queries common, `Party id` refs needed | Yes |
| Abstract aggregate + `own` | "Customer is-a Party", lifecycle independence matters, no cross-variant refs | Yes |
| Abstract aggregate + per-concrete override | Operational tier mismatch (hot vs cold siblings) | Yes (validator constraints) |
| Abstract aggregate + `contains` parts | "TPT shape" — shared base + per-concrete specialized data | No (uses existing `contains` from #477) |
| Plain aggregates + `Party id` reference | No inheritance needed; specialization is a relationship | No (works today) |

This doc proposes the *first three* and *documents the last two as
patterns*.

## Why this matters (the problem)

### Today's pain

A domain that wants "Customer is-a Party, Supplier is-a Party,
Employee is-a Party" has three options in current Loom:

1. **Copy `name`, `email`, `phone`, etc. into every concrete
   aggregate.** No DRY. Multiplied by every backend's emitted code
   (TS interface, C# record, Ecto schema, React form), every shared
   field becomes ~10-15 lines of duplicated emission per concrete.
2. **Author a macro** (`with party` in `src/stdlib/party.macro.ts`)
   that injects the fields. Works, but each new shared pattern needs
   TypeScript-authored generator code. Doesn't compose with
   user-authored macros without exposing the macro API surface
   publicly.
3. **`implements "party"` marker capability.** Name-based, not
   type-based. The validator can't check that a `Party id` reference
   resolves to "any aggregate implementing party." Capabilities work
   for cross-cutting concerns (audit, soft-delete) but can't express
   "this aggregate IS A more general thing with shared fields."

The pressure has been building. Five macros in the stdlib so far
(`auditable`, `softDeletable`, `softDeleteByDefault`, `scaffold`,
`crudish`). Each new shared-shape pattern needs another. At ~15
macros the stdlib becomes a maintenance burden and the "I want my own
shared shape" user complaint becomes unavoidable.

### What this proposal solves

A first-class way to say "this aggregate IS A more general thing,
share its fields, and let me reference any instance polymorphically
via `Party id`." Without giving up:
- The narrow DSL surface (no generics on aggregates).
- DDD modeling discipline (no virtual dispatch, no overriding, no
  diamond inheritance).
- Cross-backend portability (the four target ORMs handle inheritance
  very differently; only the simplest strategies translate well).

### What this proposal explicitly does NOT solve

- **Cross-cutting concerns that aren't fields-sharing.** `auditable` /
  `softDeletable` stay macros. Inheritance is for shape, not for
  capabilities.
- **Generic data containers.** `T envelope`, `T page`, anonymous
  `T or E` unions — those are payload-layer concerns, see sister
  proposal.
- **Type narrowing in DSL expressions.** `if customer extends Party`
  doesn't introduce a typed binding in operation bodies.

## The single constraint that simplifies the rest: always abstract

**Base types are always abstract — they can never be instantiated.**

This rules out:
- "Should the base have its own rows?" → no, the base has no table of
  its own under `own`; under `shared` the base table only ever holds
  rows of some concrete type.
- "What happens to base rows when promoted to a subtype?" → N/A; bases
  never have rows.
- "Can a row's concrete type change?" → N/A; rows are always created
  as a concrete type and stay that way.

Concrete consequences:
- Abstract aggregates have no repository (`repository Parties for
  Party` rejected by validator).
- Abstract aggregates have no `id` namespace of their own (they share
  each concrete's id namespace via the storage strategy).
- `aggregate Foo extends Party` where `Party` is non-abstract is
  rejected (the only thing you can extend is an abstract).
- Instantiation attempts (`Party.new(...)`) are rejected at any level:
  DSL surface, IR, backend emission.

This is the design choice that lets Loom skip ~80% of the questions
ORM inheritance machinery has to answer.

## The trilemma every ORM solves badly

Storage strategies for inheritance, with their honest trade-offs:

| Strategy | Shape | Read base | Read concrete | FK to base | Schema additions |
|---|---|---|---|---|---|
| **TPH** (Table-per-Hierarchy, one table + discriminator) | wide table, many nullable cols | trivial single scan | trivial (`WHERE kind = ?`) | trivial (single base table to reference) | wide table grows |
| **TPC** (Table-per-Concrete, no base table) | duplicated cols across tables | `UNION ALL` across concretes | trivial single-table | hard (FK target ambiguous across N tables) | duplicated everywhere |
| **TPT** (Table-per-Type, base + per-concrete joined) | normalized | trivial single scan on base | JOIN base + concrete | trivial (single base table) | base table |

Every ORM that ships all three (EF Core, Hibernate) treats one as
"the default" and the others as expert escape hatches. Loom would
inherit that complexity.

### Real-world usage frequency

When inheritance is modeled at all (most OLTP schemas just use flat
tables and skip the question entirely):

| Strategy | Share | Where it dominates |
|---|---|---|
| TPH | ~50-60% | EF Core / Hibernate / Rails (Single Table Inheritance is TPH). The "default" most people reach for. |
| TPC | ~30-35% | Anything outside EF / Hibernate. Ecto / Drizzle / Prisma have no inheritance machinery, so users end up at TPC by accident. |
| TPT | ~10-15% | Niche. Deep hierarchies where normalization pressure beats the JOIN cost. Most teams who try TPT later regret the read overhead. |

TPT is least common because it offers the worst day-1 read perf
(JOIN on every concrete fetch) without a compensating win unless the
hierarchy is genuinely deep and field-heavy.

## Recommended menu

Ship two storage strategies on abstract aggregates (`shared` / `own`)
plus per-concrete override. The TPT-shape and reference-only patterns
are documented as compositions of existing primitives — no third
strategy.

### Pattern 1: `storage: shared` (TPH-equivalent)

```
abstract aggregate Party storage: shared {
  name: string
  email: string
}
aggregate Customer extends Party { creditLimit: Money }
aggregate Supplier extends Party { taxId: string }
```

**Generated tables**:
- `parties (id, kind, name, email, credit_limit nullable, tax_id nullable)`.

**Semantics**:
- `Party id` refs target `parties.id` directly. Single FK target.
- `find all Party` → single indexed table scan.
- `find all Customer` → `WHERE kind = 'customer'`.
- Insert / update / delete a Customer → single-table operation on
  `parties` with `kind = 'customer'`.

**When to use**: shared fields dominate the row width; base-type
queries are common; polymorphic `Party id` refs are needed from other
aggregates.

**Cost**: nullable columns multiply with subtype count. With 5
subtypes each adding 3 own fields, the parties table is 15 nullable
columns wide. Postgres handles this fine; what you lose is column-level
documentation discipline.

### Pattern 2: `storage: own` (TPC-equivalent)

```
abstract aggregate Party storage: own {
  name: string
  email: string
}
aggregate Customer extends Party { creditLimit: Money }
aggregate Supplier extends Party { taxId: string }
```

**Generated tables**:
- `customers (id, name, email, credit_limit)`.
- `suppliers (id, name, email, tax_id)`.
- No `parties` table.

**Semantics**:
- `Party id` refs are **forbidden** (FK target ambiguous). Validator
  rejects with: *"`Party id` cannot reference a `storage: own` base.
  Use `Customer id` / `Supplier id` explicitly, or change Party to
  `storage: shared`."*
- `find all Party` → `UNION ALL` projection of base fields across
  all concrete tables. Mechanical to emit per backend.
- Insert / update / delete on Customer → single-table operation on
  `customers`. Same for Supplier on `suppliers`.

**When to use**: concrete tables have wildly different schemas;
lifecycle independence matters; no cross-variant `Party id`
references needed.

**Cost**: shared field changes touch every concrete table (5
subtypes = 5 ALTER TABLEs for one new shared field). Migration
complexity grows linearly with subtype count.

### Pattern 3: per-concrete override

```
abstract aggregate Party storage: shared {
  name: string
  email: string
}
aggregate Customer extends Party { creditLimit: Money }       # → parties table
aggregate Supplier extends Party { taxId: string }            # → parties table
aggregate LegacyVendor extends Party storage: own {           # → legacy_vendors
  fiftyObscureFields: ...
}
```

**Semantics**: mixed strategies tighten the validator:
- `Party id` requires *all* concretes to be `storage: shared`. Any
  `own` sibling makes any `Party id` reference fail validation,
  pointing at the offending reference site AND the offending sibling
  in the diagnostic.
- `find all Party` on a mixed hierarchy → `UNION ALL` of `parties`
  (filtered to shared-strategy concretes) + own-table projections.
  Mechanical; warn at >3 own siblings (perf cliff).

**When to use**: operational tier mismatch between siblings.
Concrete example: `Customer` is the read-hot path, queried
constantly, kept narrow; `LegacyVendor` has 50 obscure columns from
a long-ago migration, rarely queried, would bloat the shared table.
Override puts it in its own table while keeping Customer / Supplier
in the shared one.

### Pattern 4: TPT shape via composition (no third strategy)

```
abstract aggregate Party storage: shared {
  name: string
  email: string
}
aggregate Customer extends Party {
  contains creditAccount: CreditAccount
  contains shippingAddress: Address
}
aggregate Supplier extends Party {
  contains contract: VendorContract
  contains paymentTerms: PaymentTerms
}
```

**Generated tables**:
- `parties` — TPH base, shared fields + discriminator.
- `credit_accounts`, `shipping_addresses` — owned by Customer, FK to
  `parties.id`.
- `vendor_contracts`, `payment_terms` — owned by Supplier, FK to
  `parties.id`.

**Semantics**:
- Read Party — single table scan, no joins.
- Read `customer.creditAccount.balance` — JOIN on demand.
- `Party id` refs — trivial (single base table).
- Each concrete owns its specialized data through `contains`, which
  already has well-defined semantics (cascade delete, transaction
  boundaries, wire-shape inclusion).

**Why this beats literal TPT**:
- TPT gives you exactly one extension table per subtype with flat
  columns.
- Composition gives you N owned sub-aggregates per concrete, each
  with its own internal structure, invariants, and optional fields.
- Optional extensions (`contains creditAccount: CreditAccount?` from
  #477) are first-class — orthogonal to "is this party a Customer."
- Each contained part can be its own first-class entity with
  invariants / operations.

**No new IR concept needed.** The `contains` mechanic and optional
containment from #477 cover this. The "TPT storage strategy" question
disappears entirely.

### Pattern 5: no inheritance — Party as plain reference target

```
aggregate Party {
  name: string
  email: string
}
aggregate Customer {
  party: Party id unique
  creditLimit: Money
}
aggregate Supplier {
  party: Party id unique
  taxId: string
}
```

**Generated tables**:
- `parties (id, name, email)` — plain aggregate, no inheritance.
- `customers (id, party_id UNIQUE, credit_limit)`.
- `suppliers (id, party_id UNIQUE, tax_id)`.

**Semantics**: this is *not* inheritance at all. Customer and
Supplier are independent aggregates that *reference* a Party. The
`unique` on the FK enforces 1:1 cardinality (one Customer row per
Party).

- Customer and Supplier have their own ids (`Customer id`, `Supplier
  id`), independent lifecycle, independent repositories.
- The same Party can be both a Customer and a Supplier
  simultaneously — no inheritance forces "exactly one variant."
- `Party id` still works trivially (single parties table).
- No new keywords, no new validator rules. Works in Loom today
  except for the proposed `unique` annotation on the FK field.

**When to use**: when the conceptual frame is "Customer relationship"
rather than "Customer is-a Party." Many domains discover this is
truer than they initially thought — a Customer relationship is
something a Party *has*, not what it *is*.

**Not in this proposal**: the `unique` annotation on `Party id`
fields. Mentioned because it makes this pattern more discoverable;
worth its own small proposal if pursued.

## Decision guidance

Picking between the five patterns:

```
Is the "is-a" framing actually correct (versus "has-a relationship-with-a")?
├── No → Pattern 5 (plain reference, no inheritance)
└── Yes → Do concrete subtypes share most fields with each other?
    ├── Mostly identical → Pattern 1 (storage: shared)
    ├── Wildly different shapes / sizes → Pattern 2 (storage: own)
    ├── Mixed tiers (hot + cold) → Pattern 3 (per-concrete override)
    └── Each concrete has rich specialized data → Pattern 4 (composition)
```

When in doubt, start with Pattern 1 (shared) — it's the simplest
DSL surface and the most performant default. Migrate to Pattern 2 or
4 if the table grows uncomfortably wide.

## Validator rules (concrete)

Triggered by the storage strategy on the abstract base and per-concrete
overrides:

| Reference / operation | All `shared` | All `own` | Mixed |
|---|---|---|---|
| `Party id` from other aggregate | ✅ | ❌ "all concretes must be `shared`" | ❌ same |
| `find all Party` / `view of Party` | ✅ single scan | ✅ UNION ALL (warn at >3 concretes) | ✅ UNION ALL (mixed projection) |
| Filter on base-only field | ✅ | ✅ pushed into each arm | ✅ |
| Filter on subtype-only field | ✅ (nullable col) | ✅ (only that arm queried) | ✅ |
| `repository Parties for Party` | ❌ "abstract aggregate has no repository" | ❌ same | ❌ same |
| `Party.new(...)` (instantiation) | ❌ "abstract aggregate cannot be instantiated" | ❌ same | ❌ same |
| `operation X() on Party` | ⚠️ deferred (v1: forbid — see "what's deferred") | same | same |
| Concrete extending non-abstract aggregate | ❌ "extending requires `abstract aggregate`" | same | same |

## Per-backend mapping

| Backend | `shared` | `own` |
|---|---|---|
| .NET / EF Core | TPH native (`HasDiscriminator<TKey>("kind").HasValue<Customer>("customer")...`) | TPC native (`UseTpcMappingStrategy()`) |
| Hono / Drizzle | hand-rolled discriminator column + tagged-union response type | trivial (separate tables, separate Drizzle schemas) |
| Phoenix / Ecto | shared-table schema with a `kind` discriminator column | trivial (separate Ecto schemas + tables) |
| React / TS | wire-shape carries `kind` discriminator (TS discriminated union) | wire-shape per concrete (no discriminator needed) |

UNION ALL emission for `find all Party` on `own` storage:
- **Drizzle**: `unionAll()` operator on per-concrete selects.
- **EF Core**: `query1.Concat(query2)` on entity queryables produces
  `UNION ALL`.
- **Ecto**: `Ecto.Query.union_all/2` on per-concrete schemas.

## IR shape (sketch)

```typescript
// loom-ir.ts additions
interface AggregateIR {
  // ... existing fields
  abstract?: boolean;                    // base aggregates
  extends?: string;                      // ref to parent aggregate name
  storage?: 'shared' | 'own';            // explicit; default 'shared' if extends
  // ... existing fields
}
```

Validator additions: ~6 rules listed above. ~150 LOC of validator
code estimate. Lowering: ~50 LOC to walk extends-chain when building
wireShape. Backend emission: ~100-200 LOC per backend for the
discriminator emission and UNION generation (smaller for EF Core,
larger for Drizzle/Ecto).

Rough total: ~1000-1500 LOC across the toolchain. Comparable to the
macro system in #466.

## What's deferred (v1 explicitly excludes)

- **TPT as a first-class strategy.** Pattern 4 (composition) covers
  the same shape better. Add only if a use case can't be modeled with
  composition.
- **Multiple inheritance / mixins.** Macros remain the answer for
  cross-cutting capabilities.
- **Polymorphic method dispatch.** No `operation X() on Party` that
  dispatches per concrete. Write per-concrete operations explicitly.
  If/when added, scope to abstract operations declared as
  `abstract operation` on the base, implemented per concrete — never
  with overriding.
- **Deep hierarchies (3+ levels).** Two-level recommendation; not
  enforced by validator but documented as the sweet spot. Three-level
  inheritance in DDD almost always indicates a missed factoring.
- **Schema migration tooling for strategy changes.** `shared` →
  `own` is a table split; `own` → `shared` is a merge. Both require
  manual data migration; the generator emits the new schema and a
  migration warning, not the migration SQL.
- **`unique` annotation on aggregate-id fields** (Pattern 5 dep).
  Mentioned to make Pattern 5 viable; pursue separately.

## Open questions (need human input)

- **Naming**: `shared` / `own` are concise. Alternatives:
  `inherited` / `independent`, `pooled` / `separate`, `flat` / `split`.
  Open.
- **Discriminator column surface**: default `kind`; allow
  `storage: shared discriminator: type`? Probably not in v1; revisit
  if multiple users want the override.
- **Validator fix-it for `Party id` on `own` storage**: auto-applicable
  as a codemod? Nice-to-have, low priority.
- **Storage strategy at the abstract base only** (vs allowing
  per-concrete override): the override adds expressiveness but also
  adds validator complexity. Could ship base-only first and add
  override in a follow-up if real demand exists.

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  **sister proposal**. Splits the type system into two axes:
  - This doc (state layer): aggregates, inheritance, nominal typing,
    no generics.
  - Sister doc (transport layer): payloads, structural typing,
    generics, discriminated unions.
  
  The split is deliberate. Generics on aggregates would force every
  backend to handle parameterized types at the storage layer — a much
  larger undertaking than at the transport layer (where backends
  already serialize JSON uniformly). Read both before implementing
  either.

- #466 — macro system. Macros stay the answer for cross-cutting
  capabilities (`auditable`, `softDeletable`). Inheritance is for
  *fields and identity*, not for capabilities.

- #477 — optional containment (`contains X?`). Enables Pattern 4
  (TPT-shape via composition).

- `docs/old/proposals/observability.md` — same "narrow surface, lean on
  macros for cross-cutting" philosophy that motivated this proposal's
  scope choices.
