import type { MigrationsIR } from "../../../ir/migrations-ir.js";
import { renderPgStep } from "../../../system/sql-pg.js";
import { upperFirst } from "../../../util/naming.js";

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
// Two artefacts beyond the per-migration .cs file:
//   - `Migrations/AppDbContextModelSnapshot.cs` — empty model snapshot
//     stub.  EF requires its presence to reconcile state at runtime;
//     keeping it empty (no model entries) means EF can't compute a diff
//     against the current DbContext and would emit
//     `PendingModelChangesWarning` on every startup.  That warning is
//     suppressed in Program.cs's `AddDbContext` configuration.
// ---------------------------------------------------------------------------

export function emitDotnetMigrations(
  migrations: MigrationsIR[],
  ns: string,
  out: Map<string, string>,
): void {
  let anyEmitted = false;
  for (const m of migrations) {
    if (m.steps.length === 0) continue;
    const className = `M${m.version}_${upperFirst(m.name)}`;
    const migrationId = `${m.version}_${upperFirst(m.name)}`;
    const sql = m.steps.map(renderPgStep).join("\n\n");
    out.set(
      `Migrations/${m.version}_${upperFirst(m.name)}.cs`,
      renderMigrationClass(ns, className, migrationId, sql),
    );
    anyEmitted = true;
  }
  if (anyEmitted) {
    out.set("Migrations/AppDbContextModelSnapshot.cs", renderModelSnapshot(ns));
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
using Microsoft.EntityFrameworkCore.Migrations;

namespace ${ns}.Migrations
{
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

function renderModelSnapshot(ns: string): string {
  return `// Auto-generated.  Empty ModelSnapshot stub — EF requires the file's
// presence to construct a migrator at runtime, but every entry is
// intentionally omitted so the generator owns the schema source of
// truth.  Program.cs suppresses the resulting PendingModelChangesWarning
// in its DbContextOptionsBuilder.
using Microsoft.EntityFrameworkCore.Infrastructure;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Migrations
{
    [Microsoft.EntityFrameworkCore.Infrastructure.DbContextAttribute(typeof(AppDbContext))]
    partial class AppDbContextModelSnapshot : ModelSnapshot
    {
        protected override void BuildModel(Microsoft.EntityFrameworkCore.ModelBuilder modelBuilder)
        {
            // intentionally empty
        }
    }
}
`;
}
