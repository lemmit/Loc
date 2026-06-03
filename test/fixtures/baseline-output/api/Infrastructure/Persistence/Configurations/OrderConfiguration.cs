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
        builder.Property(x => x.Id).HasConversion(v => v.Value, v => new OrderId(v));
        builder.Property(x => x.Status).HasConversion<string>();
        // Ignore the public read-accessor and tell EF to map the
        // private backing field instead.
        builder.Ignore(x => x.Lines);
        builder.OwnsMany<OrderLine>("_lines", o => {
            o.ToTable("order_lines", "orders");
            o.WithOwner().HasForeignKey("ParentId");
            o.HasKey(x => x.Id);
            o.Property(x => x.Id).HasConversion(v => v.Value, v => new OrderLineId(v));
            o.Property(x => x.ProductId).HasConversion(v => v.Value, v => new ProductId(v));
        });
        builder.HasIndex(x => x.CustomerId);
        builder.Ignore(x => x.DomainEvents);
    }
}
