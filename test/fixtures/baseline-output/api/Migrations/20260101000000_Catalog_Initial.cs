// Auto-generated.
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Api.Migrations
{
    // The [DbContext] attribute is REQUIRED for runtime discovery:
    // EF's MigrationsAssembly only surfaces Migration subclasses whose
    // DbContextAttribute matches the context passed to Migrate().
    // Without it, Database.Migrate() finds zero migrations, creates
    // only __EFMigrationsHistory, and every table is silently missing
    // (42P01 at first INSERT/SELECT).
    [DbContext(typeof(Api.Infrastructure.Persistence.AppDbContext))]
    [Migration("20260101000000_Catalog_Initial")]
    public partial class M20260101000000_Catalog_Initial : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE SCHEMA IF NOT EXISTS products;
CREATE TABLE products.products (
  id UUID NOT NULL,
  sku TEXT NOT NULL,
  price_amount DECIMAL NOT NULL,
  price_currency TEXT NOT NULL,
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
