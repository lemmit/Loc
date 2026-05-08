// Auto-generated.
using Microsoft.EntityFrameworkCore;
using Api.Domain.Products;
using Api.Domain.Orders;
using Api.Domain.Customers;
namespace Api.Infrastructure.Persistence;

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Customer> Customers => Set<Customer>();
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new Configurations.ProductConfiguration());
        modelBuilder.ApplyConfiguration(new Configurations.OrderConfiguration());
        modelBuilder.ApplyConfiguration(new Configurations.CustomerConfiguration());
    }
}
