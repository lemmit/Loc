# Loom Migrations Design

## Context

Loom's only existing migration emitter is on Phoenix
(`src/generator/phoenix-live-view/migrations-emit.ts`). It synthesizes a single
"initial" migration set fresh from the current aggregate IR on every emit, with
deterministic timestamps based on a fixed `BASE_TIMESTAMP = 20260101000000`.
There is no notion of "the schema as it existed before," so any change to the
DSL silently rewrites that initial migration — fine for greenfield demos, but
unusable against a database that already holds data. TS/Hono and .NET have no
migration emission at all today; the TS deployable ships `drizzle-kit` and
`db:migrate` scripts in `pins.ts` but no migration files for them to run, and
.NET emits `EntityTypeConfiguration<T>` classes with no `Migrations/` folder.

The goal: introduce a snapshot-driven, platform-neutral schema delta — the
**MigrationsIR** — and teach three backends to emit additive migration files
from it. The checked-in snapshot at `.loom/snapshots/<module>.snapshot.json` is
the source of truth for "what the schema looked like last time"; each regen
diffs it against the current aggregate set, emits one new dated migration per
module that closes the gap, then rewrites the snapshot. Cross-backend
consistency falls out of having one shared diff layer; backends only translate
steps to their syntax.

## Decisions locked

1. **v1 platforms**: Phoenix (refactor existing), TS/Hono (new), .NET (new).
2. **Snapshot location**: repo-tracked, `.loom/snapshots/<module>.snapshot.json`.
3. **Ownership**: implicit — first deployable to bind a storage as `primary`
   owns its migrations. No DSL grammar change in v1.

## Architecture

### Layer 1 — Platform-neutral `MigrationsIR`

New module `src/ir/migrations-ir.ts`:

```ts
export type MigrationsIR = {
  module: string;
  storageName: string;
  baseline: SchemaSnapshot | null;   // null = initial migration
  next: SchemaSnapshot;
  steps: MigrationStep[];            // ordered ops baseline → next
  version: string;                   // deterministic timestamp slug
  name: string;                      // "Initial" or "AddOrderStatus"
};
export type SchemaSnapshot = {
  schemaVersion: 1;
  tables: TableShape[];              // sorted by name for stable JSON
};
export type ColumnType =
  | { kind: "uuid" | "int" | "bigint" | "text" | "bool" | "decimal"
        | "datetime" | "json" }
  | { kind: "array"; inner: ColumnType };
export type ColumnShape = {
  name: string; type: ColumnType; nullable: boolean; default?: string;
};
export type FKShape = { column: string; refTable: string; onDelete: "cascade" | "restrict" };
export type IndexShape = { name: string; table: string; columns: string[]; unique: boolean };
export type TableShape = {
  name: string; ownerModule: string;
  columns: ColumnShape[]; primaryKey: string[];
  foreignKeys: FKShape[]; indexes: IndexShape[];
};
export type MigrationStep =
  | { op: "createTable"; table: TableShape }
  | { op: "dropTable"; name: string }
  | { op: "addColumn"; table: string; column: ColumnShape; fk?: FKShape }
  | { op: "dropColumn"; table: string; name: string }
  | { op: "alterColumnNullable"; table: string; name: string; nullable: boolean }
  | { op: "alterColumnType"; table: string; name: string; from: ColumnType; to: ColumnType }
  | { op: "addIndex"; index: IndexShape }
  | { op: "dropIndex"; table: string; name: string };
```

### Layer 2 — Builder + diff (`src/ir/migrations-builder.ts`)

Pure functions, no I/O:

- `schemaFromModule(module: ModuleIR, storage: StorageIR): SchemaSnapshot`
  — lifted from Phoenix's current in-line logic (the
  `typeToEctoColumn`/containment work) and rewritten to return the
  platform-neutral `TableShape[]`. **Single source of truth for "what tables
  this module needs".** Backends never recompute it.
- `diffSchema(prev: SchemaSnapshot | null, next: SchemaSnapshot): MigrationStep[]`
  — table-level diff by name, column-level diff inside matched tables, index
  diff. **Column rename is not detected** (drop+add); document as a v1
  limitation; future escape hatch via a `@migration(rename: "old")`
  annotation is out of scope.
- `buildMigrations(sys: SystemIR, snapshots: SnapshotStore): MigrationsIR[]`
  — one entry per `(module, storage)` pair where the current deployable's
  declaration order makes it the implicit owner (see Layer 4). Returns empty
  steps when the snapshot already matches — emitter must skip in that case so
  regenerating a clean repo is a no-op.

### Layer 3 — Snapshot I/O (`src/system/snapshot.ts`)

```ts
export interface SnapshotStore {
  read(module: string): SchemaSnapshot | null;
}
export const fsSnapshotStore = (root: string): SnapshotStore => ...;
```

- Reader is an interface so tests inject in-memory stores; CLI wires the `fs`
  implementation in `src/cli/main.ts`, web playground gets a VFS-backed one in
  `web/` (mirrors how `_packs/loader-fs.js` is swapped — see CLAUDE.md note).
- Writer is just `out.set(".loom/snapshots/<module>.snapshot.json", json)` —
  one per module, emitted at system level alongside wire-spec. The existing
  output-writer handles disk landing.

### Layer 4 — Owner enrichment (`src/ir/enrichments.ts`)

One new pass added after the existing `wireShape` / `findAll` / `react targets`
work:

