// audit_records: the Drizzle table and the SQL migration must agree on
// nullability, column for column.
//
// The node backend has TWO runtime DDL paths for this table: against real
// Postgres the MIGRATION creates it (the shared MigrationsIR
// `auditTableShape`), but on PGlite (the per-PR behavioral leg, the
// playground boot) the DRIZZLE definition IS the DDL — no migration runs.
// Green on one says nothing about the other: #2325 made `before`/`after`
// nullable in the migration shape (a create has no before, a destroy has no
// after — the writers pass null on exactly those paths) while the drizzle
// table kept `.notNull()`, so every audited create on PGlite hit a not-null
// violation that rolled the aggregate save back with it. `conformance-parity`
// and the emitted-string tests were all blind to it; the behavioral leg
// caught it at runtime, one merge later, on an unrelated PR.
//
// Same discipline as `provenance-schema-ddl-agreement` (#2379), for the table
// where the disagreement actually shipped. Mutation-proven: restoring
// `.notNull()` on `before` in `schema.ts`'s AUDIT_TABLE fails the
// column-agreement case naming the column and both sides.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system AuditAgreement {
  subdomain Ordering {
    context Ordering {
      aggregate Order audited {
        reference: string
        quantity: int
        create(reference: string, quantity: int) {
          reference := reference
          quantity := quantity
        }
        operation cancel() {
          quantity := 0
        }
      }
      repository Orders for Order { }
    }
  }
  api OrderingApi from Ordering
  storage primary { type: postgres }
  resource orderingState { for: Ordering, kind: state, use: primary }
  deployable d {
    platform: node
    contexts: [Ordering]
    dataSources: [orderingState]
    serves: OrderingApi
    port: 4000
  }
}
`;

/** `"col" TYPE NULL|NOT NULL` rows of the audit_records CREATE TABLE. */
function sqlNullability(sql: string): Map<string, boolean> {
  const m = sql.match(/CREATE TABLE "audit_records" \(([^;]*?)\);/s);
  expect(m, "migration SQL contains CREATE TABLE audit_records").toBeTruthy();
  const out = new Map<string, boolean>();
  for (const line of (m as RegExpMatchArray)[1].split("\n")) {
    const col = line.match(/^\s*"(\w+)"\s+[A-Z][A-Z ]*?\s+(NOT NULL|NULL),?\s*$/);
    if (col) out.set(col[1], col[2] === "NULL");
  }
  return out;
}

/** `name: type("col")…` rows of the drizzle auditRecords pgTable. */
function drizzleNullability(schemaTs: string): Map<string, boolean> {
  // Lazy up to the first line-leading `}` — `[^}]*` would stop at the inner
  // brace of `timestamp("at", { withTimezone: true })` and drop 5 columns.
  const m = schemaTs.match(/pgTable\("audit_records", \{([\s\S]*?)\n\}/);
  expect(m, "db/schema.ts contains the auditRecords pgTable").toBeTruthy();
  const out = new Map<string, boolean>();
  for (const line of (m as RegExpMatchArray)[1].split("\n")) {
    const col = line.match(/^\s*\w+:\s*\w+\("(\w+)"[^)]*\)(.*),\s*$/);
    // `.primaryKey()` is implicitly NOT NULL in drizzle.
    if (col) out.set(col[1], !col[2].includes(".notNull()") && !col[2].includes(".primaryKey()"));
  }
  return out;
}

describe("audit_records — drizzle table ≡ migration DDL", () => {
  it("agrees on nullability for every column (both directions)", async () => {
    const files = await generateSystemFiles(SRC);
    const sqlPath = [...files.keys()].find(
      (p) => p.includes("/migrations/") && files.get(p)?.includes('CREATE TABLE "audit_records"'),
    );
    const schemaPath = [...files.keys()].find(
      (p) => p.endsWith("db/schema.ts") && files.get(p)?.includes('pgTable("audit_records"'),
    );
    expect(sqlPath, "an emitted migration creates audit_records").toBeTruthy();
    expect(schemaPath, "db/schema.ts declares auditRecords").toBeTruthy();

    const sql = sqlNullability(files.get(sqlPath as string) as string);
    const drizzle = drizzleNullability(files.get(schemaPath as string) as string);

    // Both parsers must have actually read the table — 13 columns today; a
    // parser that silently matches nothing would "agree" on the empty set.
    expect(sql.size).toBeGreaterThanOrEqual(13);
    expect(drizzle.size).toBe(sql.size);

    for (const [col, nullable] of sql) {
      expect(
        drizzle.get(col),
        `"${col}": migration says ${nullable ? "NULL" : "NOT NULL"}, drizzle says ` +
          `${drizzle.get(col) ? "nullable" : ".notNull()"} — on PGlite the drizzle side IS the DDL`,
      ).toBe(nullable);
    }
  });

  it("the one-sided lifecycle columns are nullable on BOTH paths", async () => {
    const files = await generateSystemFiles(SRC);
    const schemaTs = [...files.values()].find((c) => c.includes('pgTable("audit_records"'));
    const drizzle = drizzleNullability(schemaTs as string);
    // create has no before; destroy has no after — a NOT NULL here rejects
    // the audit insert and rolls the aggregate save back with it.
    expect(drizzle.get("before")).toBe(true);
    expect(drizzle.get("after")).toBe(true);
  });
});
