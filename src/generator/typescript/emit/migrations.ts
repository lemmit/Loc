import type { MigrationsIR, SchemaSnapshot } from "../../../ir/types/migrations-ir.js";
import { snake } from "../../../util/naming.js";
import { renderPgStep } from "../../sql-pg.js";

// ---------------------------------------------------------------------------
// Hono / Drizzle migration emitter.
//
// One .sql file per `MigrationsIR.steps`, with statements separated by
// the `--> statement-breakpoint` sentinel Drizzle's runtime migrator
// (`drizzle-orm/node-postgres/migrator`) splits on.  A
// `meta/_journal.json` index lists every migration ever emitted so
// `drizzle-kit migrate` / runtime `migrate()` can apply them in order.
//
// Application:
//   - `npm run db:migrate` → `drizzle-kit migrate` (reads the journal,
//     applies pending migrations against the `__drizzle_migrations`
//     tracking table the runtime creates on first run).
//   - The generated `index.ts` calls `migrate(...)` from
//     `drizzle-orm/node-postgres/migrator` at boot so deployments
//     (`node dist/index.js`) self-heal without a separate pre-start
//     command.
//
// The migration history (which migrations have ever existed) is
// persisted in `SchemaSnapshot.migrationHistory` — the builder
// appends an entry per non-empty regen so the journal can be rebuilt
// without reading the previous one off disk.
// ---------------------------------------------------------------------------

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export function emitTypescriptMigrations(
  migrations: MigrationsIR[],
  out: Map<string, string>,
): void {
  let anyEmitted = false;
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    const tag = `${m.version}_${snake(m.name)}`;
    const sql = m.steps.map(renderPgStep).join(`\n${STATEMENT_BREAKPOINT}\n`);
    out.set(`db/migrations/${tag}.sql`, sql + "\n");
    anyEmitted = true;
  }
  if (!anyEmitted) return;

  // Build the journal from each migration's `next.migrationHistory` —
  // the builder already merged the previous history with any newly
  // appended entry, so this list is complete.  Multiple modules per
  // deployable contribute one combined journal; their entries
  // interleave by version, which is the lexicographic sort order
  // anyway since versions are monotonically increasing.
  const journal = renderJournal(migrations);
  out.set("db/migrations/meta/_journal.json", journal);
}

function renderJournal(migrations: MigrationsIR[]): string {
  const entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[] = [];
  let idx = 0;
  // De-duplicate by version: when two modules in this deployable both
  // produce entries (unlikely in v1 but defensive), the version is the
  // sort key.  Within the same version, name order is stable.
  const merged = mergeHistories(migrations.map((m) => m.next));
  for (const entry of merged) {
    entries.push({
      idx,
      version: "7",
      when: versionToEpochMillis(entry.version),
      tag: `${entry.version}_${snake(entry.name)}`,
      breakpoints: true,
    });
    idx++;
  }
  // Drizzle journal envelope.  Version "7" matches what drizzle-kit
  // 0.30.x emits for the postgresql dialect; if a future drizzle-kit
  // bumps this, the runtime migrator stays compatible (it doesn't read
  // the envelope version) but `drizzle-kit migrate` warns.
  return (
    JSON.stringify(
      {
        version: "7",
        dialect: "postgresql",
        entries,
      },
      null,
      2,
    ) + "\n"
  );
}

function mergeHistories(snapshots: SchemaSnapshot[]): { version: string; name: string }[] {
  const all: { version: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const s of snapshots) {
    for (const entry of s.migrationHistory ?? []) {
      if (seen.has(entry.version)) continue;
      seen.add(entry.version);
      all.push(entry);
    }
  }
  return all.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/** Map a `YYYYMMDDHHMMSS` version slug to epoch millis.  Deterministic;
 *  Drizzle uses `when` only for ordering within a single journal load. */
function versionToEpochMillis(version: string): number {
  if (version.length !== 14) return 0;
  const year = Number(version.slice(0, 4));
  const month = Number(version.slice(4, 6)) - 1;
  const day = Number(version.slice(6, 8));
  const hour = Number(version.slice(8, 10));
  const min = Number(version.slice(10, 12));
  const sec = Number(version.slice(12, 14));
  return Date.UTC(year, month, day, hour, min, sec);
}
