import { isReservedIdent } from "../sql-reserved.js";

// ---------------------------------------------------------------------------
// Reserved-word identifier quoting for the Spring Boot backend (M-T6.43).
//
// The Java backend does not write SQL by hand — Hibernate derives it from the
// JPA mapping annotations, and Flyway owns the DDL (`ddl-auto: none`).  That
// split is why the defect here is quieter than the Dapper one it mirrors: the
// migration chain quotes ALWAYS (`sql-pg.ts`), so the TABLE is created with a
// perfectly good `"order"` column, the project COMPILES (the mapping is just a
// string), and only at runtime does Hibernate emit
//
//     select t1_0.id, t1_0.order, t1_0."group" … from orders t1_0
//                     ^^^^^^^^^^ syntax error at or near "order"
//
// for a `.ddd` field named `order`.  Every compile-tier gate is blind to it,
// which is exactly how it survived M-T6.42 (found there, filed, not fixed).
//
// TWO POSITIONS, TWO SPELLINGS — and only one of them is SQL:
//
//   - A MAPPING annotation (`@Column` / `@Table` / `@JoinColumn` /
//     `@CollectionTable`) takes a Hibernate identifier, where the portable
//     quote is the BACKTICK: Hibernate parses `` `order` `` as "quoted" and
//     re-renders it with the *dialect's* quote character (`"order"` on
//     Postgres).  Writing `"order"` there instead would make the identifier
//     literally include the quote characters.
//   - `@SQLRestriction` takes a raw SQL fragment that Hibernate appends
//     verbatim, so it needs real Postgres quoting — `"order"` — which the
//     `JSON.stringify` at the emission site then escapes for the Java literal.
//
// The word list is shared with the Dapper adapter (`src/generator/sql-reserved.ts`);
// only these two wrappers are Java's.
// ---------------------------------------------------------------------------

/** A table or column name for a JPA/Hibernate MAPPING annotation, backtick-quoted
 *  when it is a Postgres reserved word.
 *
 *  NOT for the `name =` of an `@AttributeOverride` (that is a Java property
 *  path, not an identifier), nor for compound names the emitter derives
 *  (`<owner>_id`, `<field>_provenance`, a pluralised table) — those can never
 *  collide, and quoting them would churn output for nothing. */
export function hbIdent(name: string): string {
  return isReservedIdent(name) ? `\`${name}\`` : name;
}

/** A column name inside a raw-SQL fragment (`@SQLRestriction`), quoted with
 *  Postgres' own `"…"` when it is a reserved word. */
export function sqlRestrictionIdent(name: string): string {
  return isReservedIdent(name) ? `"${name}"` : name;
}
