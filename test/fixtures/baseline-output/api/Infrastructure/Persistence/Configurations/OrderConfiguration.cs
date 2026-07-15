// Auto-generated.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Api.Domain.Orders;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Infrastructure.Persistence.Configurations;

public sealed class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> builder)
    {
        builder.ToTable("orders", "orders");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).HasConversion(v => v.Value, v => new OrderId(v)).HasColumnName("id").ValueGeneratedNever();
        builder.Property(x => x.CustomerId).HasColumnName("customer_id");
        builder.Property(x => x.Status).HasConversion<string>().HasColumnName("status");
        builder.Property(x => x.PlacedAt).HasColumnName("placed_at");
        builder.Property(x => x.Version).HasColumnName("version").IsConcurrencyToken();
        // Ignore the public read-accessor and tell EF to map the
        // private backing field instead.
        builder.Ignore(x => x.Lines);
        builder.OwnsMany<OrderLine>("_lines", o => {
            o.ToTable("order_lines", "orders");
            o.WithOwner().HasForeignKey("ParentId");
            o.Property("ParentId").HasColumnName("order_id");
            o.HasKey(x => x.Id);
            o.Property(x => x.Id).HasConversion(v => v.Value, v => new OrderLineId(v)).HasColumnName("id");
            o.Property(x => x.ProductId).HasConversion(v => v.Value, v => new ProductId(v)).HasColumnName("product_id");
            o.Property(x => x.Quantity).HasColumnName("quantity");
        });
        builder.HasIndex(x => x.CustomerId);
        builder.Ignore(x => x.DomainEvents);
    }
}
