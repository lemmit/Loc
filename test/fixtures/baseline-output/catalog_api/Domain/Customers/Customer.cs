// Auto-generated.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.Events;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Domain.Common;

namespace CatalogApi.Domain.Customers;

public sealed class Customer
{
    public CustomerId Id { get; private set; }
    public string Username { get; private set; } = default!;
    public string Email { get; private set; } = default!;
    public int Age { get; private set; } = default!;

    private readonly List<IDomainEvent> _domainEvents = new();
    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();
    private Customer()
    {
        Id = default!;
        Username = default!;
        Email = default!;
        Age = default!;
    }

    public string Display => this.Username;
    public string Inspect => "Customer(" + "id: " + this.Id.ToString() + ", " + "username: " + "'" + this.Username + "'" + ", " + "email: " + "'" + this.Email + "'" + ", " + "age: " + this.Age.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")";
    public override string ToString() => Inspect;
    public void Update(string username, string email, int age)
    {
        Username = username;
        Email = email;
        Age = age;
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
        if (!(this.Username != this.Email)) throw new DomainException("Invariant violated: username != email");
        if (!(Regex.IsMatch(this.Username, "^[a-z][a-z0-9_]*$"))) throw new DomainException("Invariant violated: username.matches(\"^[a-z][a-z0-9_]*$\")");
        if (!(this.Username.Length >= 3 && this.Username.Length <= 32)) throw new DomainException("Invariant violated: username check username.length >= 3 && username.length <= 32");
        if (!(Regex.IsMatch(this.Email, "^[^@]+@[^@]+\\.[^@]+$") && this.Email.Length <= 120)) throw new DomainException("Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120");
        if (!(this.Age >= 18 && this.Age <= 150)) throw new DomainException("Invariant violated: age check age >= 18 && age <= 150");
    }

    public sealed class State
    {
        public CustomerId Id { get; init; } = default!;
        public string Username { get; init; } = default!;
        public string Email { get; init; } = default!;
        public int Age { get; init; } = default!;
    }

    public static Customer _Create(State s)
    {
        var e = new Customer();
        e.Id = s.Id;
        e.Username = s.Username;
        e.Email = s.Email;
        e.Age = s.Age;
        e.AssertInvariants();
        return e;
    }
    public static Customer Create(string username, string email, int age)
    {
        var e = new Customer();
        e.Id = new CustomerId(Guid.CreateVersion7());
        e.Username = username;
        e.Email = email;
        e.Age = age;
        e.AssertInvariants();
        return e;
    }
}
