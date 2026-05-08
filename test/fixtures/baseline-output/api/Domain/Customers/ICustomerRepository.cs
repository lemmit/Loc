// Auto-generated.
using Api.Domain.Ids;

namespace Api.Domain.Customers;

public interface ICustomerRepository
{
    System.Threading.Tasks.Task<Customer?> GetByIdAsync(CustomerId id, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<System.Collections.Generic.IReadOnlyList<Customer>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<CustomerId> ids, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task SaveAsync(Customer aggregate, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<List<Customer>> All(System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<Customer?> ByEmail(string email, System.Threading.CancellationToken ct = default);
}
