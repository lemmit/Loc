// ---------------------------------------------------------------------------
// MigrationsIR — platform-neutral schema delta.
//
// One `MigrationsIR` per owning (module, storage) pair.  `baseline` is the
// schema as it existed last time we generated (read from
// `.loom/snapshots/<module>.snapshot.json`); `next` is the schema the
// current source describes.  `steps` is the ordered op list that closes
// the gap.  Backends only translate steps to their native syntax — they
// never re-derive the schema from the IR.
//
// The shared diff layer (`migrations-builder.ts`) guarantees Phoenix,
// TS/Drizzle and .NET/EF see the same step list for the same delta;
// cross-backend consistency falls out of having one canonical source.
// ---------------------------------------------------------------------------

export type ColumnType =
  | { kind: "uuid" }
  | { kind: "int" }
  | { kind: "bigint" }
  // Auto-incrementing 64-bit surrogate — Postgres `bigserial` (bigint + owned
  // sequence + NOT NULL + default).  Used for the per-context event log's global
  // `seq` cursor (event-log-architecture.md).  DB-assigned; never written by the
  // app, so it carries no `default` in the ColumnShape (the type IS the default).
  | { kind: "bigserial" }
  | { kind: "text" }
  | { kind: "bool" }
  | { kind: "decimal" }
  | { kind: "datetime" }
  | { kind: "json" }
  | { kind: "array"; inner: ColumnType };

export interface ColumnShape {
  name: string;
  type: ColumnType;
  nullable: boolean;
  default?: string;
  /** Set on the flattened leaf columns of a value-object field
   *  (`price: Money` → `price_amount`, `price_currency`, both
   *  `voGroup: "price"`).  Relational backends (Drizzle / EF) emit each
   *  leaf column as-is — the standard DDD destructure-into-columns shape.
   *  Phoenix, whose embedded value objects are stored as one `:map`,
   *  regroups columns sharing a `voGroup` back into a single `:map`
   *  column named for the group.  Absent on ordinary columns. */
  voGroup?: string;
  /** Set on the parent-table column standing in for a value-object
   *  *array* field (`charges: Money[]`).  Names the id-less child table the
   *  elements actually live in.  Relational backends (Drizzle / EF) **skip**
   *  this column — the data is in the child table — while Phoenix, which
   *  models the array as a single `{:array, :map}` column, renders it
   *  normally (the column's `array(json)` type already lowers to
   *  `{:array, :map}`).  Absent on ordinary columns. */
  valueArrayChildTable?: string;
}

export interface FKShape {
  column: string;
  refTable: string;
  onDelete: "cascade" | "restrict";
}

export interface IndexShape {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  /** Partial-index predicate — the raw Postgres boolean expression that
   *  follows `WHERE` (`is_deleted = false`).  Set on a `unique (...)` index
   *  derived for a `softDeletable` aggregate so re-creating a row whose
   *  predecessor was soft-deleted is allowed (uniqueness-and-indexes.md §7).
   *  Absent on ordinary FK / performance indexes — they are unconditional.
   *  The SQL renderer (`sql-pg.ts`) appends `WHERE <predicate>`; the Ecto
   *  emitter passes it as the `where:` index option. */
  predicate?: string;
  /** Per-column Postgres operator classes (multi-tenancy Phase 2 P2.5).  Keyed
   *  by column name → opclass, e.g. `{ data_key: "text_pattern_ops" }` so a
   *  `LIKE 'prefix.%'` materialized-path prefix scan uses the index under ANY
   *  locale/collation (the default opclass only indexes prefix `LIKE` under the
   *  C collation).  The SQL renderer appends the opclass after the column
   *  (`(data_key text_pattern_ops)`); the Ecto emitter emits the fragment
   *  column form (`["data_key text_pattern_ops"]`).  Absent on ordinary indexes
   *  — they use the default opclass. */
  opclasses?: Record<string, string>;
}

