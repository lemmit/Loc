# 3. Domain modeling

The core building blocks of a bounded context: `aggregate` roots (and their header modifiers), `valueobject`s, nested `entity` parts joined via `contains`, `event`s, `enum`s, and the field grammar — defaults, inline `check`s, access modifiers, and sensitivity tags. Reach for this chapter when you need to know exactly what a declaration emits: which table, which DTO, which fields cross the wire.

> **Grammar:** `Aggregate`, `ValueObject`, `EntityPart`, `EventDecl`, `EnumDecl`, `Property`, `Containment`, `FieldAccess`, `SensitivityClause` · **Validators:** `loom.bare-aggregate-in-type` · scope provider in [`src/language/ddd-scope.ts`](../../src/language/ddd-scope.ts) · **Docs:** [`../language.md`](../language.md)

Every backend reads the same fully-resolved IR, so the table layout is structurally identical across platforms — only the host-language member casing and idiom differ. The tabs below are **real generated output**; one system fixture with a `node`, `dotnet`, `java`, `python`, and `elixir` deployable over the same context produces every tab.

## `aggregate`

An `aggregate` is a consistency root. It owns a table, gets a synthetic `Name id` primary key automatically (you never declare `id`), and gets a repository. Header modifiers tune it: `ids guid|int|long|string` picks the id type (default `guid`), `persistedAs(eventLog|state)` the truth kind, `shape(relational|embedded|document)` the physical layout, and `inheritanceUsing(sharedTable|ownTable)` the TPH/TPC strategy (see [Inheritance](08-inheritance-and-polymorphism.md)).

```ddd
context Orders {
  aggregate Order {
    reference: string
  }
}
```

The implicit `id` is a branded/strongly-typed key (`guid` → UUID), the root gets a private constructor + a public `create(...)` factory + a `_create(state)` rehydrator, and a `pgTable` / EF entity is emitted with `id` as the primary key.

::: tabs backend
== node
```ts
// db/schema.ts
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey(),
  reference: text("reference").notNull(),
});
```
```ts
// domain/ids.ts — id is a branded string, minted by newOrderId()
export type OrderId = string & { readonly __brand: "OrderId" };
export const newOrderId = (): OrderId => uuidv7() as OrderId;
```
== dotnet
```csharp
// Domain/Orders/Order.cs
public sealed class Order
{
    public OrderId Id { get; private set; }
    public string Reference { get; private set; } = default!;
    // private ctor + State rehydrator + Create factory …
    public static Order Create(string reference) { /* … Id = new OrderId(Guid.CreateVersion7()); */ }
}
```
== java
```java
// domain/ids/OrderId.java is a value type; the table key is a UUID
public record OrderResponse(UUID id, String reference, /* … */) { /* … */ }
```
::: end

## `valueobject`

A `valueobject` is an immutable record with no identity, no table, and no repository of its own. It persists *inside* its owning aggregate — relationally as flattened, prefixed columns (`total: Money` → `total_amount`, `total_currency`), and on the wire as a nested object. Members are `Property` / `derived` / `invariant` / `function` — never operations (a VO has no lifecycle).

```ddd
context Orders {
  enum Currency { USD, EUR, GBP }
  valueobject Money {
    amount: decimal
    currency: Currency
  }
  aggregate Order {
    total: Money
  }
}
```

`total: Money` flattens into prefixed root columns; the type emits as an immutable record / embeddable.

::: tabs backend
== node
```ts
// domain/value-objects.ts — readonly fields, no setters
export class Money {
  constructor(
    public readonly amount: number,
    public readonly currency: Currency,
  ) {}
}
```
```ts
// db/schema.ts — flattened, prefixed onto the owner's table
total_amount: numeric("total_amount").notNull(),
total_currency: currencyEnum("total_currency").notNull(),
```
== dotnet
```csharp
// Domain/ValueObjects/Money.cs — record with init-only props
public sealed record Money
{
    public decimal Amount { get; init; }
    public Currency Currency { get; init; }
    public Money(decimal amount, Currency currency) { Amount = amount; Currency = currency; }
    private Money() { Amount = default!; Currency = default!; }  // EF/serializer ctor
}
```
== java
```java
// domain/valueobjects/Money.java — JPA-embeddable record
@Embeddable
@ValueObject
public record Money(BigDecimal amount, Currency currency) {}
```
== elixir
```elixir
# orders/money.ex — an embedded Ecto schema
defmodule ApiElixir.Orders.Money do
  use Ecto.Schema
  @primary_key false
  embedded_schema do
    field :amount, :decimal
    field :currency, ApiElixir.Orders.Currency
  end
end
```
::: end

