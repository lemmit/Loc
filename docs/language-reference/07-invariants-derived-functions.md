# 7. Invariants, derived fields & functions

Three pure, read-only member kinds shared by aggregates, entity parts, and value objects: `invariant` predicates (with optional `when` guard, `message`, and the `private` modifier), `derived` computed fields (including the reserved `display` and `inspect`), and reusable `function` helpers in expression or block form. None of them mutate state — invariants *check* it after every mutation, derived fields *project* it onto the wire shape, functions *compute* over it. Reach for this chapter when you want a rule enforced at construction time, a value computed once and shown everywhere, or a predicate shared between several operations.

> **Grammar:** `Invariant`, `Unique`, `DerivedProp`, `FunctionDecl` · **Validators:** `Invariant must be of type 'bool'` / `Cannot assign to derived property` (uncoded, `src/language/validators/types.ts` / `statements.ts`), `loom.function-block-no-return`, `loom.function-toplevel-block`, `loom.function-recursive`, `loom.reserved-derived-on-vo`, `loom.ui-id-ref-no-display`, `loom.unique-*` · **Docs:** [`../language.md`](../language.md) · [`../criterion.md`](../criterion.md) · [`../stdlib.md`](../stdlib.md)

All three are emitted **byte-identically in shape** across the five backends that run domain logic — same check site, same guard lowering, same predicate text in the violation message. The divergence is host-language syntax plus one structural exception: Phoenix keeps invariants in the Ecto changeset (there is no separate domain floor) and renders derived fields inline in the controller serializer. The frontends consume only the wire shape (so they see `derived` fields but never run an `invariant` or a `function`) and get no tab. Every tab below was generated from one scratch system with a deployable per backend (`node bin/cli.js generate system … -o out`).

## `invariant` — a checked predicate

`[private] invariant Expr [when Guard] [message "…"]` declares a `bool` predicate that must hold after every mutation (a non-`bool` expression is `Invariant must be of type 'bool', got '…'`). It is asserted in the aggregate's domain floor (`_assertInvariants` and friends), called from every factory and operation. The violation message defaults to `Invariant violated: <source text>`; a `message "…"` clause replaces it with author text that also becomes the i18n key (`msg.<hash>`, carried as a wire error code — `loomCode` / `WithErrorCode` / `PydanticCustomError` / `loom_code:`).

```ddd
aggregate Order {
  taxRate: decimal
  qty: int
  invariant taxRate >= 0
  invariant qty <= 1000 message "At most 1000 items per order"
}
```

The check is rendered as a guarded throw — `if (!(<pred>)) throw …` — carrying the message.

::: tabs backend
== node
```ts
// domain/order.ts
private _assertInvariants(): void {
  if (!(this._taxRate >= 0)) throw new DomainError("Invariant violated: taxRate >= 0");
  if (!(this._qty <= 1000)) throw new DomainError("At most 1000 items per order");
}
```
The constructor calls `this._assertInvariants()` after assigning state, so an out-of-range value never escapes `Order.create(...)`.
== dotnet
```csharp
// Domain/Orders/Order.cs
private void AssertInvariants()
{
    if (!(this.TaxRate >= 0m)) throw new DomainException("Invariant violated: taxRate >= 0");
    if (!(this.Qty <= 1000)) throw new DomainException("At most 1000 items per order");
}
```
== java
```java
// features/orders/Order.java — decimal is BigDecimal, so >= is compareTo
public void _assertInvariants() {
    if (!(this.taxRate.compareTo(new BigDecimal("0")) >= 0)) throw new DomainException("Invariant violated: taxRate >= 0");
    if (!(this.qty <= 1000)) throw new DomainException("At most 1000 items per order");
}
```
== python
```python
# app/domain/order.py
def _assert_invariants(self) -> None:
    if not (self._tax_rate >= 0):
        raise DomainError("Invariant violated: taxRate >= 0")
    if not (self._qty <= 1000):
        raise DomainError("At most 1000 items per order")
```
== elixir
```elixir
# lib/ex_api/orders/order_changeset.ex — a single-field bound becomes a native
# validator on the changeset; a messaged rule routes to validate_invariants/1 so
# it can carry its wire code
|> validate_number(:tax_rate, greater_than_or_equal_to: 0)
|> validate_invariants()

def validate_invariants(changeset) do
  data = apply_changes(changeset)
  changeset =
    if data.qty <= 1000, do: changeset, else: add_error(changeset, :qty, "At most 1000 items per order", loom_code: "msg.mnvq93")
  changeset
end
```
The Elixir backend keeps invariants in the schema's changeset (`base_changeset` / `update_changeset`, and the operation-persist pipe calls `validate_invariants/1` too), not in a hand-written assert method. A violated one surfaces as an invalid changeset → 422.
::: end

