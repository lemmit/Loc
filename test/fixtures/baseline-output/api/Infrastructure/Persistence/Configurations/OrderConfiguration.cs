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
    public void Configure(EntityTypeBuilder<Order> b)
    {
        b.ToTable("orders");
        b.HasKey(x => x.Id);
        b.Property(x => x.Id).HasConversion(v => v.Value, v => new OrderId(v));
        b.Property(x => x.Status).HasConversion<string>();
        // Ignore the public read-accessor and tell EF to map the
        // private backing field instead.
        b.Ignore(x => x.Lines);
        b.OwnsMany<OrderLine>("_lines", o => {
            o.ToTable("order_lines");
            o.WithOwner().HasForeignKey("ParentId");
            o.HasKey(x => x.Id);
            o.Property(x => x.Id).HasConversion(v => v.Value, v => new OrderLineId(v));
            o.Property(x => x.ProductId).HasConversion(v => v.Value, v => new ProductId(v));
        });
        b.HasIndex(x => x.CustomerId);
        b.Ignore(x => x.DomainEvents);
    }
}
