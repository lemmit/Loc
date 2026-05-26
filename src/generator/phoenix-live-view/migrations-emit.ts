import type {
  ColumnShape,
  ColumnType,
  MigrationStep,
  MigrationsIR,
  TableShape,
} from "../../ir/migrations-ir.js";
import { snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Phoenix Ecto migration emitter.
//
// Consumes the platform-neutral `MigrationsIR[]` from
// `src/ir/migrations-builder.ts` and translates each `MigrationStep` into
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
// Stays in Ecto DSL (not raw SQL) so AshPostgres + ecto.migrate keep
// working unchanged; the shared `src/system/sql-pg.ts` helper is for
// TS/.NET Postgres backends only.
// ---------------------------------------------------------------------------

const BASE_TIMESTAMP = 20260101000000;

export function emitMigrations(
  _appName: string,
  migrations: MigrationsIR[],
  appModule: string,
  out: Map<string, string>,
): void {
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    if (m.baseline === null) {
      emitInitial(m, appModule, out);
    } else {
      emitDelta(m, appModule, out);
    }
  }
}

function emitInitial(m: MigrationsIR, appModule: string, out: Map<string, string>): void {
  // Three classes of table, separated so timestamps preserve the
  // create-order required by FK targets:
  //   - aggregate (no cascade FK) → BASE + i
  //   - part      (one cascade FK to a parent aggregate)
  //     → BASE + N*10 + parentIndex*10 + partIndex+1
  //   - join      (two cascade FKs — Id<T>[] many-to-many)
  //     → BASE + N*100 + joinIdx
  // Matches the pre-refactor Phoenix scheme byte-for-byte, including
  // the gap between parent and part blocks.
  const createSteps = m.steps.filter(
    (s): s is Extract<MigrationStep, { op: "createTable" }> => s.op === "createTable",
  );
  const allTables = createSteps.map((s) => s.table);
  const joinTables = allTables.filter(isJoinTable);
  const partTables = allTables.filter((t) => !joinTables.includes(t) && isPartTable(t));
  const parentTables = allTables
    .filter((t) => !joinTables.includes(t) && !partTables.includes(t))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Parents — BASE + i.
  for (let i = 0; i < parentTables.length; i++) {
    writeInitialFile(parentTables[i]!, BASE_TIMESTAMP + i, appModule, out);
  }
  // Parts — grouped by parent.
  const parentCount = parentTables.length;
  for (let i = 0; i < parentTables.length; i++) {
    const parent = parentTables[i]!;
    const partsOfThis = partTables
      .filter((t) =>
        t.foreignKeys.some((fk) => fk.refTable === parent.name && fk.onDelete === "cascade"),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (let j = 0; j < partsOfThis.length; j++) {
      const ts = BASE_TIMESTAMP + parentCount * 10 + i * 10 + (j + 1);
      writeInitialFile(partsOfThis[j]!, ts, appModule, out);
    }
  }
  // Join tables — placed above the part block so the references on
  // both endpoints resolve.  Sorted by name for stable allocation.
  const sortedJoins = [...joinTables].sort((a, b) => a.name.localeCompare(b.name));
  for (let k = 0; k < sortedJoins.length; k++) {
    const ts = BASE_TIMESTAMP + parentCount * 100 + k;
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
  const body = isJoinTable(table)
    ? renderInitialJoinFile(table, migrationName, appModule)
    : renderInitialFile(table, migrationName, appModule);
  out.set(path, body);
}

function renderInitialFile(table: TableShape, migrationName: string, appModule: string): string {
  const idCol = table.columns.find((c) => c.name === "id");
  const pkType = idCol ? ectoPrimaryKeyType(idCol.type) : ":uuid";
  const otherCols = table.columns.filter((c) => c.name !== "id");
  const colLines = otherCols.map((c) => "      " + renderEctoColumn(c, table));
  const indexLines = table.indexes.map((i) => {
    const cols = i.columns.map((n) => `:${n}`).join(", ");
    const unique = i.unique ? ", unique: true" : "";
    return `    create index(:${i.table}, [${cols}]${unique})`;
  });

  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
    create table(:${table.name}, primary_key: false) do
      add :id, ${pkType}, primary_key: true, null: false
${colLines.join("\n")}
      timestamps()
    end
${indexLines.join("\n")}${indexLines.length > 0 ? "\n" : ""}  end
end
`;
}

/** Render a many-to-many join-table migration.  Composite PK on the
 *  two FK columns, both `primary_key: true` (this is what enforces the
 *  set-semantics contract for `Id<T>[]`); an `ordinal :integer` column
 *  is included for cross-backend schema parity even though the wire
 *  contract is unordered; no `timestamps()` (join rows are pure
 *  relationship records). */
function renderInitialJoinFile(
  table: TableShape,
  migrationName: string,
  appModule: string,
): string {
  const pkSet = new Set(table.primaryKey);
  const lines: string[] = [];
  for (const c of table.columns) {
    const defaultClause = c.default !== undefined ? `, default: ${c.default}` : "";
    const fk = table.foreignKeys.find((f) => f.column === c.name);
    if (fk) {
      const ref = `references(:${fk.refTable}, type: ${ectoPrimaryKeyType(c.type)}, on_delete: :${fk.onDelete === "cascade" ? "delete_all" : "restrict"})`;
      const pk = pkSet.has(c.name) ? ", primary_key: true" : "";
      lines.push(`      add :${c.name}, ${ref}, null: ${c.nullable}${pk}${defaultClause}`);
    } else {
      const pk = pkSet.has(c.name) ? ", primary_key: true" : "";
      lines.push(
        `      add :${c.name}, ${ectoColumnType(c.type)}, null: ${c.nullable}${pk}${defaultClause}`,
      );
    }
  }
  const indexLines = table.indexes.map((i) => {
    const cols = i.columns.map((n) => `:${n}`).join(", ");
    const unique = i.unique ? ", unique: true" : "";
    return `    create index(:${i.table}, [${cols}]${unique})`;
  });
  return `defmodule ${appModule}.Repo.Migrations.${migrationName} do
  use Ecto.Migration

  def change do
    create table(:${table.name}, primary_key: false) do
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
  const stepLines = m.steps.flatMap(renderEctoStep);
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
    case "dropTable":
      return [`drop table(:${step.name})`];
    case "addColumn": {
      const c = step.column;
      const decl = step.fk
        ? `references(:${step.fk.refTable}, type: ${ectoPrimaryKeyType(c.type)}, on_delete: :${step.fk.onDelete === "cascade" ? "delete_all" : "restrict"})`
        : ectoColumnType(c.type);
      return [
        `alter table(:${step.table}) do`,
        `  add :${c.name}, ${decl}, null: ${c.nullable}`,
        `end`,
      ];
    }
    case "dropColumn":
      return [`alter table(:${step.table}) do`, `  remove :${step.name}`, `end`];
    case "alterColumnNullable":
      return [
        `alter table(:${step.table}) do`,
        `  modify :${step.name}, ${ectoColumnType(step.type)}, null: ${step.nullable}`,
        `end`,
      ];
    case "alterColumnType":
      return [
        `alter table(:${step.table}) do`,
        `  modify :${step.name}, ${ectoColumnType(step.to)}, from: ${ectoColumnType(step.from)}`,
        `end`,
      ];
    case "addIndex": {
      const cols = step.index.columns.map((n) => `:${n}`).join(", ");
      const unique = step.index.unique ? ", unique: true" : "";
      return [`create index(:${step.index.table}, [${cols}]${unique})`];
    }
    case "dropIndex":
      return [`drop index(:${step.table}, name: "${step.name}")`];
  }
}

function renderCreateTableInline(table: TableShape): string[] {
  const idCol = table.columns.find((c) => c.name === "id");
  const others = table.columns.filter((c) => c.name !== "id");
  const lines: string[] = [`create table(:${table.name}, primary_key: false) do`];
  if (idCol) {
    lines.push(`  add :id, ${ectoPrimaryKeyType(idCol.type)}, primary_key: true, null: false`);
  }
  for (const c of others) lines.push("  " + renderEctoColumn(c, table));
  lines.push("  timestamps()");
  lines.push("end");
  for (const idx of table.indexes) {
    const cols = idx.columns.map((n) => `:${n}`).join(", ");
    const unique = idx.unique ? ", unique: true" : "";
    lines.push(`create index(:${table.name}, [${cols}]${unique})`);
  }
  return lines;
}

function renderEctoColumn(c: ColumnShape, table: TableShape): string {
  const defaultClause = c.default !== undefined ? `, default: ${c.default}` : "";
  const fk = table.foreignKeys.find((f) => f.column === c.name);
  if (fk) {
    const ref = `references(:${fk.refTable}, type: ${ectoPrimaryKeyType(c.type)}, on_delete: :${fk.onDelete === "cascade" ? "delete_all" : "restrict"})`;
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
