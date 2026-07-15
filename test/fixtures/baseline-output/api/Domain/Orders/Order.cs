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

public sealed class Order
{
    public OrderId Id { get; private set; }
    public string CustomerId { get; private set; } = default!;
    public OrderStatus Status { get; private set; } = default!;
    public DateTime PlacedAt { get; private set; } = default!;
    public int Version { get; private set; } = default!;
    private readonly List<OrderLine> _lines = new();
    public IReadOnlyList<OrderLine> Lines => _lines.AsReadOnly();

    private readonly List<IDomainEvent> _domainEvents = new();
    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();
    private Order()
    {
        Id = default!;
        CustomerId = default!;
        Status = default!;
        PlacedAt = default!;
        Version = default!;
    }

    public string Inspect => "Order(" + "id: " + this.Id.ToString() + ", " + "customerId: " + "'" + this.CustomerId + "'" + ", " + "status: " + this.Status.ToString() + ", " + "placedAt: " + this.PlacedAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture) + ", " + "version: " + this.Version.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", " + "lines: " + "[OrderLine[]]" + ")";
    public override string ToString() => Inspect;
    private bool IsMutable() => this.Status == OrderStatus.Draft;
    public void AddLine(ProductId productId, int qty)
    {
        if (!(this.IsMutable())) throw new DomainException("Precondition failed: isMutable()");
        if (!(qty > 0)) throw new DomainException("Precondition failed: qty > 0");
        _lines.Add(OrderLine._Create(new OrderLine.State { Id = OrderLineId.New(), ParentId = this.Id, ProductId = productId, Quantity = qty }));
        AssertInvariants();
    }

    public void Confirm()
    {
        if (!(this.IsMutable())) throw new DomainException("Precondition failed: isMutable()");
        if (!(this.Lines.Count > 0)) throw new DomainException("Precondition failed: lines.count > 0");
        Status = OrderStatus.Confirmed;
        _domainEvents.Add(new OrderConfirmed(Order: this.Id, At: DateTime.UtcNow));
        AssertInvariants();
    }

    public void Update(string customerId, OrderStatus status, DateTime placedAt)
    {
        CustomerId = customerId;
        Status = status;
        PlacedAt = placedAt;
        AssertInvariants();
    }


    public IReadOnlyList<IDomainEvent> PullEvents()
    {
        var copy = _domainEvents.ToArray();
        _domainEvents.Clear();
        return copy;
    }

    private void AssertInvariants()
    {
        if ((this.Status == OrderStatus.Confirmed) && !(this.Lines.Count > 0)) throw new DomainException("Invariant violated: lines.count > 0");
    }

    public sealed class State
    {
        public OrderId Id { get; init; } = default!;
        public string CustomerId { get; init; } = default!;
        public OrderStatus Status { get; init; } = default!;
        public DateTime PlacedAt { get; init; } = default!;
        public int Version { get; init; } = default!;
    }

    public static Order _Create(State s)
    {
        var e = new Order();
        e.Id = s.Id;
        e.CustomerId = s.CustomerId;
        e.Status = s.Status;
        e.PlacedAt = s.PlacedAt;
        e.Version = s.Version;
        e.AssertInvariants();
        return e;
    }
    public static Order Create(string customerId, OrderStatus status, DateTime placedAt)
    {
        var e = new Order();
        e.Id = new OrderId(Guid.CreateVersion7());
        e.CustomerId = customerId;
        e.Status = status;
        e.PlacedAt = placedAt;
        e.AssertInvariants();
        return e;
    }
}
