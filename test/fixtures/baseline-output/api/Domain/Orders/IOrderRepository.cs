// Auto-generated.
using Api.Domain.Ids;

namespace Api.Domain.Orders;

public interface IOrderRepository
{
    System.Threading.Tasks.Task<Order?> GetByIdAsync(OrderId id, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<System.Collections.Generic.IReadOnlyList<Order>> FindManyByIdsAsync(System.Collections.Generic.IReadOnlyList<OrderId> ids, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task SaveAsync(Order aggregate, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<List<Order>> All(System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<List<Order>> ByCustomer(string customerId, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<List<Order>> ActiveOrders(System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task<List<Order>> OrderSummary(System.Threading.CancellationToken ct = default);
}