### `.length` counts code points

A string `.length` — in a domain rule, an invariant, a precondition, anywhere — is a count of **Unicode code points**, not of the host language's native string length. This is the unit the emitted JSON Schema publishes as `minLength`/`maxLength`, so the rule the server enforces and the bound it advertises are the same number:

| target | emitted for `s.length` |
|---|---|
| node/Hono | `[...s].length` |
| .NET | `s.EnumerateRunes().Count()` |
| java | `((int) s.codePoints().count())` |
| python | `len(s)` |
| elixir | `length(String.to_charlist(s))` in a changeset validator (a charlist is one element per code point) |

`"😀X"` is therefore **2**, not 3: the astral character is one code point (two UTF-16 code units). Before this was pinned, node/.NET/java counted code units and accepted a value their own published `maxLength` forbade (`docs/audits/schemathesis-findings-2026-08.md`, F5).

### The wire layer

A non-private invariant is **also** projected to the request-validation layer the HTTP boundary runs *before* a command reaches the domain — so a malformed body is rejected as a 422, not a domain throw. It lands on the create and update request shapes of a constructible aggregate (one with a canonical `create`, e.g. via `crudish`). Simple single-field predicates lower to native validator constraints (`invariant-classify.ts` → `zod-refine.ts` / `validator-emit.ts` / the Java `*Validator` / Pydantic); anything the classifier can't reduce becomes a custom rule.

`invariant taxRate >= 0`, `invariant note.length > 0`, and `invariant qty <= 1000 message "…"` emit:

::: tabs backend
== node
```ts
// http/order.routes.ts — Zod request schema; the code-point length is an explicit
// refine plus the minLength the OpenAPI schema publishes
const CreateOrderRequest = z.object({
  note: z.string().refine((s) => [...s].length >= 1).openapi({ minLength: 1 }),
  qty: z.number().int(),
  taxRate: z.number().min(0),
}).openapi("CreateOrderRequest").refine((data: any) => data.qty <= 1000, { path: ["qty"], message: "At most 1000 items per order", params: { loomCode: "msg.mnvq93" } });
```
== dotnet
```csharp
// Application/Orders/Commands/CreateOrderCommandValidator.cs — FluentValidation
public CreateOrderCommandValidator()
{
    RuleFor(x => x.TaxRate).GreaterThanOrEqualTo(0);
    RuleFor(x => x).Must(x => x.Qty <= 1000)
        .WithName("Qty")
        .WithMessage("At most 1000 items per order")
        .WithErrorCode("msg.mnvq93");
}
```
== java
```java
// features/orders/CreateOrderValidator.java — a Spring Validator over the request record
if (!(taxRate.compareTo(new java.math.BigDecimal("0")) >= 0)) errors.rejectValue("taxRate", "loom.invariant", "Invariant violated: taxRate >= 0");
if (!(((int) note.codePoints().count()) > 0)) errors.rejectValue("note", "loom.invariant", "Invariant violated: note.length > 0");
if (!(qty <= 1000)) errors.rejectValue("qty", "msg.mnvq93", "At most 1000 items per order");
```
== python
```python
# app/http/order_routes.py — Pydantic Field constraints + a model_validator
class CreateOrderRequest(BaseModel):
    taxRate: float = Field(ge=0)
    qty: int
    note: str

    @model_validator(mode="after")
    def _check_invariants(self) -> "CreateOrderRequest":
        if not (self.qty <= 1000):
            raise ValidationError.from_exception_data("CreateOrderRequest", [InitErrorDetails(
                type=PydanticCustomError("msg.mnvq93", "At most 1000 items per order"), loc=("qty",), input=self.qty)])
        return self
```
== elixir
```elixir
# lib/ex_api/orders/order_changeset.ex — the changeset IS the wire layer; the
# code-point length rule is a validate_change closure with Ecto's own message shape
|> validate_change(:note, fn _, value ->
  if length(String.to_charlist(value)) >= 1,
    do: [],
    else: [{:note, {"should be at least %{count} character(s)", count: 1, validation: :length, kind: :min, type: :string}}]
end)
|> validate_number(:tax_rate, greater_than_or_equal_to: 0)
```
::: end

