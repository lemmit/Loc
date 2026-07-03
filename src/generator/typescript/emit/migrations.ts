import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
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

/** Migration file/journal tag.  Qualified with the module: a backend
 *  that hosts several modules gets one MigrationsIR per module, and
 *  every module's *initial* migration shares `version` (BASE_TIMESTAMP)
 *  and `name` ("Initial").  Without the module both the `.sql` filename
 *  and the journal entry collide, so only the last module's tables are
 *  ever applied and the rest of the database is empty. */
function migrationTag(version: string, module: string, name: string): string {
  return `${version}_${snake(module)}_${snake(name)}`;
}

export function emitTypescriptMigrations(
  migrations: MigrationsIR[],
  out: Map<string, string>,
): void {
  let anyEmitted = false;
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    const tag = migrationTag(m.version, m.module, m.name);
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
  // One row per (module, history entry).  Modules in the same deployable
  // share a version on their initial migration, so the journal must be
  // keyed on the module too — de-duping by version alone would collapse
  // every module's "Initial" into one entry and drop the rest of the
  // database's tables.  Sort by (version, module) for a stable, ordered
  // journal that mirrors the emitted `.sql` filenames.
  const rows = migrations
    .flatMap((m) => (m.next.migrationHistory ?? []).map((e) => ({ ...e, module: m.module })))
    .sort((a, b) =>
      a.version !== b.version
        ? a.version < b.version
          ? -1
          : 1
        : a.module < b.module
          ? -1
          : a.module > b.module
            ? 1
            : 0,
    );
  for (const row of rows) {
    entries.push({
      idx,
      version: "7",
      // `when` must be STRICTLY INCREASING across entries: drizzle's runtime
      // migrator applies a migration only when `lastApplied.created_at < when`
      // (strictly), so any two entries sharing a `when` collapse to one — the
      // second is silently skipped, its tables never created.  Modules in one
      // deployable share a version on their initial migration (all map to the
      // same epoch millis), so add `idx` to break ties.  Since `rows` is sorted
      // by version and `idx` increases by 1 per row, `base + idx` is monotonic.
      when: versionToEpochMillis(row.version) + idx,
      tag: migrationTag(row.version, row.module, row.name),
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

/** Map a `YYYYMMDDHHMMSS` version slug to epoch millis.  Deterministic; the
 *  caller adds the entry index so colliding versions still yield distinct,
 *  strictly-increasing `when` values (drizzle's migrator skips ties). */
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