> For each `(module, storageName)` pair, walk `sys.deployables` in
> declaration order; the first deployable whose `moduleBindings[].storages[]`
> contains `(role: "primary", storageName)` becomes the owner. Attach
> `migrationsOwner: deployable.name` to the module.

Backends consult `module.migrationsOwner === deployable.name` before emitting
migrations. Non-owners skip silently. **No grammar change** — purely an
enrichment-time derivation.

### Layer 5 — Per-backend emitters

| Backend | File | Action |
|---|---|---|
| Phoenix | `src/generator/phoenix-live-view/migrations-emit.ts` | **Refactor**. Accept `MigrationsIR[]` instead of `BoundedContextIR[]`. Initial-migration output must be byte-for-byte unchanged (lock with existing `phoenix-live-view-pipeline.test.ts`). Add diff-path emit (`alter table … add column`, etc.) |
| TS/Hono | `src/generator/typescript/emit/migrations.ts` | **New**. Emit `db/migrations/<version>_<snake(name)>.sql` (statements split by `--> statement-breakpoint`) + `db/migrations/meta/_journal.json` rebuilt from `SchemaSnapshot.migrationHistory`. Drizzle's runtime migrator (`drizzle-orm/node-postgres/migrator`) reads exactly these two and tracks applied state in `__drizzle_migrations` — `index.ts` calls `migrate(db, ...)` after the pool is up so the schema is current before `serve()`. `npm run db:migrate` stays wired to `drizzle-kit migrate` for out-of-band runs. We never call `drizzle-kit generate`; Loom owns the SQL |
| .NET | `src/generator/dotnet/emit/migrations.ts` | **New**. Emit `Migrations/<Timestamp>_<Name>.cs` with `[Migration("<ts>_<name>")]` class and `Up(MigrationBuilder b)` / `Down` bodies using `b.Sql(@"...")` raw SQL — avoids EF's model-snapshot tooling entirely. **No `ModelSnapshot` stub is emitted**: the snapshot only feeds `dotnet ef migrations add`, which Loom never runs (the generator owns the source of truth). `Database.Migrate()` consults the migration classes + `__EFMigrationsHistory` at runtime and is happy without a snapshot. Suppress `RelationalEventId.PendingModelChangesWarning` defensively in `AddDbContext` against the off-chance EF widens the check to "no snapshot found". Add `Database.Migrate()` call in `Program.cs` startup |

Both Postgres backends share `src/system/sql-pg.ts`: a `renderPgStep(step):
string` helper so TS and .NET produce identical SQL bodies. Phoenix stays in
Ecto DSL — its output is in Elixir, not SQL, so it does not share this helper.

### Layer 6 — Wiring

- `PlatformSurface.emitProject` (`src/platform/surface.ts`) gains
  `migrations: MigrationsIR[]` in its args.
- `src/system/index.ts` builds `MigrationsIR[]` once via `buildMigrations(...)`
  between the wire-spec emit and the per-deployable loop, writes snapshot
  files into `out`, and passes the per-deployable slice to
  `platform.emitProject(...)`.
- Each platform adapter in `src/platform/{phoenix,hono,dotnet}.ts` forwards
  the `migrations` arg into its respective `generate*ForContexts` function.

## Phased rollout

1. **Foundation, no behavior change.** Add `migrations-ir.ts`,
   `migrations-builder.ts`, `snapshot.ts`, `sql-pg.ts`, owner enrichment.
   Unit tests on the builder/diff. Existing suite stays green; no platform
   touched yet.
2. **Phoenix refactor.** Lift Phoenix's schema synthesis into
   `schemaFromModule`. Wire `MigrationsIR` through. Lock initial-migration
   output byte-for-byte against `phoenix-live-view-pipeline.test.ts`; add
   new diff-path test.
3. **TS migrations.** New emitter + prestart hook + tests.
4. **.NET migrations.** New emitter + `Program.cs` migrator call +
   `PendingModelChangesWarning` suppression + tests.
5. **Validation.** `LOOM_TS_BUILD=1`, `LOOM_PHOENIX_BUILD=1`, `LOOM_E2E=1`.
   Update `docs/generators.md` and `docs/architecture.md`.

## Verification

- `npm test` — unit + IR + builder/diff/snapshot + per-backend emit tests
  green.
- `npx vitest run test/generator/phoenix-live-view-pipeline.test.ts` —
  Phoenix output unchanged byte-for-byte on the initial-migration path
  (post-refactor regression gate).
- `LOOM_TS_BUILD=1 npm run test:tsc` — generated TS project still compiles
  with migrations directory and prestart script present.
- `LOOM_PHOENIX_BUILD=1 npx vitest run test/generated-phoenix-build.test.ts`
  — Ash 3.x mix compile still clean.
- `LOOM_E2E=1 npm run test:e2e` — docker-compose stack starts, migrations
  apply on first boot, `/health` returns 200 across backends.
- Manual: regenerate `examples/acme.ddd`, eyeball
  `.loom/snapshots/sales.snapshot.json` and one representative migration in
  each of the three backend trees; then change a property, regen, confirm
  one new dated migration appears with just the delta and the snapshot
  updates.

## Out of scope for v1

- Column renames (currently emit as drop+add — data-destructive). Future:
  `@migration(rename: "old")` annotation on properties.
- Down migrations beyond the simplest cases. `Down` emitted for .NET to keep
  EF happy but content is best-effort.
- Storages other than Postgres (Phoenix Ecto, TS Drizzle/pg, .NET EF/Npgsql).
  MySQL/SQLite would need a parallel `sql-mysql.ts` etc.
- Java/Spring backend (skipped per user's platform selection).