## `private invariant` — domain floor only

Prefix with `private` to enforce the rule **only** in the domain `_assertInvariants` floor — it is *not* projected onto the wire/validation layer, and therefore not disclosed via OpenAPI. Use it for rules you don't want advertised on the public contract (internal consistency, sensitive uniqueness).

```ddd
aggregate Order {
  taxRate: decimal
  qty: int
  invariant taxRate >= 0           // wire + domain
  private invariant qty >= 0       // domain only
}
```

Both rules appear in the domain floor; only the non-private one reaches the request validator:

::: tabs backend
== node
```ts
// domain/order.ts — BOTH invariants present in the floor
private _assertInvariants(): void {
  if (!(this._taxRate >= 0)) throw new DomainError("Invariant violated: taxRate >= 0");
  if (!(this._qty >= 0)) throw new DomainError("Invariant violated: qty >= 0");
}
```
```ts
// http/order.routes.ts — the request schema carries ONLY the non-private rule
const CreateOrderRequest = z.object({
  taxRate: z.number().min(0),
  qty: z.number().int(),      // no .min(0): the private rule is absent
  // …
})
```
== dotnet
```csharp
// Domain/Orders/Order.cs — both in the domain floor
if (!(this.TaxRate >= 0m)) throw new DomainException("Invariant violated: taxRate >= 0");
if (!(this.Qty >= 0)) throw new DomainException("Invariant violated: qty >= 0");
```
```csharp
// CreateOrderCommandValidator.cs — only the non-private rule reaches FluentValidation
RuleFor(x => x.TaxRate).GreaterThanOrEqualTo(0);
```
== elixir
```elixir
# Phoenix has ONE layer — the changeset — so a private invariant is enforced
# there like any other, and is therefore visible in the 422 errors[]
|> validate_number(:tax_rate, greater_than_or_equal_to: 0)
|> validate_number(:qty, greater_than_or_equal_to: 0)
```
::: end

Java and Python behave like node/.NET (the `qty >= 0` rule is in `_assertInvariants` / `_assert_invariants` and absent from `CreateOrderValidator` / `CreateOrderRequest`).

## `when` — a conditional invariant

`invariant Expr when Guard` only enforces `Expr` while `Guard` holds — logical implication, `guard => pred`. It lowers to a single combined `if`, never a separate branch.

```ddd
aggregate Order {
  taxRate: decimal
  note: string
  invariant note.length > 0 when taxRate > 0
}
```

The guard is evaluated first; the predicate is only asserted when the guard is true (`(guard) && !(pred)` throws).

