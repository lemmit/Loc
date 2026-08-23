// ---------------------------------------------------------------------------
// Postgres RESERVED identifiers — the one list, shared by every backend that
// puts a `.ddd`-derived name into a SQL identifier position.
//
// A field named `order` / `group` / `limit` / `end` / `right` is a Postgres
// reserved word, so the bare identifier is a syntax error wherever it lands:
//
//     CREATE TABLE tickets (order integer not null, …)     -- syntax error
//     SELECT id, order FROM tickets WHERE id = @id         -- syntax error
//     select t.order from tickets t                        -- syntax error
//
// The migrations path (`sql-pg.ts`) settled this long ago by quoting ALWAYS;
// the backends that write their own SQL — the .NET Dapper adapter, which
// provisions its own schema (`hasMigrations = !usingDapper`), and Hibernate,
// which derives its SQL from the JPA mapping annotations — each needed the same
// answer and reached it separately.  This module is that answer's single home.
//
// WHY QUOTE ONLY THE RESERVED ONES rather than always, as `sql-pg.ts` does:
// quote-always would move every byte of emitted SQL in the tree for no
// behavioural gain, and that output is pinned by a large body of
// string-asserting tests plus the cross-backend wire goldens.  Reserved-only is
// a hole closed, not a re-spelling.
//
// WHAT THIS MODULE DOES NOT OWN: the ESCAPING.  Each backend's identifier
// position has its own quoting convention — a C# regular string literal wants
// `\"order\"`, a C# verbatim literal wants `""order""`, and a Hibernate mapping
// annotation wants the portable backtick (`` `order` ``, which Hibernate
// rewrites to the dialect's quote character).  Only the PREDICATE is common, so
// only the predicate lives here; every backend keeps its own one-line wrapper.
//
// THE SET is Postgres' own `pg_get_keywords()` categories `R` (reserved) and
// `T` (reserved, can be function or type name) — empirically the two a bare
// column name cannot come from:
//
//     select word from pg_get_keywords() where catcode in ('R','T') order by word
//
// Verified against postgres:16 (101 words, byte-for-byte the list below).  The
// other two categories are fine bare: `values` is `C` (col-name-keyword) and
// `create table t (values int)` succeeds, as does the `U` (unreserved) `name`.
//
// Note `right`: it is category `T` and `create table t (right int)` really is a
// syntax error, but it was absent from this list while the list lived inside
// the Dapper emitter.  That single-word drift, found the moment the set was
// re-derived from the server for the second consumer, is the whole argument for
// this file existing rather than a copy.
// ---------------------------------------------------------------------------
const PG_RESERVED_IDENTS: ReadonlySet<string> = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "authorization",
  "binary",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "collation",
  "column",
  "concurrently",
  "constraint",
  "create",
  "cross",
  "current_catalog",
  "current_date",
  "current_role",
  "current_schema",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "freeze",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "ilike",
  "in",
  "initially",
  "inner",
  "intersect",
  "into",
  "is",
  "isnull",
  "join",
  "lateral",
  "leading",
  "left",
  "like",
  "limit",
  "localtime",
  "localtimestamp",
  "natural",
  "not",
  "notnull",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "outer",
  "overlaps",
  "placing",
  "primary",
  "references",
  "returning",
  "right",
  "select",
  "session_user",
  "similar",
  "some",
  "symmetric",
  "system_user",
  "table",
  "tablesample",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "verbose",
  "when",
  "where",
  "window",
  "with",
]);

/** True when `name` cannot appear as a BARE Postgres identifier — i.e. it must
 *  be quoted at every table / column position it reaches.
 *
 *  Takes the name in the form it will be emitted in (already `snake`d), and is
 *  case-sensitive on purpose: the emitters lowercase every identifier, so a
 *  mixed-case argument is a caller bug rather than a word to fold. */
export function isReservedIdent(name: string): boolean {
  return PG_RESERVED_IDENTS.has(name);
}

/** The set itself, for tests that want to enumerate it. Emitters should use
 *  `isReservedIdent` (or their own quoting wrapper over it). */
export const PG_RESERVED_IDENT_WORDS: ReadonlySet<string> = PG_RESERVED_IDENTS;
