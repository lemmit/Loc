// Auto-generated.
using Microsoft.EntityFrameworkCore.Migrations;

namespace CatalogApi.Migrations
{
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