## `entity` parts & `contains`

An `entity` part is a child entity with its own identity that has no independent existence — it lives only as a member of its aggregate. You declare the part inline, then bind it with `contains <name>: <Part>[]` (collection), `<Part>` (single), or `<Part>?` (optional). The part gets its own child table keyed back to the parent via a `parent_id` foreign key with `ON DELETE CASCADE` and an index. A part may carry its own `Property` / `check` / `invariant` / `derived` / `function`.

```ddd
context Orders {
  aggregate Order {
    reference: string

    entity Line {
      sku: string
      qty: int check qty > 0
    }

    contains lines: Line[]
  }
}
```

`Line` becomes its own table; `qty > 0` becomes a domain invariant on the `Line`'s constructor; the collection is owned (cascade-deleted with the parent).

::: tabs backend
== node
```ts
// db/schema.ts — child table, FK to parent, cascade + index
export const lines = pgTable("lines", {
  id: uuid("id").primaryKey(),
  parentId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  qty: integer("qty").notNull(),
}, (table) => ({
  lineOrderIdIdx: index("lines_order_id_idx").on(table.parentId),
}));
```
```ts
// domain/order.ts — the check lowers to an invariant on Line's ctor
private _assertInvariants(): void {
  if (!(this._qty > 0)) throw new DomainError("Invariant violated: qty check qty > 0");
}
// Order keeps an owned, read-only collection:
get lines(): readonly Line[] { return this._lines; }
```
== dotnet
```csharp
// Domain/Orders/Line.cs — own entity, parent id, check → AssertInvariants
public sealed class Line
{
    public LineId Id { get; private set; }
    public OrderId ParentId { get; private set; }
    public string Sku { get; private set; } = default!;
    public int Qty { get; private set; } = default!;
    private void AssertInvariants()
    {
        if (!(this.Qty > 0)) throw new DomainException("Invariant violated: qty check qty > 0");
    }
}
```
```csharp
// Domain/Orders/Order.cs — owned collection, exposed read-only
private readonly List<Line> _lines = new();
public IReadOnlyList<Line> Lines => _lines.AsReadOnly();
```
== elixir
```elixir
# orders/order.ex — has_many relationship to the child resource
relationships do
  has_many :lines, ApiElixir.Orders.Line
end
```
::: end

The generated SQL makes the parent/child shape explicit (node migration shown):

```sql
CREATE TABLE lines (
  id UUID NOT NULL,
  order_id UUID NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (order_id) REFERENCES orders ON DELETE CASCADE
);
CREATE INDEX lines_order_id_idx ON lines (order_id);
```

> Cross-*aggregate* links are **not** containment — they are `X id` reference fields (`productId: Product id`), enforced by `loom.bare-aggregate-in-type`. See [Type system](04-type-system.md) for `X id` and `X id[]` reference collections.

## `event`

An `event` is a flat record of named fields (`Property` only — no body, no methods) that an aggregate raises with `emit` inside an operation. It emits as a typed event record; the per-context union (`DomainEvent` / `IDomainEvent`) collects every event so the repository can drain and dispatch them.

```ddd
context Orders {
  event OrderPlaced {
    orderId: string
    total: decimal
  }
}
```

::: tabs backend
== node
```ts
// domain/events.ts — interface + a "type" tag + the context union
export interface OrderPlaced {
  readonly type: "OrderPlaced";
  readonly orderId: string;
  readonly total: number;
}
export type DomainEvent = OrderPlaced;
```
== dotnet
```csharp
// Domain/Events/OrderPlaced.cs — record implementing the marker interface
public sealed record OrderPlaced(string OrderId, decimal Total) : IDomainEvent;
```
== java
```java
// domain/events/OrderPlaced.java
public record OrderPlaced(String orderId, BigDecimal total) implements DomainEvent {}
```
::: end

Raising one (`emit OrderPlaced { … }`) and the `apply(e: OrderPlaced) { … }` folding pass are covered in [Behavior & statements](06-behavior-and-statements.md).

## `enum`

An `enum` is a closed set of bare-identifier values, referenced bare in expressions and defaults (`status := Confirmed`). It emits as a native enum on language backends and as a Postgres `pgEnum` / `HasConversion<string>()` column for the wire/DB layer — members re-quoted into string literals (the source `USD` arrives at the compiler as the 3-char string `USD`; see [Lexical structure](01-lexical-structure.md) §Literals).

