// `audit_records` has TWO node runtime paths built from two DIFFERENT
// definitions, and green on one says nothing about the other:
//
//   real Postgres → `db/migrations/*.sql`, rendered from the shared MigrationsIR
//                   companion shape (`auditTableShape`)
//   PGlite        → `web/src/runtime/ddl.ts` `synthDDL`, which SYNTHESISES the
//                   DDL from the DRIZZLE `auditRecords` definition in
//                   `db/schema.ts` (the playground and the behavioral tier's
//                   Hono leg both boot this way)
//
// So the Drizzle table is not merely ORM typing: on PGlite it IS the DDL.
//
// This existed as a LIVE defect. #2325 moved the audit DDL into MigrationsIR and
// fixed `before`/`after` to be nullable — a lifecycle action only has one side,
// so the create path writes a literal `before: null` — but the Drizzle table
// kept `.notNull()` on both. Real Postgres was therefore fine while PGlite 500'd
// every audited create with `Failed query: insert into "audit_records"`, which
// is what the `behavioral` leg caught on the `audited` corpus case. Neither
// backend's emitted-string tests could see it: they each only ever look at one
// side. #2387 fixed the emitters (Drizzle and MikroORM both); this file is the
// PIN that keeps the two definitions from drifting apart again, which is the
// part that was missing — the defect survived precisely because nothing
// compared them.
//
// Sibling of provenance-schema-ddl-agreement.test.ts; same comparison, same
// reason.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order audited {
        reference: string
        quantity: int
        create(reference: string, quantity: int) {
          reference := reference
          quantity := quantity
        }
        operation bump(by: int) {
          quantity := quantity + by
        }
        destroy { }
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

/** `(column name → nullable)` for the `audit_records` CREATE TABLE in the
 *  emitted SQL migrations — the real-Postgres side. */
function columnsFromSql(sql: string): Map<string, boolean> {
  const body = /CREATE TABLE "audit_records" \(\n([\s\S]*?)\n\);/.exec(sql)?.[1];
  expect(body, "audit_records CREATE TABLE in the emitted migrations").toBeDefined();
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

/** `(column name → nullable)` for the Drizzle `auditRecords` table — the PGlite
 *  side, since `synthDDL` reads exactly this to build its DDL. */
function columnsFromDrizzle(schema: string): Map<string, boolean> {
  const body = /export const auditRecords = pgTable\("audit_records", \{([\s\S]*?)\n\}/.exec(
    schema,
  )?.[1];
  expect(body, "auditRecords pgTable in db/schema.ts").toBeDefined();
  const out = new Map<string, boolean>();
  for (const line of (body as string).split("\n")) {
    const m = /^\s*\w+:\s*\w+\("([a-z_]+)"[^)]*\)(.*)$/.exec(line);
    if (!m) continue;
    const tail = m[2] as string;
    out.set(m[1] as string, !tail.includes(".notNull()") && !tail.includes(".primaryKey()"));
  }
  return out;
}

describe("hono audit_records — the SQL migration and the Drizzle schema agree", () => {
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

    // Both sides non-trivial — two empty maps would otherwise "agree".
    expect(fromSql.size).toBe(13);
    expect([...fromSql.entries()].sort()).toEqual([...fromDrizzle.entries()].sort());
  });

  it("keeps before/after nullable — a create has no before, a destroy no after", async () => {
    const files = await generateSystemFiles(SRC);
    const schema = [...files.entries()].find(([p]) => p.endsWith("db/schema.ts"))?.[1] as string;
    const fromDrizzle = columnsFromDrizzle(schema);
    // The regression that made every audited create 500 on PGlite while real
    // Postgres stayed green: the writer emits a literal `before: null`, so a
    // NOT NULL here is unsatisfiable on the create path.
    expect(fromDrizzle.get("before"), "before").toBe(true);
    expect(fromDrizzle.get("after"), "after").toBe(true);
    expect(schema).toContain('before: jsonb("before"),');
    expect(schema).not.toContain('before: jsonb("before").notNull()');
  });
});
