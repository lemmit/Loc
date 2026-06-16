import type { EnrichedBoundedContextIR, SystemIR } from "../../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
import { resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { renderPgStep } from "../../sql-pg.js";

// ---------------------------------------------------------------------------
// .NET EF Core migration emitter.
//
// One `Migrations/<Version>_<Name>.cs` class per `MigrationsIR`, each
// invoking `migrationBuilder.Sql(...)` with the rendered Postgres DDL
// from the shared `renderPgStep` helper.  Avoids EF's `dotnet ef
// migrations add` tooling entirely: we own the SQL, so EF only sees the
// migration classes at runtime via `Database.Migrate()` which honours
// the `[Migration("<version>")]` attribute for ordering and writes to
// `__EFMigrationsHistory` as usual.
//
// No `ModelSnapshot` is emitted.  The snapshot is only used by
// `dotnet ef migrations add` to compute diffs against the DbContext —
// since Loom owns migration generation end-to-end, that tooling path
// is never taken, and skipping the snapshot avoids a perpetually
// stale stub.  EF's `PendingModelChangesWarning` is gated on a
// snapshot existing in the migrations assembly; with no snapshot
// class present, the warning has nothing to compare against and
// stays silent (validated via `LOOM_DOTNET_BUILD=1 /warnaserror`).
// ---------------------------------------------------------------------------

export function emitDotnetMigrations(
  migrations: MigrationsIR[],
  ns: string,
  out: Map<string, string>,
): void {
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    // Qualify the migration identity with the module.  A backend that
    // hosts several modules gets one MigrationsIR per module, and every
    // module's *initial* migration shares `version` (BASE_TIMESTAMP) and
    // `name` ("Initial") — so without the module the filename, class
    // name, and `[Migration(id)]` all collide and only the last module's
    // tables survive (the rest of that backend's database is empty →
    // `relation "<schema>.<table>" does not exist` at runtime).
    const slug = `${m.version}_${upperFirst(m.module)}_${upperFirst(m.name)}`;
    const className = `M${slug}`;
    const sql = m.steps.map(renderPgStep).join("\n\n");
    out.set(`Migrations/${slug}.cs`, renderMigrationClass(ns, className, slug, sql));
  }
}

// Provenance / per-operation audit DDL is NOT part of the platform-neutral
// MigrationsIR (it is feature-local, mirroring the Hono Drizzle schema), so the
// .NET backend emits it as one extra migration that sorts AFTER every module's
// initial migration (BASE_TIMESTAMP "2026…").  By then every aggregate table
// exists, so the co-located `<field>_provenance` column ALTERs apply cleanly.
// EF runs the raw SQL via `migrationBuilder.Sql(...)` (no model diff), so the
// DbContext model + this DDL only need to be runtime-consistent.
const PROV_AUDIT_VERSION = "29991231235959";

/** Emit `Migrations/<late>_ProvenanceAudit.cs` when the served contexts use
 *  provenance and/or per-operation audit: CREATE the history/audit tables and
 *  ADD the co-located `<field>_provenance` columns.  No-op (nothing emitted)
 *  when neither feature is present, or on the dapper path (which self-applies
 *  its own DbSchema). */
export function emitDotnetProvenanceAuditMigration(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR | undefined,
  ns: string,
  out: Map<string, string>,
  opts: { provenance: boolean; audit: boolean },
): void {
  const stmts: string[] = [];
  if (opts.provenance) {
    stmts.push(
      [
        "CREATE TABLE IF NOT EXISTS provenance_records (",
        "  trace_id text PRIMARY KEY,",
        "  snapshot_id text NOT NULL,",
        "  target_type text NOT NULL,",
        "  field text NOT NULL,",
        "  inputs jsonb NOT NULL,",
        "  computed_value jsonb,",
        "  at timestamptz NOT NULL,",
        "  correlation_id text,",
        "  scope_id text,",
        "  actor_id text",
        ");",
      ].join("\n"),
    );
    stmts.push(
      "CREATE INDEX IF NOT EXISTS provenance_records_target_idx ON provenance_records (target_type, field);",
    );
    // Co-located current-lineage column per provenanced field, on each owning
    // aggregate's table.  The table is schema-/prefix-qualified the same way
    // efcore.ts `ToTable` derives it from the resolved dataSource binding, so
    // the ALTER hits the real table (e.g. `ordering.orders`), not a bare name.
    for (const ctx of contexts) {
      for (const agg of ctx.aggregates) {
        if (agg.isAbstract) continue;
        const ds = sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined;
        const base = snake(plural(agg.name));
        const local = ds?.tablePrefix ? `${ds.tablePrefix}${base}` : base;
        const table = ds?.schema ? `${ds.schema}.${local}` : local;
        for (const f of agg.fields) {
          if (!f.provenanced) continue;
          stmts.push(
            `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${snake(f.name)}_provenance jsonb;`,
          );
        }
      }
    }
  }
  if (opts.audit) {
    stmts.push(
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
        "  scope_id text",
        ");",
      ].join("\n"),
    );
    stmts.push(
      "CREATE INDEX IF NOT EXISTS audit_records_target_idx ON audit_records (target_type, target_id);",
    );
  }
  if (stmts.length === 0) return;
  const slug = `${PROV_AUDIT_VERSION}_ProvenanceAudit`;
  out.set(`Migrations/${slug}.cs`, renderMigrationClass(ns, `M${slug}`, slug, stmts.join("\n\n")));
}

function renderMigrationClass(
  ns: string,
  className: string,
  migrationId: string,
  sql: string,
): string {
  // C# verbatim string literals: `@"..."` allows multi-line; embedded `"`
  // characters double up to `""`.  Our renderPgStep output has no `"`
  // characters today (Postgres uses single quotes for string literals,
  // and identifiers stay bare), but escape defensively.
  const escaped = sql.replace(/"/g, '""');
  return `// Auto-generated.
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace ${ns}.Migrations
{
    // The [DbContext] attribute is REQUIRED for runtime discovery:
    // EF's MigrationsAssembly only surfaces Migration subclasses whose
    // DbContextAttribute matches the context passed to Migrate().
    // Without it, Database.Migrate() finds zero migrations, creates
    // only __EFMigrationsHistory, and every table is silently missing
    // (42P01 at first INSERT/SELECT).  global:: qualifies from the root
    // namespace: this file's namespace ends in .Migrations and some
    // layouts (byFeature, TPH) nest a same-named child namespace, so a
    // relative reference resolves against the wrong scope (CS0234);
    // global:: sidesteps the ambiguity for every namespace.
    [DbContext(typeof(global::${ns}.Infrastructure.Persistence.AppDbContext))]
    [Migration("${migrationId}")]
    public partial class ${className} : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"${escaped}");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // No-op.  Down migrations are best-effort and out of scope
            // for v1 — operators roll forward, not back.
        }
    }
}
`;
}
