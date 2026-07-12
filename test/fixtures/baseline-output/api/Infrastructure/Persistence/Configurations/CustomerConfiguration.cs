// Auto-generated.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Api.Domain.Customers;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Infrastructure.Persistence.Configurations;

public sealed class CustomerConfiguration : IEntityTypeConfiguration<Customer>
{
    public void Configure(EntityTypeBuilder<Customer> builder)
    {
        builder.ToTable("customers", "customers");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).HasConversion(v => v.Value, v => new CustomerId(v)).HasColumnName("id").ValueGeneratedNever();
        builder.Property(x => x.Username).HasColumnName("username");
        builder.Property(x => x.Email).HasColumnName("email");
        builder.Property(x => x.Age).HasColumnName("age");
        builder.HasIndex(x => x.Email);
        builder.Ignore(x => x.DomainEvents);
    }
}
