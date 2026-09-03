// SQL the read-only Tables sub-view sends through `runQuery` (M-T8.22
// slice 3).  Pure strings + identifier quoting, kept out of the component so
// the quoting is unit-testable — a table named `order"s` must not become an
// injection into the user's own database, even a throwaway one.

/** Every user table, across the per-context schemas the generated backends
 *  create (`sales.products`, not just `public`).  Postgres' own schemas and
 *  the playground's `__loom` bookkeeping are excluded. */
export const LIST_USER_TABLES_SQL =
  "SELECT table_schema, table_name FROM information_schema.tables " +
  "WHERE table_type = 'BASE TABLE' " +
  "AND table_schema NOT IN ('pg_catalog', 'information_schema', '__loom') " +
  "AND table_schema NOT LIKE 'pg_%' " +
  "ORDER BY table_schema, table_name;";

/** First `limit` rows of a table, read-only. */
export const TABLE_PREVIEW_ROWS = 50;

/** Double-quote a Postgres identifier, escaping embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function firstRowsSql(schema: string, table: string, limit = TABLE_PREVIEW_ROWS): string {
  const n = Number.isInteger(limit) && limit > 0 ? limit : TABLE_PREVIEW_ROWS;
  return `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${n};`;
}

export function countRowsSql(schema: string, table: string): string {
  return `SELECT count(*)::int AS n FROM ${quoteIdent(schema)}.${quoteIdent(table)};`;
}

export interface UserTable {
  schema: string;
  name: string;
}

/** Read the `LIST_USER_TABLES_SQL` result rows into `{schema, name}`. */
export function readUserTables(rows: ReadonlyArray<Record<string, unknown>>): UserTable[] {
  const out: UserTable[] = [];
  for (const r of rows) {
    const schema = r.table_schema;
    const name = r.table_name;
    if (typeof schema === "string" && typeof name === "string") out.push({ schema, name });
  }
  return out;
}

/** `public.products` reads as `products`; anything else keeps its schema. */
export function tableLabel(t: UserTable): string {
  return t.schema === "public" ? t.name : `${t.schema}.${t.name}`;
}
