// Auto-generated.
using Api.Domain.Ids;
using Api.Domain.Enums;

namespace Api.Domain.Orders;

public interface IOrderRepository
{
    Task<Order?> GetByIdAsync(OrderId id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<Order>> FindManyByIdsAsync(IReadOnlyList<OrderId> ids, CancellationToken cancellationToken = default);
    Task SaveAsync(Order aggregate, CancellationToken cancellationToken = default);
    Task DeleteAsync(Order aggregate, CancellationToken cancellationToken = default);
    Task<List<Order>> All(CancellationToken cancellationToken = default);
    Task<List<Order>> ByCustomer(string customerId, CancellationToken cancellationToken = default);
    Task<List<Order>> ActiveOrders(CancellationToken cancellationToken = default);
    Task<List<Order>> OrderSummary(CancellationToken cancellationToken = default);
}
