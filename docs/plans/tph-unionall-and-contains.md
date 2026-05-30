# Plan: TPH mixed-strategy `find all` (UNION-ALL) + `contains` on a TPH concrete

Status: **proposed** — design note for the two TPH emission features deferred in
PR #749. Both are currently *gated* by validator rules (the surface is honest
today; this plan is about lifting the gates with real emission). Hono/Drizzle
only, matching the rest of the TPH slice.

Companion to [`docs/proposals/aggregate-inheritance.md`](../proposals/aggregate-inheritance.md)
(Patterns 3 and 4). The single source of truth for TPH base/concrete resolution
is `src/generator/typescript/tph.ts`; every emitter already consults it.

---

## Shared groundwork (both features)

Three facts from the current code that both features build on:

1. **The shared table is named for the abstract base** (`parties`), carries
   `id` + `kind` (not-null) + base columns + every concrete's own columns made
   nullable. Emitted by `emit/schema.ts:emitTphTable` (380-406) and mirrored in
   `system/migrations-builder.ts:tphTableForAggregate` (379-422).
2. **A TPH concrete owns no table.** `tableOwnerName(agg, pool)` (tph.ts:60)
   already returns the *base* name for a TPH concrete — repositories use it via
   `repoTableName` (repository-find-builder.ts:34), so reads/writes already
   target `parties` filtered by `kind`.
3. **A TPH concrete is skipped before part/own-table emission.**
   `schema.ts:95` and `migrations-builder.ts:75` `continue` past a TPH concrete,
   so neither its (non-existent) own table nor its parts are emitted.

Both features are fundamentally "stop skipping, and point the derived names at
`tableOwnerName(...)` instead of `agg.name`."

---

## Feature 1 — UNION-ALL `find all Base` over a mixed hierarchy

**Goal:** lift `loom.tph-own-override-unsupported` (inheritance.ts:Rule 4b) and
`loom.polymorphic-id-ref-mixed-strategy` (Rule 6) so a `sharedTable` base may
have some concretes overridden to `inheritanceUsing(ownTable)` (proposal
Pattern 3), with `find all Base` reading the union of the shared table + each
override's own table.

### What already works
- An `ownTable` concrete under a TPH base **already generates a correct,
  type-checking standalone table + repo + routes** (verified during #749 — that
  was why the "dead table" premise was wrong). The *only* hole is that the base
  reader's `findAll` (base-reader-builder.ts:63-66) scans the shared table only,
  so override concretes are invisible to polymorphic reads.

### Changes

1. **Validator (inheritance.ts).** Remove Rule 4b entirely; narrow Rule 6 so a
   mixed hierarchy is *allowed* (drop the `loom.polymorphic-id-ref-mixed-strategy`
   branch). Keep the pure-`ownTable`-base rejection (`...-unsupported`) — that
   one has no single keyable table and stays out of scope.

2. **Base reader `findAll` (base-reader-builder.ts).** Replace the single
   `select().from(shared)` with a Drizzle `unionAll`:
   - Build a normalized projection (id, kind, + the union of all columns the
     hydration needs) from the shared table.
   - `.unionAll(...)` one `select` per override concrete's own table, aliasing
     its columns into the same projection shape and supplying a literal `kind`
     (the override table has no `kind` column — inject `sql\`${name}\`.as("kind")`).
   - Dispatch each row through the existing `hydrate${Base}` switch (it already
     keys on `kind`). `findById` becomes: try shared table by id; if absent,
     fall back to scanning the override tables (or, simpler v1: a `unionAll`
     filtered by id). **Note** the column lists must line up positionally for
     `unionAll` — derive them from `wireShapeFor` so shared and own projections
     are column-compatible.
   - `unionAll` is **not used anywhere in the codebase yet** (greps clean), so
     this is the first consumer — keep the helper local to the base reader.

3. **No schema/migration change.** Override tables already emit (point 1). The
   union is purely a read-side assembly.

