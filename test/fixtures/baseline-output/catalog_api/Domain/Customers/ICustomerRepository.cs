// Auto-generated.
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.Enums;
using CatalogApi.Domain.Common;

namespace CatalogApi.Domain.Customers;

public interface ICustomerRepository
{
    Task<Customer?> GetByIdAsync(CustomerId id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<Customer>> FindManyByIdsAsync(IReadOnlyList<CustomerId> ids, CancellationToken cancellationToken = default);
    Task SaveAsync(Customer aggregate, CancellationToken cancellationToken = default);
    Task DeleteAsync(Customer aggregate, CancellationToken cancellationToken = default);
    Task<Paged<Customer>> All(int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default);
    Task<Customer?> ByEmail(string email, CancellationToken cancellationToken = default);
}
