# M-T2.1 — Explicit rename intent via a dedicated `migration` surface (design)

> **Status: design-in-progress (draft PR claim).** This supersedes the mission's
> original inline-`renamed from`-annotation sketch. Rationale below.
> Sources: `docs/audits/architecture-weak-spots-2026-07.md` §2 (effort item (i)),
> `src/system/migrations-builder.ts` (rename heuristic), `docs/migrations.md`.

## Problem

Rename detection today is a heuristic: a table with *exactly one* `dropColumn`
and *one* `addColumn` of identical type collapses to a single `renameColumn`
(`migrations-builder.ts`, `applyDestructivePolicy`). Anything else —
**two renames at once**, or a **rename that also changes type** — silently
degrades to drop + add, i.e. **data loss behind `--allow-destructive`**. There is
no rename *intent* in the model, so the compiler cannot know better.

## Why not the inline annotation

The weak-spot audit and the mission proposed `quantity: int renamed from qty`
inline on the field. Rejected: it smears **transient migration bookkeeping** onto
the **durable domain model**. You add it, run once, then must remember to delete
it; forget, and it lingers as cruft. The coupling is the debt.

## Direction — a dedicated `migration` block

A top-level declaration, sibling to `context`/`system`, **isolated from the
domain model**. Aggregates never carry migration state.

```
migration "rename-order-qty" {
  rename Order.qty        -> quantity
  rename Order.shippedAt  -> fulfilledAt
}
```

**Lowering semantics.** The block feeds the existing snapshot→model diff: for each
`rename A.old -> new`, map the old snapshot column (`qty` on table `orders`) to the
new model column (`quantity`) *before* `diffSchema` classifies drops/adds, so the
engine emits an explicit `renameColumn` (plus `alterColumnType` when the type also
changed) instead of drop + add. This handles the two cases the heuristic cannot.

**Generated output (Postgres):**
```sql
ALTER TABLE "orders" RENAME COLUMN "qty" TO "quantity";
ALTER TABLE "orders" RENAME COLUMN "shipped_at" TO "fulfilled_at";
```

**Validation (AST-level):** `new` must be a live field of `A`; `old` must be
absent from `A`'s current fields; block names unique; no two renames share a
source or target column.

**Why a block, not an annotation:** it separates migration intent from the domain
model, and it is the natural home for the later data-migration steps
(`backfill` / `transform` / `sql`) that M-T2.3 needs — one migration surface grown
over time, instead of a throwaway annotation now plus a second surface later.

## Open questions (for sign-off before coding)

1. **Lifecycle** — *ledger* (each named block permanent + history-tracked in
   `.loom/`, a no-op once applied, kept as the audit trail like a Rails/EF
   migration file — true zero-debt) vs *consumed-once* (read, applied, then
   deleted — smaller, still isolated from the domain model). Recommendation: ledger.
2. **Scope of this mission** — ship `rename` only as the first slice (fold M-T2.1),
   while the block's design leaves room for M-T2.3's data-migration steps.

## Slice (once signed off)

Grammar (`migration` block + `rename` clause) → `langium:generate` →
`MigrationIntentIR` (or fold onto the module) → lower → consume in
`migrations-builder.ts` diff → validators (rename collisions) →
`print-structural.ts` arm → tests (parsing, negative validator, migration-builder
unit: two renames → two `renameColumn` + zero drops; rename+type-change →
`renameColumn` + `alterColumnType`) + the SQL/Ecto emit assertions. **Migration-only
feature — no backend/frontend codegen or wire-shape change.**
