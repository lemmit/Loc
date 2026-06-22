# 8. Inheritance & polymorphism

> **Grammar:** `abstract aggregate`, `extends`, `inheritanceUsing` · **Validators:** `loom.extends-non-abstract`, `loom.extends-self`, `loom.inheritance-modifier-misplaced`, `loom.abstract-aggregate-behavior`, `loom.abstract-repository`, `loom.polymorphic-id-ref-unsupported` · **Docs:** [`../inheritance.md`](../inheritance.md)

One aggregate may `extend` another so subtypes share a field set and can be read polymorphically. An `abstract aggregate` declares the base; concrete aggregates `extends` it; the `inheritanceUsing(…)` header modifier chooses how the hierarchy maps to tables. The whole chapter hinges on one fork: **`sharedTable` (TPH) — one table plus a `kind` discriminator — vs `ownTable` (TPC) — one table per concrete subtype.** That choice changes the emitted SQL, the polymorphic reader, and whether `<Base> id` references are legal; everything below shows both.

## `abstract aggregate` — the base

`abstract aggregate <Name>` is a base that is never instantiated. It owns **no table, repository, controller, or routes** — only the shared fields (and `derived` getters / `invariant`s / `function`s) the subtypes inherit. It may **not** declare lifecycle behaviour (`create` / `operation` → `loom.abstract-aggregate-behavior`) or have a `repository` target it (`loom.abstract-repository`).

```ddd
abstract aggregate Party inheritanceUsing(sharedTable) {
  name: string
  email: string
  derived display: string = name
}
```

The base materialises as a host-language abstract type carrying the shared fields — but no persistence of its own.

::: tabs backend
== node
```ts
// domain/party.ts (TPH) — a tagged union of the concretes, no class of its own
import type { Customer } from "./customer";
import type { Supplier } from "./supplier";

// Polymorphic Party — the tagged union of its concrete subtypes
// (discriminated by the shared table's `kind` column at the data layer).
export type Party = Customer | Supplier;
```
== dotnet
```csharp
// Domain/Parties/Party.cs (TPH) — abstract class, the concretes derive from it
// Abstract TPH base — the whole hierarchy maps to one table named
// for this base; it owns the shared Id + a 'kind' discriminator.
public abstract class Party
{
    public PartyId Id { get; internal set; } = default!;
    public string Name { get; internal set; } = default!;
    public string Email { get; internal set; } = default!;
    public string Display => this.Name;
}
```
== elixir
```elixir
# lib/elixir_api/parties.ex — the base owns no Ash.Resource; only a
# polymorphic read on the context domain (see `find all <Base>` below).
```
::: end

## `extends` — a concrete subtype

`aggregate <X> extends <Base>` is a concrete subtype. `<Base>` must be an `abstract aggregate` in the **same context** (`loom.extends-non-abstract`, `loom.extends-self`). The subtype gets an ordinary repository, routes, and DTO; the enrichment pass merges its `wireShape` as **`id` → base fields (declaration order) → own fields**, so every backend's DTO for a subtype is the same shape. A like-named own field shadows the base field (the own declaration simply wins — no override semantics).

```ddd
aggregate Customer extends Party with crudish {
  creditLimit: decimal
}
aggregate Supplier extends Party with crudish {
  rating: int
}
```

The merged wire shape, on `Customer`, is `id, name, email, creditLimit`:

::: tabs backend
== node
```ts
// http/customer.routes.ts — id → base (name, email) → own (creditLimit)
export const CustomerResponse = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  creditLimit: z.number(),
}).openapi("CustomerResponse");
```
== dotnet
```csharp
// Domain/Customers/Customer.cs — derives from the base, inherits Name/Email
public sealed class Customer : Party
{
    public decimal CreditLimit { get; internal set; }
}
```
::: end
