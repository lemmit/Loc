# 4. The type system

Every type position in the language: the nine primitive scalars, the distinct `money` type that is precise in the column but a string on the wire, `X id` cross-aggregate references, collections and options, and the closed set of postfix generic carriers `paged` / `envelope` / `option`. Reach for it when you need to know what column a field becomes, why `money` serializes differently than `decimal`, or how a carrier projects onto each backend.

> **Grammar:** `TypeRef`, `TypeAtom`, `BaseType`, `PrimitiveType`, `IdType`, `NamedType`, `GenericCtor` · **Validators:** type-system checks in `src/language/type-system.ts`; `loom.bare-aggregate-in-type`, `loom.generic-*`, `loom.union-*` · **Docs:** [`../payloads.md`](../payloads.md)

A `TypeRef` is one `BaseType` head atom, followed by zero or more postfix carrier constructors, an optional `[]` array marker, an optional `?` nullable marker, and an optional `or`-union tail — in that fixed order. Carriers and the array/optional markers bind **tighter** than `or` (`string or int option` ≡ `string or (int option)`). The head `BaseType` is one of: a `PrimitiveType`, an `X id` (`IdType`), or a bare `NamedType` (enum / value object / part). All examples below are generated from one scratch system with a backend deployable per platform; output is excerpted.

## Primitive scalars

Nine primitives: `int`, `long`, `decimal`, `money`, `string`, `bool`, `datetime`, `guid`, `json`. Each maps to a host-language type, a wire (DTO) type, and a SQL column per backend.

```ddd
aggregate Order {
  qty: int
  bigQty: long
  rate: decimal
  total: money
  ref: string
  active: bool
  placedAt: datetime
  externalId: guid
  meta: json
}
```

The SQL column types (shared `MigrationsIR`, identical DDL on every backend with a database):

```sql
qty INTEGER NOT NULL,
big_qty BIGINT NOT NULL,
rate DECIMAL NOT NULL,
total DECIMAL NOT NULL,
ref TEXT NOT NULL,
active BOOLEAN NOT NULL,
placed_at TIMESTAMP WITH TIME ZONE NOT NULL,
external_id UUID NOT NULL,
meta JSONB NOT NULL,
```

The host-language field/column declarations:

::: tabs backend
== node
```ts
// db/schema.ts — Drizzle pg-core. money carries explicit precision (see below).
qty: integer("qty").notNull(),
bigQty: bigint("big_qty", { mode: "number" }).notNull(),
rate: numeric("rate").notNull(),
ref: text("ref").notNull(),
active: boolean("active").notNull(),
placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
externalId: uuid("external_id").notNull(),
meta: jsonb("meta").notNull(),
```
== dotnet
```csharp
// Domain/Orders/Order.cs
public int Qty { get; private set; } = default!;
public long BigQty { get; private set; } = default!;
public decimal Rate { get; private set; } = default!;
public string Ref { get; private set; } = default!;
public bool Active { get; private set; } = default!;
public DateTime PlacedAt { get; private set; } = default!;
public Guid ExternalId { get; private set; } = default!;
public System.Text.Json.JsonElement Meta { get; private set; } = default!;
```
== java
```java
// features/orders/Order.java — JPA entity
@Column(name = "qty")          int qty;
@Column(name = "big_qty")      long bigQty;
@Column(name = "rate")         BigDecimal rate;
@Column(name = "ref")          String ref;
@Column(name = "active")       boolean active;
@Column(name = "placed_at")    Instant placedAt;
@Column(name = "external_id")  UUID externalId;
@Column(name = "meta")         JsonNode meta;
```
== python
```python
# app/db/schema.py — SQLAlchemy mapped columns
qty:         Mapped[int]      = mapped_column(Integer)
big_qty:     Mapped[int]      = mapped_column(BigInteger)
rate:        Mapped[Decimal]  = mapped_column(Numeric)
ref:         Mapped[str]      = mapped_column(Text)
active:      Mapped[bool]     = mapped_column(Boolean)
placed_at:   Mapped[datetime] = mapped_column(DateTime)
external_id: Mapped[str]      = mapped_column(Uuid)
# domain holds rate as float, meta as object
```
== elixir
```elixir
# lib/.../orders/order.ex — Ecto schema fields
field :qty,         :integer
field :big_qty,     :integer
field :rate,        :decimal
field :ref,         :string
field :active,      :boolean
field :placed_at,   :utc_datetime
field :external_id, Ecto.UUID
field :meta,        :map
```
::: end

