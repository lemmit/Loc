import { describe, expect, it } from "vitest";

import { emitTypescriptMigrations } from "../../../src/generator/typescript/emit/migrations.js";
import type {
  MigrationHistoryEntry,
  MigrationsIR,
  SchemaSnapshot,
} from "../../../src/ir/types/migrations-ir.js";

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
    // The tag is module-qualified ("sales") so a backend hosting several
    // modules doesn't collide every module's "Initial" onto one file.
    expect(out.has("db/migrations/20260101000000_sales_initial.sql")).toBe(true);
    const sql = out.get("db/migrations/20260101000000_sales_initial.sql")!;
    expect(sql).toMatch(/CREATE TABLE "orders" \(/);
    expect(sql).toMatch(/PRIMARY KEY \("id"\)/);
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
      tag: "20260101000000_sales_initial",
      breakpoints: true,
    });
    expect(journal.entries[1]).toMatchObject({
      idx: 1,
      tag: "20260101000005_sales_drop_x",
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

  it("keeps multi-module history entries distinct (module-qualified, no cross-module version dedup)", () => {
    const out = new Map<string, string>();
    // Two modules in one deployable, each with its own "Initial" at the
    // shared BASE version.  De-duping by version alone (the old bug)
    // would collapse both Initials into one tag and lose a module's
    // tables.  Qualifying the tag with the module keeps them distinct.
    const initial: MigrationHistoryEntry = { version: "20260101000000", name: "Initial" };
    emitTypescriptMigrations(
      [
        {
          ...ir([{ op: "dropTable", name: "a" }], { version: "20260101000001" }),
          module: "ModuleA",
          next: snap([initial, { version: "20260101000001", name: "AddSomething" }]),
        },
        {
          ...ir([{ op: "dropTable", name: "b" }], { version: "20260101000002" }),
          module: "ModuleB",
          next: snap([initial, { version: "20260101000002", name: "AddSomething" }]),
        },
      ],
      out,
    );
    const journal = JSON.parse(out.get("db/migrations/meta/_journal.json")!);
    // Sorted by (version, module): both Initials survive, then each
    // module's delta — four entries, none colliding.
    expect(journal.entries.map((e: { version: string; tag: string }) => e.tag)).toEqual([
      "20260101000000_module_a_initial",
      "20260101000000_module_b_initial",
      "20260101000001_module_a_add_something",
      "20260101000002_module_b_add_something",
    ]);
    // `when` must be STRICTLY increasing across entries — the two Initials
    // share a version (same epoch millis).  Drizzle's runtime migrator applies
    // a migration only when `lastApplied.created_at < when`, so a tie silently
    // skips the second Initial (ModuleB's tables never get created).  The
    // per-entry index breaks the tie.
    const whens = journal.entries.map((e: { when: number }) => e.when);
    expect(whens[1]).toBeGreaterThan(whens[0]);
    for (let i = 1; i < whens.length; i++) {
      expect(whens[i]).toBeGreaterThan(whens[i - 1]);
    }
  });
});
