import type { ExprIR } from "../ir/types/loom-ir.js";
import type {
  ColumnShape,
  ColumnType,
  FKShape,
  IndexShape,
  MigrationStep,
  TableShape,
} from "../ir/types/migrations-ir.js";
import { plural, snake } from "../util/naming.js";

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
      return `DROP TABLE ${qualified(step.schema, step.name)};`;
    case "addColumn":
      return renderAddColumn(step.table, step.schema, step.column, step.fk);
    case "dropColumn":
      return `ALTER TABLE ${qualified(step.schema, step.table)} DROP COLUMN ${ident(step.name)};`;
    case "renameColumn":
      return (
        `ALTER TABLE ${qualified(step.schema, step.table)} ` +
        `RENAME COLUMN ${ident(step.from)} TO ${ident(step.to)};`
      );
    case "alterColumnNullable":
      return `ALTER TABLE ${qualified(step.schema, step.table)} ALTER COLUMN ${ident(step.name)} ${
        step.nullable ? "DROP NOT NULL" : "SET NOT NULL"
      };`;
    case "alterColumnType":
      return (
        `ALTER TABLE ${qualified(step.schema, step.table)} ALTER COLUMN ${ident(step.name)} ` +
        `TYPE ${renderPgType(step.to)} USING ${ident(step.name)}::${renderPgType(step.to)};`
      );
    case "addIndex":
      // The index carries no schema of its own; the step's `schema` is the
      // owning table's schema (indexes live in the table's schema).
      return renderAddIndex(step.index, step.schema);
    case "dropIndex":
      return `DROP INDEX ${qualified(step.schema, step.name)};`;
    case "sqlComment":
      return `-- ${step.comment}`;
  }
}

