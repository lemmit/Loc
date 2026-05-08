// Auto-generated.
using Microsoft.EntityFrameworkCore;
using CatalogApi.Domain.Products;
using CatalogApi.Domain.Customers;
namespace CatalogApi.Infrastructure.Persistence;

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Product> Products => Set<Product>();
    public DbSet<Customer> Customers => Set<Customer>();
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new Configurations.ProductConfiguration());
        modelBuilder.ApplyConfiguration(new Configurations.CustomerConfiguration());
    }
}
