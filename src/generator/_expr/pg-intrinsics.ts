// Postgres-SQL-TEXT scalar-intrinsic snippets (src/util/intrinsics.ts).
//
// The two emitters that write a filter predicate as raw SQL TEXT share this
// table: .NET's Dapper repository (`whereToSql`) and Java's Hibernate
// `@SQLRestriction` static filter (`renderSqlRestriction`).  Everything else
// goes through a query builder and needs its own shape — Drizzle's `sql` tag,
// Ecto `fragment`s, SQLAlchemy `func.*`, JPA `cb.*`, HQL, or (EF Core) a LINQ
// expression it translates itself — so those tables stay per-backend.
//
// Two consumers in different platform packages is exactly why this lives at
// `src/generator/_expr/` rather than in either of them: `generator/<platform>`
// may not import another platform, and one Postgres dialect should not drift
// into two copies.
//
// Snippets receive the ALREADY-RENDERED receiver and args (a Dapper param is
// already `@name`; a `@SQLRestriction` literal is already quoted) and return a
// SQL fragment.  Pinned row-for-row against the catalogue's `queryable` set by
// `test/generator/intrinsic-completeness.test.ts`.

/** Postgres SQL text per queryable intrinsic. */
export const PG_INTRINSIC_SQL: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `btrim(${recv})`,
  "string.toUpper": (recv) => `upper(${recv})`,
  "string.toLower": (recv) => `lower(${recv})`,
  // Prefix match (tenancy-authorization-final-surface decision 2) — anchored
  // position, so a `%`/`_` in the value matches literally.  See
  // `src/util/intrinsics.ts` for the cross-backend contract.
  "string.startsWith": (recv, args) => `strpos(${recv}, ${args[0]}) = 1`,
  // ---- numerics.  int/long are integer/bigint columns, decimal/money both
  // `numeric`, so one Postgres function serves each op per receiver.  Two-value
  // min/max are LEAST/GREATEST, never the aggregates; Postgres
  // `round(numeric, n)` is already half-away-from-zero (the catalogue contract).
  "int.abs": (recv) => `abs(${recv})`,
  "long.abs": (recv) => `abs(${recv})`,
  "decimal.abs": (recv) => `abs(${recv})`,
  "money.abs": (recv) => `abs(${recv})`,
  "int.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "long.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "decimal.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "money.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "long.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "decimal.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "money.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "decimal.round": (recv, args) =>
    args.length > 0 ? `round(${recv}, ${args[0]})` : `round(${recv})`,
  "money.round": (recv, args) =>
    args.length > 0 ? `round(${recv}, ${args[0]})` : `round(${recv})`,
  "decimal.floor": (recv) => `floor(${recv})`,
  "money.floor": (recv) => `floor(${recv})`,
  "decimal.ceil": (recv) => `ceil(${recv})`,
  "money.ceil": (recv) => `ceil(${recv})`,
  // `timestamptz` columns are stored in UTC, so `date_trunc('day', …)` cuts the
  // day at the UTC boundary — the catalogue's midnight-UTC bucket.
  "datetime.startOfDay": (recv) => `date_trunc('day', ${recv})`,
};
