import type {
  ColumnShape,
  ColumnType,
  IndexShape,
  MigrationStep,
  MigrationsIR,
  TableShape,
} from "../../ir/types/migrations-ir.js";
import { snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Phoenix Ecto migration emitter.
//
// Consumes the platform-neutral `MigrationsIR[]` from
// `src/system/migrations-builder.ts` and translates each `MigrationStep` into
// Ecto migration DSL.
//
// File layout:
//   - Initial migration (baseline === null): one .exs file per top-level
//     table + one per part-table, sequentially timestamped from BASE so
//     parent migrations precede their parts in Ecto's apply order.
//     Filename: `priv/repo/migrations/<ts>_create_<table>.exs`.
//   - Subsequent migrations: one .exs file containing every step, named
//     `<MigrationsIR.version>_<snake(MigrationsIR.name)>.exs`.
//
// Stays in Ecto DSL (not raw SQL) so `ecto.migrate` keeps working
// unchanged; the shared `src/generator/sql-pg.ts` helper is for
// TS/.NET Postgres backends only.
// ---------------------------------------------------------------------------

const BASE_TIMESTAMP = 20260101000000;

/** Render a MigrationsIR column `default` into an Ecto `, default: …` clause.
 *  The shared `MigrationsIR` stores SQL defaults verbatim (e.g. `now()`,
 *  `gen_random_uuid()`) — valid bare in raw Postgres DDL (`sql-pg.ts`) but NOT
 *  in Ecto migration DSL, where a SQL function call must be wrapped in
 *  `fragment("…")` (a bare `default: now()` is an undefined-function compile
 *  error).  A plain literal (number/boolean, e.g. `0`) stays bare. */
function ectoDefaultClause(def: string | undefined): string {
  if (def === undefined) return "";
  // A SQL function-call default (`now()`, `gen_random_uuid()`) → fragment.
  const isSqlExpr = /^[a-z_][a-z0-9_]*\s*\(.*\)$/i.test(def.trim());
  return isSqlExpr ? `, default: fragment(${JSON.stringify(def)})` : `, default: ${def}`;
}

/** Ecto option string for a table / index / reference that lives in a
 *  non-default Postgres schema — the owning bounded context's schema,
 *  carried on `TableShape.schema` (the Ecto schema maps `table "x"` in
 *  `schema "catalog"`, so the migration must create `catalog.x` or the
 *  schema queries a relation that doesn't exist).  Empty for the
 *  default (`public`) schema, preserving the unqualified output. */
function prefixOpt(schema: string | undefined): string {
  return schema ? `, prefix: ${JSON.stringify(schema)}` : "";
}

/** Trailing Ecto `create index(...)` options for one `IndexShape`.
 *  `, unique: true` for a unique index; `, where: "…"` for a partial index
 *  (a `unique` key on a softDeletable aggregate — re-create after soft-delete
 *  is allowed); an explicit `, name: "…"` for unique indexes so the
 *  changeset's `unique_constraint` and the cross-backend 23505 → 409 mapping
 *  reference the same deterministic constraint name.  FK / performance indexes
 *  keep Ecto's default name (never referenced), so output is unchanged. */
function ectoIndexOpts(i: IndexShape, prefix: string): string {
  const unique = i.unique ? ", unique: true" : "";
  const where = i.predicate ? `, where: ${JSON.stringify(i.predicate)}` : "";
  const name = i.unique ? `, name: ${JSON.stringify(i.name)}` : "";
  return `${unique}${where}${name}${prefix}`;
}

/** The bracketed column list for a `create index(...)` call.  A column with a
 *  per-column opclass (P2.5 materialized-path prefix index) uses Ecto's raw
 *  fragment string form (`"data_key text_pattern_ops"`) so the opclass reaches
 *  the DDL; plain columns stay `:atom`s. */
function ectoIndexColumns(i: IndexShape): string {
  return i.columns
    .map((n) => {
      const oc = i.opclasses?.[n];
      return oc ? JSON.stringify(`${n} ${oc}`) : `:${n}`;
    })
    .join(", ");
}

/** The `execute "CREATE SCHEMA …"` line (4-space indented, trailing
 *  newline) prepended to a `change/0` body when the table is schema-
 *  qualified, or "" for the default schema.  Idempotent (`IF NOT
 *  EXISTS`) since several per-aggregate migrations can share one schema.
 *  Forward-only — matching the no-op down of every other backend. */
function schemaCreateLine(schema: string | undefined): string {
  return schema ? `    execute "CREATE SCHEMA IF NOT EXISTS ${schema}"\n` : "";
}

/** Per-module version stride.  Every backend that serves >1 module writes
 *  all their initial migrations into ONE `priv/repo/migrations/` dir, and
 *  Ecto refuses to run a dir with a duplicated version prefix.  `emitInitial`
 *  allocates each module's versions from `BASE_TIMESTAMP` (parents `+i`, parts
 *  `+N*10+…`, joins `+N*100+k`), so without a per-module offset every module's
 *  first table collides at `BASE_TIMESTAMP`.  Offsetting module M by
 *  `M * STRIDE` keeps each module's block disjoint; the stride is far larger
 *  than any realistic within-module span (`N*100 + joins`). */
const MODULE_VERSION_STRIDE = 1_000_000;

/** The `timestamps()` line a state-table migration appends — column-aware
 *  so it matches the emitted schema (otherwise `ecto.migrate` fails with
 *  "column updated_at specified more than once").  An audit capability
 *  (`with audit` / `auditable`) declares explicit `created_at` /
 *  `updated_at` columns; the bundled `timestamps()` would add a SECOND
 *  `updated_at`.  The Ecto schema drops `timestamps()` entirely when an
 *  `updated_at` field is present (`vanilla/schema-emit.ts`), so the
 *  migration must too — the audit columns are the only timestamps.  With
 *  no `updated_at` column present the migration emits a plain
 *  `timestamps()`, so non-audit output is unchanged. */
function timestampsMacro(table: TableShape): string | null {
  const hasUpdatedAt = table.columns.some((c) => c.name === "updated_at");
  return hasUpdatedAt ? null : "timestamps()";
}

export function emitMigrations(
  _appName: string,
  migrations: MigrationsIR[],
  appModule: string,
  out: Map<string, string>,
): void {
  let initialModuleIndex = 0;
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    if (m.baseline === null) {
      emitInitial(m, appModule, out, initialModuleIndex * MODULE_VERSION_STRIDE);
      initialModuleIndex++;
    } else {
      emitDelta(m, appModule, out);
    }
  }
}