::: tabs backend
== node
```ts
// domain/order.ts
if ((this._taxRate > 0) && !([...this._note].length > 0)) throw new DomainError("Invariant violated: note.length > 0");
```
```ts
// http/order.routes.ts — the wire layer renders it as a Zod refine (implication form)
.refine((data: any) => !(data.taxRate > 0) || ([...data.note].length > 0), { path: ["note"], message: "Invariant violated: note.length > 0" })
```
== dotnet
```csharp
// Domain/Orders/Order.cs
if ((this.TaxRate > 0m) && !(this.Note.EnumerateRunes().Count() > 0)) throw new DomainException("Invariant violated: note.length > 0");
```
```csharp
// CreateOrderCommandValidator.cs — wire layer as a .Must implication
RuleFor(x => x).Must(x => !(x.TaxRate > 0m) || (x.Note.EnumerateRunes().Count() > 0))
    .WithName("Note")
    .WithMessage("Invariant violated: note.length > 0");
```
== java
```java
// features/orders/Order.java
if ((this.taxRate.compareTo(new BigDecimal("0")) > 0) && !(((int) this.note.codePoints().count()) > 0)) throw new DomainException("Invariant violated: note.length > 0");
```
== python
```python
# app/domain/order.py
if (self._tax_rate > 0) and not (len(self._note) > 0):
    raise DomainError("Invariant violated: note.length > 0")
```
```python
# app/http/order_routes.py — model_validator, implication form
if not (not (self.taxRate > 0) or (len(self.note) > 0)):
    raise ValueError("Invariant violated: note.length > 0")
```
== elixir
```elixir
# Honest gap: a guarded invariant whose predicate is a single-field shape
# (.length / .matches / a numeric bound) is emitted NEITHER as a native
# validator NOR in validate_invariants/1 — the changeset carries nothing for it.
# A guarded CROSS-FIELD comparison (both sides plain fields) does render, as
#   changeset = if <guard> do (if <pred>, do: changeset, else: add_error(…)) else changeset end
```
::: end

## `unique (a, b)` — a set-level invariant

`unique (col, …)` declares a natural-key rule over the aggregate's rows. It cannot run in the per-instance floor, so the compiler *derives* its enforcement — a DB unique index (partial under `softDeletable`) plus a per-backend `23505 → 409` mapping. Columns are bare field names (`loom.unique-unknown-field`, `-collection-field`, `-valueobject-field`, `-duplicate-column`; a tenant-owned aggregate must include its tenant key, `loom.unique-missing-tenant-scope`; not on an event-sourced aggregate, `loom.unique-on-event-sourced`). The schema side is in [Migrations](../migrations.md).

## `derived` — a computed read-only field

`derived name: Type = Expr` is a property computed from other facts on the node — no storage column, no setter. Assigning to it is a compile error (`Cannot assign to derived property 'x'`). It is part of the [enriched `wireShape`](../technical.md), so it appears on the response DTO of every backend and on the wire that frontends consume; an optional declared type (`money?`) carries its optionality onto the wire.

```ddd
aggregate Order {
  subtotal: money
  taxRate: decimal
  derived total: money = subtotal + subtotal * taxRate
}
```

Emitted as a read-only getter on the domain object **and** a member of the response record.

::: tabs backend
== node
```ts
// domain/order.ts — getter, no backing field
get total(): Decimal { return this._subtotal.plus(this.tax); }
```
```ts
// http/order.routes.ts — present on the wire response (money → string)
export const OrderResponse = z.object({
  id: z.string(),
  subtotal: z.string(),
  taxRate: z.number(),
  // …
  total: z.string(),      // derived, on the wire
  display: z.string(),
});
```
== dotnet
```csharp
// Domain/Orders/Order.cs — expression-bodied get-only property
public decimal Total => this.Subtotal + this.Tax;
```
```csharp
// Application/Orders/Queries/GetOrderByIdHandler.cs — projected onto the response record
new OrderResponse(found.Id.Value, found.Subtotal.ToString("F4", CultureInfo.InvariantCulture), /* … */, found.Total.ToString("F4", CultureInfo.InvariantCulture), /* … */, found.Display)
```
== java
```java
// features/orders/Order.java — public accessor method
public BigDecimal total() {
    return this.subtotal.add(this.tax());
}
// OrderResponse.from(value) maps it: value.total().setScale(4, RoundingMode.HALF_UP).toPlainString()
```
== python
```python
# app/domain/order.py — @property, surfaced into the response model via wireShape
@property
def total(self) -> Decimal:
    return self._subtotal + self.tax
```
== elixir
```elixir
# lib/ex_api_web/controllers/order_controller.ex — no schema function; every
# derived is computed inline in the serializer map
"total" => __money_round(Decimal.add(record.subtotal, Decimal.mult(record.subtotal, record.tax_rate))),
```
::: end

