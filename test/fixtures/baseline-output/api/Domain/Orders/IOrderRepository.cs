// Auto-generated.
using Api.Domain.Ids;

namespace Api.Domain.Orders;

public interface IOrderRepository
{
    Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);
    Task<IReadOnlyList<Order>> FindManyByIdsAsync(IReadOnlyList<OrderId> ids, CancellationToken ct = default);
    Task SaveAsync(Order aggregate, CancellationToken ct = default);
    Task<List<Order>> All(CancellationToken ct = default);
    Task<List<Order>> ByCustomer(string customerId, CancellationToken ct = default);
    Task<List<Order>> ActiveOrders(CancellationToken ct = default);
    Task<List<Order>> OrderSummary(CancellationToken ct = default);
}
