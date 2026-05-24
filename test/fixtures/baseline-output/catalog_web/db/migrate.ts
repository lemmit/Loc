// Auto-generated.  Runs every .sql file in this directory in
// lexicographic order, recording which have been applied in a
// `loom_migrations` tracking table.  Idempotent — running twice
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS loom_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      );
    `);
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
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

// Allow direct invocation: `npm run db:migrate` invokes `tsx db/migrate.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
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
