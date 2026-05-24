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
}

export interface TableShape {
  name: string;
  ownerModule: string;
  columns: ColumnShape[];
  primaryKey: string[];
  foreignKeys: FKShape[];
  indexes: IndexShape[];
}

export interface SchemaSnapshot {
  schemaVersion: 1;
  /** Version of the last migration written against this snapshot.  The
   *  builder bumps it monotonically (next = `String(BigInt(lastVersion)
   *  + 1n)`) so subsequent migration files always sort after existing
   *  ones without consulting the filesystem.  Absent on a freshly-init
   *  snapshot — the builder starts at the canonical base timestamp. */
  lastVersion?: string;
  tables: TableShape[];
}

export type MigrationStep =
  | { op: "createTable"; table: TableShape }
  | { op: "dropTable"; name: string }
  | { op: "addColumn"; table: string; column: ColumnShape; fk?: FKShape }
  | { op: "dropColumn"; table: string; name: string }
  | { op: "alterColumnNullable"; table: string; name: string; nullable: boolean }
  | { op: "alterColumnType"; table: string; name: string; from: ColumnType; to: ColumnType }
  | { op: "addIndex"; index: IndexShape }
  | { op: "dropIndex"; table: string; name: string };

export interface MigrationsIR {
  /** Owning module name — `.loom/snapshots/<module>.snapshot.json` is keyed
   *  here.  System orchestrator distributes one MigrationsIR to every
   *  needsDb deployable that includes the module (per-deployable
   *  compose databases ⇒ each owns its own migration files). */
  module: string;
  /** Optional storage binding name (`pg`, `analyticsDb`).  Empty string when
   *  the deployable used the bare `modules: Sales` form. */
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
