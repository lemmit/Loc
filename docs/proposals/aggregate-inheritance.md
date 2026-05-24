# Aggregate inheritance and storage strategies

> Status: proposal. Captures a design discussion about whether (and how) to
> add inheritance to Loom's aggregate model. Recommends: ship abstract
> aggregates with two storage strategies (`shared`, `own`) + optional
> per-concrete override; treat the TPT shape as expressible via existing
> composition primitives (`contains`) rather than as a third strategy.

## Problem

Loom aggregates today are flat. Domains that want to express shared
structure ("Customer is-a Party", "Employee is-a Party", "Vendor is-a
Party") have three workarounds, none of which carry the same weight as
first-class inheritance:

- **Copy fields per aggregate.** No DRY. The shared shape exists in the
  author's head but not in the source.
- **Macros (`with X`).** Work for cross-cutting concerns (`auditable`,
  `softDeletable`) but each new shared pattern needs TS-authored macro
  infrastructure. Doesn't scale.
- **Marker capabilities (`implements "..."`).** Name-based, not type-based.
  Useful but limited.

As the macro stdlib crosses a handful of patterns, the question becomes:
should the DSL get a first-class way to express "this aggregate IS A more
general thing"?

## Goals

- Field / invariant / operation inheritance from a base shape.
- Polymorphic references (`Party id` covering Customer + Supplier) where
  the domain actually wants them.
- Operational control over storage (read-perf trade-offs are
  domain-knowledge, not toolchain-knowledge).
- Cross-backend support across the four targets (TS/Hono+Drizzle,
  .NET/EF Core, Phoenix/Ash, React).

## Non-goals

- Multiple inheritance, mixins, diamond resolution.
- Deep hierarchies (>2 levels in practice).
- Polymorphic method dispatch with overriding.
- Type narrowing on inheritance discriminators in DSL surface syntax.

## The single constraint that simplifies the rest: always abstract

**Base types are always abstract — they can never be instantiated.**

This rules out:

- "Should the base have its own rows?" → no.
- "What happens to base rows when promoted to a subtype?" → N/A.
- "Can a row's concrete type change?" → N/A.

Concrete consequences:

- Abstract aggregates have no repository.
- Abstract aggregates have no `id` of their own (they share each
  concrete's id namespace via the storage strategy).
- The validator rejects "instantiate abstract" attempts at any level
  (DSL surface, IR, backend emission).

## The trilemma every ORM solves badly

Storage strategies for inheritance:

| Strategy | Shape | Read base | Read concrete | FK to base | Schema additions |
|---|---|---|---|---|---|
| TPH (one table, discriminator) | wide table, many nullable cols | trivial | trivial | trivial | wide table grows |
| TPC (per-concrete tables) | duplicated cols across tables | UNION ALL | trivial | hard | duplicated everywhere |
| TPT (base + per-concrete joined) | normalized | trivial | JOIN | trivial | base table |

Every ORM that ships all three (EF Core, Hibernate) treats one as "the
default" and the others as expert escape hatches. Industry usage when
inheritance is modeled at all: roughly TPH ~50-60%, TPC ~30-35%, TPT
~10-15%. TPT is the least used because it offers the worst day-1 read
perf (JOIN on every concrete fetch) without a compensating win unless
the hierarchy is genuinely deep.

## Recommended menu

Ship two storage strategies on abstract aggregates. Express the third
(TPT) shape via existing composition primitives.

### `storage: shared` (TPH)

```
abstract aggregate Party storage: shared {
  name: string
  email: string
}
aggregate Customer extends Party { creditLimit: Money }
aggregate Supplier extends Party { taxId: string }
```

Generated:

- One `parties` table with `name`, `email`, `kind` (discriminator),
  `credit_limit` (nullable), `tax_id` (nullable).
- `Party id` refs target `parties.id` directly.
- "Find all parties" = single indexed scan.
- "Find all Customers" = filtered scan on `kind = 'customer'`.

When to use: shared fields dominate, base-type queries are common,
polymorphic `Party id` refs are needed.

### `storage: own` (TPC)

```
abstract aggregate Party storage: own {
  name: string
  email: string
}
aggregate Customer extends Party { creditLimit: Money }
aggregate LegacyVendor extends Party { fiftyObscureFields: ... }
```

Generated:

- `customers` table: id, name, email, credit_limit.
- `legacy_vendors` table: id, name, email, fifty_obscure_fields...
- No `parties` table.
- "Find all parties" = `UNION ALL` projection across concrete tables.
  Mechanical to generate per backend.
- `Party id` refs are forbidden (the FK would target multiple tables).
  Validator error pointing at the reference, with fix-it: "use
  `Customer id` / `LegacyVendor id` explicitly, or change to
  `storage: shared`."

When to use: concrete tables have wildly different shapes; lifecycle
independence matters; no cross-variant `Party id` references needed.

### Per-concrete override

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

Mixed strategies tighten the validator:

- `Party id` requires *all* concretes to be `storage: shared`. Any `own`
  sibling → reject at the reference site, with the offending sibling
  named in the diagnostic.
- "Find all parties" on a mixed hierarchy = `UNION ALL` of `parties`
  (filtered to shared concretes) + own-table projections. Mechanical
  but worth a perf warning in the docs.

When to use: operational tier mismatch between siblings (hot vs cold,
narrow vs wide schemas).

### TPT shape via composition (no third storage strategy)

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

Tables that emerge:

- `parties` — TPH base, shared fields.
- `credit_accounts`, `shipping_addresses` — owned by Customer.
- `vendor_contracts`, `payment_terms` — owned by Supplier.

Semantics:

- Read Party — single table scan, no joins.
- Read `customer.creditAccount.balance` — JOIN on demand.
- `Party id` refs — trivial (single base table).
- Each concrete owns its specialized data through `contains`, which
  already has well-defined semantics (cascade delete, transaction
  boundaries, wire-shape inclusion).

This is strictly *more expressive* than literal TPT:

- TPT gives you exactly one extension table per subtype with flat
  columns.
- Composition gives you N owned sub-aggregates per concrete, each with
  its own internal structure, invariants, and optional fields.
- Optional extensions (`contains creditAccount: CreditAccount?` from
  #477) are first-class — orthogonal to "is this party a Customer."

No new IR concept needed. The `contains` mechanic and optional
containment from #477 cover this. The "TPT storage strategy" question
disappears entirely.

## Validator rules

Triggered by the storage strategy on the abstract base and per-concrete
overrides:

| Reference / operation | All `shared` | All `own` | Mixed |
|---|---|---|---|
| `Party id` from other aggregate | ✅ | ❌ "all concretes must be `shared`" | ❌ same |
| `find all Party` / `view of Party` | ✅ single scan | ✅ UNION ALL (with perf warning at threshold) | ✅ UNION ALL (mixed projection) |
| Filter on base-only field | ✅ | ✅ pushed into each arm | ✅ |
| Filter on subtype-only field | ✅ (nullable col) | ✅ (only that arm queried) | ✅ |
| `operation X() on Party` | ⚠️ deferred (likely forbid — no abstract operations in v1) | same | same |

## Per-backend mapping

| Backend | `shared` | `own` |
|---|---|---|
| .NET / EF Core | TPH native (`HasDiscriminator`) | TPC native (`UseTpcMappingStrategy`) |
| Hono / Drizzle | hand-rolled (discriminator column + tagged-union response) | trivial (separate tables) |
| Phoenix / Ash | embedded resources or `tagged_unions` | trivial (separate resources) |
| React / TS | wire-shape carries `kind` discriminator (union type) | wire-shape per concrete (no discriminator needed) |

UNION ALL emission for `find all Party` on `own` storage:

- Drizzle: `unionAll()` operator.
- EF Core: `query1.Concat(query2)` produces UNION ALL.
- Ash / Ecto: `Ecto.Query.union_all/2` on schemas.

## What's deferred

- **TPT as a first-class strategy.** Composition covers the same shape
  better. Add only if a use case can't be modeled with composition.
- **Multiple inheritance / mixins.** Macros remain the answer for
  cross-cutting capabilities.
- **Polymorphic method dispatch.** No `operation X() on Party` that
  dispatches per concrete; write per-concrete operations explicitly.
- **Deep hierarchies (3+ levels).** Two-level recommendation; not
  enforced but documented as the sweet spot.
- **Schema migration tooling for strategy changes.** `shared` → `own`
  is a table split; `own` → `shared` is a merge. Both require manual
  data migration; the generator emits the new schema and a migration
  warning.

## Open questions

- Should `storage` be settable on the concrete subtype only, or also at
  the abstract base as a default? Current proposal: base as default,
  concrete as optional override.
- Discriminator column name surface: default `kind`; allow
  `storage: shared discriminator: type`? Probably not in v1.
- Naming bikeshed: `shared` / `own` are concise; alternatives
  `inherited` / `independent`, `pooled` / `separate`. Open.
- Validator fix-it for `Party id` on `own` storage: auto-applicable as
  a codemod? Nice-to-have.

## Related work

- #466 — macro system; macros remain the answer for cross-cutting
  capabilities (`auditable`, `softDeletable`).
- #477 — optional containment (`contains X?`); enables the TPT-shape
  via composition pattern.
- `docs/proposals/payload-transport-layer.md` — sister proposal
  addressing the *transport* layer (events, commands, queries) with
  generics. Both proposals split the type system into a state ladder
  (this doc) and a transport ladder (sister doc).
