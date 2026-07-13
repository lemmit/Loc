# T2 — Data & schema evolution

*Weak-spot #2: the structural diff engine is real (ALTER, FK-ordered, destructive-gated), but nothing protects data through evolution. Silent data loss is the one unforgivable bug class for a platform that claims "business apps".*

## M-T2.1 — explicit rename intent (column) — `partial` · **M** · P1
**Column rename shipped** via a dedicated, domain-model-isolated `migration "<name>" { Agg.old -> new }` block (NOT the originally-sketched inline `renamed from` annotation — rejected as tech debt: transient migration bookkeeping smeared onto the durable domain model). The block folds into the snapshot→model diff to emit an explicit `renameColumn` (+ `alterColumnType`/`alterColumnNullable` on a type/nullability change), handling the two cases the one-drop-one-add heuristic can't: **two renames at once** and **rename+type-change**. Ledger-style (permanent in source, naturally inert once baked into the baseline snapshot — no new `.loom/` history file). Grammar + IR + lowering + migration-builder consumption + structural validators (`loom.migration-duplicate-name`, `loom.rename-to-self`, `loom.rename-duplicate-source/-target`) + printer + tests (parsing / negative validator / diff unit / buildMigrations e2e / SQL render). Design: [`missions/M-T2.1-migration-surface-design.md`](missions/M-T2.1-migration-surface-design.md).
**Remaining (deferred slice):** aggregate/**table** rename — needs a new `renameTable` op across the sql-pg/elixir/java renderers + the derived-table (part/association/value-collection) name cascade. The block grammar is shaped so `backfill`/`transform`/`sql` steps (M-T2.3) slot in as further step alternatives.
Sources: `src/system/migrations-builder.ts` (`diffTable` rename pass, `resolveRenames`), weak-spots §2.
Acceptance (met): two simultaneous renames on one table produce two `renameColumn` steps and zero drops; destructive gate untouched (`test/ir/migrations-builder.test.ts` → "explicit renames (M-T2.1)").

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
