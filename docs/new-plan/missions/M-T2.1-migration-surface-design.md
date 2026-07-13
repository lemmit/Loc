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
  Order.qty        -> quantity
  Order.shippedAt  -> fulfilledAt
}
```

**Keyword-free steps — no `rename` keyword.** The step is spelled
`Agg.old -> new`, not `rename Agg.old -> new`: `rename` is used pervasively as a
domain identifier across the corpus (28 `operation rename`, 12 `workflow rename`,
a `function rename`, 40+ `.rename` accesses), so introducing it as a keyword would
break the existing model surface. `migration` is the only new keyword (zero
declaration-name collisions), admitted as a soft keyword in identifier positions.
The `->` operator carries the rename intent inside the block.

**Lowering semantics.** The block feeds the existing snapshot→model diff: for each
`A.old -> new`, map the old snapshot column (`qty` on table `orders`) to the
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

## Resolved decisions (signed off 2026-07-13)

1. **Lifecycle — ledger.** Each named block is a permanent, immutable record kept
   in source as the audit trail. Crucially, **no new `.loom/` history file is
   needed**: because migrations derive from the snapshot→model diff, a rename block
   is *naturally inert* once its effect is baked into the baseline snapshot — the
   next diff simply finds no `qty` column to rename, so the block matches nothing
   and is a no-op. Permanence and idempotency both fall out of the existing
   snapshot mechanism. The snapshot *is* the applied-history record.
2. **Scope — `rename` only** this slice (column rename within an aggregate's
   table). Aggregate/table rename and M-T2.3's `backfill`/`transform`/`sql` steps
   are deliberately deferred; the block grammar is shaped so they slot in as
   further step alternatives.

### Ledger correctness details

- **Chain resolution.** With `qty -> quantity` (gen 1) and later `quantity ->
  amount` (gen 2), each generate advances the snapshot so each rename fires against
  the right baseline. If a user stacks both before generating, the builder resolves
  the transitive chain (`qty → quantity → amount`) against the baseline column that
  actually exists, emitting the single applicable `renameColumn`. Cycle-guarded.
- **Validation is structural / snapshot-independent** (a historical ledger block
  legitimately references names that have since moved on, so we must NOT require
  `to` to be currently live): `loom.migration-duplicate-name` (block names unique),
  `loom.rename-to-self` (`from == to`), `loom.rename-duplicate-source` /
  `loom.rename-duplicate-target` (ambiguous re-mapping of one column). The
  aggregate is a real cross-reference (`[Aggregate:ID]`), so a bad aggregate name
  is caught by scoping.
- **Precedence.** An explicit rename takes priority over the existing one-drop-one-
  add heuristic (which stays for un-annotated single renames), and it is the *only*
  path that handles two-at-once and rename+type-change (→ `renameColumn` +
  `alterColumnType`).

## Slice (shipped)

Grammar (`migration` block + keyword-free `RenameStep`) → `langium:generate` →
`RenameIntentIR` on `LoomModel` → lower → consume in
`migrations-builder.ts` diff (`resolveRenames` → `diffTable` rename pass) →
validators (rename collisions) →
`print-structural.ts` arm → tests (parsing, negative validator, migration-builder
unit: two renames → two `renameColumn` + zero drops; rename+type-change →
`renameColumn` + `alterColumnType`) + the SQL/Ecto emit assertions. **Migration-only
feature — no backend/frontend codegen or wire-shape change.**
