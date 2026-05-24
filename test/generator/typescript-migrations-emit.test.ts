import { describe, expect, it } from "vitest";

import { emitTypescriptMigrations } from "../../src/generator/typescript/emit/migrations.js";
import type { MigrationsIR, SchemaSnapshot } from "../../src/ir/migrations-ir.js";

// ---------------------------------------------------------------------------
// TS/Hono migrations emitter — covers the db/migrations/<version>_<name>.sql
// + db/migrate.ts files emitted into a Hono deployable.
// ---------------------------------------------------------------------------

const EMPTY_SNAP: SchemaSnapshot = {
  schemaVersion: 1,
  lastVersion: "20260101000000",
  tables: [],
};

function ir(steps: MigrationsIR["steps"], opts: { version?: string; name?: string } = {}): MigrationsIR {
  return {
    module: "Sales",
    storageName: "",
    baseline: EMPTY_SNAP,
    next: EMPTY_SNAP,
    steps,
    version: opts.version ?? "20260101000001",
    name: opts.name ?? "AddSomething",
  };
}

describe("typescript migrations emitter", () => {
  it("emits one .sql file per non-empty MigrationsIR + co-emits db/migrate.ts", () => {
    const out = new Map<string, string>();
    emitTypescriptMigrations(
      [
        ir(
          [
            {
              op: "createTable",
              table: {
                name: "orders",
                ownerModule: "Sales",
                columns: [
                  { name: "id", type: { kind: "uuid" }, nullable: false },
                  { name: "total", type: { kind: "int" }, nullable: false },
                ],
                primaryKey: ["id"],
                foreignKeys: [],
                indexes: [],
              },
            },
          ],
          { version: "20260101000000", name: "Initial" },
        ),
      ],
      out,
    );
    expect(out.has("db/migrations/20260101000000_initial.sql")).toBe(true);
    expect(out.has("db/migrate.ts")).toBe(true);

    const sql = out.get("db/migrations/20260101000000_initial.sql")!;
    expect(sql).toMatch(/CREATE TABLE orders \(/);
    expect(sql).toMatch(/id UUID NOT NULL/);
    expect(sql).toMatch(/total INTEGER NOT NULL/);
    expect(sql).toMatch(/PRIMARY KEY \(id\)/);
  });

  it("skips empty-step migrations entirely (no .sql, no migrate.ts)", () => {
    const out = new Map<string, string>();
    emitTypescriptMigrations([ir([], { name: "NoOp" })], out);
    expect(out.size).toBe(0);
  });

  it("renders ALTER TABLE for addColumn / dropColumn", () => {
    const out = new Map<string, string>();
    emitTypescriptMigrations(
      [
        ir(
          [
            {
              op: "addColumn",
              table: "orders",
              column: { name: "note", type: { kind: "text" }, nullable: true },
            },
            { op: "dropColumn", table: "orders", name: "legacy" },
          ],
          { version: "20260101000005", name: "Tweak" },
        ),
      ],
      out,
    );
    const sql = out.get("db/migrations/20260101000005_tweak.sql")!;
    expect(sql).toMatch(/ALTER TABLE orders ADD COLUMN note TEXT NULL;/);
    expect(sql).toMatch(/ALTER TABLE orders DROP COLUMN legacy;/);
  });

  it("renders FOREIGN KEY constraints inline on createTable", () => {
    const out = new Map<string, string>();
    emitTypescriptMigrations(
      [
        ir(
          [
            {
              op: "createTable",
              table: {
                name: "orders",
                ownerModule: "Sales",
                columns: [
                  { name: "id", type: { kind: "uuid" }, nullable: false },
                  { name: "customer", type: { kind: "uuid" }, nullable: false },
                ],
                primaryKey: ["id"],
                foreignKeys: [
                  { column: "customer", refTable: "customers", onDelete: "restrict" },
                ],
                indexes: [
                  {
                    name: "orders_customer_idx",
                    table: "orders",
                    columns: ["customer"],
                    unique: false,
                  },
                ],
              },
            },
          ],
          { version: "20260101000000", name: "Initial" },
        ),
      ],
      out,
    );
    const sql = out.get("db/migrations/20260101000000_initial.sql")!;
    expect(sql).toMatch(
      /FOREIGN KEY \(customer\) REFERENCES customers ON DELETE RESTRICT/,
    );
    expect(sql).toMatch(/CREATE INDEX orders_customer_idx ON orders \(customer\);/);
  });

  it("migrate.ts script tracks state in a loom_migrations table", () => {
    const out = new Map<string, string>();
    emitTypescriptMigrations([ir([{ op: "dropTable", name: "x" }])], out);
    const script = out.get("db/migrate.ts")!;
    expect(script).toMatch(/CREATE TABLE IF NOT EXISTS loom_migrations/);
    expect(script).toMatch(/SELECT version FROM loom_migrations/);
    expect(script).toMatch(/INSERT INTO loom_migrations \(version\)/);
    expect(script).toMatch(/export async function runMigrations/);
  });
});
