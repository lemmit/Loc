import type {
  BoundedContextIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
import { snake } from "../../../util/naming.js";
import { renderPgStep } from "../../sql-pg.js";
import { contextsHaveAudit } from "./audit.js";
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

// A version far in the future so this migration sorts after every module's
// initial + delta migrations (parity with the provenance migration's
// `29991231000000`).  `_1` keeps it distinct from the provenance tag.
const AUDIT_MIGRATION_TAG = "29991231000001_audit";

/** The LATE audit migration (audit-and-logging.md): hand-emitted — audit is
 *  NOT in the shared MigrationsIR.  Creates `audit_records`.  The version sorts
 *  after every module migration.  No-op (byte-identical) when no aggregate
 *  declares an `audited` operation.  Each statement is one breakpoint chunk
 *  (asyncpg runs one statement per call). */
export function emitPythonAuditMigration(
  contexts: EnrichedBoundedContextIR[],
  out: Map<string, string>,
): void {
  if (!contextsHaveAudit(contexts)) return;
  const statements: string[] = [];
  statements.push(
    [
      "CREATE TABLE IF NOT EXISTS audit_records (",
      "  audit_id text PRIMARY KEY,",
      "  operation_id text NOT NULL,",
      "  action text NOT NULL,",
      "  target_type text NOT NULL,",
      "  target_id text NOT NULL,",
      "  actor jsonb,",
      "  before jsonb NOT NULL,",
      "  after jsonb NOT NULL,",
      "  at timestamptz NOT NULL,",
      "  status text NOT NULL,",
      "  correlation_id text,",
      "  scope_id text,",
      "  parent_id text",
      ");",
    ].join("\n"),
  );
  statements.push(
    "CREATE INDEX IF NOT EXISTS audit_records_target_idx ON audit_records (target_type, target_id);",
  );
  statements.push(
    "CREATE INDEX IF NOT EXISTS audit_records_correlation_idx ON audit_records (correlation_id);",
  );
  out.set(
    `migrations/${AUDIT_MIGRATION_TAG}.sql`,
    `${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`,
  );
}

export const MIGRATE_PY = `"""Boot-time migration runner.  Auto-generated.

Applies pending SQL files from migrations/ in filename order, tracking
applied tags in __loom_migrations (the Drizzle-runtime-migrator
pattern).  Out of band: \`python -m app.db.migrate\`.
"""

import asyncio
import time
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.engine import engine
from app.obs.log import log

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
        pending = [f for f in files if f.stem not in applied]
        # Catalog migration-lifecycle events (observability.md) — same
        # event names + level Hono/.NET emit so a cross-backend log
        # consumer pivots on one identity.
        log("info", "migrations_starting", count=len(pending))
        count = 0
        for f in pending:
            tag = f.stem
            started = time.monotonic()
            try:
                for statement in f.read_text().split(_BREAKPOINT):
                    stmt = statement.strip()
                    if stmt:
                        await conn.execute(text(stmt))
                await conn.execute(
                    text("INSERT INTO __loom_migrations (tag) VALUES (:tag)"), {"tag": tag}
                )
            except Exception as exc:  # noqa: BLE001 — log + re-raise to abort boot
                log("error", "migration_failed", id=tag, name=tag, error=str(exc))
                raise
            count += 1
            log(
                "info",
                "migration_applied",
                id=tag,
                name=tag,
                duration_ms=round((time.monotonic() - started) * 1000, 3),
            )
        log("info", "migrations_complete", applied=count)


if __name__ == "__main__":
    asyncio.run(run_migrations())
`;
