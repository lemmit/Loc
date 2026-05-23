// Auto-generated.
using CatalogApi.Domain.Ids;

namespace CatalogApi.Domain.Customers;

public interface ICustomerRepository
{
    Task<Customer?> GetByIdAsync(CustomerId id, CancellationToken ct = default);
    Task<IReadOnlyList<Customer>> FindManyByIdsAsync(IReadOnlyList<CustomerId> ids, CancellationToken ct = default);
    Task SaveAsync(Customer aggregate, CancellationToken ct = default);
    Task<List<Customer>> All(CancellationToken ct = default);
    Task<Customer?> ByEmail(string email, CancellationToken ct = default);
}