```ddd
context Orders {
  enum Currency { USD, EUR, GBP }
  aggregate Order {
    currency: Currency
  }
}
```

::: tabs backend
== node
```ts
// domain/value-objects.ts — const object + literal-union type
export const Currency = { USD: "USD", EUR: "EUR", GBP: "GBP" } as const;
export type Currency = "USD" | "EUR" | "GBP";
```
```ts
// db/schema.ts — bare members re-quoted into a pgEnum
export const currencyEnum = pgEnum("currency", ["USD", "EUR", "GBP"]);
```
== dotnet
```csharp
// Domain/Enums/Currency.cs — a real CLR enum
public enum Currency { USD, EUR, GBP }
```
```csharp
// Persistence: stored as its string name
o.Property(x => x.Currency).HasConversion<string>().HasColumnName("currency");
```
== java
```java
// domain/enums/Currency.java
public enum Currency { USD, EUR, GBP }
```
== elixir
```elixir
# orders/currency.ex — Ecto.Enum; members are downcased atoms on the wire
defmodule ApiElixir.Orders.Currency do
  use Ecto.Type
  # backed by Ecto.Enum, values: [:usd, :eur, :gbp]
end
```
::: end

> **Casing divergence.** Node/dotnet/java keep the member name verbatim (`USD`); the Elixir backend lowercases members to atoms (`:usd`). Both round-trip consistently within a backend; the divergence is only visible if you compare wire payloads across backends.

## Fields (`Property`)

A field is `name: Type [provenanced] [sensitive(...)] [access] [= default] [check Expr]` — modifiers in that order. A `= default` value seeds the field when the client omits it; `check Expr` is a per-field validation predicate lowered to an invariant. (`provenanced` is covered in [`../provenance.md`](../provenance.md).)

```ddd
context Orders {
  aggregate Order {
    note: string = "pending"   // default
    reference: string          // required, no default
  }
}
```

The default surfaces in the input DTO (the field becomes optional, defaulting server-side) and as the value seeded when absent.

::: tabs backend
== node
```ts
// http/order.routes.ts — default lands on the zod input schema
const CreateOrderRequest = z.object({
  reference: z.string(),
  note: z.string().default("pending"),
  // …
});
```
== dotnet
```csharp
// Application/Orders/Requests/OrderRequests.cs — default on the record param
public sealed record CreateOrderRequest(
    [Required(AllowEmptyStrings = true)] string Reference,
    string Note = "pending",
    /* … */);
```
== elixir
```elixir
# orders/order.ex — default on the attribute
attribute :note, :string, allow_nil?: false, default: "pending"
```
::: end

A `check` on a field is exactly the inline form of a member `invariant` — both lower to the constructor guard shown under `contains` above (`qty: int check qty > 0` → `if (!(this._qty > 0)) throw …`). See [Invariants, derived & functions](07-invariants-derived-functions.md) for the full invariant surface.

## Access modifiers

Every field carries an access modifier governing its role across three shapes: the **create** input, the **update** wire, and the **read** projection. `editable` (the default, no keyword) is full client read+write. The five explicit modifiers:

| Modifier | Read (response) | Create input | Update wire | Stored |
|---|---|---|---|---|
| `editable` *(default)* | ✓ | ✓ | ✓ | ✓ |
| `immutable` | ✓ | ✓ | ✗ (set once) | ✓ |
| `managed` | ✓ | ✗ (server seeds) | ✗ | ✓ |
| `token` | ✓ | ✗ | ✓ (echoed, like `id`) | ✓ |
| `internal` | ✗ (never via API) | ✗ | ✗ | ✓ (views may read) |
| `secret` | ✗ (never disclosed) | ✓ | ✓ (write-only) | ✓ |

The synthetic `id` is hardcoded `token`. `managed` fields are server-seeded in the `create` factory (`datetime` → now, `int` → `0`); `secret` and `internal` are dropped from the read projection.

```ddd
context Orders {
  aggregate Order {
    reference: string                  // editable (default)
    slug: string immutable             // set once at creation
    createdAt: datetime managed        // server stamps it; not client-writable
    version: int token                 // round-tripped for optimistic concurrency
    couponCode: string secret          // accepted on write; never sent back
    internalScore: int internal        // hidden from clients
  }
}
```

The **create input** drops `managed` / `token` / `internal` (`createdAt`, `version`, `internalScore`) but keeps `secret` and `immutable` (`couponCode`, `slug`):

