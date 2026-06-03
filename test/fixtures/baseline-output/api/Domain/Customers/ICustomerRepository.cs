// Auto-generated.
using Api.Domain.Ids;

namespace Api.Domain.Customers;

public interface ICustomerRepository
{
    Task<Customer?> GetByIdAsync(CustomerId id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<Customer>> FindManyByIdsAsync(IReadOnlyList<CustomerId> ids, CancellationToken cancellationToken = default);
    Task SaveAsync(Customer aggregate, CancellationToken cancellationToken = default);
    Task DeleteAsync(Customer aggregate, CancellationToken cancellationToken = default);
    Task<List<Customer>> All(CancellationToken cancellationToken = default);
    Task<Customer?> ByEmail(string email, CancellationToken cancellationToken = default);
}
