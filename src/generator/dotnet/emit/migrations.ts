import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
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
    const className = `M${m.version}_${upperFirst(m.name)}`;
    const migrationId = `${m.version}_${upperFirst(m.name)}`;
    const sql = m.steps.map(renderPgStep).join("\n\n");
    out.set(
      `Migrations/${m.version}_${upperFirst(m.name)}.cs`,
      renderMigrationClass(ns, className, migrationId, sql),
    );
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
