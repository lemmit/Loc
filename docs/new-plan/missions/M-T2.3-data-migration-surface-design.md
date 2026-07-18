# M-T2.3 — Data-migration surface (design + implementation plan)

> **Status: implemented (PR #1983 — design + slices S1–S4 in one PR, one
> commit per slice), scope trimmed to the crucial core per review.**
> v1 ships exactly two data steps — **backfill** and **raw `sql`** — plus the
> destructive-gate fixes they unlock.
>
> **Update 2026-07-18 — the deferred appendix items shipped** (one PR each):
> `renameIndex` collapse (a), the sibling `targetFk` cascade (b), the
> shape-coverage audit + eventLog `stream_type` fix-up (c), and **M-T2.4
> reshape detection** are all landed (see `docs/new-plan/T2-data-evolution.md`
> for the code evidence). Still deferred: the **transform `using` clause** and
> the **workflow/projection rename** (tracker slice d) — both propose-first.
> Verified against `main` @ #1981 — no in-flight PR touches this area.
> Sources: `docs/new-plan/T2-data-evolution.md`,
> [`M-T2.1-migration-surface-design.md`](M-T2.1-migration-surface-design.md),
> `docs/audits/architecture-weak-spots-2026-07.md` §2,
> `src/system/migrations-builder.ts`, `src/generator/sql-pg.ts`,
> `src/generator/elixir/migrations-emit.ts`, `docs/migrations.md`.

## Problem (the crucial subset)

The structural diff engine is real (ALTER, FK-ordered, destructive-gated,
rename-intent-aware), but **nothing moves data through evolution** — the
weak-spot audit's words: *"No data migrations — the only concession is a
`-- TODO backfill` comment."* The gaps v1 closes:

1. **NOT-NULL adds** — the sole concession is the `--allow-destructive`
   rewrite `add nullable → "-- TODO backfill" sqlComment → SET NOT NULL`
   (`applyDestructivePolicy`, `migrations-builder.ts`). The operator must
   hand-edit generated SQL — per backend, per environment — or the
   `SET NOT NULL` fails on any populated table.
2. **NULL → NOT NULL flips** on an existing column are **not gated at all**
   (`applyDestructivePolicy` classifies only `dropTable` / `dropColumn` /
   blocking NOT-NULL *adds*) — they fail at apply time on any row holding
   NULL. A gap discovered while writing this design; closed here.
3. **No escape hatch** — no sanctioned way to run *any* one-shot DML (seed a
   derived column, fix up data ahead of a contract step) through the
   migration chain. `MigrationStep` is DDL-only.
4. **TPH concrete rename strands data silently** — renaming a TPH concrete
   changes no DDL, so the shipped M-T2.1 cascade emits nothing, and rows
   keep the old `kind` discriminator forever. The one rename residue that is
   *silent corruption* rather than gated inconvenience — included in v1 on
   that criterion.

Deliberately **not** in v1 (appendix): type-change transforms (covered by
expand→contract + backfill, see below), `renameIndex` niceties, the sibling
`targetFk` cascade (gated today, never silent), M-T2.4 reshape detection
(gated today), workflow/projection rename, the `__manual` file carve-out.

## Direction — grow the existing `migration` block; no new files, no second surface

M-T2.1 deliberately shaped `migration "<name>" { … }` so data steps *"slot in
as further step alternatives"*. **The originally-sketched per-backend "stub
file the user fills" is rejected** — the same way M-T2.1 rejected the inline
`renamed from` annotation:

- A hand-edited generated file must survive regeneration → write-once
  machinery, five per-backend variants of the same logic (a Drizzle `.sql`,
  an EF class, an Ecto `.exs`, a Flyway file, a Python `.sql`), and a
  violated "the generated tree is disposable" invariant. The coupling is the
  debt.
- A DSL-side step is single-source, cross-backend by construction (every
  backend applies Postgres), rides the **existing** migration chain (same
  file, same version, same history entry), and is validated + printed +
  ledgered like every other step.

### Surface (v1 — two steps, both keyword-light)

```ddd
migration "order-evolution" {
  Order.qty -> quantity            // column rename          (shipped, M-T2.1)
  Order -> PurchaseOrder           // table/aggregate rename (shipped, M-T2.1)
  Order.status = "pending"         // NEW: backfill
  sql "UPDATE sales.orders SET note = '' WHERE note IS NULL"   // NEW: raw escape hatch
}
```

- **Backfill is keyword-free**: `Agg.field = <expr>` — `=` carries the intent
  exactly as `->` carries rename. No new token. (The target field is spelled
  bare, like the rename target: a backfill can only hit its own table, so
  re-qualifying would only make invalid cross-table spellings representable.)
