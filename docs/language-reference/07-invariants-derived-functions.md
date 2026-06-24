# 7. Invariants, derived fields & functions

Three pure, read-only member kinds shared by aggregates, entity parts, and value objects: `invariant` predicates (with optional `when` guard and the `private` modifier), `derived` computed fields (including the reserved `display` and `inspect`), and reusable `function` helpers. None of them mutate state — invariants *check* it after every mutation, derived fields *project* it onto the wire shape, functions *compute* over it. Reach for this chapter when you want a rule enforced at construction time, a value computed once and shown everywhere, or a predicate shared between several operations.

> **Grammar:** `Invariant`, `DerivedProp`, `FunctionDecl` · **Validators:** `loom.precondition-not-bool` (a non-`bool` invariant), `loom.derived-assignment` (assigning a derived property), the bare-aggregate / purity checks · **Docs:** [`../language.md`](../language.md) · [`../criterion.md`](../criterion.md)

All three are emitted **byte-identically in shape** across the five backends that run domain logic — same check site, same guard lowering, same predicate text in the violation message. The divergence is purely host-language syntax. The frontends consume only the wire shape (so they see `derived` fields but never run an `invariant` or a `function`); they have no `backend`/`frontend` split here and get no tab.

## `invariant` — a checked predicate

`invariant Expr [when Expr]` declares a `bool` predicate that must hold after every mutation. It is asserted in the aggregate's domain floor (`_assertInvariants` and friends), called from every factory and operation. A non-`bool` expression is a compile error.

```ddd
aggregate Order {
  taxRate: decimal
  status: string
  invariant taxRate >= 0
}
```

The check is rendered as a guarded throw — `if (!(<pred>)) throw …` — carrying the original source text in the message.

::: tabs backend
== node
```ts
// domain/order.ts
private _assertInvariants(): void {
  if (!(this._taxRate >= 0)) throw new DomainError("Invariant violated: taxRate >= 0");
}
```
The constructor calls `this._assertInvariants()` after assigning state, so an out-of-range value never escapes `Order.create(...)`.
== dotnet
```csharp
// Domain/Orders/Order.cs
private void AssertInvariants()
{
    if (!(this.TaxRate >= 0m)) throw new DomainException("Invariant violated: taxRate >= 0");
}
```
== java
```java
// Domain/Orders/Order.java
public void _assertInvariants() {
    if (!(taxRate >= 0)) throw new DomainException("Invariant violated: taxRate >= 0");
}
```
== python
```python
# app/domain/order.py
def _assert_invariants(self) -> None:
    if not (self._tax_rate >= 0):
        raise DomainError("Invariant violated: taxRate >= 0")
```
== elixir
```elixir
# Ecto changeset — single-field predicates reduce to a built-in validator
changeset
|> validate_number(:tax_rate, greater_than_or_equal_to: 0,
     message: "Invariant violated: taxRate >= 0")
```
The Elixir backend keeps invariants in the schema's `changeset/2` (changeset layer), not in a hand-written assert method. A predicate the classifier can reduce to a single-field comparison becomes a built-in (`validate_number`); everything else falls through to the closure form shown under [`when` guards](#when--a-conditional-invariant).
::: end

### The wire layer

A non-private invariant is **also** projected to the request-validation layer the HTTP boundary runs *before* a command reaches the domain — so a malformed body is rejected as a 422, not an unhandled domain throw. Simple single-field predicates lower to native validator constraints; anything the classifier can't reduce becomes a custom rule.

`invariant taxRate >= 0` and `invariant currency.length == 3` (on the `Money` value object) emit:

::: tabs backend
== node
```ts
// http/order.routes.ts — Zod request/value-object schemas
const MoneySchema = z.object({
  amount: z.coerce.number().min(0),
  currency: z.string().length(3),
});
const CreateOrderRequest = z.object({
  taxRate: z.coerce.number().min(0),
  // …
});
```
== dotnet
```csharp
// Application/Orders/Commands/CreateOrderCommandValidator.cs — FluentValidation
public CreateOrderCommandValidator()
{
    RuleFor(x => x.TaxRate).GreaterThanOrEqualTo(0);
}
```
== java
```java
// OrderValidators.create(...) — wire-layer guard, throws WireValidationException (422)
if (!(taxRate >= 0)) errors.add(WireValidationException.error("/taxRate", "Invariant violated: taxRate >= 0"));
```
== elixir
```elixir
# Ecto changeset validations run at the changeset layer; there is no separate
# wire-validation pass — a violated invariant surfaces as an invalid changeset → 422.
```
::: end

> Python emits the constructor-level domain enforcement and Pydantic request models, but does not yet lower every invariant predicate onto the Pydantic model as a custom validator — single-field constraints are the covered case. Honest gap.

## `private invariant` — domain floor only

