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
    /** The Postgres schema the table lives under, set when the
     *  generated `db/schema.ts` routes it through `pgSchema(...)`
     *  (system-mode emits `<context>.table(...)`, defaulting the
     *  schema to `snake(context.name)`).  `undefined` for unqualified
     *  `pgTable(...)` (legacy single-context mode) — those tables
     *  live in `public`. */
    schema?: string;
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
  // Column DEFAULT.  `hasDefault` is set for serial types (implicit
  // sequence — no explicit DEFAULT) AND for `.default(...)` / `.defaultNow()`
  // columns; `default` carries the value (a Drizzle `SQL` object for
  // `defaultNow()`/`sql\`…\``, or a literal).
  hasDefault?: boolean;
  default?: unknown;
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

// Serial column types carry their DEFAULT implicitly (the type creates a
// backing sequence), so we must NOT emit an explicit `DEFAULT` for them.
const SERIAL_TYPES = new Set([
  "PgSerial",
  "PgSmallSerial",
  "PgBigSerial53",
  "PgBigSerial64",
]);

/** The `DEFAULT …` clause for a column, or `null` when it has none (or one we
 *  can't faithfully render).  Needed because the generated event-log table
 *  inserts rely on DB defaults (`seq` bigserial, `occurred_at` `defaultNow()`):
 *  the repository omits those columns so the row falls back to the default.
 *  Serial defaults come from the type; a Drizzle `SQL` default (e.g.
 *  `defaultNow()` → `sql\`now()\``) is flattened from its string chunks; a
 *  literal default is quoted.  A default with bound params is skipped (we don't
 *  guess) rather than emitted wrong. */
function columnDefaultSql(c: DrizzleColumn): string | null {
  if (!c.hasDefault || SERIAL_TYPES.has(c.columnType)) return null;
  const d = c.default;
  if (d == null) return null;
  if (typeof d === "object") {
    const chunks = (d as { queryChunks?: unknown }).queryChunks;
    if (!Array.isArray(chunks)) return null;
    let out = "";
    for (const ch of chunks) {
      const val = (ch as { value?: unknown }).value;
      if (Array.isArray(val) && val.every((x) => typeof x === "string")) {
        out += val.join("");
      } else {
        return null; // param / non-string chunk — don't guess
      }
    }
    return out.length > 0 ? out : null;
  }
  if (typeof d === "string") return quoteSqlString(d);
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  return null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Schema-qualified table reference: `"sales"."products"` when the
 *  table declares a pgSchema, plain `"products"` otherwise.  The index
 *  NAME is never schema-qualified — Postgres places a new index in its
 *  table's schema automatically — so this is used only for the table
 *  reference in CREATE TABLE / CREATE INDEX ... ON. */
function qualifiedTable(schema: string | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
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

  // Postgres schemas first — the generated repositories query
  // schema-qualified tables (`from "sales"."products"`) whenever the
  // source's context resolves a dataSource, so the matching
  // `CREATE SCHEMA` must run before any qualified CREATE TABLE.
  // Without this the tables land in `public`, boot succeeds, and
  // every query 500s on a missing `sales.*` relation.  Collected from
  // each table's `getTableConfig().schema`; `public` is implicit so
  // it's skipped.  `IF NOT EXISTS` keeps re-apply idempotent.
  const schemas: string[] = [];
  const seenSchemas = new Set<string>();
  for (const t of tables) {
    const s = helpers.getTableConfig(t).schema;
    if (s && s !== "public" && !seenSchemas.has(s)) {
      seenSchemas.add(s);
      schemas.push(s);
    }
  }
  for (const s of schemas) {
    lines.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`);
  }

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
    const tableRef = qualifiedTable(cfg.schema, cfg.name);
    const colDefs: string[] = [];
    for (const c of cfg.columns) {
      const parts = [quoteIdent(c.name), columnSql(c)];
      if (c.notNull) parts.push("NOT NULL");
      const def = columnDefaultSql(c);
      if (def) parts.push(`DEFAULT ${def}`);
      if (c.primary) parts.push("PRIMARY KEY");
      colDefs.push(`  ${parts.join(" ")}`);
    }
    // `IF NOT EXISTS` makes table creation idempotent.  Note: this
    // doesn't migrate existing tables — if the source schema
    // changes, the user has to "Reset DB" to drop + re-create.
    lines.push(
      `CREATE TABLE IF NOT EXISTS ${tableRef} (\n${colDefs.join(",\n")}\n);`,
    );
    for (const ix of cfg.indexes) {
      const cols = ix.config.columns
        .map((c) => quoteIdent(c.name ?? c.fieldName ?? "?"))
        .join(", ");
      lines.push(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(ix.config.name)} ` +
          `ON ${tableRef} (${cols});`,
      );
    }
  }

  return lines.join("\n\n") + "\n";
}