function renderCreateTable(table: TableShape): string {
  const lines: string[] = [];
  // A value-object array's parent stand-in column is skipped on relational
  // backends — its elements live in the id-less child table, not a column.
  for (const c of table.columns) {
    if (c.valueArrayChildTable) continue;
    lines.push("  " + renderColumnDef(c));
  }
  if (table.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(ident).join(", ")})`);
  }
  // FK targets live in the same context as the table, hence the same
  // schema — qualify them with the table's schema so the reference
  // resolves under `search_path = public` (which is all the backends set).
  for (const fk of table.foreignKeys) {
    lines.push("  " + renderFkConstraint(fk, table.schema));
  }
  const body = lines.join(",\n");
  // Create the owning context's schema first (idempotent) so the
  // `<schema>.<table>` the EF / Drizzle mappings query actually exists.
  const createSchema = table.schema ? `CREATE SCHEMA IF NOT EXISTS ${ident(table.schema)};\n` : "";
  let sql = `${createSchema}CREATE TABLE ${qualified(table.schema, table.name)} (\n${body}\n);`;
  for (const idx of table.indexes) sql += "\n" + renderAddIndex(idx, table.schema);
  return sql;
}

/** `<schema>.<name>` when a schema is set, else the bare (public) name. */
function qualified(schema: string | undefined, name: string): string {
  return schema ? `${ident(schema)}.${ident(name)}` : ident(name);
}

function renderAddColumn(
  table: string,
  schema: string | undefined,
  column: ColumnShape,
  fk: FKShape | undefined,
): string {
  const t = qualified(schema, table);
  let sql = `ALTER TABLE ${t} ADD COLUMN ${renderColumnDef(column)};`;
  if (fk) {
    // FK targets live in the same schema as the referencing table.
    sql +=
      `\nALTER TABLE ${t} ADD CONSTRAINT ${ident(table + "_" + column.name + "_fk")} ` +
      `FOREIGN KEY (${ident(column.name)}) REFERENCES ${qualified(schema, fk.refTable)} ` +
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

function renderFkConstraint(fk: FKShape, schema?: string): string {
  return (
    `FOREIGN KEY (${ident(fk.column)}) REFERENCES ${qualified(schema, fk.refTable)} ` +
    `ON DELETE ${fk.onDelete.toUpperCase()}`
  );
}

function renderAddIndex(idx: IndexShape, schema?: string): string {
  const unique = idx.unique ? "UNIQUE " : "";
  // Partial index (`WHERE …`) — set on a `unique` index derived for a
  // softDeletable aggregate so re-create after soft-delete is allowed.
  const where = idx.predicate ? ` WHERE ${idx.predicate}` : "";
  // Per-column opclass (P2.5 materialized-path prefix index): `text_pattern_ops`
  // after the column makes `LIKE 'prefix.%'` index-usable under any collation.
  const cols = idx.columns
    .map((c) => {
      const oc = idx.opclasses?.[c];
      return oc ? `${ident(c)} ${oc}` : ident(c);
    })
    .join(", ");
  return (
    `CREATE ${unique}INDEX ${ident(idx.name)} ON ${qualified(schema, idx.table)} ` +
    `(${cols})${where};`
  );
}

export function renderPgType(t: ColumnType): string {
  switch (t.kind) {
    case "uuid":
      return "UUID";
    case "int":
      return "INTEGER";
    case "bigserial":
      return "BIGSERIAL";
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

/** Double-quoted identifier — the same quote-always spelling the seed path
 *  (`qIdent`) uses, so DDL and DML agree.  Postgres folds an unquoted
 *  identifier to lowercase and the migration builder already snake-cases
 *  everything to lowercase, so `"orders"` references the same relation as a
 *  bare `orders` — quoting is a no-op for the common case but makes a
 *  reserved-word column (`order`, `user`, `end`) or any `.ddd`-sourced name
 *  safe instead of a syntax error. */
function ident(name: string): string {
  return qIdent(name);
}

// ---------------------------------------------------------------------------
// Seed `raw`-path inserts (database-seeding.md §3.1) — a direct Postgres
// INSERT for one literal row.  Shared by all three backends' seed emitters
// (executed via Drizzle `db.execute`, EF `ExecuteSqlRawAsync`, Ecto
// `Ecto.Adapters.SQL`), so the SQL is bit-identical cross-backend.  The
// table/column naming mirrors the migration builder (`plural(snake(agg))` /
// `snake(field)`), so the INSERT targets the schema those migrations create.
// ---------------------------------------------------------------------------

/** INSERT for one `raw` seed row: explicit `id` + literal FK / scalar / enum
 *  columns.  Value objects / containment columns are unsupported in v1 (the
 *  validator reports them before this runs).  `schema` qualifies the table
 *  for backends whose tables live outside the connection's search_path
 *  (java's per-module schemas); omitted, the SQL is unchanged. */
export function renderSeedRowInsert(
  aggregate: string,
  fields: { name: string; value: ExprIR }[],
  schema?: string,
): string {
  const bare = qIdent(plural(snake(aggregate)));
  const table = schema ? `${qIdent(schema)}.${bare}` : bare;
  const cols = fields.map((f) => qIdent(snake(f.name))).join(", ");
  const vals = fields.map((f) => seedSqlLiteral(f.value)).join(", ");
  return `INSERT INTO ${table} (${cols}) VALUES (${vals})`;
}

/** Double-quoted identifier — matches the lowercase tables the migrations
 *  create and is safe for reserved words (`order`, `user`).  An embedded `"`
 *  is doubled per the Postgres quoting rule, so a `.ddd`-sourced name can't
 *  break out of the quotes. */
function qIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** An ExprIR seed value as a Postgres SQL literal.  Scalars / enum values /
 *  id literals only; anything else throws (raw v1 limitation). */
function seedSqlLiteral(e: ExprIR): string {
  if (e.kind === "literal") {
    switch (e.lit) {
      case "string":
        return sqlStr(e.value);
      case "money":
      case "decimal":
      case "int":
      case "long":
        return e.value;
      case "bool":
        return e.value === "true" ? "TRUE" : "FALSE";
      case "null":
        return "NULL";
      case "now":
        return "now()";
      default:
        return sqlStr(e.value);
    }
  }
  // Enum value → its stored text (pgEnum stores the value name).
  if (e.kind === "ref" && e.refKind === "enum-value") {
    return sqlStr(e.name);
  }
  throw new Error(
    `raw seed: unsupported column value of kind '${e.kind}' — raw rows admit scalar / enum / id literals only`,
  );
}

/** Single-quoted SQL string literal (doubling embedded quotes). */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