export interface TableShape {
  name: string;
  /** Postgres schema the table lives in — the owning bounded context's
   *  schema (`snake(context.name)` by default, or the dataSource's
   *  explicit `schema:` override).  `undefined` means the unqualified
   *  `public` schema (single-context legacy systems, or callers that
   *  build a schema without a system to resolve bindings against).
   *  The SQL renderer emits `CREATE SCHEMA IF NOT EXISTS` + qualifies
   *  table / FK / index references; the EF + Drizzle table mappings
   *  resolve the same schema, so the runtime DDL matches what they query. */
  schema?: string;
  ownerModule: string;
  columns: ColumnShape[];
  primaryKey: string[];
  foreignKeys: FKShape[];
  indexes: IndexShape[];
  /** Set on the id-less child table that holds a value-object *array*
   *  field's elements (`charges: Money[]` → `order_charges`).  Relational
   *  backends (Drizzle / EF) create it; Phoenix **skips** it — it stores
   *  the array inline as a `{:array, :map}` column on the parent instead. */
  valueCollection?: boolean;
  /** Reshape-detection stamp (M-T2.4): the effective saving shape of the
   *  aggregate whose ROOT table this is (`relational` / `embedded` /
   *  `document`).  Stamped on the aggregate root only (not parts / joins /
   *  saga / event-log / outbox).  The diff compares a matched pair's
   *  `savingShape`; a flip (relational → document) is a *reshape* — a
   *  full-table data move the column-churn diff can't express — so it raises
   *  `loom.migration-shape-change` instead of the generic destructive listing.
   *  Optional ⇒ `schemaVersion` stays 1; an UNstamped baseline (pre-M-T2.4
   *  snapshot) simply isn't compared, so the flip falls to the generic
   *  destructive gate as before (backward-compatible grace). */
  savingShape?: SavingShape;
  /** Reshape-detection stamp (M-T2.4): the inheritance strategy + root base
   *  of an inheritance table — `sharedTable` on a TPH shared base table,
   *  `ownTable` on each TPC concrete's own table.  Keyed by the root base
   *  name so a TPH↔TPC flip (whose table NAMES change, so no matched pair
   *  exists) is detected by grouping this generation's created + dropped
   *  inheritance tables per base and comparing strategies.  Same optional /
   *  grace semantics as {@link savingShape}. */
  inheritance?: InheritanceStamp;
}

/** Persistence saving shape — mirrors the IR's `SavingShape`, redeclared here
 *  so `migrations-ir.ts` stays free of an `ir/types/loom-ir.ts` import (the
 *  MigrationsIR layer is consumed by the backends, which must not pull the full
 *  IR vocabulary). */
export type SavingShape = "relational" | "embedded" | "document";

export interface InheritanceStamp {
  strategy: "sharedTable" | "ownTable";
  /** Root-base aggregate name — the grouping key that pairs a TPH shared table
   *  with the TPC concrete tables of the SAME hierarchy across a flip. */
  base: string;
}

export interface SchemaSnapshot {
  schemaVersion: 1;
  /** Version of the last migration written against this snapshot.  The
   *  builder bumps it monotonically (next = `String(BigInt(lastVersion)
   *  + 1n)`) so subsequent migration files always sort after existing
   *  ones without consulting the filesystem.  Absent on a freshly-init
   *  snapshot — the builder starts at the canonical base timestamp. */
  lastVersion?: string;
  /** Ordered history of every migration emitted against this snapshot.
   *  The TS/Hono emitter rebuilds Drizzle's `meta/_journal.json` from
   *  this list so Drizzle's runtime migrator (and `drizzle-kit migrate`)
   *  can apply them.  Phoenix + .NET ignore the field — their own
   *  framework migration tables (`schema_migrations`, `__EFMigrationsHistory`)
   *  track runtime state.  Empty / absent on a fresh snapshot. */
  migrationHistory?: MigrationHistoryEntry[];
  /** Applied-data-migration ledger (M-T2.3).  Keys `"<block>#<index>"` for
   *  every raw `sql` migration-block step already emitted against this
   *  baseline.  Raw SQL has no structural condition to guard on (unlike
   *  renames/backfills, which are naturally inert once baked in), so the
   *  snapshot records which ones ran — a `sql` step is emitted exactly
   *  once.  Absent / empty when no raw steps have been emitted.  Optional
   *  ⇒ `schemaVersion` stays 1; old snapshots read fine. */
  appliedDataMigrations?: string[];
  tables: TableShape[];
}

export interface MigrationHistoryEntry {
  version: string;
  name: string;
}