- **`sql`** heads the raw step — one new soft keyword, admitted in the
  identifier-position unions + keyword-coverage snapshot refreshed, so a
  domain field named `sql` keeps parsing.

Disambiguation is LL(k)-clean: after `Agg.field` the next token decides
(`->` rename, `=` backfill); `sql` + STRING is the raw step.

Generated output (Postgres — shared by TS/.NET/Python/Java via `renderPgStep`;
Ecto via `execute/1`):

```sql
ALTER TABLE "sales"."orders" ADD COLUMN "status" TEXT NULL;
UPDATE "sales"."orders" SET "status" = 'pending' WHERE "status" IS NULL;
ALTER TABLE "sales"."orders" ALTER COLUMN "status" SET NOT NULL;
UPDATE sales.orders SET note = '' WHERE note IS NULL;
```

### Why no transform step — expand→migrate→contract covers it

A type change with a value mapping needs **no dedicated syntax** because
backfill expressions may reference sibling columns. The standard discipline:

```ddd
// generation 1 — expand: add the new column, fill it from the old
aggregate Order { total: decimal  totalCents: int }
migration "cents-expand" { Order.totalCents = total * 100 }

// generation 2 — contract: drop the old column (destructive-gated, deliberate)
aggregate Order { totalCents: int }
```

```sql
-- generation 1
ALTER TABLE "sales"."orders" ADD COLUMN "total_cents" INTEGER NULL;
UPDATE "sales"."orders" SET "total_cents" = "total" * 100 WHERE "total_cents" IS NULL;
ALTER TABLE "sales"."orders" ALTER COLUMN "total_cents" SET NOT NULL;
-- generation 2 (under --allow-destructive)
ALTER TABLE "sales"."orders" DROP COLUMN "total";
```

An in-place `alterColumnType` keeps today's blind default cast
(`USING col::type`) — Postgres fails loudly on impossible casts, and the
expand→contract path is the documented recipe for lossy ones. A convenience
`using <expr>` clause remains a possible later addition (appendix), not v1.

### Semantics per step