Prefix with `private` to enforce the rule **only** in the domain `_assertInvariants` floor — it is *not* projected onto the wire/validation layer, and therefore not disclosed via OpenAPI. Use it for rules you don't want advertised on the public contract (internal consistency, sensitive uniqueness).

```ddd
aggregate Order {
  subtotal: Money
  taxRate: decimal
  invariant taxRate >= 0           // wire + domain
  private invariant subtotal.amount >= 0   // domain only
}
```

Both rules appear in the domain floor; only the non-private one reaches the request validator. From the real generation above:

::: tabs backend
== node
```ts
// domain/order.ts — BOTH invariants present in the floor
private _assertInvariants(): void {
  if (!(this._taxRate >= 0)) throw new DomainError("Invariant violated: taxRate >= 0");
  if (!(this._subtotal.amount >= 0)) throw new DomainError("Invariant violated: subtotal.amount >= 0");
}
```
```ts
// http/order.routes.ts — request schema carries ONLY the non-private rule
const CreateOrderRequest = z.object({
  taxRate: z.coerce.number().min(0),   // private subtotal.amount >= 0 is absent
  // …
});
```
== dotnet
```csharp
// Domain/Orders/Order.cs — both in the domain floor
private void AssertInvariants()
{
    if (!(this.TaxRate >= 0m)) throw new DomainException("Invariant violated: taxRate >= 0");
    if (!(this.Subtotal.Amount >= 0m)) throw new DomainException("Invariant violated: subtotal.amount >= 0");
}
```
```csharp
// CreateOrderCommandValidator.cs — only the non-private rule reaches FluentValidation
RuleFor(x => x.TaxRate).GreaterThanOrEqualTo(0);
// (no rule for subtotal.amount — it is private)
```
::: end

## `when` — a conditional invariant

`invariant Expr when Guard` only enforces `Expr` while `Guard` holds — logical implication, `guard => pred`. It lowers to a single combined `if`, never a separate branch.

```ddd
aggregate Order {
  taxRate: decimal
  status: string
  invariant status.length > 0 when taxRate > 0
}
```

The guard is evaluated first; the predicate is only asserted when the guard is true (`(guard) && !(pred)` throws).

::: tabs backend
== node
```ts
// domain/order.ts
if ((this._taxRate > 0) && !(this._status.length > 0)) throw new DomainError("Invariant violated: status.length > 0");
```
```ts
// http/order.routes.ts — the wire layer renders it as a Zod refine (implication form)
.refine((data) => !(data.taxRate > 0) || (data.status.length > 0), {
  path: ["status"],
  message: "Invariant violated: status.length > 0",
});
```
== dotnet
```csharp
// Domain/Orders/Order.cs
if ((this.TaxRate > 0m) && !(this.Status.Length > 0)) throw new DomainException("Invariant violated: status.length > 0");
```
```csharp
// CreateOrderCommandValidator.cs — wire layer as a .Must implication
RuleFor(x => x).Must(x => !(x.TaxRate > 0m) || (x.Status.Length > 0))
    .WithName("Status")
    .WithMessage("Invariant violated: status.length > 0");
```
== java
```java
// Domain/Orders/Order.java
if ((taxRate > 0) && !(status.length() > 0)) throw new DomainException("Invariant violated: status.length > 0");
```
== python
```python
# app/domain/order.py
if (self._tax_rate > 0) and not (self._status.length() > 0):
    raise DomainError("Invariant violated: status.length > 0")
```
== elixir
```elixir
# Ecto: a guarded / cross-field invariant falls through to the closure form,
# emitted as the implication `not guard or cond`
changeset
|> validate_change(:status, fn _field, _value ->
  record = apply_changes(changeset)
  if not (record.tax_rate > 0) or (String.length(record.status) > 0),
    do: [],
    else: [status: "Invariant violated: status.length > 0"]
end)
```
::: end

## `derived` — a computed read-only field

`derived name: Type = Expr` is a property computed from other facts on the node — no storage column, no setter. Assigning to it is a compile error (`loom.derived-assignment`). It is part of the [enriched `wireShape`](../technical.md), so it appears on the response DTO of every backend and on the wire that frontends consume.

```ddd
aggregate Order {
  subtotal: Money
  taxRate: decimal
  derived total: decimal = subtotal.amount + subtotal.amount * taxRate
}
```

Emitted as a read-only getter on the domain object **and** a member of the response record.

