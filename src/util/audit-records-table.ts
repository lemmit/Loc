// The `audit_records` table shape — ONE definition, six consumers.
//
// This table is emitted five different ways: the platform-neutral DDL
// (`system/migrations-builder.ts` → MigrationsIR), the Hono Drizzle `pgTable`,
// the MikroORM entity, the EF Core POCO + EntityTypeConfiguration, the JPA
// entity, and the Dapper `DbSchema` CREATE TABLE.  A hand-written column list
// in each of them drifts, and the drift is invisible: `before` / `after` are
// NULLABLE (a `create` has no before-state, a `destroy` has no after-state, and
// the writers pass `null` on exactly those paths), so a Drizzle schema
// declaring them `.notNull()` — or a MikroORM entity with `nullable: false` —
// hits a NOT NULL violation while the emitted `.sql` migration says the
// opposite.  (`web/src/runtime/ddl.ts` synthesises the behavioral DDL from the
// DRIZZLE schema, not from the migration, so the two halves are compared only
// at runtime.)
//
// Deriving the shape in `migrations-builder` alone is not enough: the writers
// cannot import it (`generator/` may not depend on `system/`).  Hence this
// module, in `util/`, which every consumer may import.
//
// The rendering stays per-backend (each has its own type vocabulary and casing
// conventions); what is shared is the column set, the property names and — the
// thing that actually broke — the nullability.  `audit-records-consistency`
// (test/conformance) pins each emitter's output against this list, the same
// pure-data-mirror + consistency-test pattern `adapter-metadata.ts` uses.

/** Logical column type.  Each backend maps it to its own vocabulary: `text` →
 *  `text`/`string`/`String`, `json` → `jsonb`/`Object`, `datetime` →
 *  `timestamptz`/`DateTime`/`OffsetDateTime`. */
export type AuditColumnType = "text" | "json" | "datetime";

export interface AuditRecordColumn {
  /** Postgres column name (snake_case) — what lands in the DDL. */
  column: string;
  /** camelCase property name the ORM/entity emitters bind it to.  PascalCase
   *  targets (.NET) upper-case the first letter; that is a rendering detail,
   *  not a separate fact. */
  prop: string;
  type: AuditColumnType;
  /** NULLABILITY IS THE POINT OF THIS MODULE.  See the header — this is the
   *  field the five copies disagreed on. */
  nullable: boolean;
}

export const AUDIT_RECORDS_TABLE = "audit_records";

/** The primary key column. */
export const AUDIT_RECORDS_PK = "audit_id";

/** Column order is the emission order every consumer follows, so a diff across
 *  backends stays line-for-line comparable. */
export const AUDIT_RECORD_COLUMNS: readonly AuditRecordColumn[] = [
  { column: "audit_id", prop: "auditId", type: "text", nullable: false },
  { column: "operation_id", prop: "operationId", type: "text", nullable: false },
  { column: "action", prop: "action", type: "text", nullable: false },
  { column: "target_type", prop: "targetType", type: "text", nullable: false },
  { column: "target_id", prop: "targetId", type: "text", nullable: false },
  { column: "actor", prop: "actor", type: "json", nullable: true },
  // NULLABLE, deliberately: a `create` has no before-state and a `destroy` has
  // no after-state, and every writer passes null on exactly those paths.
  { column: "before", prop: "before", type: "json", nullable: true },
  { column: "after", prop: "after", type: "json", nullable: true },
  { column: "at", prop: "at", type: "datetime", nullable: false },
  { column: "status", prop: "status", type: "text", nullable: false },
  { column: "correlation_id", prop: "correlationId", type: "text", nullable: true },
  { column: "scope_id", prop: "scopeId", type: "text", nullable: true },
  { column: "parent_id", prop: "parentId", type: "text", nullable: true },
];

/** Secondary indexes: the per-entity history read, and tracing one command
 *  across aggregates. */
export const AUDIT_RECORD_INDEXES: ReadonlyArray<{ name: string; columns: readonly string[] }> = [
  { name: "audit_records_target_idx", columns: ["target_type", "target_id"] },
  { name: "audit_records_correlation_idx", columns: ["correlation_id"] },
];

/** Lookup by Postgres column name — for emitters that walk their own list and
 *  need the canonical nullability for a column. */
export function auditColumn(column: string): AuditRecordColumn | undefined {
  return AUDIT_RECORD_COLUMNS.find((c) => c.column === column);
}