### Reserved `display` and `inspect`

Two derived names are special-cased (aggregates only — on a value object they are `loom.reserved-derived-on-vo`).

`derived display: string = …` declares the aggregate's **user-facing label**. When present, `string(aggregate)`, implicit `"x " + aggregate` and a `{aggregate}` template hole compile to a member access on it, and frontend `Select` pickers over an `X id` field use it for option text; without it those expressions are compile errors and a UI that references the id is `loom.ui-id-ref-no-display`. It rides the wire like any derived.

`derived inspect: string = …` declares the **developer-facing debug form**, emitted as the host language's stringification hook (`toString()` + `[util.inspect.custom]` / `ToString()` / `toString()` / `__repr__`). When you omit it, phase ⑥ **synthesises** a structural form on every aggregate, and any field carrying a `sensitive(...)` tag is printed as `<redacted>`; Elixir emits a `defimpl Inspect` for that redacted form only when the aggregate has a sensitive field. A user-supplied `inspect` is rendered verbatim (you opt out of redaction by writing your own); it is **not** on the wire.

```ddd
aggregate Order {
  note: string
  qty: int
  ssn: string sensitive(pii)
  derived display: string = "Order " + note
  // inspect omitted → synthesised structural form
}
```

::: tabs backend
== node
```ts
// domain/order.ts — `display` getter + the SYNTHESISED `inspect`/toString
get display(): string { return "Order " + this._note; }
get inspect(): string { return "Order(" + "id: " + String(this._id) + ", " + "note: " + "'" + this._note + "'" + ", " + "qty: " + String(this._qty) + ", " + "ssn: " + "<redacted>" + ", " + "version: " + String(this._version) + ")"; }
toString(): string { return this.inspect; }
[Symbol.for("nodejs.util.inspect.custom")](): string { return this.inspect; }
```
== dotnet
```csharp
// Domain/Orders/Order.cs — `Display` + synthesised `Inspect` delegated from ToString()
public string Display => "Order " + this.Note;
public string Inspect => "Order(" + "id: " + this.Id.ToString() + ", " + /* …structural, ssn: <redacted>… */ ")";
public override string ToString() => Inspect;
```
== java
```java
public String display() { return "Order " + this.note; }
public String inspect() { return "Order(" + "id: " + String.valueOf(this.id) + ", " + /* … */ ")"; }
@Override
public String toString() { return inspect(); }
```
== python
```python
@property
def display(self) -> str:
    return "Order " + self._note
@property
def inspect(self) -> str:
    return "Order(" + "id: " + str(self._id) + ", " + /* … */ ")"
def __repr__(self) -> str:
    return self.inspect
```
== elixir
```elixir
# lib/ex_api/orders/order.ex — emitted only because `ssn` is sensitive
defimpl Inspect, for: ExApi.Orders.Order do
  import Inspect.Algebra
  def inspect(record, _opts) do
    string("Order(" <> "id: " <> to_string(record.id) <> ", " <> "note: " <> "'" <> record.note <> "'" <> ", " <> "qty: " <> to_string(record.qty) <> ", " <> "ssn: " <> "<redacted>" <> ", " <> "version: " <> to_string(record.version) <> ")")
  end
end
# `display` is serialized inline by the controller: "display" => "Order " <> record.note
```
::: end

