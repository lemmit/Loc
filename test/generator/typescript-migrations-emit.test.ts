import { describe, expect, it } from "vitest";

import { emitTypescriptMigrations } from "../../src/generator/typescript/emit/migrations.js";
import type {
  MigrationHistoryEntry,
  MigrationsIR,
  SchemaSnapshot,
} from "../../src/ir/migrations-ir.js";

// ---------------------------------------------------------------------------
// TS/Hono migrations emitter — emits Drizzle-format `<tag>.sql` files
// with `--> statement-breakpoint` separators + a `meta/_journal.json`
// index that both `drizzle-kit migrate` and Drizzle's runtime migrator
// (`drizzle-orm/.../migrator`) consume.
// ---------------------------------------------------------------------------

function snap(history: MigrationHistoryEntry[] = [], lastVersion?: string): SchemaSnapshot {
  return {
    schemaVersion: 1,
    lastVersion,
    migrationHistory: history.length > 0 ? history : undefined,
    tables: [],
  };
}

function ir(
  steps: MigrationsIR["steps"],
  opts: { version?: string; name?: string; history?: MigrationHistoryEntry[] } = {},
): MigrationsIR {
  const version = opts.version ?? "20260101000001";
  const name = opts.name ?? "AddSomething";
  return {
    module: "Sales",
    storageName: "",
    baseline: snap(),
    next: snap([...(opts.history ?? []), { version, name }], version),
    steps,
    version,
    name,
  };
}

describe("typescript migrations emitter", () => {
  it("emits one .sql file per non-empty MigrationsIR with statement-breakpoint separators", () => {
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
            { op: "dropTable", name: "legacy" },
          ],
          { version: "20260101000000", name: "Initial" },
        ),
      ],
      out,
    );
    expect(out.has("db/migrations/20260101000000_initial.sql")).toBe(true);
    const sql = out.get("db/migrations/20260101000000_initial.sql")!;
    expect(sql).toMatch(/CREATE TABLE orders \(/);
    expect(sql).toMatch(/PRIMARY KEY \(id\)/);
    // Drizzle splits on the sentinel — both statements need to be
    // visible as separate chunks.
    expect(sql).toContain("--> statement-breakpoint");
    expect(sql.indexOf("DROP TABLE")).toBeGreaterThan(sql.indexOf("--> statement-breakpoint"));
  });

  it("emits a Drizzle-format meta/_journal.json from the snapshot's migration history", () => {
    const out = new Map<string, string>();
    emitTypescriptMigrations(
      [
        ir([{ op: "dropTable", name: "x" }], {
          version: "20260101000005",
          name: "DropX",
          history: [{ version: "20260101000000", name: "Initial" }],
        }),
      ],
      out,
    );
    expect(out.has("db/migrations/meta/_journal.json")).toBe(true);
    const journal = JSON.parse(out.get("db/migrations/meta/_journal.json")!);
    expect(journal).toMatchObject({
      version: "7",
      dialect: "postgresql",
    });
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[0]).toMatchObject({
      idx: 0,
      tag: "20260101000000_initial",
      breakpoints: true,
    });
    expect(journal.entries[1]).toMatchObject({
      idx: 1,
      tag: "20260101000005_drop_x",
      breakpoints: true,
    });
    // `when` is derived from the version slug (epoch-millis).
    expect(typeof journal.entries[0].when).toBe("number");
    expect(journal.entries[0].when).toBeLessThan(journal.entries[1].when);
  });

  it("skips empty-step migrations entirely (no .sql, no journal)", () => {
    const out = new Map<string, string>();
    emitTypescriptMigrations(
      [
        {
          module: "Sales",
          storageName: "",
          baseline: snap(),
          next: snap(),
          steps: [],
          version: "20260101000001",
          name: "NoOp",
        },
      ],
      out,
    );
    expect(out.size).toBe(0);
  });

  it("dedupes multi-module history entries by version", () => {
    const out = new Map<string, string>();
    // Two modules, both with an "Initial" entry sharing the BASE
    // version — journal must list it once.
    const shared: MigrationHistoryEntry = { version: "20260101000000", name: "Initial" };
    emitTypescriptMigrations(
      [
        {
          ...ir([{ op: "dropTable", name: "a" }], { version: "20260101000001" }),
          module: "ModuleA",
          next: snap([shared, { version: "20260101000001", name: "AddSomething" }]),
        },
        {
          ...ir([{ op: "dropTable", name: "b" }], { version: "20260101000002" }),
          module: "ModuleB",
          next: snap([shared, { version: "20260101000002", name: "AddSomething" }]),
        },
      ],
      out,
    );
    const journal = JSON.parse(out.get("db/migrations/meta/_journal.json")!);
    expect(journal.entries.map((e: { version: string; tag: string }) => e.tag)).toEqual([
      "20260101000000_initial",
      "20260101000001_add_something",
      "20260101000002_add_something",
    ]);
  });
});
