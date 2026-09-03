import { describe, expect, it } from "vitest";
import type { EvolutionOk, MigrationView } from "../../web/src/build/protocol.js";
import { destructiveDrops, tintCounts, tintTables } from "../../web/src/layout/migration-tint.js";

// The Migrations tab's diagram tint (M-T8.22 slice 1, audit M8): the pure
// `EvolutionResult → per-table tint` map the panel renders beside the SQL.

const base = (over: Partial<EvolutionOk>): EvolutionOk => ({
  ok: true,
  hasBaseline: true,
  migrations: [],
  tables: [
    { module: "sales", name: "products", columns: ["id", "sku", "name"], refs: [] },
    { module: "sales", name: "orders", columns: ["id", "customer_id"], refs: ["customers"] },
    { module: "sales", name: "customers", columns: ["id", "email"], refs: [] },
  ],
  wireChanges: [],
  breaking: false,
  diagnostics: [],
  ...over,
});

const mig = (steps: MigrationView["steps"], destructive = false): MigrationView => ({
  module: "sales",
  name: "Change",
  version: "1",
  steps,
  destructive,
});

describe("tintTables", () => {
  it("returns nothing for a missing or failed diff", () => {
    expect(tintTables(null)).toEqual([]);
    expect(tintTables({ ok: false, diagnostics: [] })).toEqual([]);
  });

  it("dims every table when the migration is empty", () => {
    const rows = tintTables(base({}));
    expect(rows.map((r) => [r.name, r.tint])).toEqual([
      ["products", "untouched"],
      ["orders", "untouched"],
      ["customers", "untouched"],
    ]);
    expect(tintCounts(rows)).toEqual({ added: 0, changed: 0, removed: 0, untouched: 3 });
  });

  it("greens a created table, ambers a touched one, keeps the rest dimmed", () => {
    const e = base({
      tables: [
        ...base({}).tables,
        { module: "sales", name: "invoices", columns: ["id", "total"], refs: ["orders"] },
      ],
      migrations: [
        mig([
          { op: "createTable", sql: 'CREATE TABLE "sales"."invoices" (...);', table: "invoices" },
          {
            op: "addColumn",
            sql: 'ALTER TABLE "sales"."customers" ADD COLUMN "phone" TEXT;',
            table: "customers",
          },
        ]),
      ],
    });
    const rows = tintTables(e);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.invoices!.tint).toBe("added");
    expect(by.customers!.tint).toBe("changed");
    expect(by.customers!.changedColumns).toEqual(["phone"]);
    expect(by.products!.tint).toBe("untouched");
    expect(by.orders!.tint).toBe("untouched");
    expect(tintCounts(rows)).toEqual({ added: 1, changed: 1, removed: 0, untouched: 2 });
  });

  it("recovers a dropped table from the dropTable step (it is gone from the schema)", () => {
    const e = base({
      tables: base({}).tables.filter((t) => t.name !== "customers"),
      migrations: [
        mig(
          [{ op: "dropTable", sql: 'DROP TABLE "sales"."customers";', table: "customers" }],
          true,
        ),
      ],
    });
    const rows = tintTables(e);
    const dropped = rows.find((r) => r.name === "customers");
    expect(dropped?.tint).toBe("removed");
    expect(dropped?.columns).toEqual([]);
    // Dropped tables come after the live schema, so the layout is stable.
    expect(rows.at(-1)?.name).toBe("customers");
  });

  it("a created table stays green even when later steps also touch it", () => {
    const e = base({
      tables: [{ module: "sales", name: "notes", columns: ["id", "body"], refs: [] }],
      migrations: [
        mig([
          { op: "createTable", sql: "CREATE TABLE notes (...);", table: "notes" },
          { op: "addIndex", sql: 'CREATE INDEX "notes_body_idx" ON notes (body);', table: "notes" },
        ]),
      ],
    });
    expect(tintTables(e)[0]?.tint).toBe("added");
    expect(tintTables(e)[0]?.ops).toEqual(["createTable", "addIndex"]);
  });

  it("reads renamed / altered column names out of the SQL for the highlight", () => {
    const e = base({
      migrations: [
        mig([
          {
            op: "renameColumn",
            sql: 'ALTER TABLE "sales"."products" RENAME COLUMN "name" TO "title";',
            table: "products",
          },
          {
            op: "alterColumnNullable",
            sql: 'ALTER TABLE "sales"."products" ALTER COLUMN "sku" SET NOT NULL;',
            table: "products",
          },
          { op: "sqlComment", sql: "-- backfill here" },
        ]),
      ],
    });
    const products = tintTables(e).find((r) => r.name === "products")!;
    expect(products.tint).toBe("changed");
    expect(products.changedColumns).toEqual(["name", "title", "sku"]);
  });
});

describe("destructiveDrops", () => {
  it("names the table and column data a destructive migration would drop", () => {
    const m = mig(
      [
        { op: "dropTable", sql: 'DROP TABLE "sales"."customers";', table: "customers" },
        {
          op: "dropColumn",
          sql: 'ALTER TABLE "sales"."orders" DROP COLUMN "note";',
          table: "orders",
        },
        {
          op: "alterColumnType",
          sql: 'ALTER TABLE "sales"."orders" ALTER COLUMN "qty" TYPE INTEGER;',
          table: "orders",
        },
        {
          op: "addColumn",
          sql: 'ALTER TABLE "sales"."orders" ADD COLUMN "x" TEXT;',
          table: "orders",
        },
      ],
      true,
    );
    expect(destructiveDrops(m)).toEqual([
      "table customers (every row)",
      "column orders.note",
      "values of orders.qty that do not fit the new type",
    ]);
  });

  it("is empty for a purely additive migration", () => {
    expect(
      destructiveDrops(
        mig([{ op: "addColumn", sql: "ALTER TABLE t ADD COLUMN c TEXT;", table: "t" }]),
      ),
    ).toEqual([]);
  });
});
