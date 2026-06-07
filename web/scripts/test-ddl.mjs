// Deterministic, network-free unit test for the runtime DDL synth
// (`web/src/runtime/ddl.ts`).  Guards the regression fixed in the
// per-context-pgSchema change: system-mode backends route every table
// through a `pgSchema("sales")`, so the generated repositories query
// `from "sales"."products"` — `synthDDL` must emit a matching
// `CREATE SCHEMA` + schema-qualified `CREATE TABLE`/`CREATE INDEX`, or
// the backend boots but every query 500s on a missing `sales.*`
// relation.
//
// `e2e/runtime.spec.ts` covers the same path end-to-end, but it
// self-skips when the browser context can't reach the npm registry —
// so this pure test (no npm install, no PGlite, no drizzle) is the
// reliable CI gate.  `synthDDL` takes its Drizzle helpers injected, so
// we feed it hand-built fakes that mimic `getTableConfig()`'s shape
// and assert on the SQL string.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { synthDDL } from "../src/runtime/ddl.ts";

// A sentinel the fake `is(value, Table)` recognises — stands in for
// Drizzle's real `Table` symbol class.
const TABLE = Symbol("Table");

/** Build a fake Drizzle table whose `getTableConfig()` returns the
 *  given shape.  `schema` undefined → unqualified (legacy `pgTable`);
 *  set → system-mode `pgSchema(schema).table(...)`. */
function fakeTable(config) {
  return { __isTable: true, __config: { columns: [], indexes: [], ...config } };
}

function col(name, columnType, extra = {}) {
  return { name, columnType, notNull: false, primary: false, ...extra };
}

const helpers = {
  is: (value, type) =>
    type === TABLE && typeof value === "object" && value != null && value.__isTable === true,
  Table: TABLE,
  getTableConfig: (t) => t.__config,
};

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("# synthDDL — schema-qualified (system mode)");

const qualified = synthDDL(
  {
    products: fakeTable({
      name: "products",
      schema: "sales",
      columns: [
        col("id", "PgText", { notNull: true, primary: true }),
        col("sku", "PgText", { notNull: true }),
        col("price_amount", "PgNumeric", { notNull: true }),
      ],
    }),
    orderLines: fakeTable({
      name: "order_lines",
      schema: "sales",
      columns: [col("id", "PgText", { notNull: true, primary: true })],
      indexes: [{ config: { name: "order_lines_parent_id_idx", columns: [{ name: "order_id" }] } }],
    }),
  },
  helpers,
);

check("emits CREATE SCHEMA for the pgSchema", () => {
  assert.match(qualified, /CREATE SCHEMA IF NOT EXISTS "sales";/);
});
check("emits the schema before any qualified CREATE TABLE", () => {
  assert.ok(
    qualified.indexOf('CREATE SCHEMA IF NOT EXISTS "sales"') <
      qualified.indexOf('CREATE TABLE IF NOT EXISTS "sales"."products"'),
    "CREATE SCHEMA must precede the qualified CREATE TABLE",
  );
});
check("schema-qualifies the CREATE TABLE", () => {
  assert.match(qualified, /CREATE TABLE IF NOT EXISTS "sales"\."products"/);
});
check("does NOT emit an unqualified products table", () => {
  assert.doesNotMatch(qualified, /CREATE TABLE IF NOT EXISTS "products"/);
});
check("schema-qualifies the CREATE INDEX ON target (not the index name)", () => {
  assert.match(
    qualified,
    /CREATE INDEX IF NOT EXISTS "order_lines_parent_id_idx" ON "sales"\."order_lines"/,
  );
});
check("emits CREATE SCHEMA exactly once per distinct schema", () => {
  const occurrences = qualified.match(/CREATE SCHEMA IF NOT EXISTS "sales"/g) ?? [];
  assert.equal(occurrences.length, 1, `expected 1 CREATE SCHEMA, got ${occurrences.length}`);
});

console.log("# synthDDL — unqualified (legacy single-context)");

const plain = synthDDL(
  {
    products: fakeTable({
      name: "products",
      // schema omitted → public
      columns: [col("id", "PgText", { notNull: true, primary: true })],
    }),
  },
  helpers,
);

check("emits no CREATE SCHEMA when no table declares one", () => {
  assert.doesNotMatch(plain, /CREATE SCHEMA/);
});
check("emits an unqualified CREATE TABLE in public", () => {
  assert.match(plain, /CREATE TABLE IF NOT EXISTS "products"/);
});

const self = path.basename(fileURLToPath(import.meta.url));
if (failures > 0) {
  console.error(`\n# ${self}: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n# all green");
