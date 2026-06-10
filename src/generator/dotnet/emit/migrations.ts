import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
import { upperFirst } from "../../../util/naming.js";
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
