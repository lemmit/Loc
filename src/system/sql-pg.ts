import type {
  ColumnShape,
  ColumnType,
  FKShape,
  IndexShape,
  MigrationStep,
  TableShape,
} from "../ir/types/migrations-ir.js";

// ---------------------------------------------------------------------------
// Postgres SQL renderer shared by the TS/Hono and .NET/EF migration emitters.
//
// Both backends end up calling Postgres; producing identical SQL via this
// helper means a schema migration written by either backend is bit-for-bit
// equivalent.  Phoenix stays in Ecto DSL — its output is Elixir, not SQL,
// so it does not share this helper.
// ---------------------------------------------------------------------------

export function renderPgStep(step: MigrationStep): string {
  switch (step.op) {
    case "createTable":
      return renderCreateTable(step.table);
    case "dropTable":
      return `DROP TABLE ${ident(step.name)};`;
    case "addColumn":
      return renderAddColumn(step.table, step.column, step.fk);
    case "dropColumn":
      return `ALTER TABLE ${ident(step.table)} DROP COLUMN ${ident(step.name)};`;
    case "alterColumnNullable":
      return `ALTER TABLE ${ident(step.table)} ALTER COLUMN ${ident(step.name)} ${
        step.nullable ? "DROP NOT NULL" : "SET NOT NULL"
      };`;
    case "alterColumnType":
      return (
        `ALTER TABLE ${ident(step.table)} ALTER COLUMN ${ident(step.name)} ` +
        `TYPE ${renderPgType(step.to)} USING ${ident(step.name)}::${renderPgType(step.to)};`
      );
    case "addIndex":
      return renderAddIndex(step.index);
    case "dropIndex":
      return `DROP INDEX ${ident(step.name)};`;
  }
}

function renderCreateTable(table: TableShape): string {
  const lines: string[] = [];
  for (const c of table.columns) lines.push("  " + renderColumnDef(c));
  if (table.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(ident).join(", ")})`);
  }
  for (const fk of table.foreignKeys) {
    lines.push("  " + renderFkConstraint(fk));
  }
  const body = lines.join(",\n");
  let sql = `CREATE TABLE ${ident(table.name)} (\n${body}\n);`;
  for (const idx of table.indexes) sql += "\n" + renderAddIndex(idx);
  return sql;
}

function renderAddColumn(table: string, column: ColumnShape, fk: FKShape | undefined): string {
  let sql = `ALTER TABLE ${ident(table)} ADD COLUMN ${renderColumnDef(column)};`;
  if (fk) {
    sql +=
      `\nALTER TABLE ${ident(table)} ADD CONSTRAINT ${ident(table + "_" + column.name + "_fk")} ` +
      `FOREIGN KEY (${ident(column.name)}) REFERENCES ${ident(fk.refTable)} ` +
      `ON DELETE ${fk.onDelete.toUpperCase()};`;
  }
  return sql;
}

function renderColumnDef(c: ColumnShape): string {
  const parts = [ident(c.name), renderPgType(c.type)];
  parts.push(c.nullable ? "NULL" : "NOT NULL");
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  return parts.join(" ");
}

function renderFkConstraint(fk: FKShape): string {
  return (
    `FOREIGN KEY (${ident(fk.column)}) REFERENCES ${ident(fk.refTable)} ` +
    `ON DELETE ${fk.onDelete.toUpperCase()}`
  );
}

function renderAddIndex(idx: IndexShape): string {
  const unique = idx.unique ? "UNIQUE " : "";
  return (
    `CREATE ${unique}INDEX ${ident(idx.name)} ON ${ident(idx.table)} ` +
    `(${idx.columns.map(ident).join(", ")});`
  );
}

export function renderPgType(t: ColumnType): string {
  switch (t.kind) {
    case "uuid":
      return "UUID";
    case "int":
      return "INTEGER";
    case "bigint":
      return "BIGINT";
    case "text":
      return "TEXT";
    case "bool":
      return "BOOLEAN";
    case "decimal":
      return "DECIMAL";
    case "datetime":
      return "TIMESTAMP WITH TIME ZONE";
    case "json":
      return "JSONB";
    case "array":
      return `${renderPgType(t.inner)}[]`;
  }
}

/** Lowercase identifier passthrough.  The migration builder already
 *  snake-cases everything, so the produced names are valid bare
 *  identifiers in Postgres.  Reserved-name edge cases (`user`, `order`,
 *  …) would need double-quoting; no current fixture exercises them. */
function ident(name: string): string {
  return name;
}