// Every delta step carries the Postgres `schema` of the relation it targets
// (the owning bounded context's schema, from the same resolution `createTable`
// uses).  `undefined` means the unqualified `public` schema.  Without this,
// an ALTER/DROP on a schema-qualified system targets the wrong relation or
// fails (audit finding 17).  `createTable` still carries its schema on the
// nested `TableShape`, so it needs no separate field.
export type MigrationStep =
  | { op: "createTable"; table: TableShape }
  | { op: "dropTable"; name: string; schema?: string }
  // Whole-table rename (M-T2.1 aggregate/table rename) — `from`/`to` are the
  // bare (unqualified) old + new table names; `schema` is the relation's
  // Postgres schema (both ends share it — a rename never crosses schemas).
  // Postgres/Ecto keep every FK constraint pointing at the table valid across
  // the rename, so no separate FK-retarget step is emitted.  Non-destructive.
  | { op: "renameTable"; from: string; to: string; schema?: string }
  | { op: "addColumn"; table: string; schema?: string; column: ColumnShape; fk?: FKShape }
  | { op: "dropColumn"; table: string; schema?: string; name: string }
  | {
      op: "renameColumn";
      table: string;
      schema?: string;
      from: string;
      to: string;
      type: ColumnType;
    }
  | {
      op: "alterColumnNullable";
      table: string;
      schema?: string;
      name: string;
      type: ColumnType;
      nullable: boolean;
    }
  | {
      op: "alterColumnType";
      table: string;
      schema?: string;
      name: string;
      from: ColumnType;
      to: ColumnType;
    }
  | { op: "addIndex"; index: IndexShape; schema?: string }
  | { op: "dropIndex"; table: string; schema?: string; name: string }
  // Rename an index in place (M-T2.1 a) — `from`/`to` are the bare (unqualified)
  // old + new index names; `schema` is the owning table's Postgres schema (an
  // index lives in its table's schema).  Emitted by `diffSchema` when a table or
  // column rename changes only the DERIVED index name (the index is otherwise
  // identical after mapping columns/table through this generation's renames), so
  // the non-destructive rebuild collapses to a single `ALTER INDEX … RENAME TO`
  // instead of a drop+create.  Postgres has native support; Ecto has no `rename
  // index` DSL, so it wraps the same SQL in `execute/1` (forward-only, matching
  // D-MIG-NO-DOWN).
  | { op: "renameIndex"; from: string; to: string; schema?: string }
  // A pass-through comment line (`-- …` in SQL, `# …` in Ecto).  Emitted by the
  // destructive-change gate's NOT-NULL-add rewrite to mark the backfill the
  // operator must perform between adding a nullable column and setting it NOT
  // NULL.  Renders to a no-op comment on every backend.
  | { op: "sqlComment"; comment: string }
  // Data backfill (M-T2.3): `UPDATE <table> SET <column> = <valueSql>`
  // [`WHERE <column> IS NULL` when `onlyNull`].  `valueSql` is a pre-rendered
  // Postgres scalar expression (the `IndexShape.predicate` precedent — SQL
  // text in the platform-neutral IR), produced by `renderSqlScalarExpr` from
  // a validated `migration`-block backfill step.  `onlyNull: true` (the
  // NOT-NULL-sequence default) makes re-application against a half-migrated
  // table safe.  Renders as raw SQL on every backend (Ecto: `execute/1`).
  | {
      op: "backfillColumn";
      table: string;
      schema?: string;
      column: string;
      valueSql: string;
      onlyNull: boolean;
    }
  // Raw one-shot DML (M-T2.3): a `sql "…"` step from a `migration` block,
  // emitted verbatim.  NOT naturally inert — the builder records the step's
  // `<block>#<index>` key in the snapshot's `appliedDataMigrations` so it is
  // emitted exactly once.  Ordered after the generation's structural steps.
  | { op: "sqlExec"; sql: string };

export interface MigrationsIR {
  /** Owning module name — `.loom/snapshots/<module>.snapshot.json` is keyed
   *  here.  System orchestrator distributes one MigrationsIR to every
   *  needsDb deployable that includes the module (per-deployable
   *  compose databases ⇒ each owns its own migration files). */
  module: string;
  /** Optional storage binding name (`pg`, `analyticsDb`).  Empty string when
   *  the deployable used the bare `contexts: [Sales]` form. */
  storageName: string;
  /** Snapshot read from disk on the previous regen; `null` on first run. */
  baseline: SchemaSnapshot | null;
  /** Schema the current source describes — what gets written back to disk
   *  after the per-deployable loop completes. */
  next: SchemaSnapshot;
  /** Ordered ops from baseline → next.  Empty when the snapshot matches
   *  the current source — emitter MUST skip in that case so regenerating
   *  a clean repo is a no-op. */
  steps: MigrationStep[];
  /** Deterministic timestamp slug, `<YYYYMMDDHHMMSS>` — drives migration
   *  file ordering across regens.  See `migrations-builder.ts`. */
  version: string;
  /** Human-readable migration name (PascalCase) — `"Initial"` on first
   *  run, `"AddOrderStatus"` etc. on subsequent diffs. */
  name: string;
}
