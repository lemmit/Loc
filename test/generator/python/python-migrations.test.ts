import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — migrations (plan S9): MigrationsIR → breakpoint-
// separated SQL files over the shared sql-pg renderer (bit-identical
// DDL with Hono/.NET) + the tracked boot-time runner (the Drizzle-
// runtime-migrator pattern; asyncpg runs one statement per chunk, so
// each breakpoint chunk is exactly one statement).  Verified live: a
// fresh Postgres migrates, re-running no-ops, repositories round-trip
// against the migrated schema-qualified UUID tables.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/domain.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python migrations", () => {
  it("emits the initial migration with module-qualified tag + one statement per chunk", async () => {
    const files = await build();
    const sqlPath = [...files.keys()].find((k) =>
      /api\/migrations\/.*_sales_initial\.sql$/.test(k),
    );
    expect(sqlPath, "initial migration missing").toBeTruthy();
    const sql = files.get(sqlPath!)!;
    expect(sql).toContain("CREATE TABLE sales.orders (");
    expect(sql).toContain("--> statement-breakpoint");
    // Every chunk is a single statement (asyncpg constraint).
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const semis = chunk.trim().match(/;/g) ?? [];
      expect(semis.length).toBeLessThanOrEqual(1);
    }
  });

  it("ships the tracked boot-time runner wired into the lifespan", async () => {
    const files = await build();
    const migrate = files.get("api/app/db/migrate.py")!;
    expect(migrate).toContain("CREATE TABLE IF NOT EXISTS __loom_migrations");
    expect(migrate).toContain("split(_BREAKPOINT)");
    expect(migrate).toContain('if __name__ == "__main__":');
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("await run_migrations()");
    expect(main).toContain("lifespan=lifespan");
    const docker = files.get("api/Dockerfile")!;
    expect(docker).toContain("COPY migrations/ ./migrations/");
  });

  it("SQLAlchemy models live where the DDL puts them (schema-qualified, uuid ids)", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain('{"schema": "sales"},');
    expect(schema).toContain(
      "id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)",
    );
  });
});