Two cross-backend notes worth calling out: `json` is an **opaque blob** — `JSONB` in SQL, never structurally expanded (`z.unknown()` / `JsonElement` / `JsonNode` / `object` / `:map`); and Python alone widens `decimal` to a host `float` (`rate: float`) while keeping the `Numeric` column, where the other backends carry a precise host decimal (`Decimal` / `BigDecimal`).

## `money` — precise column, string on the wire

`money` is **not** `decimal`. It is a distinct primitive with two guarantees: the **column is a precise decimal** (`DECIMAL(19, 4)` where the backend lets you pin it), and the **wire representation is a string**, never a float — so no JSON-number rounding can corrupt a currency amount in transit. The matching literal form is `money("10.50")` (a `STRING` argument, never a `DECIMAL`); see [Lexical structure](01-lexical-structure.md).

```ddd
aggregate Order {
  total: money
}
```

The column pins precision `19, 4` where the ORM exposes it:

::: tabs backend
== node
```ts
// db/schema.ts — explicit precision/scale, unlike a bare `decimal`
total: numeric("total", { precision: 19, scale: 4 }).notNull(),
```
== dotnet
```csharp
// Domain/Orders/Order.cs — precise host decimal
public decimal Total { get; private set; } = default!;
```
== java
```java
// features/orders/Order.java
@Column(name = "total") BigDecimal total;
```
== python
```python
# app/db/schema.py — Numeric(19, 4), unlike bare `Numeric` for decimal
total: Mapped[Decimal] = mapped_column(Numeric(19, 4))
```
== elixir
```elixir
# lib/.../orders/order.ex
field :total, :decimal
```
::: end

The contrast that matters is the **wire** type. On the response DTO, `total` is a **string** on the backends that drive a typed serializer (node / .NET / Java), even though the in-memory value is a precise decimal:

::: tabs backend
== node
```ts
// http/order.routes.ts — money field is z.string(), not z.number()
export const OrderResponse = z.object({
  rate: z.number(),     // decimal → number
  total: z.string(),    // money   → string
  // …
});
```
== dotnet
```csharp
// Application/Orders/Responses/OrderResponses.cs — string on the wire record
public sealed record OrderResponse(
    [property: Required] decimal Rate,
    [property: Required] string Total,   // money → string
    /* … */);
// RecentHandler projects it: d.Total.ToString(CultureInfo.InvariantCulture)
```
== java
```java
// features/orders/OrderResponse.java — String, serialized via toPlainString()
public record OrderResponse(BigDecimal rate, String total, /* … */) {
  public static OrderResponse from(Order value) {
    return new OrderResponse(value.rate(),
        value.total().toPlainString(),   // money → string
        /* … */);
  }
}
```
== python
```python
# app/http/order_routes.py — honest gap: FastAPI's OrderResponse emits
# `total: float`, not a string. The CreateOrderRequest input is `Decimal`,
# but the response model widens money to float.
class OrderResponse(BaseModel):
    rate: float
    total: float
```
== elixir
```elixir
# Phoenix serializes the :decimal field through Jason on the struct itself
# (no per-field stringify seam in this REST-less LiveView output); the
# precise column is the guarantee here, the string-on-wire is not enforced.
field :total, :decimal
```
::: end

So three backends (node, .NET, Java) deliver the full money contract — precise column **and** string wire. Python keeps the precise column but serializes the response field as a `float`; Elixir keeps the precise column and serializes via Jason's `Decimal` encoder. Treat string-on-wire as guaranteed on the typed-serializer backends.

## `X id` — cross-aggregate references

A reference to another aggregate is spelled `Target id` (`IdType`), never the bare aggregate name. The custom scope provider rejects a bare cross-aggregate type with `loom.bare-aggregate-in-type` — a bare `NamedType` resolves only to enums, value objects, and entity parts in the *same* aggregate. `X id` lowers to the target's primary-key value type (a `guid` here) and produces a real foreign key plus, on the typed backends, a strongly-typed id wrapper.

```ddd
aggregate Customer { name: string }

aggregate Order {
  customer: Customer id
}
```

The reference is a `uuid`/`UUID` column with an FK constraint:

```sql
customer UUID NOT NULL,
FOREIGN KEY (customer) REFERENCES orders.customers ON DELETE RESTRICT
```

The host member is a wrapped id, not a raw `Guid`/`UUID`:

::: tabs backend
== node
```ts
// db/schema.ts — plain uuid column; the id branding lives in the domain layer
customer: uuid("customer").notNull(),
```
== dotnet
```csharp
// Domain/Orders/Order.cs — strongly-typed CustomerId
public CustomerId Customer { get; private set; } = default!;
// OrderConfiguration.cs — EF value converter to/from the raw Guid column
builder.Property(x => x.Customer)
    .HasConversion(v => v.Value, v => new CustomerId(v))
    .HasColumnName("customer");
```
== java
```java
// features/orders/Order.java — @AttributeOverride maps the CustomerId VO's
// `value` onto the `customer` column
@AttributeOverride(name = "value", column = @Column(name = "customer"))
CustomerId customer;
```
== python
```python
# domain holds the wrapped id; the route unwraps on create
customer: CustomerId            # app/domain/order.py
# CustomerId(body.customer)     # app/http/order_routes.py
```
== elixir
```elixir
# Ecto stores the reference as a plain :binary_id field
field :customer, Ecto.UUID
```
::: end

On the wire the reference flattens to its id value (`customer: z.string()` / `Guid Customer` / `UUID customer`).

## Collections — `T[]`

A trailing `[]` makes the field an array. For scalar/enum elements this is a native array column.

```ddd
aggregate Order {
  tags: string[]
}
```

```sql
tags TEXT[] NOT NULL,
```

::: tabs backend
== node
```ts
tags: text("tags").array().notNull(),   // db/schema.ts
// OrderResponse: tags: z.array(z.string())
```
== dotnet
```csharp
public List<string> Tags { get; private set; } = default!;
// OrderResponse: IReadOnlyList<string> Tags
```
== java
```java
@Column(name = "tags") List<String> tags;   // OrderResponse: List<String> tags
```
== python
```python
tags: list[str]                              # OrderResponse: tags: list[str]
```
== elixir
```elixir
attribute :tags, {:array, :string}, allow_nil?: false
```
::: end

An array of **references** — `X id[]` — is different: enrichment derives a join-table association for it rather than an inline array column. See [`../payloads.md`](../payloads.md) and the association derivation in enrichment (phase ⑥).

## Options — `T?`

A trailing `?` makes the field nullable: a `NULL`-able column and an optional/nullable host member and wire field. (`T?` is distinct from the `option` *carrier* below — `?` is a nullable field, `option` is a tagged variant.)

```ddd
aggregate Order {
  notes: string?
}
```

```sql
notes TEXT NULL,
```

::: tabs backend
== node
```ts
notes: text("notes"),                 // no .notNull()
// OrderResponse: notes: z.string().nullish()
```
== dotnet
```csharp
public string? Notes { get; private set; }   // no `= default!`, no [Required]
```
== java
```java
@Column(name = "notes") String notes;         // nullable record component
```
== python
```python
notes: str | None                             # OrderResponse: notes: str | None = None
```
== elixir
```elixir
attribute :notes, :string, allow_nil?: true
```
::: end

## Generic carriers — `paged`, `envelope`, `option`

Three **carrier-bounded generic payloads** are built in, instantiated ML-postfix (the keyword follows its argument): `T paged`, `T envelope`, `T option`. A carrier may appear only in a **transport position** — a repository `find` return type or a payload field — never as a stored aggregate property (`loom.generic-position`). The argument must itself be a carrier (a primitive, an `X id`, an enum, a value object, or an aggregate, which projects through its `<Agg>Wire`); a nested or non-carrier argument is rejected (`loom.generic-arg-not-carrier`). The pinned shapes:

```
paged(T)    → { items: T[]; page: int; pageSize: int; total: int; totalPages: int }   # 1-based
envelope(T) → { id: string; ts: datetime; body: T }
option(T)   → the 2-variant tagged union  union[T, none]
```

```ddd
repository OrderRepo for Order {
  find recent(): Order paged
  find audit(): Order envelope
  find byRef(ref: string): Order option
}
```

### `paged`

No backend serializes its framework-native paging type — each maps to the one DTO above.

