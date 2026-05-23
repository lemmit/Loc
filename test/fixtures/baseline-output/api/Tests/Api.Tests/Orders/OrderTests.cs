// Auto-generated.  Do not edit by hand.
using System;
using Xunit;
using AwesomeAssertions;
using Api.Domain.Orders;
using Api.Domain.Common;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Domain.Ids;

namespace Api.Tests.Orders;

public sealed class OrderTests
{
    [Fact(DisplayName = "confirming an order with no lines is rejected")]
    public void Confirming_an_order_with_no_lines_is_rejected()
    {
        var order = Order.Create(new { CustomerId = "cust-001", Status = OrderStatus.Draft, PlacedAt = "2024-01-01T00:00:00Z" });
        Assert.Throws<DomainException>(() => { var __ = order.Confirm(); });
    }

}
