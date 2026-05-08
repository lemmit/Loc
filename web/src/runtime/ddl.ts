// DDL synth from a Drizzle pg-core schema.
//
// We don't ship Drizzle Kit (its CLI doesn't run in a browser
// worker cleanly), so this module walks the schema's table /
// enum metadata and emits the bare-minimum CREATE TYPE / CREATE
// TABLE / CREATE INDEX SQL needed to bring a fresh PGlite up to
// the shape the generated repositories expect.
//
// All Drizzle helpers (`is`, `Table`, `getTableConfig`) come
// from the bundle module — using them transitively guarantees we
// reference the same Drizzle instance the bundled repositories
// were compiled against.

interface DrizzleHelpers {
  is: (value: unknown, type: unknown) => boolean;
  Table: unknown;
  getTableConfig: (table: unknown) => {
    name: string;
    columns: DrizzleColumn[];
    indexes: DrizzleIndex[];
  };
}

interface DrizzleColumn {
  name: string;
  columnType: string;
  notNull: boolean;
  primary: boolean;
  enumValues?: readonly string[];
  enum?: { enumName: string };
  // varchar length, numeric precision/scale, timestamp tz, etc.
  config?: Record<string, unknown>;
  precision?: number;
  scale?: number;
  length?: number;
  withTimezone?: boolean;
}

interface DrizzleIndex {
  config: {
    name: string;
    columns: Array<{ name?: string; fieldName?: string }>;
  };
}

interface DrizzleEnum {
  enumName: string;
  enumValues: readonly string[];
}

function isPgEnum(v: unknown): v is DrizzleEnum {
  if (v == null) return false;
  const obj = v as { enumName?: unknown; enumValues?: unknown };
  return (
    typeof obj.enumName === "string" && Array.isArray(obj.enumValues)
  );
}

// Map Drizzle's columnType discriminator to the matching PostgreSQL
// SQL type.  Coverage tracks what the Loom generator actually emits
// for `db/schema.ts` — extend when we encounter a new column type
// in a generated file.
function columnSql(c: DrizzleColumn): string {
  switch (c.columnType) {
    case "PgText":
      return "text";
    case "PgVarchar":
      return c.length != null ? `varchar(${c.length})` : "varchar";
    case "PgChar":
      return c.length != null ? `char(${c.length})` : "char";
    case "PgInteger":
      return "integer";
    case "PgSmallInt":
      return "smallint";
    case "PgSerial":
      return "serial";
    case "PgSmallSerial":
      return "smallserial";
    case "PgBigSerial53":
    case "PgBigSerial64":
      return "bigserial";
    case "PgBigInt53":
    case "PgBigInt64":
      return "bigint";
    case "PgNumeric":
      if (c.precision != null) {
        return c.scale != null
          ? `numeric(${c.precision},${c.scale})`
          : `numeric(${c.precision})`;
      }
      return "numeric";
    case "PgReal":
      return "real";
    case "PgDoublePrecision":
      return "double precision";
    case "PgBoolean":
      return "boolean";
    case "PgTimestamp":
    case "PgTimestampString":
      return c.withTimezone ? "timestamp with time zone" : "timestamp";
    case "PgDate":
    case "PgDateString":
      return "date";
    case "PgTime":
      return "time";
    case "PgUUID":
      return "uuid";
    case "PgJson":
      return "json";
    case "PgJsonb":
      return "jsonb";
    case "PgEnumColumn":
      if (!c.enum?.enumName) {
        throw new Error(`PgEnumColumn "${c.name}" missing enum reference`);
      }
      return `"${c.enum.enumName}"`;
    default:
      throw new Error(`DDL synth: unsupported drizzle column type "${c.columnType}" (column "${c.name}")`);
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function synthDDL(
  schema: Record<string, unknown>,
  helpers: DrizzleHelpers,
): string {
  const enums: DrizzleEnum[] = [];
  const tables: unknown[] = [];
  for (const value of Object.values(schema)) {
    if (isPgEnum(value)) {
      enums.push(value);
    } else if (helpers.is(value, helpers.Table)) {
      tables.push(value);
    }
  }

  const lines: string[] = [];

  // Enums first — column declarations in CREATE TABLE may reference
  // their type names.  Postgres lacks `CREATE TYPE IF NOT EXISTS`
  // so we wrap each in a DO block that catches the duplicate-object
  // error.  Idempotent on re-run, which lets the runtime worker
  // re-apply this DDL against a persistent OPFS PGlite without
  // dropping data first.
  for (const e of enums) {
    const values = e.enumValues.map(quoteSqlString).join(", ");
    lines.push(
      `DO $$ BEGIN CREATE TYPE ${quoteIdent(e.enumName)} AS ENUM (${values}); ` +
        `EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
  }

  for (const t of tables) {
    const cfg = helpers.getTableConfig(t);
    const colDefs: string[] = [];
    for (const c of cfg.columns) {
      const parts = [quoteIdent(c.name), columnSql(c)];
      if (c.notNull) parts.push("NOT NULL");
      if (c.primary) parts.push("PRIMARY KEY");
      colDefs.push(`  ${parts.join(" ")}`);
    }
    // `IF NOT EXISTS` makes table creation idempotent.  Note: this
    // doesn't migrate existing tables — if the source schema
    // changes, the user has to "Reset DB" to drop + re-create.
    lines.push(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(cfg.name)} (\n${colDefs.join(",\n")}\n);`,
    );
    for (const ix of cfg.indexes) {
      const cols = ix.config.columns
        .map((c) => quoteIdent(c.name ?? c.fieldName ?? "?"))
        .join(", ");
      lines.push(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(ix.config.name)} ` +
          `ON ${quoteIdent(cfg.name)} (${cols});`,
      );
    }
  }

  return lines.join("\n\n") + "\n";
}
