# T2 — Data & schema evolution — completed missions

*Archived 2026-09-02 from [`../T2-data-evolution.md`](../T2-data-evolution.md). Every mission below is closed (`done` / `shipped` / `closed` / `concluded` / `withdrawn`); the bodies are moved verbatim (links re-based one level deeper) so the evidence trail stays readable. Nothing here is open work — the live track file lists what remains.*

## M-T2.2 — Migration-baseline safety guards — `done` (PR #1895, 2026-07-14) · **M** · P1
Sources: `src/system/snapshot.ts`, `src/system/migration-artifacts.ts`, weak-spots §2, [migrations.md](../../migrations.md).

## M-T2.3 — Data-migration surface — `done` (v1 PR #1983; deferred slices 2026-07-18) · **M** · P1 (design-first)
Sources: weak-spots §2, `migrations-builder.ts` destructive policy, the design doc.

## M-T2.4 — Shape/strategy-change migrations — `done` (2026-07-18) · **M** · P2
Sources: [aggregate-inheritance](../../old/proposals/aggregate-inheritance.md) §migration, [document-and-json-hierarchies](../../old/proposals/document-and-json-hierarchies.md), the M-T2.3 design appendix, `src/system/migrations-builder.ts` (`detectReshapes`, `MigrationShapeChangeError`, `stampReshapeMetadata`).

## M-T2.6 — Bound the implicit `find all()` (DEBT-28) — `done` · **M** · P2 ⚠ coordinated
Sources: [pagination-design-note](../../old/proposals/pagination-design-note.md) DEBT-28.

## M-T2.13 — Migration-evolution gate — `done` (PR #2264) · **M** · P2
Sources: `docs/migrations.md`, weak-spots §"silent data loss"; runtime companion to M-T2.1 (rename intent) + M-T2.2 (baseline safety) + M-T2.3 (data migrations).

## M-T2.14 — `columnTypeEqual` is blind to precision/scale: #2575's `NUMERIC(19,4)` never reaches an existing database — `done` (PR [#2669](https://github.com/lemmit/Loc/pull/2669), 2026-08-25) · **S–M** · P1 ⭐ the migration #2575 promised but did not deliver

**DONE (2026-08-25, #2669).** `columnTypeEqual` now treats precision/scale as part of a decimal column's identity, so a bounds change diffs out through `alterColumnType`; a provably-total widening (`decimalBoundWidens`) is the one carve-out from the destructive gate, the pre-#2575 money catch-up stays behind `--allow-destructive`; the migration-evolution harness's `fingerprintSchema` was itself bound-blind and was fixed in the same PR. *(Status flipped 2026-09-02 by the plan audit — the PR merged with the mission unflipped.)*

Found 2026-08-23 by the numeric-types audit ([F15](../../audits/numeric-types-audit-2026-08-23.md)), confirmed twice independently. [#2575](https://github.com/lemmit/Loc/pull/2575) bounded money's DDL to `NUMERIC(19,4)` and claimed migration safety ("`alterColumnType` already existed with a `USING` cast, so an existing database gets a real type-change migration"). It does not: `columnTypeEqual` (`src/system/migrations-builder.ts`) compares `kind` only, and `decimal`/`money` share `kind: "decimal"` — a baseline's `{kind:"decimal"}` compares **equal** to `{kind:"decimal", precision:19, scale:4}`, so no `alterColumnType` is ever diffed out. Every pre-#2575 database keeps the unbounded column (the storage half of #2549, resurfaced for migrated schemas), and a user-visible `decimal ↔ money` field retype produces **no migration at all**.

**Why every existing gate is green.** `schema-load` loads *fresh* chains (the fresh DDL is correct); `migration-evolution` has no fixture evolving a pre-bounds baseline across the #2575 boundary.

**The fix:** compare `precision`/`scale` in `columnTypeEqual` so a bounds change diffs out through the existing `alterColumnType`/`USING` path — minding the destructive-gating semantics (a widening bound is safe; a narrowing one belongs behind `--allow-destructive` review).

**Verification when it lands.** A migration-evolution witness evolving a pre-#2575 baseline to `NUMERIC(19,4)`, plus a `decimal → money` retype producing a migration; mutation-proved by reverting the comparator.

Sources: [numeric-types-audit-2026-08-23](../../audits/numeric-types-audit-2026-08-23.md) F15, plan.json N6, #2549/#2575. Relates to M-T2.2 (baseline safety), M-T2.13 (the gate that gets the witness).
