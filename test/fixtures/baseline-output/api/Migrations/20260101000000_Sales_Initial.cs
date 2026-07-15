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
    // (42P01 at first INSERT/SELECT).  global:: qualifies from the root
    // namespace: this file's namespace ends in .Migrations and some
    // layouts (byFeature, TPH) nest a same-named child namespace, so a
    // relative reference resolves against the wrong scope (CS0234);
    // global:: sidesteps the ambiguity for every namespace.
    [DbContext(typeof(global::Api.Infrastructure.Persistence.AppDbContext))]
    [Migration("20260101000000_Sales_Initial")]
    public partial class M20260101000000_Sales_Initial : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE SCHEMA IF NOT EXISTS ""orders"";
CREATE TABLE ""orders"".""orders"" (
  ""id"" UUID NOT NULL,
  ""customer_id"" TEXT NOT NULL,
  ""status"" TEXT NOT NULL,
  ""placed_at"" TIMESTAMP WITH TIME ZONE NOT NULL,
  ""version"" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (""id"")
);

CREATE SCHEMA IF NOT EXISTS ""orders"";
CREATE TABLE ""orders"".""order_lines"" (
  ""id"" UUID NOT NULL,
  ""order_id"" UUID NOT NULL,
  ""product_id"" UUID NOT NULL,
  ""quantity"" INTEGER NOT NULL,
  PRIMARY KEY (""id""),
  FOREIGN KEY (""order_id"") REFERENCES ""orders"".""orders"" ON DELETE CASCADE,
  FOREIGN KEY (""product_id"") REFERENCES ""orders"".""products"" ON DELETE RESTRICT
);
CREATE INDEX ""order_lines_order_id_idx"" ON ""orders"".""order_lines"" (""order_id"");
CREATE INDEX ""order_lines_product_id_idx"" ON ""orders"".""order_lines"" (""product_id"");");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // No-op.  Down migrations are best-effort and out of scope
            // for v1 — operators roll forward, not back.
        }
    }
}