## `function` — a pure helper

`function name(params): Type = Expr` (expression form) or `function name(params): Type { let … return … }` (block form — `let` bindings, `precondition` / `requires`, and a mandatory `return`, `loom.function-block-no-return`) is a pure, side-effect-free helper callable from any expression in the same aggregate / value object — invariant predicates, derived expressions, operation bodies. The expression form is SQL-inlinable like a `criterion`; the block form is not queryable. It compiles to a private method on the aggregate (the backends keep it internal; it is not part of the public command surface).

A **top-level** `function` (declared at context / system scope, the ambient stdlib pattern — see [`../stdlib.md`](../stdlib.md)) must be expression-form (`loom.function-toplevel-block`) and inlines at its call sites, so it may not recurse (`loom.function-recursive`).

```ddd
aggregate Order {
  taxRate: decimal
  status: Status
  function isMutable(): bool = status == Status.Draft
  function fee(q: int): decimal {
    let base = decimal(q) * 2.5
    return base + taxRate
  }
}

valueobject Price {
  amount: decimal
  currency: string
  function withTax(rate: decimal): decimal = amount * (1 + rate)
}
```

::: tabs backend
== node
```ts
// domain/order.ts — decimal is a plain number on node
private isMutable(): boolean { return this._status === Status.Draft; }
private fee(q: number): number {
  const base = q * 2.5;
  return base + this._taxRate;
}
// domain/value-objects.ts
withTax(rate: number): number { return this.amount * (1 + rate); }
```
== dotnet
```csharp
// Domain/Orders/Order.cs
private bool IsMutable() => this.Status == Status.Draft;
private decimal Fee(int q)
{
    var @base = (decimal)q * 2.5m;
    return @base + this.TaxRate;
}
// Domain/ValueObjects/Price.cs
private decimal WithTax(decimal rate) => this.Amount * (1m + rate);
```
== java
```java
// features/orders/Order.java — decimal is BigDecimal
private boolean isMutable() {
    return this.status == Status.Draft;
}
private BigDecimal fee(int q) {
    var base = BigDecimal.valueOf(q).multiply(new BigDecimal("2.5"));
    return base.add(this.taxRate);
}
// domain/valueobjects/Price.java
private BigDecimal withTax(BigDecimal rate) {
    return this.amount.multiply((new BigDecimal("1").add(rate)));
}
```
== python
```python
# app/domain/order.py — underscore-prefixed; decimal is a float
def _is_mutable(self) -> bool:
    return self._status == Status.Draft

def _fee(self, q: int) -> float:
    base = float(q) * 2.5
    return base + self._tax_rate

# app/domain/value_objects.py
def with_tax(self, rate: float) -> float:
    return self.amount * (1 + rate)
```
== elixir
```elixir
# lib/ex_api/orders.ex — public context functions taking the struct first
@doc "Pure domain function `isMutable` on `Order`."
@spec is_mutable(ExApi.Orders.Order.t()) :: boolean()
def is_mutable(%ExApi.Orders.Order{} = record) do
  record.status == :Draft
end

@spec fee(ExApi.Orders.Order.t(), integer()) :: Decimal.t()
def fee(%ExApi.Orders.Order{} = record, _q) do
  base = Decimal.mult(Decimal.new(q), Decimal.new("2.5"))
  Decimal.add(base, record.tax_rate)
end
```
Honest gap: the block form underscore-prefixes a parameter the body reads (`_q` above), so a block-form function with a parameter does not compile on Phoenix today; the expression form is fine.
::: end

A `function` is the reusable-expression knob; for a reusable *predicate* shared across aggregates as a named specification, see [`criterion.md`](../criterion.md); for a stateless cross-aggregate calculator, see [Domain services](23-domain-services-and-seeds.md).
