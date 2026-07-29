# T2 — Data & schema evolution

*Weak-spot #2: the structural diff engine is real (ALTER, FK-ordered, destructive-gated), but nothing protects data through evolution. Silent data loss is the one unforgivable bug class for a platform that claims "business apps".*

## M-T2.1 — explicit rename intent (column + table) — `partial` · **M** · P1
**Column rename shipped** via a dedicated, domain-model-isolated `migration "<name>" { Agg.old -> new }` block (NOT the originally-sketched inline `renamed from` annotation — rejected as tech debt: transient migration bookkeeping smeared onto the durable domain model). The block folds into the snapshot→model diff to emit an explicit `renameColumn` (+ `alterColumnType`/`alterColumnNullable` on a type/nullability change), handling the two cases the one-drop-one-add heuristic can't: **two renames at once** and **rename+type-change**. Ledger-style (permanent in source, naturally inert once baked into the baseline snapshot — no new `.loom/` history file). Grammar + IR + lowering + migration-builder consumption + structural validators (`loom.migration-duplicate-name`, `loom.rename-to-self`, `loom.rename-duplicate-source/-target`) + printer + tests (parsing / negative validator / diff unit / buildMigrations e2e / SQL render). Design: [`missions/M-T2.1-migration-surface-design.md`](missions/M-T2.1-migration-surface-design.md).
**Table/aggregate rename shipped** (2026-07-14): the keyword-free `OldName -> NewAggregate` step (only the live NEW aggregate is a cross-reference; the old name is a bare id). A new `renameTable` `MigrationStep` renders on Postgres (`ALTER TABLE … RENAME TO …`, shared by TS/.NET/Python/Java via `sql-pg.ts`) and Ecto (`rename table(:old), to: table(:new)`). `resolveTableRenames` derives the full **owned-child cascade** structurally (snake-stem substitution off the enriched aggregate): root table + value-collection child tables + association join tables (each a `renameTable`) and their owner FK columns + contained parts' owner FK column (each a `renameColumn`). `diffSchema` rewrites a baseline copy so a renamed table pairs with its new self instead of drop+recreate; every candidate is guarded on baseline existence, so the ledger block is a no-op once baked in (and a nested-part FK'd to a sibling, or a same-generation add, is silently skipped). The result is **non-destructive** — no dropTable/dropColumn smuggles data loss past the gate.
**Deferred slices (a)–(c) shipped 2026-07-18** (the M-T2.3 design appendix sketches, one PR each): **(a) `renameIndex` collapse** — `diffTable` now pairs a `dropIndex` with the `addIndex` that is the same index under a new name (identical columns after mapping through this generation's column renames, uniqueness, predicate, opclasses) and emits the new `renameIndex` step (`ALTER INDEX … RENAME TO` on Postgres; Ecto `execute/1`), so a table/column rename renames its derived FK indexes in place with zero drop/create. **(b) sibling `targetFk` cascade** — a second pass in `resolveTableRenames` runs THIS module's aggregates against the GLOBAL intent list and emits the `snake(old)_id → snake(new)_id` column rename on every join table this module owns whose association targets a renamed aggregate (cross-module: the sibling owner can live elsewhere), so an aggregate rename is now non-destructive *everywhere in the system*. **(c) shape-coverage audit** — TPC-concrete / document-root / embedded-root renames verified to already cascade correctly (pinned by tests); the one silent-corruption gap the audit found — a `persistedAs(eventLog)` aggregate rename stranding rows under the old `stream_type` — now emits a ledgered `sqlExec` fix-up mirroring the TPH `kind` one. **(d) still deferred** (optional, propose-first): renaming a **workflow** or **projection** drop+recreates its state/projection table; needs `TableRename`'s live side extended beyond `[Aggregate:ID]` — its own follow-on slice. Tests: `test/ir/migrations-builder.test.ts` → "renameIndex collapse (M-T2.1 a)", "sibling reference-collection targetFk cascade (M-T2.1 b)", "shape-coverage rename cascade (M-T2.1 c)". The block grammar is shaped so `backfill`/`sql` steps (M-T2.3) slot in as further step alternatives.
Sources: `src/system/migrations-builder.ts` (`diffTable`/`diffSchema` rename passes, `resolveRenames`/`resolveTableRenames`), weak-spots §2.
Acceptance (met): two simultaneous column renames on one table → two `renameColumn` + zero drops; an aggregate rename with parts + value-collection + association → root + 2 child `renameTable` + 3 FK `renameColumn`, zero drop/create (`test/ir/migrations-builder.test.ts` → "explicit renames (M-T2.1)" / "table/aggregate rename intent (M-T2.1)"); destructive gate untouched.

## M-T2.2 — Migration-baseline safety guards — `done` (PR #1895, 2026-07-14) · **M** · P1
Sources: `src/system/snapshot.ts`, `src/system/migration-artifacts.ts`, weak-spots §2, [migrations.md](../migrations.md).

## M-T2.3 — Data-migration surface — `done` (v1 PR #1983; deferred slices 2026-07-18) · **M** · P1 (design-first)
Sources: weak-spots §2, `migrations-builder.ts` destructive policy, the design doc.

## M-T2.4 — Shape/strategy-change migrations — `done` (2026-07-18) · **M** · P2
Sources: [aggregate-inheritance](../old/proposals/aggregate-inheritance.md) §migration, [document-and-json-hierarchies](../old/proposals/document-and-json-hierarchies.md), the M-T2.3 design appendix, `src/system/migrations-builder.ts` (`detectReshapes`, `MigrationShapeChangeError`, `stampReshapeMetadata`).

## M-T2.5 — Brownfield adoption (existing database) — `open` · **XL** · P3 (proposal needed)
Nothing introspects an existing schema; Loom is greenfield-only. A future `ddd adopt` that introspects Postgres into a baseline snapshot (+ partial `.ddd` skeleton) would open the largest user segment. Write the proposal; don't start code before T2.1–T2.3 land.

## M-T2.6 — Bound the implicit `find all()` (DEBT-28) — `done` · **M** · P2 ⚠ coordinated
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

## M-T2.13 — Migration-evolution gate — `done` (PR #2264) · **M** · P2
Sources: `docs/migrations.md`, weak-spots §"silent data loss"; runtime companion to M-T2.1 (rename intent) + M-T2.2 (baseline safety) + M-T2.3 (data migrations).