::: tabs backend
== node
```ts
// domain/order.ts — getter, no backing field
get total(): number { return this._subtotal.amount + this._subtotal.amount * this._taxRate; }
```
```ts
// http/order.routes.ts — present on the wire response
export const OrderResponse = z.object({
  id: z.string(),
  subtotal: MoneySchema,
  taxRate: z.number(),
  status: z.string(),
  total: z.number(),      // derived, on the wire
  display: z.string(),
});
```
== dotnet
```csharp
// Domain/Orders/Order.cs — expression-bodied get-only property
public decimal Total => this.Subtotal.Amount + this.Subtotal.Amount * this.TaxRate;
```
```csharp
// Application/Orders/Responses/OrderResponses.cs — on the wire record
public sealed record OrderResponse(
    [property: Required] Guid Id,
    [property: Required] MoneyResponse Subtotal,
    [property: Required] decimal TaxRate,
    [property: Required] string Status,
    [property: Required] decimal Total,    // derived
    [property: Required] string Display);
```
== java
```java
// Domain/Orders/Order.java — public accessor method
public BigDecimal total() {
    return subtotal.amount() + subtotal.amount() * taxRate;
}
// OrderResponse record includes `total` and maps it via value.total() in from(...)
```
== python
```python
# app/domain/order.py — @property, surfaced into the response model via wireShape
@property
def total(self) -> Decimal:
    return self._subtotal.amount + self._subtotal.amount * self._tax_rate
```
== elixir
```elixir
# Ecto schema — a derived function; the Jason encoder includes it on the wire
def total(record) do
  Decimal.add(record.subtotal_amount,
    Decimal.mult(record.subtotal_amount, record.tax_rate))
end
```
::: end

### Reserved `display` and `inspect`

Two derived names are special-cased.

`derived display: string = …` declares the aggregate's **user-facing label**. When present, `string(aggregate)` and implicit `"x " + aggregate` compile to a member access on it, and React `Select` pickers use it for option text; without it those expressions are compile errors.

`derived inspect: string = …` declares the **developer-facing debug form**, emitted as the host language's stringification hook (`toString()` / `[util.inspect.custom]` / `__repr__` / a `def inspect(record)` module function). When you omit it, the backend **auto-generates** a structural form, and any field carrying a `sensitive(...)` tag is printed as `<redacted>`. A user-supplied `inspect` is rendered verbatim (you opt out of redaction by writing your own).

```ddd
aggregate Order {
  status: string
  derived display: string = "Order " + status
  // inspect omitted → auto-generated structural form
}
```

::: tabs backend
== node
```ts
// domain/order.ts — `display` getter + the AUTO-generated `inspect`/toString
get display(): string { return "Order " + this._status; }
get inspect(): string { return "Order(" + "id: " + String(this._id) + ", " + /* …structural… */ ")"; }
toString(): string { return this.inspect; }
[Symbol.for("nodejs.util.inspect.custom")](): string { return this.inspect; }
```
== dotnet
```csharp
// Domain/Orders/Order.cs — `Display` + auto `Inspect` delegated from ToString()
public string Display => "Order " + this.Status;
public string Inspect => "Order(" + "id: " + this.Id.ToString() + ", " + /* …structural… */ ")";
public override string ToString() => Inspect;
```
== elixir
```elixir
# A user-supplied `inspect` derived becomes a public module function, e.g.:
@spec inspect(t()) :: String.t()
def inspect(record) do
  "Order " <> record.status
end
```
::: end

`display` and `inspect` ride the same wireShape rule as any other derived (they are `string` fields on the response), so the label is available client-side without a round-trip to compute it.

## `function` — a pure helper

`function name(params): Type = Expr` is a pure, side-effect-free helper callable from any expression in the same aggregate / value object — invariant predicates, derived expressions, operation bodies. It compiles to a private method (the backends keep it internal; it is not part of the public command surface).

```ddd
aggregate Order {
  subtotal: Money
  taxRate: decimal
  function grandTotal(): decimal = subtotal.amount * (1 + taxRate)
}

valueobject Money {
  amount: decimal
  currency: string
  function withTax(rate: decimal): decimal = amount * (1 + rate)
}
```

::: tabs backend
== node
```ts
// domain/order.ts
private grandTotal(): number { return this._subtotal.amount * (1 + this._taxRate); }
// domain/value-objects.ts
private withTax(rate: number): number { return this.amount * (1 + rate); }
```
== dotnet
```csharp
// Domain/Orders/Order.cs
private decimal GrandTotal() => this.Subtotal.Amount * (1m + this.TaxRate);
// Domain/ValueObjects/Money.cs
private decimal WithTax(decimal rate) => this.Amount * (1m + rate);
```
== java
```java
// Domain/Orders/Order.java
private BigDecimal grandTotal() {
    return subtotal.amount() * (1 + taxRate);
}
```
== python
```python
# app/domain/order.py — private (underscore-prefixed) method
def _grand_total(self) -> Decimal:
    return self._subtotal.amount * (1 + self._tax_rate)
```
== elixir
```elixir
# Public module function so validate/calculate bodies can call it,
# suppressed from docs with @doc false.
@spec grand_total(t()) :: Decimal.t()
@doc false
def grand_total(record) do
  record.subtotal_amount * (1 + record.tax_rate)
end
```
::: end

A `function` is the reusable-expression knob; for a reusable *predicate* shared across aggregates as a named specification, see [`criterion.md`](../criterion.md).
