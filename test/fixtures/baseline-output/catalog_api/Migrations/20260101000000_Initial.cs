// Auto-generated.
using Microsoft.EntityFrameworkCore.Migrations;

namespace CatalogApi.Migrations
{
    [Migration("20260101000000_Initial")]
    public partial class M20260101000000_Initial : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE TABLE customers (
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