::: tabs backend
== node
```ts
// http/order.routes.ts
export const OrderPaged = z.object({
  items: z.array(OrderResponse), page: z.number(), pageSize: z.number(),
  total: z.number(), totalPages: z.number(),
}).openapi("OrderPaged");
// a paged find auto-gains page/pageSize query controls (defaults 1 / 20)
```
== dotnet
```csharp
// Domain/Common — one shared record, reused by every paged find
public sealed record Paged<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total, int TotalPages);
// RecentQuery : IQuery<Paged<OrderResponse>>; the handler maps EF Skip/Take + CountAsync onto it
```
== java
```java
// domain/common/Paged.java
public record Paged<T>(List<T> items, int page, int pageSize, int total, int totalPages) {}
```
== python
```python
# app/db/paging.py
@dataclass(frozen=True)
class PagedResult[T]:
    items: list[T]; page: int; page_size: int; total: int; total_pages: int
# OrderPaged BaseModel mirrors it onto the wire (items/page/pageSize/total/totalPages)
```
== elixir
```elixir
# Ecto offset pagination query; the controller maps the limit/offset page to the envelope
def recent(opts) do
  Order |> limit(^opts.page_size) |> offset(^opts.offset) |> Repo.all()
end
```
::: end

### `envelope`

The pinned contract is `envelope(T) → { id, ts, body }`. **Honest gap:** in the generated output for a plain `find audit(): Order envelope`, the backends here do **not** project the `{ id, ts, body }` wrapper onto the route — the find returns the bare body (`OrderResponse`) on both Hono and .NET:

::: tabs backend
== node
```ts
// http/order.routes.ts — the envelope find's route schema is bare OrderResponse,
// not the { id, ts, body } wrapper
200: { description: "OK", content: { "application/json": { schema: OrderResponse } } },
// return c.json(repo.toWire(result) as z.infer<typeof OrderResponse>, 200);
```
== dotnet
```csharp
// Api/OrdersController.cs + Application/Orders/Queries/AuditQuery.cs
[HttpGet("audit")]
public async Task<ActionResult<OrderResponse>> AuditOrder()   // bare OrderResponse
// public sealed record AuditQuery() : IQuery<OrderResponse>;
```
::: end

> Treat `{ id, ts, body }` as the carrier's intended contract, but verify the specific backend's `envelope` route emission against fresh `main` — it is the least uniformly projected of the three carriers, and this configuration emits the unwrapped body.

### `option`

`T option` is sugar for the 2-variant tagged union `union[T, none]` — it flows through the same union machinery as `A or B`, not through the nullable `?` path. Every variant serializes with a **`type` discriminator**: a record variant flattens its fields alongside `type`, and the `none` unit is bare `{ "type": "none" }`. The variant tag is the variant type's name.

::: tabs backend
== node
```ts
// http/order.routes.ts
export const OrderOrnone = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Order"), id: z.string(), /* …Order wire… */ }),
  z.object({ type: z.literal("none") }),
]).openapi("OrderOrnone");
// route returns { type: "Order", ...repo.toWire(result) }
```
== dotnet
```csharp
// Application/Orders/Responses/OrderOrnone.cs
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(OrderOrnone_Order), "Order")]
[JsonDerivedType(typeof(OrderOrnone_none), "none")]
public abstract record OrderOrnone;
public sealed record OrderOrnone_Order(/* …Order fields… */) : OrderOrnone;
public sealed record OrderOrnone_none() : OrderOrnone;
```
== java
```java
// features/orders/OrderOrnoneResponse.java
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
  @JsonSubTypes.Type(value = OrderOrnoneResponse_Order.class, name = "Order"),
  @JsonSubTypes.Type(value = OrderOrnoneResponse_none.class, name = "none"),
})
public sealed interface OrderOrnoneResponse
    permits OrderOrnoneResponse_Order, OrderOrnoneResponse_none {}
```
== python
```python
# app/http/order_routes.py — the find returns the tagged record
async def by_ref_orders(ref: str, ...):
    if (found := await repo.by_ref(ref)) is None:
        raise AggregateNotFoundError("not_found")
    return {"type": "Order", **repo.to_wire(found)}
```
::: end

The same tagged-wire machinery backs the anonymous `A or B` union and the named `payload F = A | B` form — all three produce one discriminated wire shape. The full union surface (variant kinds, precedence, position rules, the `loom.union-*` validators) lives in [`../payloads.md`](../payloads.md).
