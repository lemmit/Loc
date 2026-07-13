# Reference-collection set semantics — drop the stored association `ordinal`

**Status: SHIPPED** (#1590; re-verified 2026-07-03). The `X id[]` association
join table carries no `ordinal` on any backend — `tableForAssociation`
(`src/system/migrations-builder.ts`) emits just `(ownerFk, targetFk)` as the
whole-row composite PK, and every backend's ref-collection emitter documents
the set semantics. Value-object collections correctly keep their `(parentFk,
ordinal)` ordering. This file is retained as the design rationale.

## Principle

An `X id[]` reference collection is **contractually a set**: it carries
*membership only, no order*. Two facts follow directly:

1. **Order is a read-time projection, not a storage property.** If a caller
   needs an ordered list of references, they declare an explicit ordering
   field (a `position` / `rank` property) and `sort:` on the read — both
   already first-class in the language. The reference collection itself never
   promises insertion order, so storing one is storing a fiction.
2. **The join row is just its key.** The many-to-many join table's primary key
   is already the `(owner_fk, target_fk)` pair (this is what enforces set
   semantics — each pair is unique, inserts are idempotent). Any *additional*
   column is payload the contract does not justify.

This was settled by the owner when **PR #1580** (which tried to make the
Elixir backend preserve insertion order on `X id[]`) was closed **won't-do**,
and it is pinned in `experience_gathered.md` §8.4 ("`X id[]` is contractually
a set; ordinal is an implementation detail"). **DEBT-13** ("ordered `X id[]`")
is **de-scoped as a non-feature** in
[`../plans/debt-prioritized-backlog.md`](../plans/debt-prioritized-backlog.md).

## What was removed and why

The relational backends (node/Drizzle, .NET/EF+Dapper, Java/JPA,
Python/SQLAlchemy) historically persisted **and `ORDER BY`'d** a nullable
`ordinal` column on every `X id[]` association join table, stamped from the
field's list index. The node save-builder's own comment admitted the smell:

> Set semantics — the wire contract for `Id<T>[]` doesn't promise order — but
> we still write the ordinal column … so it's something deterministic per
> backend.

The **only** thing the stored ordinal bought for a reference collection was a
**deterministic read-back order** (stable reads + cross-backend wire /
conformance parity). That determinism is a legitimate goal — but a stored
ordinal is the wrong way to get it:

| | Stored `ordinal` | `ORDER BY <target_fk>` (adopted) |
|---|---|---|
| Deterministic read-back | yes | yes |
| Needs a column | yes | **no** |
| Needs a write-time stamp | yes | **no** |
| Agrees across out-of-order / partial writes | no (index-dependent) | **yes** (content-addressed by the id) |
| Implies insertion order is meaningful | **yes (false signal)** | no |

Ordering by the **target FK id** is equally deterministic, is
*content-addressed* (every backend agrees on the same order even across
out-of-order or partial writes, because the order is a function of the data,
not of write history), needs no column and no stamp, and stops implying that
insertion order is meaningful.

So the cleanup, applied identically on all five backends:

- **Schema / migration** — drop the `ordinal` column from `X id[]` association
  join tables. The shared `MigrationsIR` join table (`tableForAssociation` in
  `src/system/migrations-builder.ts`) now has just the two FK columns + the
  `(owner_fk, target_fk)` composite PK + the reverse-membership index. Every
  backend's own schema emitter follows (Drizzle `db/schema.ts`, EF join entity
  + Dapper DDL, JPA `@ElementCollection`, SQLAlchemy join model).
- **Write** — stop stamping `ordinal` on join inserts; the plain composite-PK
  upsert/insert stays (node `onConflictDoNothing`, .NET add-if-absent, Dapper
  `INSERT (owner, target)`, Python `on_conflict_do_nothing`). Java's
  `@ElementCollection` write needs no manual path.
- **Read** — order the association read by the **target FK id** on every
  backend that reads the join: node Drizzle `.orderBy(<targetFk>)`, .NET EF
  `.OrderBy(j => j.<TargetProp>)` + Dapper `ORDER BY <target_fk>`, Java JPA
  `@OrderBy` (no argument → orders by the element value, i.e. the target id),
  Python `.order_by(<TargetFk>)`, Elixir `many_to_many` `preload_order:
  [asc: :id]` (orders by the target row's `:id`).

One deterministic order key — the **target FK id** — applied identically on
all five, so the cross-backend conformance-parity wire diff stays green.

## Carve-out — value-object collections KEEP their `ordinal`

This change touches **only** `X id[]` reference-collection association joins.
It does **not** touch **value-object collections** (inline, identity-less VOs
in a child table, e.g. `lines: LineItem[]`).

A value-object collection's child table is keyed by `(parent_id, ordinal)` —
the `ordinal` is **part of its primary key** and the *only* way to store an
ordered, duplicate-allowing list of identity-less elements. There is no target
id to order by (the elements have no identity), so the ordinal is load-bearing
state, not a denormalised cache. Those tables, their `ordinal` columns, and
their `ORDER BY ordinal` reads are left entirely unchanged.

The two are easy to confuse in the emitters because both used the name
`ordinal`. The distinguishing facts:

| | `X id[]` association join (changed) | `<VO>[]` value collection (unchanged) |
|---|---|---|
| `ordinal` role | nullable payload, `default 0` | non-nullable, **in the PK** |
| Primary key | `(owner_fk, target_fk)` | `(parent_fk, ordinal)` |
| Elements have identity | yes (a target aggregate id) | no |
| Order is meaningful | no (it's a set) | yes (declared list order) |
| Read order key | target FK id | `ordinal` |

## Why this is safe

- The join PK was already `(owner_fk, target_fk)`, so set semantics — and
  insert idempotency — never depended on the ordinal.
- The wire contract for `Id<T>[]` never promised order, so no consumer can
  observe a behaviour change beyond "the stable read order is now the target
  id instead of the (never-promised) insertion order".
- This change is **intentionally output-changing** — the byte-identical
  generator gates diff (unlike a pure refactor), and the affected generator
  tests + association fixtures were updated to the new `ORDER BY <target_fk>`
  form. Value-collection fixtures are untouched.

## References

- **PR #1580** — closed won't-do (the Elixir insertion-order attempt).
- `experience_gathered.md` **§8.4** — "`X id[]` is contractually a set;
  ordinal is an implementation detail" (now records the association-join
  ordinal was dropped).
- [`../plans/debt-prioritized-backlog.md`](../plans/debt-prioritized-backlog.md)
  — **DEBT-13** de-scoped as a non-feature.
