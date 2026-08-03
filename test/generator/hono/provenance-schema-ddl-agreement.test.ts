// `provenance_records` has TWO node runtime paths, built from two different
// definitions — and green on one says nothing about the other:
//
//   real Postgres → `db/migrations/*.sql`, rendered from the shared
//                   MigrationsIR companion shape (`provenanceTableShape`)
//   PGlite        → `web/src/runtime/ddl.ts` `synthDDL`, which SYNTHESISES the
//                   DDL from the DRIZZLE `provenanceRecords` definition in
//                   `db/schema.ts` (the playground and the behavioral tier's
//                   Hono leg both boot this way)
//
// So the Drizzle table is not merely ORM typing here: on PGlite it IS the DDL.
// A column present in one and absent in the other, or nullable in one and NOT
// NULL in the other, produces a table that accepts every provenanced write on
// one runtime and rejects it on the other — a class the emitted-string tests
// each backend keeps are structurally blind to, because they only ever look at
// one side.
//
// This pins BOTH sides of the same generated project at once and compares them
// column-for-column.  Sibling of the gate the audit consolidation (#2325)
// wanted for `audit_records`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order {
        reference: string
        quantity: int
        unitPrice: int
        total: int provenanced
        operation reprice(qty: int, price: int) {
          quantity := qty
          unitPrice := price
          total := qty * price
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
}
`;

/** `(column name → nullable)` for the `provenance_records` CREATE TABLE in the
 *  emitted SQL migrations — the real-Postgres side. */
function columnsFromSql(sql: string): Map<string, boolean> {
  const body = /CREATE TABLE "provenance_records" \(\n([\s\S]*?)\n\);/.exec(sql)?.[1];
  expect(body, "provenance_records CREATE TABLE in the emitted migrations").toBeDefined();
  const out = new Map<string, boolean>();
  for (const line of (body as string).split("\n")) {
    const m = /^\s*"([a-z_]+)"\s+(.*?),?$/.exec(line);
    if (!m || line.includes("PRIMARY KEY (")) continue;
    out.set(
      m[1] as string,
      /\bNULL\b/.test(m[2] as string) && !/\bNOT NULL\b/.test(m[2] as string),
    );
  }
  return out;
}

/** `(column name → nullable)` for the Drizzle `provenanceRecords` table — the
 *  PGlite side, since `synthDDL` reads exactly this to build its DDL.  A column
 *  is NOT NULL iff it carries `.notNull()` or `.primaryKey()`. */
function columnsFromDrizzle(schema: string): Map<string, boolean> {
  const body =
    /export const provenanceRecords = pgTable\("provenance_records", \{([\s\S]*?)\n\}/.exec(
      schema,
    )?.[1];
  expect(body, "provenanceRecords pgTable in db/schema.ts").toBeDefined();
  const out = new Map<string, boolean>();
  for (const line of (body as string).split("\n")) {
    const m = /^\s*\w+:\s*\w+\("([a-z_]+)"[^)]*\)(.*)$/.exec(line);
    if (!m) continue;
    const tail = m[2] as string;
    out.set(m[1] as string, !tail.includes(".notNull()") && !tail.includes(".primaryKey()"));
  }
  return out;
}

describe("hono provenance_records — the SQL migration and the Drizzle schema agree", () => {
  it("declares the same columns with the same nullability on both runtime paths", async () => {
    const files = await generateSystemFiles(SRC);
    const schema = [...files.entries()].find(([p]) => p.endsWith("db/schema.ts"))?.[1];
    const sql = [...files.entries()]
      .filter(([p]) => p.includes("db/migrations/") && p.endsWith(".sql"))
      .map(([, c]) => c)
      .join("\n");
    expect(schema, "db/schema.ts").toBeDefined();

    const fromSql = columnsFromSql(sql);
    const fromDrizzle = columnsFromDrizzle(schema as string);

    // Both sides are non-trivial — a regex that silently matched nothing would
    // otherwise make two empty maps "agree" (the §59 blind-by-construction
    // shape).
    expect(fromSql.size).toBe(11);
    expect([...fromSql.entries()].sort()).toEqual([...fromDrizzle.entries()].sort());

    // And the nullability the writers actually need: a flush leaves the four
    // request-context ids and the computed value null, and must never be able
    // to leave the identity/target columns null.
    for (const nullable of [
      "computed_value",
      "correlation_id",
      "scope_id",
      "actor_id",
      "parent_id",
    ])
      expect(fromSql.get(nullable), nullable).toBe(true);
    for (const notNull of ["trace_id", "snapshot_id", "target_type", "field", "inputs", "at"])
      expect(fromSql.get(notNull), notNull).toBe(false);
  });

  it("creates the table from the SHARED MigrationsIR migration, not the late provenance one", async () => {
    const files = await generateSystemFiles(SRC);
    const late = [...files.entries()].find(([p]) => p.endsWith("_provenance.sql"))?.[1];
    // The late migration keeps only the per-aggregate co-located columns; the
    // history table is a shared companion table now, so it lands in the
    // ordinary module migration alongside the outbox and audit tables.
    expect(late).toBeDefined();
    expect(late).toContain("total_provenance");
    expect(late).not.toContain("CREATE TABLE");
    const initial = [...files.entries()].find(([p]) => p.endsWith("_sales_initial.sql"))?.[1];
    expect(initial).toContain('CREATE TABLE "provenance_records"');
    expect(initial).toContain('CREATE INDEX "provenance_records_correlation_idx"');
  });
});
