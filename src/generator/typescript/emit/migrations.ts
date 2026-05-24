import type { MigrationsIR } from "../../../ir/migrations-ir.js";
import { renderPgStep } from "../../../system/sql-pg.js";
import { snake } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Hono / Drizzle migration emitter.
//
// One .sql file per `MigrationsIR`, each carrying every step's rendered
// Postgres DDL.  Files are sequenced by `<version>_<snake(name)>.sql`
// so a directory listing sort matches application order.
//
// Migration application is driven by a small co-emitted `db/migrate.ts`
// script — it tracks state in a `loom_migrations` table (one row per
// `version`) so subsequent regens skip already-applied files without
// relying on Drizzle-kit's journal format.  index.ts calls this script
// during boot before serving traffic; the docker container exec path
// hits the same code.
//
// Empty-step migrations are dropped — `buildMigrations` doesn't elide
// them at the IR level (they still carry a snapshot to persist), but
// no .sql file should land for them.
// ---------------------------------------------------------------------------

export function emitTypescriptMigrations(
  migrations: MigrationsIR[],
  out: Map<string, string>,
): void {
  let anyEmitted = false;
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    const name = `${m.version}_${snake(m.name)}`;
    const sql = m.steps.map(renderPgStep).join("\n\n");
    out.set(`db/migrations/${name}.sql`, sql + "\n");
    anyEmitted = true;
  }
  if (anyEmitted) {
    out.set("db/migrate.ts", MIGRATE_TS);
  }
}

// ---------------------------------------------------------------------------
// Migrator script — one row per applied version in `loom_migrations`.
// Imported by index.ts via `await runMigrations()` at boot so the
// schema is current before the server accepts traffic.
// ---------------------------------------------------------------------------

const MIGRATE_TS = `// Auto-generated.  Runs every .sql file in this directory in
// lexicographic order, recording which have been applied in a
// \`loom_migrations\` tracking table.  Idempotent — running twice
// applies nothing on the second invocation.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "migrations");

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(\`
      CREATE TABLE IF NOT EXISTS loom_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      );
    \`);
    const existing = await client.query<{ version: string }>(
      "SELECT version FROM loom_migrations",
    );
    const applied = new Set(existing.rows.map((r) => r.version));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const version = file.split("_")[0]!;
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO loom_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(\`migration \${file} failed: \${(err as Error).message}\`);
      }
    }
  } finally {
    await client.end();
  }
}

// Allow direct invocation: \`npm run db:migrate\` invokes \`tsx db/migrate.ts\`.
if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  runMigrations(url).then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
`;
