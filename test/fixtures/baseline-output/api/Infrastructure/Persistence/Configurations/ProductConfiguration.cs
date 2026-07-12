// Auto-generated.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Api.Domain.Products;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Infrastructure.Persistence.Configurations;

public sealed class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> builder)
    {
        builder.ToTable("products", "products");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).HasConversion(v => v.Value, v => new ProductId(v)).HasColumnName("id").ValueGeneratedNever();
        builder.Property(x => x.Sku).HasColumnName("sku");
        builder.OwnsOne<Money>(x => x.Price, o => {
            o.Property(x => x.Amount).HasColumnName("price_amount");
            o.Property(x => x.Currency).HasColumnName("price_currency");
        });
        builder.HasIndex(x => x.Sku);
        builder.Ignore(x => x.DomainEvents);
    }
}