function emitInitial(
  m: MigrationsIR,
  appModule: string,
  out: Map<string, string>,
  /** Per-module offset added to every allocated version so migrations from
   *  different modules don't collide in the shared dir.  See
   *  `MODULE_VERSION_STRIDE`. */
  baseOffset = 0,
): void {
  const base = BASE_TIMESTAMP + baseOffset;
  // Three classes of table, separated so timestamps preserve the
  // create-order required by FK targets:
  //   - aggregate (no cascade FK) → BASE + i
  //   - part      (one cascade FK to a parent aggregate)
  //     → BASE + N*10 + parentIndex*10 + partIndex+1
  //   - join      (two cascade FKs — Id<T>[] many-to-many)
  //     → BASE + N*100 + joinIdx
  // Includes an intentional gap between parent and part blocks so
  // inserts/updates to either tier don't shift the other's numbering.
  const createSteps = m.steps.filter(
    (s): s is Extract<MigrationStep, { op: "createTable" }> => s.op === "createTable",
  );
  // Value-object array child tables (`charges: Money[]`) are now emitted as
  // real id-less relational child tables on Phoenix too,
  // not collapsed into an inline `{:array, :map}` column on the parent.  They
  // are FK-cascaded children of their owner aggregate — the same tier as a
  // containment part table — so they share the part block's create-ordering
  // (parent before child).  See `renderInitialValueCollectionFile`.
  const allTables = createSteps.map((s) => s.table);
  const joinTables = allTables.filter(isJoinTable);
  const partTables = allTables.filter(
    (t) => !joinTables.includes(t) && (isPartTable(t) || t.valueCollection),
  );
  const parentTables = allTables
    .filter((t) => !joinTables.includes(t) && !partTables.includes(t))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Parents — base + i.
  for (let i = 0; i < parentTables.length; i++) {
    writeInitialFile(parentTables[i]!, base + i, appModule, out);
  }
  // Parts (incl. value-collection children) — grouped by parent.
  const parentCount = parentTables.length;
  for (let i = 0; i < parentTables.length; i++) {
    const parent = parentTables[i]!;
    const partsOfThis = partTables
      .filter((t) =>
        t.foreignKeys.some((fk) => fk.refTable === parent.name && fk.onDelete === "cascade"),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (let j = 0; j < partsOfThis.length; j++) {
      const ts = base + parentCount * 10 + i * 10 + (j + 1);
      writeInitialFile(partsOfThis[j]!, ts, appModule, out);
    }
  }
  // Join tables — placed above the part block so the references on
  // both endpoints resolve.  Sorted by name for stable allocation.
  const sortedJoins = [...joinTables].sort((a, b) => a.name.localeCompare(b.name));
  for (let k = 0; k < sortedJoins.length; k++) {
    const ts = base + parentCount * 100 + k;
    writeInitialFile(sortedJoins[k]!, ts, appModule, out);
  }
}

function writeInitialFile(
  table: TableShape,
  ts: number,
  appModule: string,
  out: Map<string, string>,
): void {
  const path = `priv/repo/migrations/${ts}_create_${table.name}.exs`;
  const migrationName = `Create${tableToPascal(table.name)}`;
  const body = table.valueCollection
    ? renderInitialValueCollectionFile(table, migrationName, appModule)
    : isJoinTable(table)
      ? renderInitialJoinFile(table, migrationName, appModule)
      : isEventLogTable(table)
        ? renderInitialEventLogFile(table, migrationName, appModule)
        : isStateTable(table)
          ? renderInitialStateFile(table, migrationName, appModule)
          : renderInitialFile(table, migrationName, appModule);
  out.set(path, body);
}

/** The single per-context append-only event log (`<ctx>_events`,
 *  event-log-architecture.md).  It has no `id` (so it would otherwise fall to
 *  `renderInitialStateFile`), but unlike a saga-state table it carries a
 *  `bigserial` `seq` cursor, a composite `(stream_type, stream_id, version)`
 *  PK, a unique index on `seq`, and NO `timestamps()` (its time column is
 *  `occurred_at`).  Detected by the `seq` bigserial column, unique to this
 *  table. */
function isEventLogTable(t: TableShape): boolean {
  return t.columns.some((c) => c.name === "seq" && c.type.kind === "bigserial");
}

/** Render the per-context event-log migration: composite PK columns marked
 *  `primary_key: true`, the remaining columns (incl. the `bigserial` `seq`)
 *  as plain adds, then the unique `seq` index.  No `timestamps()` — the log's
 *  time column is the explicit `occurred_at`. */
function renderInitialEventLogFile(
  table: TableShape,
  migrationName: string,
  appModule: string,
): string {
  const pk = new Set(table.primaryKey);
  const prefix = prefixOpt(table.schema);
  const colLines = table.columns.map((c) => {
    if (pk.has(c.name)) {
      return `      add :${c.name}, ${ectoPrimaryKeyType(c.type)}, primary_key: true, null: false`;
    }
    return "      " + renderEctoColumn(c, table);
  });
  const indexLines = table.indexes.map(
    (i) => `    create index(:${i.table}, [${ectoIndexColumns(i)}]${ectoIndexOpts(i, prefix)})`,
  );
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
${schemaCreateLine(table.schema)}    create table(:${table.name}, primary_key: false${prefix}) do
${colLines.join("\n")}
    end
${indexLines.join("\n")}${indexLines.length > 0 ? "\n" : ""}  end
end
`;
}

/** A persisted workflow-correlation (saga) state table: keyed by the
 *  workflow's correlation field rather than a synthetic `id`, with no
 *  foreign keys (the routing row is standalone).  `renderInitialFile`'s
 *  hard-coded `id` PK doesn't fit, so these render with the correlation
 *  column(s) marked `primary_key: true`. */
function isStateTable(t: TableShape): boolean {
  return !t.columns.some((c) => c.name === "id") && !isJoinTable(t);
}

function renderInitialStateFile(
  table: TableShape,
  migrationName: string,
  appModule: string,
): string {
  const pk = new Set(table.primaryKey);
  const prefix = prefixOpt(table.schema);
  const colLines = table.columns
    .filter((c) => !c.valueArrayChildTable)
    .map((c) => {
      if (pk.has(c.name)) {
        return `      add :${c.name}, ${ectoPrimaryKeyType(c.type)}, primary_key: true, null: false`;
      }
      return "      " + renderEctoColumn(c, table);
    });
  const ts = timestampsMacro(table);
  if (ts) colLines.push(`      ${ts}`);
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
${schemaCreateLine(table.schema)}    create table(:${table.name}, primary_key: false${prefix}) do
${colLines.join("\n")}
    end
  end
end
`;
}

function renderInitialFile(table: TableShape, migrationName: string, appModule: string): string {
  const idCol = table.columns.find((c) => c.name === "id");
  const pkType = idCol ? ectoPrimaryKeyType(idCol.type) : ":uuid";
  // The parent's value-collection stand-in column (`{:array, :map}`,
  // tagged `valueArrayChildTable`) is dropped — the data lives in the
  // emitted child table now, not inline on the parent.  Matches the
  // relational backends' `sql-pg.ts` skip.
  const otherCols = collapseVoGroups(
    table.columns.filter((c) => c.name !== "id" && !c.valueArrayChildTable),
  );
  const colLines = [
    `      add :id, ${pkType}, primary_key: true, null: false`,
    ...otherCols.map((c) => "      " + renderEctoColumn(c, table)),
  ];
  const ts = timestampsMacro(table);
  if (ts) colLines.push(`      ${ts}`);
  const prefix = prefixOpt(table.schema);
  const indexLines = table.indexes.map(
    (i) => `    create index(:${i.table}, [${ectoIndexColumns(i)}]${ectoIndexOpts(i, prefix)})`,
  );

  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
${schemaCreateLine(table.schema)}    create table(:${table.name}, primary_key: false${prefix}) do
${colLines.join("\n")}
    end
${indexLines.join("\n")}${indexLines.length > 0 ? "\n" : ""}  end
end
`;
}

/** Render a value-object collection child-table migration (`charges:
 *  Money[]` → `order_charges`).  Unlike the relational backends — whose
 *  child table is keyed by the composite `(parent_fk, ordinal)` in the
 *  shared MigrationsIR — the Phoenix child carries a SYNTHETIC `id` uuid
 *  primary key so it can be modelled as an Ecto `has_many` whose rows are
 *  managed via `cast_assoc` (which wants row identity for the
 *  replace-on-update diff).  The synthetic id never reaches the wire — the
 *  child's Jason encoder projects only the value object's own fields, so
 *  the array stays `[{amount,currency},…]`, byte-identical with every other
 *  backend.  Parent FK cascades; `ordinal` preserves declared order. */
function renderInitialValueCollectionFile(
  table: TableShape,
  migrationName: string,
  appModule: string,
): string {
  const prefix = prefixOpt(table.schema);
  // Synthetic uuid PK (NOT in the MigrationsIR composite PK — Phoenix adds
  // it so the child has Ecto-managed row identity).
  const lines: string[] = ["      add :id, :uuid, primary_key: true, null: false"];
  for (const c of table.columns) {
    const defaultClause = ectoDefaultClause(c.default);
    const fk = table.foreignKeys.find((f) => f.column === c.name);
    if (fk) {
      const ref = `references(:${fk.refTable}${prefix}, type: ${ectoPrimaryKeyType(c.type)}, on_delete: :${fk.onDelete === "cascade" ? "delete_all" : "restrict"})`;
      lines.push(`      add :${c.name}, ${ref}, null: ${c.nullable}${defaultClause}`);
    } else {
      lines.push(
        `      add :${c.name}, ${ectoColumnType(c.type)}, null: ${c.nullable}${defaultClause}`,
      );
    }
  }
  const indexLines = table.indexes.map(
    (i) => `    create index(:${i.table}, [${ectoIndexColumns(i)}]${ectoIndexOpts(i, prefix)})`,
  );
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
${schemaCreateLine(table.schema)}    create table(:${table.name}, primary_key: false${prefix}) do
${lines.join("\n")}
    end
${indexLines.join("\n")}${indexLines.length > 0 ? "\n" : ""}  end
end
`;
}

/** Render a many-to-many join-table migration.  Composite PK on the
 *  two FK columns, both `primary_key: true` (this is what enforces the
 *  set-semantics contract for `Id<T>[]` — the pair IS the whole row, no
 *  payload column); no `timestamps()` (join rows are pure relationship
 *  records).  Deterministic read-back order is a read-time projection
 *  (the `many_to_many` preloads `order_by: [asc: :id]` on the target),
 *  not a stored `ordinal`. */
function renderInitialJoinFile(
  table: TableShape,
  migrationName: string,
  appModule: string,
): string {
  const pkSet = new Set(table.primaryKey);
  const prefix = prefixOpt(table.schema);
  const lines: string[] = [];
  for (const c of table.columns) {
    const defaultClause = ectoDefaultClause(c.default);
    const fk = table.foreignKeys.find((f) => f.column === c.name);
    if (fk) {
      const ref = `references(:${fk.refTable}${prefix}, type: ${ectoPrimaryKeyType(c.type)}, on_delete: :${fk.onDelete === "cascade" ? "delete_all" : "restrict"})`;
      const pk = pkSet.has(c.name) ? ", primary_key: true" : "";
      lines.push(`      add :${c.name}, ${ref}, null: ${c.nullable}${pk}${defaultClause}`);
    } else {
      const pk = pkSet.has(c.name) ? ", primary_key: true" : "";
      lines.push(
        `      add :${c.name}, ${ectoColumnType(c.type)}, null: ${c.nullable}${pk}${defaultClause}`,
      );
    }
  }
  const indexLines = table.indexes.map(
    (i) => `    create index(:${i.table}, [${ectoIndexColumns(i)}]${ectoIndexOpts(i, prefix)})`,
  );
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
${schemaCreateLine(table.schema)}    create table(:${table.name}, primary_key: false${prefix}) do
${lines.join("\n")}
    end
${indexLines.join("\n")}${indexLines.length > 0 ? "\n" : ""}  end
end
`;
}

function emitDelta(m: MigrationsIR, appModule: string, out: Map<string, string>): void {
  const path = `priv/repo/migrations/${m.version}_${snake(m.name)}.exs`;
  out.set(path, renderDeltaFile(m, appModule));
}

function renderDeltaFile(m: MigrationsIR, appModule: string): string {
  const migrationName = upperFirst(m.name);
  const stepLines = m.steps.flatMap((s) => renderEctoStep(s));
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
${stepLines.map((l) => "    " + l).join("\n")}
  end
end
`;
}

function renderEctoStep(step: MigrationStep): string[] {
  switch (step.op) {
    case "createTable":
      return renderCreateTableInline(step.table);
    case "dropTable": {
      const prefix = prefixOpt(step.schema);
      return [`drop table(:${step.name}${prefix})`];
    }
    case "renameTable": {
      const prefix = prefixOpt(step.schema);
      return [`rename table(:${step.from}${prefix}), to: table(:${step.to}${prefix})`];
    }
    case "addColumn": {
      const c = step.column;
      const prefix = prefixOpt(step.schema);
      const decl = step.fk
        ? `references(:${step.fk.refTable}${prefix}, type: ${ectoPrimaryKeyType(c.type)}, on_delete: :${step.fk.onDelete === "cascade" ? "delete_all" : "restrict"})`
        : ectoColumnType(c.type);
      return [
        `alter table(:${step.table}${prefix}) do`,
        `  add :${c.name}, ${decl}, null: ${c.nullable}`,
        `end`,
      ];
    }
    case "dropColumn":
      return [
        `alter table(:${step.table}${prefixOpt(step.schema)}) do`,
        `  remove :${step.name}`,
        `end`,
      ];
    case "renameColumn":
      return [
        `rename table(:${step.table}${prefixOpt(step.schema)}), :${step.from}, to: :${step.to}`,
      ];
    case "alterColumnNullable":
      return [
        `alter table(:${step.table}${prefixOpt(step.schema)}) do`,
        `  modify :${step.name}, ${ectoColumnType(step.type)}, null: ${step.nullable}`,
        `end`,
      ];
    case "alterColumnType":
      return [
        `alter table(:${step.table}${prefixOpt(step.schema)}) do`,
        `  modify :${step.name}, ${ectoColumnType(step.to)}, from: ${ectoColumnType(step.from)}`,
        `end`,
      ];
    case "addIndex": {
      const cols = ectoIndexColumns(step.index);
      return [
        `create index(:${step.index.table}, [${cols}]${ectoIndexOpts(step.index, prefixOpt(step.schema))})`,
      ];
    }
    case "dropIndex":
      return [`drop index(:${step.table}, name: "${step.name}"${prefixOpt(step.schema)})`];
    case "sqlComment":
      return [`# ${step.comment}`];
  }
}

function renderCreateTableInline(table: TableShape): string[] {
  const idCol = table.columns.find((c) => c.name === "id");
  const others = collapseVoGroups(
    table.columns.filter((c) => c.name !== "id" && !c.valueArrayChildTable),
  );
  const prefix = prefixOpt(table.schema);
  const lines: string[] = [];
  if (table.schema) lines.push(`execute "CREATE SCHEMA IF NOT EXISTS ${table.schema}"`);
  lines.push(`create table(:${table.name}, primary_key: false${prefix}) do`);
  if (idCol) {
    lines.push(`  add :id, ${ectoPrimaryKeyType(idCol.type)}, primary_key: true, null: false`);
  }
  for (const c of others) lines.push("  " + renderEctoColumn(c, table));
  const ts = timestampsMacro(table);
  if (ts) lines.push(`  ${ts}`);
  lines.push("end");
  for (const idx of table.indexes) {
    const cols = ectoIndexColumns(idx);
    lines.push(`create index(:${table.name}, [${cols}]${ectoIndexOpts(idx, prefix)})`);
  }
  return lines;
}

/** Regroup the flattened leaf columns of a value-object field
 *  (`price_amount`, `price_currency`, both `voGroup: "price"`) back into a
 *  single `:map` column named for the group.  The canonical migration
 *  flattens value objects into columns (the relational/DDD shape the
 *  Drizzle / EF ORMs query); the Phoenix Ecto schema stores an embedded
 *  value object as one `:map`, so Phoenix collapses each group here.  A group's `:map` is
 *  nullable iff every leaf is (i.e. the value-object field itself was
 *  optional).  Columns without a `voGroup` pass through unchanged. */
function collapseVoGroups(columns: readonly ColumnShape[]): ColumnShape[] {
  const out: ColumnShape[] = [];
  const handled = new Set<string>();
  for (const c of columns) {
    if (!c.voGroup) {
      out.push(c);
      continue;
    }
    if (handled.has(c.voGroup)) continue;
    handled.add(c.voGroup);
    const group = columns.filter((x) => x.voGroup === c.voGroup);
    out.push({ name: c.voGroup, type: { kind: "json" }, nullable: group.every((x) => x.nullable) });
  }
  return out;
}

function renderEctoColumn(c: ColumnShape, table: TableShape): string {
  const defaultClause = ectoDefaultClause(c.default);
  const fk = table.foreignKeys.find((f) => f.column === c.name);
  if (fk) {
    const ref = `references(:${fk.refTable}${prefixOpt(table.schema)}, type: ${ectoPrimaryKeyType(c.type)}, on_delete: :${fk.onDelete === "cascade" ? "delete_all" : "restrict"})`;
    return `add :${c.name}, ${ref}, null: ${c.nullable}${defaultClause}`;
  }
  return `add :${c.name}, ${ectoColumnType(c.type)}, null: ${c.nullable}${defaultClause}`;
}

// ---------------------------------------------------------------------------
// Type translation.  Regular columns: text → :text, json → :map, etc.
// Primary keys / FK references: text → :string (Ecto's string-PK
// convention — varchar(255)), uuid → :uuid.
// ---------------------------------------------------------------------------

function ectoColumnType(t: ColumnType): string {
  switch (t.kind) {
    case "uuid":
      return ":uuid";
    case "int":
      return ":integer";
    case "bigint":
      return ":bigint";
    case "bigserial":
      // Ecto's `:bigserial` — bigint + owned sequence (event-log-architecture.md).
      return ":bigserial";
    case "text":
      return ":text";
    case "bool":
      return ":boolean";
    case "decimal":
      return ":decimal";
    case "datetime":
      return ":utc_datetime";
    case "json":
      return ":map";
    case "array":
      return `{:array, ${ectoColumnType(t.inner)}}`;
  }
}

function ectoPrimaryKeyType(t: ColumnType): string {
  if (t.kind === "text") return ":string";
  return ectoColumnType(t);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPartTable(t: TableShape): boolean {
  // A part has exactly one cascade FK back to its parent aggregate.
  // Join tables (Id<T>[] many-to-many) also have cascades but to two
  // different parents — distinguished by `isJoinTable`.
  return t.foreignKeys.filter((fk) => fk.onDelete === "cascade").length === 1;
}

function isJoinTable(t: TableShape): boolean {
  // Many-to-many join: two cascade FKs to different parent tables,
  // and the table has no `id` column (composite PK).
  const cascades = t.foreignKeys.filter((fk) => fk.onDelete === "cascade");
  if (cascades.length !== 2) return false;
  return !t.columns.some((c) => c.name === "id");
}

function tableToPascal(name: string): string {
  return name.split("_").map(upperFirst).join("");
}
