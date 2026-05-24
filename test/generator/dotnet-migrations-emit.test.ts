import { describe, expect, it } from "vitest";

import { emitDotnetMigrations } from "../../src/generator/dotnet/emit/migrations.js";
import type { MigrationsIR, SchemaSnapshot } from "../../src/ir/migrations-ir.js";

// ---------------------------------------------------------------------------
// .NET migrations emitter — one Migration class per MigrationsIR, plus
// the empty ModelSnapshot stub EF needs at runtime.
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

describe("dotnet migrations emitter", () => {
  it("emits one Migration class per non-empty MigrationsIR + an empty ModelSnapshot stub", () => {
    const out = new Map<string, string>();
    emitDotnetMigrations(
      [
        ir(
          [
            {
              op: "createTable",
              table: {
                name: "orders",
                ownerModule: "Sales",
                columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
                primaryKey: ["id"],
                foreignKeys: [],
                indexes: [],
              },
            },
          ],
          { version: "20260101000000", name: "Initial" },
        ),
      ],
      "Api",
      out,
    );
    expect(out.has("Migrations/20260101000000_Initial.cs")).toBe(true);
    expect(out.has("Migrations/AppDbContextModelSnapshot.cs")).toBe(true);

    const mig = out.get("Migrations/20260101000000_Initial.cs")!;
    expect(mig).toMatch(/namespace Api\.Migrations/);
    expect(mig).toMatch(/\[Migration\("20260101000000_Initial"\)\]/);
    expect(mig).toMatch(/public partial class M20260101000000_Initial : Migration/);
    expect(mig).toMatch(/migrationBuilder\.Sql\(@"CREATE TABLE orders \(/);
    expect(mig).toMatch(/protected override void Down\(MigrationBuilder migrationBuilder\)/);
  });

  it("skips empty-step migrations entirely (no .cs, no snapshot)", () => {
    const out = new Map<string, string>();
    emitDotnetMigrations([ir([], { name: "NoOp" })], "Api", out);
    expect(out.size).toBe(0);
  });

  it("renders the ModelSnapshot stub keyed to AppDbContext", () => {
    const out = new Map<string, string>();
    emitDotnetMigrations([ir([{ op: "dropTable", name: "x" }])], "MyApp", out);
    const snap = out.get("Migrations/AppDbContextModelSnapshot.cs")!;
    expect(snap).toMatch(/namespace MyApp\.Migrations/);
    expect(snap).toMatch(/DbContextAttribute\(typeof\(AppDbContext\)\)/);
    expect(snap).toMatch(/partial class AppDbContextModelSnapshot : ModelSnapshot/);
    expect(snap).toMatch(/intentionally empty/);
  });

  it("escapes embedded double-quotes in SQL for the verbatim string literal", () => {
    // SQL bodies emitted by renderPgStep don't contain `"` today, but the
    // escape path is defensive — verify it survives if a future step renders one.
    const out = new Map<string, string>();
    emitDotnetMigrations(
      [
        {
          ...ir([{ op: "dropTable", name: 'has"quote' }]),
        },
      ],
      "Api",
      out,
    );
    const path = [...out.keys()].find((k) => k.endsWith(".cs") && !k.includes("Snapshot"))!;
    const body = out.get(path)!;
    // Original `"` in identifier doubles to `""` inside @"...".
    expect(body).toContain('DROP TABLE has""quote;');
  });
});
