# node criterion-retrieval capability-filter leak (silent gap #8)

**Status:** claimed / in progress. **Branch:** `claude/node-criterion-filter-leak`.

## The gap (audited, confirmed on fresh `main`)

On the node (TS/Hono) backend, a **criterion-based retrieval** (`run<Name>`)
silently omits the aggregate's always-on capability `filter` predicate, while
every other read on the same repository (`findById` / `findManyByIds` /
`findAll` / custom finds / views) AND-s it in. Soft-deleted / other-tenant /
archived rows therefore **leak through any retrieval**. No `loom.*` validator
covers it → a 🔴 SILENT correctness gap (bucket c). PR #1501's note is live, not
stale.

This is **node-only**: .NET (`HasQueryFilter`), Java (`@FilterDef
autoEnabled`), and Elixir (a scoped Ecto query applied in the repo) apply the filter globally;
Python's `runMethod` already threads the predicate. Node is the outlier — it
splices the capability predicate per-read-site and the retrieval site is the one
that forgot.

## Evidence

Generated `order-repository.ts` for an aggregate with `filter NotArchived` +
`retrieval EuOrders … where InRegion("EU")`:

```ts
// findAll  → .where(notArchivedCriterion())                 ✓
// recent   → .where(and(eq(...code..), notArchivedCriterion())) ✓
// runEuOrders (RETRIEVAL) → .where(inRegionCriterion("EU"))  ✗ notArchivedCriterion() MISSING
```

(A test where the retrieval `where` *is* the same criterion as the filter masks
the bug — they coincide. A distinct `where` exposes it.)

## The seam

- `src/generator/typescript/repository-find-builder.ts` `runMethod` — builds
  its where at line ~496 (`.where(${withKind(whereInner, kindPred)})`), takes
  **no `filterPred`** and never calls `combinePredicate`.
- Caller `src/generator/typescript/repository-builder.ts:199` —
  `runMethod(agg, r, ctx)` (no `filterPred`), while the adjacent finds/views at
  196–197 receive the `filterPred` computed once at line 126.

Analog to mirror (same file): `buildFindWhereClause` (lines 535–594) wraps every
branch in `combinePredicate(..., filterPred)` (`combinePredicate` =
`filterPred ? and(existing, filterPred) : existing`).

## Fix

1. `runMethod(agg, retrieval, ctx, filterPred: string | null = null)` — add the param.
2. line ~496: `.where(${combinePredicate(withKind(whereInner, kindPred), filterPred)})`.
3. `repository-builder.ts:199`: `runMethod(agg, r, ctx, filterPred)`.

Retrievals carry no `ignoring`/bypass in the IR, so AND-ing the full always-on
`filterPred` is correct (nothing to bypass). No grammar/IR/validator change.

## Test

`test/generator/typescript/` — an aggregate with a capability `filter` and a
retrieval whose `where` differs from the filter; assert the generated `run<Name>`
where-clause AND-s in the capability predicate (and the no-filter aggregate's
retrieval stays byte-identical).
