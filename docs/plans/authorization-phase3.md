# Authorization Phase 3 — the policy WRITE ladder (P3.1)

Status: in progress (PR #1742). Scope of this doc: **P3.1 only** — the write
verb on `policy {}` read rules. Later P3.x slices (operation/view/workflow
gates, field masking, `deny`) are out of scope and untouched.

## Problem

Phase 2 shipped the `policy { allow local|deep|global on X }` **read** ladder
(`docs/tenancy.md` → "The policy {} read ladder"). It rewrites a tenant-owned
aggregate's `tenantOwned` capability filter (`contextFilters`) from the flat
`tenantId ==` floor to a widened materialized-path scope, and that filter rides
every read seam — including the **by-id command load** that precedes a
mutation, because on every backend the mutation path loads through the SAME
read-scoped accessor:

| Backend | mutation load seam | read filter applied there |
|---|---|---|
| node/Hono | `repo.getById` → `findById` | yes (Drizzle `.where(... AND readPred)`) |
| .NET/EF | `GetByIdAsync` | yes (`HasQueryFilter`) |
| Python/SQLAlchemy | `repo.get_by_id` | yes (capability `where`) |
| Java/JPA | `getById` / `findById` | yes (`@SQLRestriction`) |
| Elixir/Ecto | `get_<agg>!` | yes (scoped `find_by_id` query) |

Consequence today: `allow deep on X` silently widens **writes** to the whole
subtree too — you can `PATCH`/`DELETE` any descendant row, not just your own.
There is no way to say "read the subtree, but only mutate my own org."

## P3.1 surface

`policy {}` read rules grow an optional verb:

```ddd
policy {
  allow deep on Account        // read: caller's subtree (bare = read, unchanged)
  allow write deep on Account  // write: caller's subtree (opt-in)
  allow write local on Memo    // write: caller's own org (the default; explicit here)
}
```

- **Loom (`.ddd`) source** — bare `allow <level> on X` is today's read rule,
  byte-identical. `allow write <level> on X` is new.
- **Grammar** — `PolicyReadRule` gains `verb=('write')?`. There is deliberately
  **no `read` verb synonym**: `read` is far too common a user identifier
  (`let read = api.orders.getById(...)` appears across the corpus) to promote to
  a global keyword, so the read form stays bare. `write` is the only new
  keyword (unused as an identifier anywhere), admitted as a soft keyword in the
  identifier rules alongside `filter`/`stamp`. `local`/`deep`/`global` share the
  same `ReadLevel` token set; `write global` parses but is a **validator** error
  (below).

### Write levels

- `write local` — the caller's own org node (the flat `tenantId ==` floor).
  **The default** when no write rule names an aggregate. `= today` for the
  overwhelmingly common flat / read-local case.
- `write deep` — the caller's org + all descendants (the `dataKey`
  descendant-or-self materialized-path prefix, anchored at `orgPath`).
- `write global` — **NOT offered in P3.1.** Root-subtree-wide mutation is a
  footgun; rejected with `loom.policy-write-global-unsupported`. (A caller can
  still *read* `global`; they just can't blanket-write the whole root subtree.)

## Semantics

A write rule gates every **INSTANCE mutation** — update-style operations,
`destroy`, and applier dispatch on a loaded instance — on the target row's
`dataKey` being inside the caller's **write scope**:

- write scope of `local` = `tenantId == currentUser.tenantId` (the floor).
- write scope of `deep`  = descendant-or-self of `currentUser.orgPath` (the
  same `DEEP_SCOPE_MEMBER` sentinel the read `deep` level uses).

Out-of-write-scope target → the **same status the read path gives for an
out-of-scope row: 404** (no existence leak — a row you may read but not write,
and a row that doesn't exist, are indistinguishable to a would-be writer).
NULL-`dataKey` rows degrade to the tenant floor — the same OR-fallback the read
`deep` scope carries (`DEEP_SCOPE_SEMANTICS`), so legacy/principal-less rows
stay writable by their own tenant and never widen.

**Creates are untouched** — `tenantOwned` stamping already pins a new row's
`dataKey` to the caller's `orgPath`, so a create can never land outside the
caller's own node regardless of write level.

### Coherence rule (fail-closed)

`allow write deep on X` requires `allow deep on X` **or** `allow global on X`
— you cannot write what you cannot read. Violation →
`loom.policy-write-wider-than-read` (error). (`write local` needs no read rule;
the floor is always readable.)

### Fail-closed default (a deliberate, noted behavior change)

When an aggregate's **read** level is widened (`deep`/`global`) and there is
**no** write rule, the write level defaults to `local` and the command load is
tightened back to the floor. This is a behavior CHANGE for existing
read-widened aggregates that carry mutations (today they inherit the wider read
scope for writes). It is the fail-closed default the slice establishes: reads
widen, writes stay at the floor unless explicitly opted in. Byte-identical for
every flat / read-`local` system (the guard is emitted only when the write
scope is strictly narrower than the read scope).

## Enforcement point per backend

The write scope is derived once in enrichment as `AggregateIR.writeScopeFilter`
(an `ExprIR`), set **only when the write scope is strictly narrower than the
read scope** (`writeRank < readRank`, ranks `local=0 < deep=1 < global=2`):

- read widened, write `local` (default) → floor predicate.
- read `global`, write `deep` → deep-scope sentinel.
- otherwise `undefined` → command load unchanged (byte-identical).

The predicate is built from the same `tenant-stance.ts` builders the read
ladder uses (`buildTenantFloorFilter` / `buildDeepScopeFilter`), so it renders
through each backend's existing principal-filter path — no new render code.

Each backend AND-s `writeScopeFilter` into its **command-load** seam (the one
the mutation dispatch uses, distinct from the query/read load where the
pipeline distinguishes them):

| Backend | mechanism | how |
|---|---|---|
| node/Hono | command load distinguished (`getById` ≠ `findById`) | `getById` gains a write-scope existence pre-guard (`SELECT id … WHERE id = ? AND <writePred> LIMIT 1`); miss → `AggregateNotFoundError` (→ 404), then the unchanged `findById` hydrates. |
| Python/SQLAlchemy | command load distinguished (`get_by_id`) | `get_by_id` gains a `SELECT` write-scope pre-guard; miss → `AggregateNotFoundError` (→ 404). |
| .NET/EF | shared load, explicit guard | `GetByIdAsync` AND-s the write predicate as an explicit post-`HasQueryFilter` `.Where(...)`; miss → `null` → the mediator maps to 404. |
| Java/JPA | shared load (`@SQLRestriction`), explicit guard | `getById` runs a write-scope existence check (Criteria/JPQL) before returning; miss → `AggregateNotFoundException` (→ 404). |
| Elixir/Ecto | scoped `find_by_id` query | the command `get_<agg>!` path AND-s the write predicate into its scoped query; miss → `nil` → controller 404. |

The guard is only emitted when `writeScopeFilter` is present, so a plain
aggregate's command load is byte-identical.

## Not in scope (P3.x follow-ups)

Operation/view/workflow gates, field masking, `deny`, `write global`,
per-operation write levels, and the runtime hierarchy e2e extension (rides on
`test/fixtures/corpus/tenancy-hierarchy.ddd`, PR #1739 — added here only if it
has merged onto `main`).
