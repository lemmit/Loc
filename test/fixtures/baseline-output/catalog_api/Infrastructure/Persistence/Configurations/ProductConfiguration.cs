// Auto-generated.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using CatalogApi.Domain.Products;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Infrastructure.Persistence.Configurations;

public sealed class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> b)
    {
        b.ToTable("products", "products");
        b.HasKey(x => x.Id);
        b.Property(x => x.Id).HasConversion(v => v.Value, v => new ProductId(v));
        b.OwnsOne<Money>(x => x.Price);
        b.HasIndex(x => x.Sku);
        b.Ignore(x => x.DomainEvents);
    }
}
