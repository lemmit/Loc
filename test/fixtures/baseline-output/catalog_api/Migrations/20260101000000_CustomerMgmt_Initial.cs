// Auto-generated.
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CatalogApi.Migrations
{
    // The [DbContext] attribute is REQUIRED for runtime discovery:
    // EF's MigrationsAssembly only surfaces Migration subclasses whose
    // DbContextAttribute matches the context passed to Migrate().
    // Without it, Database.Migrate() finds zero migrations, creates
    // only __EFMigrationsHistory, and every table is silently missing
    // (42P01 at first INSERT/SELECT).
    [DbContext(typeof(CatalogApi.Infrastructure.Persistence.AppDbContext))]
    [Migration("20260101000000_CustomerMgmt_Initial")]
    public partial class M20260101000000_CustomerMgmt_Initial : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE SCHEMA IF NOT EXISTS customers;
CREATE TABLE customers.customers (
  id UUID NOT NULL,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  age INTEGER NOT NULL,
  PRIMARY KEY (id)
);");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // No-op.  Down migrations are best-effort and out of scope
            // for v1 — operators roll forward, not back.
        }
    }
}