| Step | Fires when (per generation, against the module's baseline) | Emits | Inert when |
|---|---|---|---|
| `Agg.f = expr` (backfill) | the diff contains an `addColumn` for that column, **or** a NULL→NOT-NULL `alterColumnNullable` for it | `addColumn` (nullable) → `backfillColumn` → `alterColumnNullable(NOT NULL)`; or `backfillColumn` → the flip | column already present + populated in baseline (baked in) |
| `sql "…"` | **not naturally inert** — see the ledger note | `sqlExec`, verbatim, ordered after the generation's structural steps | its `<block>#<index>` key is recorded in the snapshot's `appliedDataMigrations` |

**The one ledger extension.** Rename/backfill steps are *naturally* inert
(guarded on a structural condition in the diff) — M-T2.1's "the snapshot IS
the applied-history record" property holds untouched. A raw `sql` step has no
structural condition, so `SchemaSnapshot` gains one optional field:
`appliedDataMigrations?: string[]` (keys `"<blockName>#<stepIndex>"`; block
names are already validator-unique). A `sql` step is emitted exactly once, in
declaration order, and recorded. No new file; `schemaVersion` stays `1` — an
optional-field addition old snapshots read fine (the schema-qualification
format bump set the tolerant-read precedent).

**`sql` ordering + the expand/contract discipline.** Raw steps run at the
**end** of their generation's migration, after all structural steps. Data
rescue *before* a drop is therefore the two-generation expand→contract dance
above. Documented behavior, not a limitation: interleaving user SQL into the
FK-safe global step order (drops run *first*) is exactly the cleverness that
corrupts databases.

**Lifecycle.** Rename steps stay the permanent ledger (structural, never go
stale). Data steps (`= expr` / `sql`) *may* be pruned once applied everywhere
— the snapshot records them — and **must** be pruned or updated if a later
refactor invalidates their expressions: expressions are re-validated on every
compile, so a stale reference fails loudly at the block, never silently.

### Expressions — the SQL-renderable subset

Backfill expressions lower in phase ⑤ as ordinary typed `ExprIR` **scoped to
the aggregate** (sibling fields resolve as `this-prop` refs → snake-cased
column references). Phase ⑨ renders them to SQL text.

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
  Type check rides the existing type system: `loom.backfill-type-mismatch`
  (expr type = field type).
- **Shape restriction**: backfill targets relational (and embedded
  *root-scalar*) columns. On a `shape(document)` aggregate there is no column
  to backfill — rejected with `loom.migration-step-shape-unsupported` (honest
  gate; the `sql` step over the `data` jsonb column is the v1 story there).
- **Layering** is clean: `system/migrations-builder.ts` already sits above
  `generator/` (it feeds `sql-pg.ts`), and `IndexShape.predicate` already
  carries pre-rendered SQL text through the platform-neutral IR — `valueSql`
  follows that exact precedent.

### `MigrationStep` additions (`src/ir/types/migrations-ir.ts`)

```ts
| { op: "backfillColumn"; table: string; schema?: string; column: string;
    valueSql: string; onlyNull: boolean }        // UPDATE t SET c = <valueSql> [WHERE c IS NULL]
| { op: "sqlExec"; sql: string }                 // verbatim statement
```

`onlyNull: true` (the backfill default) makes re-application against a
half-migrated table safe and is exactly what the NOT-NULL sequence needs.
Rendering is **two renderers, zero per-backend emitter work**:

- `sql-pg.ts` (TS/.NET/Python/Java): `backfillColumn` → `UPDATE`; `sqlExec` →
  verbatim + `;`. The existing wrappers carry them untouched — Drizzle's
  statement-breakpoint join, EF's single `migrationBuilder.Sql(@"…")`,
  Python's `splitStatements` (one statement per arm holds), Flyway's plain
  `.sql`.
- `elixir/migrations-emit.ts` (Ecto): both → `execute("…")` (precedent:
  `execute` already carries `CREATE SCHEMA IF NOT EXISTS`).

### Destructive-gate integration (`applyDestructivePolicy`)

- An `addColumn` NOT-NULL-no-default **with a declared backfill** is *not
  destructive*: it rewrites to the three-step sequence with a **real UPDATE**
  in the middle — **no `--allow-destructive` needed**. Undeclared, the gate +
  TODO-comment path stays, and `MigrationDestructiveError`'s message now names
  the fix: `add a backfill step: migration "…" { Order.status = <value> }`.
- A NULL→NOT-NULL **flip** joins the destructive classification (problem #2):
  with a declared backfill it becomes `backfillColumn` → flip,
  non-destructive; without, it is gated exactly like a blocking add.

### TPH discriminator fix-up (problem #4)

The shipped table-rename cascade (`resolveTableRenames`) gains one arm: when
the renamed aggregate is a **TPH concrete**, emit
`sqlExec` `UPDATE <base table> SET kind = 'New' WHERE kind = 'Old'` — guarded
by the rename's own baseline guard, so it is ledger-inert like the rest of
the cascade. (~10 lines inside the existing cascade; included in v1 because
the status quo is *silent* data corruption, not a gated inconvenience.)

```ddd
migration "car-to-sedan" { Car -> Sedan }        // Car is TPH under Vehicle
```
```sql
UPDATE "fleet"."vehicles" SET "kind" = 'Sedan' WHERE "kind" = 'Car';
```

## Decision record (minted in slice S4 — the first `D-MIG-*` tags)

- **D-MIG-NO-DOWN** — down-migrations are **no-op everywhere, by decision**
  (today's de-facto behavior, promoted to a pinned decision). Operators roll
  forward; recovery is backup + roll-forward. Down paths are
  untested-by-construction and data-destructive (the "down" of a backfill is
  a drop), and the snapshot ledger re-derives forward state deterministically.
- **D-MIG-DSL-STEPS** (supersedes the mission's stub-file sketch) — data
  migrations are DSL steps in the `migration` block, not emitted stub files;
  rationale above.

## Validators (structural / snapshot-independent, per M-T2.1)

| Code | Rejects |
|---|---|
| `loom.migration-expr-unsupported` | backfill expression outside the SQL-renderable subset |
| `loom.backfill-type-mismatch` | backfill expr type ≠ field type |
| `loom.backfill-duplicate` | two backfills for one `Agg.field` within one block |
| `loom.migration-sql-empty` | `sql ""` |
| `loom.migration-step-shape-unsupported` | backfill on a `shape(document)` aggregate |

A backfill's `Agg` stays a live cross-reference (its field must exist *now* —
it names the new column) with the field name raw, mirroring `ColumnRename`.

## Implementation slices (each an independent PR, in order)

| # | Slice | Size | Contents / gate |
|---|---|---|---|
| S1 ✅ | **Step vocabulary + renderers** | S | `backfillColumn` / `sqlExec` in `migrations-ir.ts`; `sql-pg.ts` + `elixir/migrations-emit.ts` arms; `renderSqlScalarExpr` + `sqlRenderableExpr` (absorbing `seedSqlLiteral`). Pure vocabulary — no producer, zero behavior change; a clean-repo regen stays byte-identical. Unit tests per arm, both renderers. |
| S2 ✅ | **Grammar + IR + lowering + validators + print** | M | The two step alternatives; `sql` soft keyword + keyword-coverage snapshot + `langium:generate` committed; `BackfillIntentIR` / `SqlStepIR`; expr lowering in aggregate scope; the validator table above; `print-structural` arms (print-completeness gated); parsing + negative-validator + roundtrip tests. Ships with a temporary honest gate — `loom.migration-data-steps-unsupported` — lifted by S3, so a half-landed surface errors instead of silently no-oping. |
| S3 ✅ | **Builder consumption** | M | `buildMigrations` threads the intents; backfill → non-destructive NOT-NULL sequence; NULL→NOT-NULL flip gating + backfill integration; `sqlExec` + `appliedDataMigrations` snapshot ledger; TPH discriminator arm in `resolveTableRenames`; upgraded `MigrationDestructiveError` message; lifts the S2 gate. Tests: `migrations-builder` e2e (two-generation ledger inertness, exactly-once `sql`, expand→contract recipe) + a boot-verified backfill round-trip (generated stack: migrate → insert rows → regen with a NOT-NULL+backfill field → migrate → assert values), per the generated-stack-verifier discipline. |
| S4 ✅ | **Docs + decisions** | S | `migrations.md` gains a §Data migrations section (incl. the expand→migrate→contract recipe); `decisions.md` gains D-MIG-NO-DOWN + D-MIG-DSL-STEPS; tracker status updates. |

Cross-cutting verification: fast suite + `pipeline-layering` per slice;
langium drift gate on S2; the per-backend compile gates (`hono-build`,
`dotnet-build`, `java-build`, `python-build`, `elixir-vanilla-build`) on
S1/S3 — migration files change shape only when new steps are present, so a
clean regen stays byte-identical throughout the whole sequence.

## Acceptance (tracker-style)

- NOT-NULL add **with** a declared backfill applies with **no flag** — a real
  `UPDATE` between add and `SET NOT NULL`, boot-verified against a populated
  database. **Without** one it stays gated, and the error names the backfill
  syntax.
- A NULL→NOT-NULL flip on a populated column is gated (previously it failed
  silently at apply time); with a backfill it applies cleanly.
- A `sql` step is applied **exactly once** across three consecutive
  generations (snapshot ledger), verbatim on all five backends.
- The expand→migrate→contract recipe round-trips: generation 1 backfills the
  new column from the old; generation 2's drop stays destructive-gated.
- Renaming a TPH concrete rewrites its discriminator rows.
- Down migrations remain no-op — D-MIG-NO-DOWN recorded.

---

## Appendix — deferred, with sketches (not lost, just not v1)

Each of these is **gated or cosmetic today** (never silent), so it can wait.
Sketches preserved from the pre-trim design for whoever picks them up:

- **Transform clause** (`Agg.old -> new using <expr>` / `Agg.f using <expr>`)
  — convenience over expand→contract; would add `alterColumnType.usingSql`
  and a `using` soft keyword. Only worth it if expand→contract proves
  annoying in practice.
- **`renameIndex` collapse** (M-T2.1 a) — pair a `dropIndex` with the
  `addIndex` that is the same index under a new name (identical table/
  columns/unique/predicate/opclasses after rename mapping) → `ALTER INDEX …
  RENAME TO`. Cosmetic: the rebuild is non-destructive.
- **Sibling reference-collection `targetFk` cascade** (M-T2.1 b) — a second
  cascade pass over the *global* intent list renaming `snake(old)_id` on
  sibling-owned join tables. Gated today, never silent.
- **Rest of M-T2.1 (c)** — TPC/document/embedded/eventLog rename audit +
  pins (TPH data fix-up shipped in v1; the rest is verify-first).
- **M-T2.1 (d)** — workflow/projection rename (extend `TableRename`'s live
  side beyond `[Aggregate:ID]`). Tracked in the T2 tracker.
- **M-T2.4 reshape detection** — stamp `savingShape?` / `inheritance?` on
  snapshot `TableShape`s; flip → dedicated `loom.migration-shape-change`
  error; under the flag, rename to `<table>__pre_reshape` + create + TODO
  recipe, backup stamped into the snapshot so its cleanup drop is gated next
  generation. Gated today (generic destructive error), so deferred.
- **`__manual` file carve-out** in the M-T2.2 baseline guard (b) for
  hand-written native migrations — the `sql` step reduces the need; revisit
  on demand.
