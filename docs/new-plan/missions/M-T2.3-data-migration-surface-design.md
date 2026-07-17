# M-T2.3 — Data-migration surface (design + implementation plan)

> **Status: design (PR #1983).** Covers the full T2 data-migration gap set:
> **M-T2.3** (data-migration surface, the core), **M-T2.4**
> (shape/strategy-change migrations, built on it), and the **M-T2.1 deferred
> slices** (a)–(c). Verified against `main` @ #1981 — no in-flight PR touches
> this area.
> Sources: `docs/new-plan/T2-data-evolution.md`,
> [`M-T2.1-migration-surface-design.md`](M-T2.1-migration-surface-design.md),
> `docs/audits/architecture-weak-spots-2026-07.md` §2,
> `src/system/migrations-builder.ts`, `src/generator/sql-pg.ts`,
> `src/generator/elixir/migrations-emit.ts`, `docs/migrations.md`.

## Problem

The structural diff engine is real (ALTER, FK-ordered, destructive-gated,
rename-intent-aware), but **nothing moves data through evolution** — the
weak-spot audit's words: *"No data migrations — the only concession is a
`-- TODO backfill` comment."* Concretely:

1. **NOT-NULL adds** — the sole concession is the `--allow-destructive`
   rewrite `add nullable → "-- TODO backfill" sqlComment → SET NOT NULL`
   (`applyDestructivePolicy`, `migrations-builder.ts`). The operator must
   hand-edit generated SQL — per backend, per environment — or the
   `SET NOT NULL` fails on any populated table.
2. **Type changes** — `alterColumnType` renders a blind default cast
   (`USING col::type`, `sql-pg.ts`). A cast Postgres can't do (`text → int`)
   fails at apply time; a lossy one succeeds silently. There is no way to say
   *how* old values map to the new type.
3. **NULL → NOT NULL flips** on an existing column are **not gated at all**
   (`applyDestructivePolicy` classifies only `dropTable` / `dropColumn` /
   blocking NOT-NULL *adds*) — they fail at apply time on any row holding
   NULL. A gap discovered while writing this design; closed here.
4. **No escape hatch** — no sanctioned way to run *any* one-shot DML (seed a
   derived column, fix up discriminators, move data ahead of a contract step)
   through the migration chain. `MigrationStep` is DDL-only.
5. **Reshapes** (M-T2.4) — flipping `shape(relational|embedded|document)` or
   TPH/TPC strategy has **no detection at all**: `matchTables` pairs by table
   name, so a relational→document flip diffs as mass `dropColumn`s +
   `addColumn`s (+ part/join `dropTable`s), and a TPH↔TPC flip as
   drop+recreate — data loss behind the *generic* destructive gate with a
   misleading diagnostic.
6. **Rename residue** (M-T2.1 deferred a–c) — FK-index drop+recreate instead
   of a rename; a sibling's reference-collection `targetFk` left to the
   destructive gate; TPH/TPC and document/embedded/eventLog roots only
   partially cascaded.

## Direction — grow the existing `migration` block; no new files, no second surface

M-T2.1 deliberately shaped `migration "<name>" { … }` so that
`backfill`/`transform`/`sql` steps *"slot in as further step alternatives"*.
That is exactly what we do. **The originally-sketched per-backend "stub file
the user fills" is rejected** — this design supersedes that sketch the same
way M-T2.1 superseded the inline `renamed from` annotation:

- A hand-edited generated file must survive regeneration → write-once
  machinery, five per-backend variants of the same logic (a Drizzle `.sql`, an
  EF class, an Ecto `.exs`, a Flyway file, a Python `.sql`), and a violated
  "the generated tree is disposable" invariant. The coupling is the debt.
- A DSL-side `sql` step is single-source, cross-backend by construction (every
  backend applies Postgres), rides the **existing** migration chain (same
  file, same version, same history entry), and is validated + printed +
  ledgered like every other step.

### Surface (v1)

```ddd
migration "order-evolution" {
  Order.qty -> quantity                        // column rename            (shipped, M-T2.1)
  Order -> PurchaseOrder                       // table/aggregate rename   (shipped, M-T2.1)
  Order.status = "pending"                     // NEW: backfill
  Order.total -> totalCents using total * 100  // NEW: rename + transform
  Order.rating using rating                    // NEW: in-place transform (type change)
  sql "UPDATE sales.orders SET note = '' WHERE note IS NULL"   // NEW: raw escape hatch
}
```

Generated output (Postgres — shared by TS/.NET/Python/Java via `renderPgStep`;
Ecto mirrors each step via its DSL / `execute/1`):

```sql
ALTER TABLE "sales"."orders" ADD COLUMN "status" TEXT NULL;
UPDATE "sales"."orders" SET "status" = 'pending' WHERE "status" IS NULL;
ALTER TABLE "sales"."orders" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "sales"."orders" RENAME COLUMN "total" TO "total_cents";
ALTER TABLE "sales"."orders" ALTER COLUMN "total_cents" TYPE INTEGER USING ("total_cents" * 100);
UPDATE sales.orders SET note = '' WHERE note IS NULL;
```

**Keyword policy (the M-T2.1 precedent).** All three steps stay keyword-light:

- **Backfill is keyword-free**: `Agg.field = <expr>` — `=` carries the intent
  exactly as `->` carries rename. No new token.
- **`using`** introduces the transform expression (deliberately mirroring
  Postgres `ALTER COLUMN … TYPE … USING …`). Admitted as a **soft keyword** in
  the identifier-position unions + the keyword-coverage snapshot refreshed, so
  a domain field named `using` keeps parsing.
- **`sql`** heads the raw step. Same soft-keyword treatment.

Disambiguation inside the block is LL(k)-clean: after `Agg.field` the next
token decides (`->` rename, `=` backfill, `using` transform); `sql` + STRING
is the raw step; bare `OldName -> NewAggregate` stays the table rename.

### Semantics per step

| Step | Fires when (per generation, against the module's baseline) | Emits | Inert when |
|---|---|---|---|
| `Agg.f = expr` (backfill) | the diff contains an `addColumn` for that column, **or** a NULL→NOT-NULL `alterColumnNullable` for it | `addColumn` (nullable) → `backfillColumn` → `alterColumnNullable(NOT NULL)`; or `backfillColumn` → the flip | column already present + populated in baseline (baked in) |
| `Agg.old -> new using expr` | the rename fires (M-T2.1 rules) **and** the type also changed | `renameColumn` → `alterColumnType` with `usingSql` | rename already baked in |
| `Agg.f using expr` | the diff contains an `alterColumnType` for that column | `alterColumnType` with `usingSql` replacing the blind default cast | no type change in this diff |
| `sql "…"` | **not naturally inert** — see the ledger note | `sqlExec`, verbatim, ordered after the generation's structural steps | its `<block>#<index>` key is recorded in the snapshot's `appliedDataMigrations` |

**The one ledger extension.** Rename/backfill/transform steps are *naturally*
inert (guarded on a structural condition in the diff) — M-T2.1's "the snapshot
IS the applied-history record" property holds untouched. A raw `sql` step has
no structural condition, so `SchemaSnapshot` gains one optional field:
`appliedDataMigrations?: string[]` (keys `"<blockName>#<stepIndex>"`; block
names are already validator-unique). A `sql` step is emitted exactly once, in
declaration order, and recorded. No new file; `schemaVersion` stays `1` — an
optional-field addition old snapshots read fine (the schema-qualification
format bump set the tolerant-read precedent).

**`sql` ordering + the expand/contract discipline.** Raw steps run at the
**end** of their generation's migration, after all structural steps. Data
rescue *before* a drop is therefore the standard two-generation
expand→migrate→contract dance: generation 1 adds the new home + backfill/`sql`
copies while the old column still exists; generation 2 drops the old column
(destructive-gated, as today). This is documented behavior, not a limitation:
interleaving user SQL into the FK-safe global step order (drops run *first*)
is exactly the cleverness that corrupts databases.

**Lifecycle.** Rename steps stay the permanent ledger (structural, never go
stale). Data steps (`= expr` / `using` / `sql`) *may* be pruned once applied
everywhere — the snapshot records them — and **must** be pruned or updated if
a later refactor invalidates their expressions: expressions are re-validated
on every compile, so a stale reference fails loudly at the block, never
silently.

### Expressions — the SQL-renderable subset

Backfill/transform expressions lower in phase ⑤ as ordinary typed `ExprIR`
**scoped to the aggregate** (sibling fields resolve as `this-prop` refs →
snake-cased column references; the transform's own field refers to the
pre-cast column value). Phase ⑨ renders them to SQL text.

- **Renderer** — greenfield (verified: no ExprIR→SQL-text renderer exists;
  the find-where/criterion lowerings produce per-backend ORM *objects*, and
  `seedSqlLiteral` covers literals only): `renderSqlScalarExpr(e, ctx)` in
  `src/generator/sql-pg-expr.ts`, absorbing `seedSqlLiteral`'s literal
  handling. v1 supports: literals (string/int/long/decimal/money/bool/null/
  `now()`), enum values (stored text), `this-prop` refs (→ quoted column,
  `voGroup`-aware for VO leaf columns), unary/binary arithmetic, string
  concatenation (`+` → `||`), comparisons + boolean operators, conditional
  (`?:` → `CASE WHEN`) — and nothing else. Deliberately **not** an
  `ExprTarget` implementation: that contract exists for full-language
  backends; this is a validated subset where most of the 17 kinds are
  *rejected up front*, not rendered.
- **Honest gate**: a paired pure predicate `sqlRenderableExpr(e): true |
  {reason}` backs an IR-level check (`loom.migration-expr-unsupported`) so an
  unsupported expression is a compile error at the step, never an emit crash.
  Type checks ride the existing type system: `loom.backfill-type-mismatch`
  (expr type = field type), `loom.transform-type-mismatch` (expr type = new
  column type).
- **Shape restriction**: backfill/transform target relational (and embedded
  *root-scalar*) columns. On a `shape(document)` aggregate there is no column
  to backfill — rejected with `loom.migration-step-shape-unsupported` (honest
  gate; the `sql` step over the `data` jsonb column is the v1 story there).
- **Layering** is clean: `system/migrations-builder.ts` already sits above
  `generator/` (it feeds `sql-pg.ts`), and `IndexShape.predicate` already
  carries pre-rendered SQL text through the platform-neutral IR —
  `valueSql`/`usingSql` follow that exact precedent.

### `MigrationStep` additions (`src/ir/types/migrations-ir.ts`)

```ts
| { op: "backfillColumn"; table: string; schema?: string; column: string;
    valueSql: string; onlyNull: boolean }        // UPDATE t SET c = <valueSql> [WHERE c IS NULL]
| { op: "sqlExec"; sql: string }                 // verbatim statement
| { op: "renameIndex"; from: string; to: string; schema?: string }   // M-T2.1 (a)
// alterColumnType gains:  usingSql?: string     // replaces the default `col::type` cast
```

`onlyNull: true` (the backfill default) makes re-application against a
half-migrated table safe and is exactly what the NOT-NULL sequence needs.
Rendering is **two renderers, zero per-backend emitter work**:

- `sql-pg.ts` (TS/.NET/Python/Java): `backfillColumn` → `UPDATE`; `sqlExec` →
  verbatim + `;`; `renameIndex` → `ALTER INDEX … RENAME TO`; `usingSql` →
  `USING (<expr>)`. The existing wrappers carry them untouched — Drizzle's
  statement-breakpoint join, EF's single `migrationBuilder.Sql(@"…")`,
  Python's `splitStatements` (one statement per step arm holds), Flyway's
  plain `.sql`.
- `elixir/migrations-emit.ts` (Ecto): `backfillColumn`/`sqlExec`/`renameIndex`
  → `execute("…")` (precedent: `execute` already carries `CREATE SCHEMA IF NOT
  EXISTS`); the transform → `execute` of the full `ALTER … USING` statement
  (Ecto's `modify/3` has no `USING` seam).

### Destructive-gate integration (`applyDestructivePolicy`)

- An `addColumn` NOT-NULL-no-default **with a declared backfill** is *not
  destructive*: it rewrites to the three-step sequence with a **real UPDATE**
  in the middle — **no `--allow-destructive` needed**. Undeclared, the gate +
  TODO-comment path stays, and `MigrationDestructiveError`'s message now names
  the fix: `add a backfill step: migration "…" { Order.status = <value> }`.
- A NULL→NOT-NULL **flip** joins the destructive classification (problem #3):
  with a declared backfill it becomes `backfillColumn` → flip,
  non-destructive; without, it is gated exactly like a blocking add.
- An `alterColumnType` **without** a transform keeps today's default cast but
  gains an advisory `loom.migration-type-change-untransformed` **warning**
  when the (from, to) pair is off the known-safe widening list (`int→bigint`,
  `int→decimal`, `*→text`) — pointing at `using`. Warning, not gate: Postgres
  fails loudly on impossible casts, and hard-gating every type change would
  punish the safe majority.

## M-T2.1 deferred slices — closed

**(a) `renameIndex` collapse.** After `diffTable` fills the buckets, pair each
`dropIndex` with the `addIndex` that is the *same index under a new name*:
identical `(table, columns, unique, predicate, opclasses)` once old column
names are mapped through this generation's column/table renames. Collapse to
`renameIndex`. Retires the drop+recreate on **both** table renames and column
renames — derived FK-index names ride along instead of rebuilding.

**(b) Sibling reference-collection `targetFk`.** `resolveTableRenames` today
cascades only tables the renamed aggregate *owns*. Add a second pass, run per
module against the **global** intent list (a sibling owner can live in another
module): for every aggregate whose `associations` carry `targetFk ===
snake(old) + "_id"`, emit a `columnRename` on that join table (`order_id →
purchase_order_id` on the *sibling's* join table). Its covering index follows
via (a). Removes the last place an aggregate rename leaks into the destructive
gate.

**(c) Inheritance / document / embedded / eventLog coverage.** Verify-first
audit per shape, then close what's real:

- **TPC** concrete rename — standard root cascade over the *merged*
  descriptor (expected to work today; pin with a test).
- **TPH** — renaming the **base** renames the shared table (root cascade).
  Renaming a **concrete** changes no DDL but strands the discriminator
  *data*: cascade `sqlExec` `UPDATE <base> SET kind = 'New' WHERE kind =
  'Old'`, guarded by the rename's own baseline guard.
- **document / embedded** roots — single `renameTable` (no owned child
  tables; jsonb payload keys are field-named, unaffected). Pin with tests.
- **eventLog / eventSourced** — the per-context `<ctx>_events` stream carries
  a `stream_type` column; where it embeds the aggregate name, cascade the
  same `sqlExec` fix-up (`UPDATE <ctx>_events SET stream_type = … WHERE …`).
- **Adjacent gap, dispositioned not dropped**: renaming a **workflow** or
  **projection** drop+recreates its state/projection table today — the same
  bug class on a different declaration kind. The tracker gains it as
  **M-T2.1 slice (d)** (extend `TableRename`'s live side beyond
  `[Aggregate:ID]`) rather than silently widening this design's scope.

## M-T2.4 — shape/strategy-change migrations

**Detection needs one stored fact.** The effective saving shape is derivable
from *current* source but not from the *baseline* (its source is gone — the
snapshot is exactly the home for last-generation facts, consistent with
"store a fact only when it's an input the pipeline can't re-derive").
`TableShape` gains optional `savingShape?: "relational" | "document" |
"embedded" | "eventLog"` and `inheritance?: "tph" | "tpc"`, stamped by
`schemaFromModule`. Absent on old snapshots ⇒ detection simply doesn't fire
until one regen has stamped it — graceful, no format bump.

**Behavior on a flip** (same-named table, different shape; or a TPH↔TPC table-set change):

1. Without `--allow-destructive`: a dedicated `MigrationShapeChangeError`
   (`loom.migration-shape-change`) naming the aggregate, `from → to` shape,
   and the recipe — replacing today's misleading generic destructive listing.
   CLI-caught alongside `MigrationDestructiveError` / `MigrationBaselineError`.
2. Under `--allow-destructive`: **no drop.** Emit `renameTable(orders →
   orders__pre_reshape)` → `createTable(orders, <new shape>)` → `sqlComment`
   TODO naming the copy the operator owes, with the `sql`-step recipe
   (`INSERT INTO orders (…) SELECT … FROM orders__pre_reshape`). The backup
   table **is stamped into the written snapshot**, so the *next* generation
   diffs it as a `dropTable` — gated like any drop. Result: zero silent loss,
   no orphaned backup, cleanup stays a deliberate operator act.

## Decision record (minted in slice S8 — the first `D-MIG-*` tags)

- **D-MIG-NO-DOWN** — down-migrations are **no-op everywhere, by decision**
  (today's de-facto behavior, promoted to a pinned decision). Operators roll
  forward; recovery is backup + roll-forward. Down paths are
  untested-by-construction and data-destructive (the "down" of a backfill is
  a drop), and the snapshot ledger re-derives forward state
  deterministically.
- **D-MIG-DSL-STEPS** (supersedes the mission's stub-file sketch) — data
  migrations are DSL steps in the `migration` block, not emitted stub files;
  rationale at the top of this doc.
- **Manual native migrations** (procedural, app-level — beyond SQL): a
  hand-written migration file carrying a `__manual` marker in its name is
  **tolerated by the M-T2.2 baseline guard (b)** (skipped in the
  files↔history comparison) and applied by the native runner in version order
  where the runner scans the directory (Flyway, Python, Ecto). For Drizzle
  the journal rebuild must **preserve entries it didn't emit**; EF users go
  through `dotnet ef migrations add`. Documented per backend in
  `migrations.md`. This is the pressure valve that keeps the `sql` step
  honest about being SQL-only.

## Validators (structural / snapshot-independent, per M-T2.1)

| Code | Rejects |
|---|---|
| `loom.migration-expr-unsupported` | backfill/transform expression outside the SQL-renderable subset |
| `loom.backfill-type-mismatch` | backfill expr type ≠ field type |
| `loom.transform-type-mismatch` | transform expr type ≠ new column type |
| `loom.backfill-duplicate` | two backfills for one `Agg.field` within one block |
| `loom.migration-sql-empty` | `sql ""` |
| `loom.migration-step-shape-unsupported` | backfill/transform on a `shape(document)` aggregate |
| `loom.migration-type-change-untransformed` | *warning* — risky type change with no `using` |
| `loom.migration-shape-change` | generate-time (M-T2.4), replaces the generic destructive error |

A backfill's `Agg` stays a live cross-reference (its field must exist *now* —
it names the new column) with the field name raw, mirroring `ColumnRename`.

## Implementation slices (each an independent PR, in order)

| # | Slice | Size | Contents / gate |
|---|---|---|---|
| S1 | **Step vocabulary + renderers** | S | New `MigrationStep` variants + `usingSql`; `sql-pg.ts` + `elixir/migrations-emit.ts` arms; `renderSqlScalarExpr` + `sqlRenderableExpr` (absorbing `seedSqlLiteral`). Pure vocabulary — no producer, zero behavior change; a clean-repo regen stays byte-identical. Unit tests per arm, both renderers. |
| S2 | **Grammar + IR + lowering + validators + print** | M | Step alternatives; soft keywords (`using`, `sql`) + keyword-coverage snapshot + `langium:generate` committed; `BackfillIntentIR` / `TransformIntentIR` / `SqlStepIR` (+ `RenameIntentIR.using`); expr lowering in aggregate scope; the validator table above; `print-structural` arms (print-completeness gated); parsing + negative-validator + roundtrip tests. Ships with a temporary honest gate — `loom.migration-data-steps-unsupported` — lifted by S3, so a half-landed surface errors instead of silently no-oping. |
| S3 | **Builder consumption** | M | `buildMigrations` threads the intents; backfill → non-destructive NOT-NULL sequence; NULL→NOT-NULL flip gating + backfill integration; transform → `usingSql`; `sqlExec` + `appliedDataMigrations` snapshot ledger; upgraded `MigrationDestructiveError` message; lifts the S2 gate. Tests: `migrations-builder` e2e (two-generation ledger inertness, exactly-once `sql`, chained rename+transform) + a boot-verified backfill round-trip (generated stack: migrate → insert rows → regen with a NOT-NULL+backfill field → migrate → assert values), per the generated-stack-verifier discipline. |
| S4 | **`renameIndex` collapse** (M-T2.1 a) | S | Pairing in `diffSchema` (renderers already in S1); tests: table rename and column rename each produce `renameIndex`, zero index drop/creates. |
| S5 | **Sibling `targetFk` cascade + TPH discriminator data** (M-T2.1 b + TPH arm of c) | S | Second cascade pass over the global intent list; `sqlExec` for `kind` values; tests incl. a cross-module sibling. |
| S6 | **Shape-coverage audit + closure** (rest of M-T2.1 c) | S | TPC/document/embedded/eventLog rename pins + fixes; tracker gains M-T2.1 (d) (workflow/projection rename) as an explicit follow-on mission. |
| S7 | **M-T2.4 reshape** | M | Shape/strategy stamps on `TableShape`; detection in `diffSchema`; `MigrationShapeChangeError` + CLI catch; backup-rename flow + next-generation gated drop; tests (relational→document, TPH→TPC, backup-drop gating, unstamped-baseline grace). |
| S8 | **Docs + decisions + manual carve-out** | S | `migrations.md` gains a §Data migrations section; `decisions.md` gains D-MIG-NO-DOWN + D-MIG-DSL-STEPS; `__manual` guard tolerance in `migration-artifacts.ts` + Drizzle journal-preserve, with tests; tracker status updates. |

Cross-cutting verification: fast suite + `pipeline-layering` per slice;
langium drift gate on S2; the per-backend compile gates (`hono-build`,
`dotnet-build`, `java-build`, `python-build`, `elixir-vanilla-build`) on
S1/S3 — migration files change shape only when new steps are present, so a
clean regen stays byte-identical throughout the whole sequence.

## Acceptance (tracker-style, for the whole gap set)

- NOT-NULL add **with** a declared backfill applies with **no flag** — a real
  `UPDATE` between add and `SET NOT NULL`, boot-verified against a populated
  database. **Without** one it stays gated, and the error names the backfill
  syntax.
- A `sql` step is applied **exactly once** across three consecutive
  generations (snapshot ledger), verbatim on all five backends.
- Rename+type-change with `using` emits `renameColumn` + `alterColumnType …
  USING (<expr>)`; all shipped M-T2.1 acceptance stays green untouched.
- Aggregate rename end-state: FK indexes emit `renameIndex` (zero index
  drop/creates), a sibling's reference-collection join table renames its
  `targetFk`, TPH discriminator values are rewritten — **an aggregate rename
  emits zero destructive steps anywhere in the system**.
- Shape flip: dedicated diagnostic without the flag; with it, backup-rename +
  create + TODO (no `dropTable` in generation 1) and the backup's drop gated
  in generation 2.
- Down migrations remain no-op — D-MIG-NO-DOWN recorded; `migrations.md`
  documents the expand→migrate→contract discipline.