### Risks / decisions
- **Column alignment** is the whole game. The override's own table has the
  merged base fields as *not-null* columns and no `kind`; the shared table has
  them not-null and concrete columns nullable. The projection must select a
  consistent ordered column set on both sides. Drive it from `wireShapeFor(base)`
  (the base's wire columns) + an injected `kind` literal; concrete-only columns
  that exist on one side but not the other are the hard part — **v1 restriction:
  the union projection covers base columns + id + kind only; concrete-specific
  columns are loaded by a second per-`kind` pass** (or defer concrete-specific
  columns in the polymorphic union and document that `find all Base` returns the
  base-shaped projection, with concrete fields hydrated via the kind switch
  reading the right table). Decide this before coding — it's the one genuine
  design fork.
- **Perf cliff:** the proposal says warn at >3 override siblings. Add a
  validator *warning* (not error) when an override count crosses the threshold.

### Tests
- IR/validator: mixed hierarchy no longer errors; pure-ownTable-base still does.
- Generator: base reader emits `unionAll`, one arm per override, with the
  injected `kind` literal; `tsc --noEmit` clean on a generated mixed project
  (this is the real gate — the #749 work proved the standalone tables compile,
  so the only new failure surface is the union SQL typing).
- Migration parity unchanged.

---

## Feature 2 — `contains` part on a TPH concrete (join-table-on-shared-table)

**Goal:** lift `loom.tph-contains-unsupported` (inheritance.ts:Rule 4c) so a TPH
concrete may carry a `contains` part (proposal Pattern 4, TPT-shape). The part
gets its own join table FK-ing the **shared** base table.

### Root cause (today)
A contained part's table derives its parent FK from the parent aggregate's name:
- `schema.ts:116` calls `emitTable(part.name, …, agg.name, …)`; `emitTable:428`
  emits `parentId: text("${snake(parentName)}_id")`.
- `migrations-builder.ts:91` calls `tableForPart(part, agg, …)`;
  `tableForPart:427/432` sets `parentFk = ${snake(parent.name)}_id`,
  `refTable = plural(snake(parent.name))`.

For a TPH concrete, `agg.name` is e.g. `Customer`, so the FK points at a
`customers` table that doesn't exist. **And** TPH concretes are skipped before
the part loop ever runs (`schema.ts:95`, `migrations-builder.ts:75`), so the
part table isn't emitted at all → repository references a `schema.<part>` that
was never declared (the 14 `tsc` errors found in #749).

### Changes

1. **Validator (inheritance.ts).** Remove Rule 4c.

2. **Schema (emit/schema.ts).** In `renderSchema`, *before* the
   `isTphConcrete → continue` at line 95, emit the concrete's contained-part
   tables. Route the part's parent name through `tableOwnerName(agg, ctx.aggregates)`
   so the FK column + ref target the shared base table:
   - `emitTable` needs the parent's *table-owner* name, not `agg.name`. Either
     pass `tableOwnerName(agg, pool)` as the `parentName` arg, or thread the pool
     and resolve inside. The part still belongs to the concrete logically; only
     the physical FK target changes.
   - The part table's `parentId` references `parties.id`. Since a part row only
     exists for rows of this concrete's `kind`, no extra discriminator is needed
     on the part table (the parent row already carries `kind`).

3. **Migrations (migrations-builder.ts).** Mirror: emit `tableForPart` for a TPH
   concrete's parts (don't skip), deriving `parentTable`/`parentFk` from
   `tableOwnerName(parent, pool)` rather than `parent.name`. Add an
   `ownerModule`-correct FK to the shared table.

4. **Repository load (repository-find-builder.ts).** The whole-tree load
   (`findByIdMethod:148`, `findManyByIdsMethod:74`) already reads
   `schema.<childTable>.parentId == id` where `id` is the parent row id — and a
   TPH concrete's id *is* the shared-table row id, so **this likely works
   unchanged** once the child table exists and `wireShape` carries the
   containment (it already does — enrichments.ts:672 adds contains entries
   regardless of layout). Verify `hydrateRootForFindAllExpr:486` reads the part
   from its by-parent map for a TPH concrete (it should — it's layout-agnostic).

### Risks / decisions
- **FK column naming.** `party_id` (owner) vs `customer_id` (logical). Use the
  owner (`party_id`) so the FK is valid; document that the column is named for
  the physical parent. A part shared across two concretes of the same base would
  collide on table name — **v1 restriction: a part name must be unique within
  the hierarchy** (add a validator check, or scope the part table name by
  concrete: `customer_addresses`). Prefer the latter (concrete-scoped table
  name) so two concretes can each contain a same-named part type.
- **Nested parts** (a part that itself `contains`) — recurse with the same
  owner resolution; likely free once the top-level fix is in, but test it.

### Tests
- Validator: `contains` on a TPH concrete no longer errors; the previously
  failing fixture from #749 now generates.
- Generator: the concrete's part table is emitted, `parentId` FKs the **shared**
  table; `tsc --noEmit` clean (the real gate — this fixture had 14 errors).
- Migration: part table CREATE references the shared table; SQL parity check.
- Repository: `findById` loads the contained part for a concrete.

---

## Sequencing

Feature 2 is the smaller, higher-value, fully-`tsc`-verifiable change (it turns
14 silent errors into working output, and the repository load is likely already
correct). **Do Feature 2 first.** Feature 1 carries the one real design fork
(union column alignment) and should follow once Pattern 4 is proven.

Neither feature needs an environment beyond `npm test` + `LOOM_TS_BUILD=1`
(`tsc --noEmit` against generated output) — both are Hono-only and the gate is
type-checkable here. No `dotnet`/docker dependency.

## Out of scope
- TPH on .NET / Phoenix / React (separate slice; needs `dotnet build` to verify).
- `find all Base` returning concrete-specific columns in the *union* projection
  (Feature 1 v1 may return the base-shaped projection — see the design fork).
