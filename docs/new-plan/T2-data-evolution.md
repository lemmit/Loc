# T2 — Data & schema evolution

*Weak-spot #2: the structural diff engine is real (ALTER, FK-ordered, destructive-gated), but nothing protects data through evolution. Silent data loss is the one unforgivable bug class for a platform that claims "business apps".*

## M-T2.1 — `renamed from` field/aggregate intent — `open` · **M** · P1
Rename detection is a heuristic (exactly one drop + one add of identical type → `renameColumn`); two renames at once, or rename+type-change, silently degrade to drop+add. Add an explicit rename annotation in the grammar (e.g. `quantity: int renamed from qty`, consumed once then removable), lower it into `MigrationsIR` as a first-class `renameColumn`, and validate collisions. Covers table renames (aggregate rename) too.
Sources: `src/system/migrations-builder.ts:787-805`, weak-spots §2, D-RENAME (naming precedent).
Acceptance: two simultaneous renames on one table produce two `renameColumn` steps and zero drops; destructive gate untouched.

## M-T2.2 — Migration-baseline safety guards — `open` · **M** · P1
A missing `.loom/snapshots/<module>.snapshot.json` silently re-emits full `Initial` and resets the version chain; on-disk delta files are never verified against `migrationHistory`; a stale baseline reissues used version numbers. Add: (a) refuse `Initial` when the output tree already contains migration files (override flag), (b) verify migration files ↔ `migrationHistory` at generate time, (c) error on version-number reuse.
Sources: `src/system/snapshot.ts`, weak-spots §2, [migrations.md](../migrations.md).

## M-T2.3 — Data-migration surface — `open` · **L** · P1 (design-first)
Only structural DDL exists; the lone concession is a `-- TODO backfill` comment. Design a minimal data-migration story: an emitted, history-tracked stub file the user fills (per backend's native mechanism), plus DSL-side hooks for the common cases (default backfill on NOT-NULL add; rename-with-transform). Down-migrations stay no-op by decision — document it as a D-tag.
Sources: weak-spots §2, `migrations-builder.ts` destructive policy.

## M-T2.4 — Shape/strategy-change migrations — `open` · **M** · P2
Flipping `shape(relational|embedded|document)` or TPH/TPC strategy reshapes the table with no data-move story; inheritance doc explicitly defers. Minimum: detect the reshape in the diff and fail with a dedicated diagnostic + emitted data-migration stub (building on M-T2.3), instead of a generic destructive error.
Sources: [aggregate-inheritance](../old/proposals/aggregate-inheritance.md) §migration, [document-and-json-hierarchies](../old/proposals/document-and-json-hierarchies.md).

## M-T2.5 — Brownfield adoption (existing database) — `open` · **XL** · P3 (proposal needed)
Nothing introspects an existing schema; Loom is greenfield-only. A future `ddd adopt` that introspects Postgres into a baseline snapshot (+ partial `.ddd` skeleton) would open the largest user segment. Write the proposal; don't start code before T2.1–T2.3 land.

## M-T2.6 — Bound the implicit `find all()` (DEBT-28) — `open` · **M** · P2 ⚠ coordinated
The auto-`findAll` is unbounded — the scaling failure mode of every generated list endpoint. Flip implicit findAll to paged-by-default (breaking change; one coordinated PR + fixture re-baseline + frontend consumption via M-T1.1), or gate with a max-rows guard as an interim.
Sources: [pagination-design-note](../old/proposals/pagination-design-note.md) DEBT-28.

## M-T2.7 — Seeding tail — `partial` · **M** · P3
Phases 5–7: imperative workflow-body `seed`, `seed-spec.json` + compose seed step + `saas` template wiring, `ddd seed` runner + `--reset` + `key:` natural-key upsert for reference data.
Sources: [database-seeding](../old/proposals/database-seeding.md), D-SEED-*.

## M-T2.8 — Auto-derived finder indexes — `partial` · **S** · P2
`unique (...)` shipped (Slice 1). Slice 2: derive plain indexes from `find ... where` columns (D-INDEX-INFRA/D-INDEX-SUGGEST constrain: manual indexes live on the storage binding; suggestions are advisory).
Sources: [uniqueness-and-indexes](../old/proposals/uniqueness-and-indexes.md) Slice 2.

## M-T2.9 — Storage-config tail — `partial` · **M** · P3
Remaining from the storage RFC: logical `dataSource` bindings (`dataSources:` per D-STORAGE-SPLIT), the `STORAGE_CAPABILITIES` matrix, per-deployable outbox overrides. Note 2026-07-12 pruning: `style:` knob and `marten`/`layered` stubs are gone — don't resurrect.
Sources: [storage-and-platform-config](../old/proposals/storage-and-platform-config.md).

## M-T2.10 — Document/embedded shape completion — `partial` · **M** · P2
`embedded` on Drizzle (TS) still emits relationally ⚠ verify-first; `document` on Phoenix/Ecto unscheduled (honest gate); `supportedShapes` two-tier validator (capability error vs idiomaticity warning); eventLog+document/embedded snapshot rehydration deferred behind appliers.
Sources: [document-and-json-hierarchies](../old/proposals/document-and-json-hierarchies.md), global-plan T2.h residue; elixir document residual is M-T6.2.

## M-T2.11 — `encryptedAtRest` — `blocked(proposal)` · **XL** · P3
Deliberately parked stub. Needs a full proposal (key management, deterministic-encryption/blind-index finds, backend matrix, seed round-trip) before any code.
Sources: [encrypted-at-rest](../old/proposals/encrypted-at-rest.md).

## M-T2.12 — Money currency dimension + reporting queries — `open` · **L** · P3
From the completeness audit: `money` has precision but no currency dimension; no cross-row aggregation/reporting query surface (`sum of Order.total where …`). Both are language-level designs — write proposals; reporting may fold into `projection` (M-T4.2) + `view` extensions.
Sources: [completeness-audit-2026-07](../audits/completeness-audit-2026-07.md).
