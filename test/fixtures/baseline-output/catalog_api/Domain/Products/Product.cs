// Auto-generated.
using System;
using System.Collections.Generic;
using System.Linq;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.Events;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Domain.Common;

namespace CatalogApi.Domain.Products;

public sealed class Product
{
    public ProductId Id { get; private set; }
    public string Sku { get; private set; } = default!;
    public Money Price { get; private set; } = default!;

    private readonly List<IDomainEvent> _domainEvents = new();
    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();
    private Product()
    {
        Id = default!;
        Sku = default!;
        Price = default!;
    }

    public string Display => this.Sku;
    public string Inspect => "Product(" + "id: " + this.Id.ToString() + ", " + "sku: " + "'" + this.Sku + "'" + ", " + "price: " + "Money(" + "amount: " + this.Price.Amount.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", " + "currency: " + "'" + this.Price.Currency + "'" + ")" + ")";
    public override string ToString() => Inspect;
    public void Update(string sku, Money price)
    {
        Sku = sku;
        Price = price;
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
        if (!(this.Sku.Length > 0)) throw new DomainException("Invariant violated: sku.length > 0");
    }

    public sealed class State
    {
        public ProductId Id { get; init; } = default!;
        public string Sku { get; init; } = default!;
        public Money Price { get; init; } = default!;
    }

    public static Product _Create(State s)
    {
        var e = new Product();
        e.Id = s.Id;
        e.Sku = s.Sku;
        e.Price = s.Price;
        e.AssertInvariants();
        return e;
    }
    public static Product Create(string sku, Money price)
    {
        var e = new Product();
        e.Id = new ProductId(Guid.CreateVersion7());
        e.Sku = sku;
        e.Price = price;
        e.AssertInvariants();
        return e;
    }
}