::: tabs backend
== node
```ts
// domain/order.ts — Create takes only the client-writable fields;
// managed/token/internal are seeded server-side
static create(input: { reference: string; /* total, currency, note */ couponCode: string; slug: string; email: string }): Order {
  return new Order({
    id: Ids.newOrderId(),
    // …
    createdAt: new Date(),   // managed datetime → now()
    version: 0,              // token int → 0
    internalScore: 0,        // internal int → 0
    // …
  });
}
```
== dotnet
```csharp
// Domain/Orders/Order.cs — Create signature omits managed/token/internal
public static Order Create(string reference, /* … */ string couponCode, string slug, string email)
// CreateOrderRequest record likewise: CouponCode + Slug present; CreatedAt/Version/InternalScore absent
```
== python
```python
# http/order_routes.py
class CreateOrderRequest(BaseModel):
    reference: str
    # …
    couponCode: str   # secret: accepted on input
    slug: str         # immutable: set on create
    email: str
    # createdAt / version / internalScore are NOT accepted
```
::: end

The **read projection** drops `secret` and `internal` (`couponCode`, `internalScore`) but keeps `managed` / `token` / `immutable`:

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — toWire() omits couponCode + internalScore
toWire(root: Order): unknown {
  return { id: root.id as string, reference: root.reference, /* total, currency, note */
           createdAt: (root.createdAt as Date).toISOString(), version: root.version,
           slug: root.slug, email: root.email, lines: /* … */ };
}
```
== dotnet
```csharp
// Application/Orders/Responses/OrderResponses.cs — no CouponCode, no InternalScore
public sealed record OrderResponse(
    [property: Required] Guid Id, [property: Required] string Reference, /* … */
    [property: Required] string CreatedAt, [property: Required] int Version,
    [property: Required] string Slug, [property: Required] string Email,
    [property: Required] IReadOnlyList<LineResponse> Lines);
```
== python
```python
# http/order_routes.py — OrderResponse omits couponCode + internalScore
class OrderResponse(BaseModel):
    id: str
    reference: str
    # …
    createdAt: str
    version: int
    slug: str
    email: str
    lines: list[LineResponse]
```
::: end

> **Honest cross-backend gap.** The read-projection drop of `secret` / `internal` holds on **node, dotnet, and python**. The **java** and **elixir** response shapes currently include `couponCode` / `internalScore` (Java's `OrderResponse` record and Elixir's `Jason.Encoder` field list emit the full attribute set). Treat the wire-redaction guarantee as node/dotnet/python today; do not rely on it for the java/elixir responses.

## `sensitive(...)`

`sensitive(tag1, tag2, …)` tags a field with one or more information-flow classifications. Tags are bare identifiers, opaque to the compiler — `pii`, `phi`, `cred`, `audited` are conventional but any identifier is accepted. The downstream effect today: the field is **redacted in the aggregate's `inspect` / `ToString()` debug form** (so it never lands in logs, exceptions, or debugger watches). It is orthogonal to access — combine `sensitive(...) secret` for a field that is both write-only and log-redacted.

```ddd
context Orders {
  aggregate Order {
    reference: string
    email: string sensitive(pii)
  }
}
```

The generated `inspect` renders `email` as `<redacted>` while other fields show their value:

::: tabs backend
== node
```ts
// domain/order.ts (excerpt of the inspect getter)
get inspect(): string {
  return "Order(" + "id: " + String(this._id) + ", "
       + "reference: " + "'" + this._reference + "'" + ", "
       + "email: " + "<redacted>" + ", " + /* … */ + ")";
}
```
== dotnet
```csharp
// Domain/Orders/Order.cs (excerpt of the Inspect string)
public string Inspect => "Order(" + "id: " + this.Id.ToString() + ", "
    + "reference: " + "'" + this.Reference + "'" + ", "
    + "email: " + "<redacted>" + ", " + /* … */ + ")";
public override string ToString() => Inspect;
```
== elixir
```elixir
# orders/order.ex (excerpt of inspect/1)
def inspect(record) do
  "Order(" <> "id: " <> to_string(record.id) <> ", "
    <> "email: " <> "<redacted>" <> ", " <> # …
end
```
::: end

The field is still stored and (subject to its access modifier) still crosses the API wire — `sensitive(...)` governs the *debug* representation, not the response projection. See [`../language.md`](../language.md) §"Sensitivity" and [`../provenance.md`](../provenance.md) for the broader compliance surface.
