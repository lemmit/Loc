import type { EnrichedBoundedContextIR, SystemIR } from "../../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
import { resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import { plural, snake } from "../../../util/naming.js";
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
  // Additional (version, tag) rows to fold into the journal alongside the
  // platform-neutral migrations — used for the LATE provenance migration
  // (`emitTypescriptProvenanceMigration`), which is hand-emitted outside
  // `MigrationsIR` so it has no `migrationHistory` entry of its own.
  extraHistory: ReadonlyArray<{ version: string; tag: string }> = [],
): void {
  let anyEmitted = false;
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    const tag = migrationTag(m.version, m.module, m.name);
    const sql = m.steps.map(renderPgStep).join(`\n${STATEMENT_BREAKPOINT}\n`);
    out.set(`db/migrations/${tag}.sql`, sql + "\n");
    anyEmitted = true;
  }
  if (!anyEmitted && extraHistory.length === 0) return;

  // Build the journal from each migration's `next.migrationHistory` —
  // the builder already merged the previous history with any newly
  // appended entry, so this list is complete.  Multiple modules per
  // deployable contribute one combined journal; their entries
  // interleave by version, which is the lexicographic sort order
  // anyway since versions are monotonically increasing.
  const journal = renderJournal(migrations, extraHistory);
  out.set("db/migrations/meta/_journal.json", journal);
}

function renderJournal(
  migrations: MigrationsIR[],
  extraHistory: ReadonlyArray<{ version: string; tag: string }> = [],
): string {
  const entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[] = [];
  let idx = 0;
  // One row per (module, history entry) plus any extra (e.g. provenance)
  // rows.  Modules in the same deployable share a version on their initial
  // migration, so rows are keyed on the resolved tag (not bare version) —
  // de-duping by version alone would collapse every module's "Initial" into
  // one entry and drop the rest of the database's tables.  Sort by
  // (version, tag) for a stable, ordered journal that mirrors the emitted
  // `.sql` filenames.
  const rows = migrations
    .flatMap((m) =>
      (m.next.migrationHistory ?? []).map((e) => ({
        version: e.version,
        tag: migrationTag(e.version, m.module, e.name),
      })),
    )
    .concat(extraHistory)
    .sort((a, b) =>
      a.version !== b.version ? (a.version < b.version ? -1 : 1) : a.tag < b.tag ? -1 : 1,
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
      tag: row.tag,
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

// ---------------------------------------------------------------------------
// LATE provenance migration (provenance.md) — the Hono/Drizzle counterpart of
// `emitDotnetProvenanceAuditMigration` / `emitPythonProvenanceMigration` /
// elixir-vanilla's `create_provenance` migration.  Carries the CO-LOCATED
// `<field>_provenance` columns only: they hang off the aggregate tables
// `MigrationsIR` owns, so they must be ALTERed in after those exist, and a
// version far in the future sorts this after every module's initial + delta
// migrations (parity with the `29991231235959` / `29991231000000` siblings)
// regardless of module count.  The `provenance_records` history table is NOT
// created here — it is a shared `MigrationsIR` companion table
// (`provenanceTableShape`), like the outbox and the audit log.
// ---------------------------------------------------------------------------

const PROVENANCE_MIGRATION_VERSION = "29991231000000";

/** The LATE migration's tag (sorts after every module migration). */
export function provenanceMigrationTag(): string {
  return `${PROVENANCE_MIGRATION_VERSION}_provenance`;
}

/** Snake-cased name of the co-located backing column for a provenanced field
 *  (`total` → `total_provenance`) — must agree with `schema.ts` /
 *  `aggregate.ts` / the repository builders, which all derive it the same
 *  way. */
function provColumn(fieldName: string): string {
  return `${snake(fieldName)}_provenance`;
}

/** Emit `db/migrations/<version>_provenance.sql`: ADD the co-located
 *  `<field>_provenance` jsonb column per provenanced aggregate table.  No-op
 *  (nothing emitted, `undefined` returned) when no served aggregate declares a
 *  provenanced field. Returns the `(version, tag)` pair so the caller can fold
 *  it into the Drizzle journal — a `.sql` file that's absent from the journal
 *  is never applied by the runtime migrator. */
export function emitTypescriptProvenanceMigration(
  contexts: readonly EnrichedBoundedContextIR[],
  sys: SystemIR | undefined,
  out: Map<string, string>,
): { version: string; tag: string } | undefined {
  const steps: string[] = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      if (agg.isAbstract) continue;
      const fields = agg.fields.filter((f) => f.provenanced);
      if (fields.length === 0) continue;
      const ds = sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined;
      const base = snake(plural(agg.name));
      const table = ds?.tablePrefix ? `${ds.tablePrefix}${base}` : base;
      for (const f of fields) {
        steps.push(
          renderPgStep({
            op: "addColumn",
            table,
            schema: ds?.schema,
            column: { name: provColumn(f.name), type: { kind: "json" }, nullable: true },
          }),
        );
      }
    }
  }
  if (steps.length === 0) return undefined;

  // The `provenance_records` history table itself is NOT emitted here: it moved
  // to the shared MigrationsIR (`provenanceTableShape`), so all five backends
  // derive one definition.  What stays is the per-aggregate half above — the
  // co-located `<field>_provenance` columns, which hang off tables MigrationsIR
  // already owns and so must be ALTERed in after them.
  const tag = provenanceMigrationTag();
  out.set(`db/migrations/${tag}.sql`, `${steps.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`);
  return { version: PROVENANCE_MIGRATION_VERSION, tag };
}
