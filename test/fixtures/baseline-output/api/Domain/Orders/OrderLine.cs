// Auto-generated.
using System;
using System.Collections.Generic;
using System.Linq;
using Api.Domain.Ids;
using Api.Domain.Events;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Domain.Common;

namespace Api.Domain.Orders;

public sealed class OrderLine
{
    public OrderLineId Id { get; private set; }
    public OrderId ParentId { get; private set; }
    public ProductId ProductId { get; private set; } = default!;
    public int Quantity { get; private set; } = default!;

    private OrderLine()
    {
        Id = default!;
        ParentId = default!;
        ProductId = default!;
        Quantity = default!;
    }


    private void AssertInvariants()
    {
        if (!(this.Quantity > 0)) throw new DomainException("Invariant violated: quantity > 0");
    }

    public sealed class State
    {
        public OrderLineId Id { get; init; } = default!;
        public OrderId ParentId { get; init; } = default!;
        public ProductId ProductId { get; init; } = default!;
        public int Quantity { get; init; } = default!;
    }

    public static OrderLine _Create(State s)
    {
        var e = new OrderLine();
        e.Id = s.Id;
        e.ParentId = s.ParentId;
        e.ProductId = s.ProductId;
        e.Quantity = s.Quantity;
        e.AssertInvariants();
        return e;
    }
}
