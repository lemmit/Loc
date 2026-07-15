# T2 — Data & schema evolution

*Weak-spot #2: the structural diff engine is real (ALTER, FK-ordered, destructive-gated), but nothing protects data through evolution. Silent data loss is the one unforgivable bug class for a platform that claims "business apps".*

## M-T2.1 — explicit rename intent (column + table) — `partial` · **M** · P1
**Column rename shipped** via a dedicated, domain-model-isolated `migration "<name>" { Agg.old -> new }` block (NOT the originally-sketched inline `renamed from` annotation — rejected as tech debt: transient migration bookkeeping smeared onto the durable domain model). The block folds into the snapshot→model diff to emit an explicit `renameColumn` (+ `alterColumnType`/`alterColumnNullable` on a type/nullability change), handling the two cases the one-drop-one-add heuristic can't: **two renames at once** and **rename+type-change**. Ledger-style (permanent in source, naturally inert once baked into the baseline snapshot — no new `.loom/` history file). Grammar + IR + lowering + migration-builder consumption + structural validators (`loom.migration-duplicate-name`, `loom.rename-to-self`, `loom.rename-duplicate-source/-target`) + printer + tests (parsing / negative validator / diff unit / buildMigrations e2e / SQL render). Design: [`missions/M-T2.1-migration-surface-design.md`](missions/M-T2.1-migration-surface-design.md).
**Table/aggregate rename shipped** (2026-07-14): the keyword-free `OldName -> NewAggregate` step (only the live NEW aggregate is a cross-reference; the old name is a bare id). A new `renameTable` `MigrationStep` renders on Postgres (`ALTER TABLE … RENAME TO …`, shared by TS/.NET/Python/Java via `sql-pg.ts`) and Ecto (`rename table(:old), to: table(:new)`). `resolveTableRenames` derives the full **owned-child cascade** structurally (snake-stem substitution off the enriched aggregate): root table + value-collection child tables + association join tables (each a `renameTable`) and their owner FK columns + contained parts' owner FK column (each a `renameColumn`). `diffSchema` rewrites a baseline copy so a renamed table pairs with its new self instead of drop+recreate; every candidate is guarded on baseline existence, so the ledger block is a no-op once baked in (and a nested-part FK'd to a sibling, or a same-generation add, is silently skipped). The result is **non-destructive** — no dropTable/dropColumn smuggles data loss past the gate.
**Remaining (deferred slice):** (a) the derived FK-index names embed the renamed table/column, so they drop+recreate (non-destructive rebuild) rather than a `renameIndex` — a nicety, not correctness; (b) renaming an aggregate that is the *target* of a SIBLING aggregate's reference collection (`Other.xs: Old id[]`) leaves that sibling join table's `targetFk` column change to the destructive gate (gated, never silent); (c) TPH/TPC-inheritance and document/embedded-shape roots only cascade what their baseline actually contains. The block grammar is shaped so `backfill`/`transform`/`sql` steps (M-T2.3) slot in as further step alternatives.
Sources: `src/system/migrations-builder.ts` (`diffTable`/`diffSchema` rename passes, `resolveRenames`/`resolveTableRenames`), weak-spots §2.
Acceptance (met): two simultaneous column renames on one table → two `renameColumn` + zero drops; an aggregate rename with parts + value-collection + association → root + 2 child `renameTable` + 3 FK `renameColumn`, zero drop/create (`test/ir/migrations-builder.test.ts` → "explicit renames (M-T2.1)" / "table/aggregate rename intent (M-T2.1)"); destructive gate untouched.

## M-T2.2 — Migration-baseline safety guards — `done` (PR #1895, 2026-07-14) · **M** · P1
All three guards shipped as a generate-time check over the platform-neutral `MigrationsIR` (`src/system/migration-artifacts.ts`, `checkMigrationBaseline`), wired into `generateSystemsFromLoom` and fed the on-disk inventory by `fsMigrationArtifactIndex(outDir, loom)` (fs-backed, CLI-only — mirrors `fsSnapshotStore`; the web playground omits it and keeps prior behaviour): **(a)** refuse `Initial` when the snapshot is missing but migration files already exist (`--allow-rebaseline` override); **(b)** verify on-disk files ↔ `baseline.migrationHistory` (missing/unexpected file → error); **(c)** reject a version already present on disk (stale-baseline reuse). New recoverable `MigrationBaselineError` (CLI-caught alongside `SnapshotReadError`/`MigrationDestructiveError`). Backend-agnostic filename recognition (`<version>_…` + Flyway `V<version>.<n>__…`). Tests: `test/system/migration-artifacts.test.ts` (14 — filename extraction, all three guards + override, fs scan + end-to-end refusal/override/no-op through `generate system`). Doc: [migrations.md](../migrations.md) §Baseline safety.
**Remaining (deferred):** the guard scans the owner deployable's subtree for migration-dir segments — a future backend with a novel migration layout adds its dir basename to `isMigrationDirSegment`. Version reuse (c) is defense-in-depth; in practice drift (b) catches the same stale-baseline states first.
Sources: `src/system/snapshot.ts`, `src/system/migration-artifacts.ts`, weak-spots §2, [migrations.md](../migrations.md).

## M-T2.3 — Data-migration surface — `open` · **L** · P1 (design-first)
Only structural DDL exists; the lone concession is a `-- TODO backfill` comment. Design a minimal data-migration story: an emitted, history-tracked stub file the user fills (per backend's native mechanism), plus DSL-side hooks for the common cases (default backfill on NOT-NULL add; rename-with-transform). Down-migrations stay no-op by decision — document it as a D-tag.
Sources: weak-spots §2, `migrations-builder.ts` destructive policy.

## M-T2.4 — Shape/strategy-change migrations — `open` · **M** · P2
Flipping `shape(relational|embedded|document)` or TPH/TPC strategy reshapes the table with no data-move story; inheritance doc explicitly defers. Minimum: detect the reshape in the diff and fail with a dedicated diagnostic + emitted data-migration stub (building on M-T2.3), instead of a generic destructive error.
Sources: [aggregate-inheritance](../old/proposals/aggregate-inheritance.md) §migration, [document-and-json-hierarchies](../old/proposals/document-and-json-hierarchies.md).

## M-T2.5 — Brownfield adoption (existing database) — `open` · **XL** · P3 (proposal needed)
Nothing introspects an existing schema; Loom is greenfield-only. A future `ddd adopt` that introspects Postgres into a baseline snapshot (+ partial `.ddd` skeleton) would open the largest user segment. Write the proposal; don't start code before T2.1–T2.3 land.

## M-T2.6 — Bound the implicit `find all()` (DEBT-28) — `done` · **M** · P2 ⚠ coordinated
The auto-`findAll` is unbounded — the scaling failure mode of every generated list endpoint. **Done:** flipped implicit findAll to paged-by-default in one coordinated PR with M-T1.1 slice 9. `ensureFindAll` (`src/ir/enrich/enrichments.ts`) now synthesises `paged<T>` (envelope `{items, page, pageSize, total, totalPages}`) instead of `T[]`, unconditional; the paged route (`?page=&pageSize=&sort=&dir=`) with whitelisted ORDER BY (`src/ir/util/sortable-fields.ts`, id default) threads through all five backends (Hono/node, .NET, Java, Python, Elixir/Phoenix — the Elixir auto-`findAll` gained a real paged `list` + context/controller `page_param/3` threading). Full fixture re-baseline (`test/fixtures/baseline-output/**`) + a 1000-row runtime acceptance capstone (`test/behavioral/pagination.mjs`, gated in `behavioral-e2e.yml`) prove the window/counters/ORDER BY end-to-end.
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
