import { describe, expect, it } from "vitest";

import { emitDotnetMigrations } from "../../../src/generator/dotnet/emit/migrations.js";
import type { MigrationsIR, SchemaSnapshot } from "../../../src/ir/types/migrations-ir.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// .NET migrations emitter — one Migration class per MigrationsIR, plus
// the empty ModelSnapshot stub EF needs at runtime.
// ---------------------------------------------------------------------------

const EMPTY_SNAP: SchemaSnapshot = {
  schemaVersion: 1,
  lastVersion: "20260101000000",
  tables: [],
};

function ir(
  steps: MigrationsIR["steps"],
  opts: { version?: string; name?: string } = {},
): MigrationsIR {
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
  it("emits one Migration class per non-empty MigrationsIR (no ModelSnapshot — Loom owns migrations)", () => {
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
    // Filename / class / [Migration] id are module-qualified ("Sales")
    // so a backend hosting several modules doesn't collide every
    // module's "Initial" onto one file.
    expect(out.has("Migrations/20260101000000_Sales_Initial.cs")).toBe(true);
    // ModelSnapshot is intentionally absent — `dotnet ef migrations add` is
    // never invoked against this project, and `Database.Migrate()` only
    // consults the [Migration] classes + __EFMigrationsHistory at runtime.
    expect(out.has("Migrations/AppDbContextModelSnapshot.cs")).toBe(false);

    const mig = out.get("Migrations/20260101000000_Sales_Initial.cs")!;
    expect(mig).toMatch(/namespace Api\.Migrations/);
    // EF's MigrationsAssembly only discovers Migration subclasses whose
    // [DbContext] attribute matches the context handed to Migrate() —
    // without this attribute Database.Migrate() silently applies nothing
    // (only __EFMigrationsHistory appears; first INSERT dies with 42P01).
    // global:: qualifies from the root namespace — required because some
    // layouts (byFeature, TPH) nest a same-named child namespace, against
    // which a relative `Api.Infrastructure…` would mis-resolve (CS0234).
    expect(mig).toMatch(
      /\[DbContext\(typeof\(global::Api\.Infrastructure\.Persistence\.AppDbContext\)\)\]/,
    );
    expect(mig).toMatch(/using Microsoft\.EntityFrameworkCore\.Infrastructure;/);
    expect(mig).toMatch(/\[Migration\("20260101000000_Sales_Initial"\)\]/);
    expect(mig).toMatch(/public partial class M20260101000000_Sales_Initial : Migration/);
    expect(mig).toMatch(/migrationBuilder\.Sql\(@"CREATE TABLE ""orders"" \(/);
    expect(mig).toMatch(/protected override void Down\(MigrationBuilder migrationBuilder\)/);
  });

  it("schema-qualifies the table, its FK references, and its indexes when the table has a schema", () => {
    const out = new Map<string, string>();
    emitDotnetMigrations(
      [
        ir(
          [
            {
              op: "createTable",
              table: {
                name: "pipelines",
                schema: "catalog",
                ownerModule: "Projects",
                columns: [
                  { name: "id", type: { kind: "uuid" }, nullable: false },
                  { name: "project_id", type: { kind: "uuid" }, nullable: false },
                ],
                primaryKey: ["id"],
                foreignKeys: [{ column: "project_id", refTable: "projects", onDelete: "cascade" }],
                indexes: [
                  {
                    name: "pipelines_project_id_idx",
                    table: "pipelines",
                    columns: ["project_id"],
                    unique: false,
                  },
                ],
              },
            },
          ],
          { version: "20260101000000", name: "Initial" },
        ),
      ],
      "Api",
      out,
    );
    const mig = out.get("Migrations/20260101000000_Sales_Initial.cs")!;
    // The context's schema is created first, then every relation is
    // schema-qualified so EF's `ToTable("pipelines","catalog")` mapping
    // finds the table it queries at runtime.
    expect(mig).toContain('CREATE SCHEMA IF NOT EXISTS ""catalog"";');
    expect(mig).toContain('CREATE TABLE ""catalog"".""pipelines"" (');
    expect(mig).toContain('REFERENCES ""catalog"".""projects""');
    expect(mig).toContain('ON ""catalog"".""pipelines"" (""project_id"")');
  });

  it("skips empty-step migrations entirely", () => {
    const out = new Map<string, string>();
    emitDotnetMigrations([ir([], { name: "NoOp" })], "Api", out);
    expect(out.size).toBe(0);
  });

  it("a migrations-bearing deployable migrates at startup and never calls EnsureCreated", async () => {
    // Mixing Migrate() with EnsureCreated() is the classic EF trap:
    // whichever runs first creates *a* table, the other sees a non-empty
    // database and no-ops — so a Migrate() that discovered zero migrations
    // (the missing-[DbContext] bug) left __EFMigrationsHistory behind and
    // EnsureCreated() then silently skipped creating the entity tables.
    const { model, errors } = await parseString(`system Mig {
      subdomain Shop {
        context Catalog {
          aggregate Product with crudish { sku: string derived display: string = sku }
          repository Products for Product { }
        }
      }
      storage db { type: postgres }
      resource catalogState { for: Catalog, kind: state, use: db }
      deployable api { platform: dotnet contexts: [Catalog] dataSources: [catalogState] port: 8080 }
    }`);
    if (errors.length) throw new Error(errors.join("\n"));
    const files = generateSystems(model).files;
    const program = [...files.entries()].find(([k]) => /api\/Program\.cs$/.test(k))?.[1];
    expect(program, "Program.cs missing").toBeDefined();
    expect(program).toContain("db.Database.Migrate()");
    expect(program).not.toContain("EnsureCreated");

    // And the migration class itself is discoverable by that Migrate() call.
    const mig = [...files.entries()].find(([k]) => /api\/Migrations\/.*\.cs$/.test(k))?.[1];
    expect(mig, "migration class missing").toBeDefined();
    expect(mig).toContain(
      "[DbContext(typeof(global::Api.Infrastructure.Persistence.AppDbContext))]",
    );
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
    // The identifier is `"`-quoted (embedded `"` doubled per Postgres) and
    // then EACH `"` doubles again inside the C# `@"..."` verbatim literal.
    expect(body).toContain('DROP TABLE ""has""""quote"";');
  });
});
