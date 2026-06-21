import type { BoundedContextIR, SystemIR } from "../../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
import { snake } from "../../../util/naming.js";
import { renderPgStep } from "../../sql-pg.js";
import {
  provenancedAggregates,
  provenanceMigrationTag,
  renderPyProvenanceMigration,
} from "./provenance.js";

// ---------------------------------------------------------------------------
// Python migration emitter — the Drizzle-runtime-migrator pattern with
// the shared Postgres DDL renderer (`sql-pg.ts`, bit-identical with
// Hono/.NET):
//
//   migrations/<version>_<module>_<name>.sql   one per MigrationsIR
//   app/db/migrate.py                          boot-time runner (emitted
//                                              by the orchestrator)
//
// Statements are separated by the `--> statement-breakpoint` sentinel.
// Unlike node-postgres, asyncpg can't run multi-statement strings, so
// each step's rendered SQL is ALSO split into individual statements at
// generation time — every breakpoint chunk is exactly one statement.
//
// Application: `run_migrations()` (called from the FastAPI lifespan)
// creates a `__loom_migrations` tracking table, applies pending files
// in filename order, records each tag.  Out of band:
// `python -m app.db.migrate`.
// ---------------------------------------------------------------------------

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** Same module-qualified tag the Hono emitter uses — modules sharing a
 *  deployable all emit an "Initial" at the same base version, so the
 *  module keeps the filenames distinct. */
function migrationTag(version: string, module: string, name: string): string {
  return `${version}_${snake(module)}_${snake(name)}`;
}

/** Split one rendered step into single statements (asyncpg executes one
 *  statement per call).  The DDL is loom-rendered, so a `;` at end of
 *  line is always a statement boundary. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n|;\s*$/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`);
}

export function emitPythonMigrations(migrations: MigrationsIR[], out: Map<string, string>): void {
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    const tag = migrationTag(m.version, m.module, m.name);
    const statements = m.steps.flatMap((s) => splitStatements(renderPgStep(s)));
    out.set(`migrations/${tag}.sql`, `${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`);
  }
}

/** The LATE provenance migration (provenance.md): hand-emitted — provenance is
 *  NOT in the shared MigrationsIR.  Adds the co-located `<field>_provenance`
 *  jsonb column per provenanced table + creates `provenance_records`.  The
 *  version sorts after every module migration, so the columns/table land last.
 *  No-op (byte-identical) when no aggregate declares a provenanced field. */
export function emitPythonProvenanceMigration(
  contexts: BoundedContextIR[],
  out: Map<string, string>,
  sys?: SystemIR,
): void {
  const provAggs = provenancedAggregates(contexts, sys);
  if (provAggs.length === 0) return;
  out.set(`migrations/${provenanceMigrationTag()}.sql`, renderPyProvenanceMigration(provAggs));
}

export const MIGRATE_PY = `"""Boot-time migration runner.  Auto-generated.

Applies pending SQL files from migrations/ in filename order, tracking
applied tags in __loom_migrations (the Drizzle-runtime-migrator
pattern).  Out of band: \`python -m app.db.migrate\`.
"""

import asyncio
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.engine import engine

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "migrations"

_BREAKPOINT = "--> statement-breakpoint"


async def run_migrations(target: AsyncEngine = engine) -> None:
    files = sorted(MIGRATIONS_DIR.glob("*.sql")) if MIGRATIONS_DIR.is_dir() else []
    if not files:
        return
    async with target.begin() as conn:
        await conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS __loom_migrations ("
                "tag TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )
        )
        rows = (await conn.execute(text("SELECT tag FROM __loom_migrations"))).all()
        applied = {row[0] for row in rows}
        for f in files:
            tag = f.stem
            if tag in applied:
                continue
            for statement in f.read_text().split(_BREAKPOINT):
                stmt = statement.strip()
                if stmt:
                    await conn.execute(text(stmt))
            await conn.execute(
                text("INSERT INTO __loom_migrations (tag) VALUES (:tag)"), {"tag": tag}
            )


if __name__ == "__main__":
    asyncio.run(run_migrations())
`;
