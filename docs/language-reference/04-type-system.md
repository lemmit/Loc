# 4. The type system

Every type position in the language: the ten primitive scalars (plus the expression-only `duration`), the distinct `money` type that is precise in the column and a fixed-scale string on the wire, `X id` cross-aggregate references, collections and options, and the closed set of postfix generic carriers `paged` / `envelope` / `option`. Reach for it when you need to know what column a field becomes, why `money` serializes differently than `decimal`, or how a carrier projects onto each backend.

> **Grammar:** `TypeRef`, `TypeAtom`, `BaseType`, `PrimitiveType`, `IdType`, `NamedType`, `GenericCtor`, `DURATION` (the `timerSource` literal) · **Validators:** type-system checks in `src/language/type-system.ts`; `loom.bare-aggregate-in-type`, `loom.generic-position`, `loom.generic-arg-not-carrier`, `loom.union-*`, `loom.intrinsic-nullable-receiver`, `loom.duration-arity` / `loom.duration-arg-type`, `loom.file-field-needs-object-storage`, `loom.token-nullable`, `loom.repository-find-deprecated` · **Docs:** [`../payloads.md`](../payloads.md), [`../conformance-semantics.md`](../conformance-semantics.md) (RS-12 / RS-24 — the numeric wire rules), [`../resources.md`](../resources.md) (`File` storage)

A `TypeRef` is one `BaseType` head atom, followed by zero or more postfix carrier constructors, an optional `[]` array marker, an optional `?` nullable marker, and an optional `or`-union tail — in that fixed order. Carriers and the array/optional markers bind **tighter** than `or` (`string or int option` ≡ `string or (int option)`). The head `BaseType` is one of: a `PrimitiveType`, an `X id` (`IdType`), a bare `NamedType` (enum / value object / part; an event or payload only in the transport positions that admit them), or the UI-only `slot` / `action` / capability-only `Self id`. All examples below are generated from one scratch system with a backend deployable per platform; output is excerpted.

## Primitive scalars

Ten primitives: `int`, `long`, `decimal`, `money`, `string`, `bool`, `datetime`, `guid`, `json`, `File`. Each maps to a host-language type, a wire (DTO) type, and a SQL column per backend. (`duration` is a type in the expression language — the result of `days(3)` or `datetime - datetime` — but not a declarable field type; see [`duration`](#duration--expression-only).)

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

The SQL column types (shared `MigrationsIR`, identical DDL on every backend with a database — every context lives in its own Postgres schema):

```sql
CREATE TABLE "orders"."orders" (
  "id" UUID NOT NULL,
  "qty" INTEGER NOT NULL,
  "big_qty" BIGINT NOT NULL,
  "rate" DECIMAL NOT NULL,
  "total" DECIMAL(19, 4) NOT NULL,
  "ref" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL,
  "placed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "external_id" UUID NOT NULL,
  "meta" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,        -- implicit optimistic-concurrency counter
  PRIMARY KEY ("id")
);
```

The host-language field/column declarations:

::: tabs backend
== node
```ts
// db/schema.ts — Drizzle pg-core. money carries explicit precision (see below).
qty: integer("qty").notNull(),
bigQty: bigint("big_qty", { mode: "number" }).notNull(),
rate: numeric("rate").notNull(),
total: numeric("total", { precision: 19, scale: 4 }).notNull(),
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
public decimal Total { get; private set; } = default!;
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
@Column(name = "total")        BigDecimal total;
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
total:       Mapped[Decimal]  = mapped_column(Numeric(19, 4))
ref:         Mapped[str]      = mapped_column(Text)
active:      Mapped[bool]     = mapped_column(Boolean)
placed_at:   Mapped[datetime] = mapped_column(DateTime(timezone=True))
external_id: Mapped[str]      = mapped_column(Uuid(as_uuid=False))
meta:        Mapped[object]   = mapped_column(JSONB)
# app/domain/order.py holds rate as float, total as Decimal, meta as object
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex — Ecto schema fields
field :qty,         :integer
field :big_qty,     :integer
field :rate,        :decimal
field :total,       :decimal
field :ref,         :string
field :active,      :boolean
field :placed_at,   :utc_datetime
field :external_id, Ecto.UUID
field :meta,        :map
```
::: end

`json` is an **opaque blob** — `JSONB` in SQL, never structurally expanded (`z.unknown()` / `JsonElement` / `JsonNode` / `object` / `:map`).

### Numeric representation rules

The four numeric types follow one cross-cutting contract (`docs/conformance-semantics.md` RS-12 / RS-24; audited in [`numeric-types-audit-2026-08-23`](../audits/numeric-types-audit-2026-08-23.md)):

| Type | Column | JSON wire | Domain representation — node / dotnet / java / python / elixir |
|---|---|---|---|
| `int` | `INTEGER` | integer | `number` / `int` / `int` / `int` / integer |
| `long` | `BIGINT` | integer | JS `number` (`bigint(…, { mode: "number" })`) / `long` / `long` / `int` / integer |
| `decimal` | `DECIMAL` | **number** (float64, lossy by design) | `number` / `System.Decimal` (→ `double` on the response) / `BigDecimal` (→ `double` on the response) / `float` (column `Decimal`) / `%Decimal{}` (→ `Decimal.to_float` on the response) |
| `money` | `DECIMAL(19, 4)` | **string**, always 4 decimals (`"12.5000"`) | decimal.js `Decimal` / `decimal` / `BigDecimal` / `Decimal` / `%Decimal{}` |

**Widening.** `int → long → decimal` is implicit (`isAssignable` in `type-system.ts`); `money` is a closed type that never joins the chain. Integral division widens to `decimal` (`5 / 2` is `2.5` on every backend, so `derived half: int = a / b` is a type error — declare it `decimal` or use `a.divTrunc(b)`); `+ - * %` stay int-preserving. Money arithmetic admits only `money ± money`, `money × {int|long|decimal}` (commutative) and `money ÷ {int|long|decimal}` — `total + rate` with `rate: decimal` is rejected (*Allowed for money: money ± money, money × {int|long|decimal}, money ÷ {int|long|decimal}*). Bare numeric literals promote to the typed position they sit in (`subtotal >= 0` with `subtotal: money`). The operator surface is [Expressions](05-expressions.md#arithmetic--widening).

## `money` — precise column, string on the wire

`money` is **not** `decimal`. It is a distinct primitive with two guarantees: the **column is `DECIMAL(19, 4)`** (`MONEY_WIRE_SCALE`, `src/generator/money-scale.ts`), and the **wire representation is a string at a fixed scale of 4** (`"12.5"`, `"12.50"` and `"12"` all read back as `"12.5000"`, rounded half-away-from-zero) — never a float, so no JSON-number rounding can corrupt an amount in transit. The matching literal form is `money("10.50")` (a `STRING` argument, never a `DECIMAL`); see [Lexical structure](01-lexical-structure.md). `money` carries no currency dimension; pair it with a `Currency` enum in a value object when you need one.

```ddd
aggregate Order {
  rate: decimal
  total: money
}
```

The column pins precision `19, 4` where the ORM exposes it (the shared DDL always does):

::: tabs backend
== node
```ts
// db/schema.ts — explicit precision/scale, unlike a bare `decimal`
total: numeric("total", { precision: 19, scale: 4 }).notNull(),
```
== dotnet
```csharp
// Domain/Orders/Order.cs — precise host decimal; the column type comes from the shared migration
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
# priv/repo/migrations/…_create_orders.exs
add :total, :decimal, precision: 19, scale: 4, null: false
```
::: end

The contrast that matters is the **wire** type. On the response DTO `total` is a **string** and `rate` a **number** on all five backends — each backend narrows its decimal to a double and fixes money to scale 4 at the response boundary:

::: tabs backend
== node
```ts
// http/order.routes.ts — money field is z.string(), not z.number()
export const OrderResponse = z.object({
  rate: z.number(),     // decimal → number
  total: z.string(),    // money   → string
  // …
});
// db/repositories/order-repository.ts — toWire(): rate: root.rate, total: root.total.toFixed(4)
```
== dotnet
```csharp
// Application/Orders/Responses/OrderResponses.cs
public sealed record OrderResponse(
    [property: Required] double Rate,    // decimal → double
    [property: Required] string Total,   // money   → string
    /* … */);
// GetOrderByIdHandler.cs projects it:
//   double.Parse(found.Rate.ToString(InvariantCulture), InvariantCulture),
//   found.Total.ToString("F4", InvariantCulture)
```
== java
```java
// features/orders/OrderResponse.java
public record OrderResponse(double rate, String total, /* … */) {
  public static OrderResponse from(Order value) {
    return new OrderResponse(
        value.rate().doubleValue(),                                            // decimal → double
        value.total().setScale(4, java.math.RoundingMode.HALF_UP).toPlainString(), // money → string
        /* … */);
  }
}
```
== python
```python
# app/http/order_routes.py
class OrderResponse(BaseModel):
    rate: float
    total: str

# app/db/wire.py — to_wire() calls money_str(root.total)
def money_str(amount: Decimal) -> str:
    return format(amount.quantize(Decimal("1e-4"), rounding="ROUND_HALF_UP"), "f")
```
== elixir
```elixir
# lib/api_elixir_web/api/schemas/order_response.ex
rate:  %OpenApiSpex.Schema{type: :number, format: :double},
total: %OpenApiSpex.Schema{type: :string, format: :decimal},

# lib/api_elixir_web/controllers/order_controller.ex — serialize/1
"rate"  => __decimal_num(record.rate),     # Decimal.to_float/1
"total" => __money_round(record.total),    # Decimal.round(dec, 4); Jason encodes a Decimal as a string
```
::: end

On the frontends a money value is displayed **verbatim from the wire** (`moneyText` in `src/lib/format.*` — no invented currency symbol, no 2-decimal truncation), and money form inputs submit the string. A `decimal` field, by contrast, is a JSON number in both directions.

## `duration` — expression-only

`duration` is the type of a temporal span. It has no field syntax (`d: duration` does not resolve) and no column; it exists so `datetime` arithmetic type-checks. It is produced by the intrinsics `days(n)` / `hours(n)` / `minutes(n)` (an `int` amount — `days(1.5)` is `loom.duration-arg-type`: *Fractional spans are written in the finer unit ('hours(36)', not 'days(1.5)')*; the wrong arity is `loom.duration-arity`) and by `datetime - datetime`. The closed rules (`temporalArithmetic` in `type-system.ts`): `datetime ± duration → datetime`, `datetime - datetime → duration`, `duration ± duration → duration`, `duration × int → duration`; everything else is rejected. Calendar-relative units (`months`, `years`) are deliberately absent — every unit is absolute. (The `DURATION` *token* — `15s`, `5m`, `1h` — is a separate literal admitted only in a `timerSource`'s `every:` clause; [Channels](14-apis-storage-resources-channels.md).)

```ddd
aggregate Order {
  placedAt: datetime
  derived dueAt: datetime = placedAt + days(3)
  derived overdue: bool = now() - placedAt > hours(48)
}
```

::: tabs backend
== node
```ts
// domain/order.ts — milliseconds arithmetic on Date
get dueAt(): Date { return new Date((this._placedAt).getTime() + (((3) * 86400000))); }
get overdue(): boolean { return ((new Date()).getTime() - (this._placedAt).getTime()) > ((48) * 3600000); }
```
== dotnet
```csharp
// Domain/Orders/Order.cs — TimeSpan
public DateTime DueAt => this.PlacedAt + TimeSpan.FromDays(3);
public bool Overdue => DateTime.UtcNow - this.PlacedAt > TimeSpan.FromHours(48);
```
== java
```java
// features/orders/Order.java — java.time.Duration
public Instant dueAt() { return this.placedAt.plus(Duration.ofDays(3)); }
public boolean overdue() { return Duration.between(this.placedAt, Instant.now()).compareTo(Duration.ofHours(48)) > 0; }
```
== python
```python
# app/domain/order.py — timedelta
def due_at(self) -> datetime:
    return self._placed_at + timedelta(days=(3))
def overdue(self) -> bool:
    return datetime.now(UTC) - self._placed_at > timedelta(hours=(48))
```
== elixir
```elixir
# lib/api_elixir_web/controllers/order_controller.ex — derived values are computed at serialize time
"dueAt" => DateTime.add(record.placed_at, ((3) * 86400000), :millisecond),
```
::: end

## `File` — a stored object reference

`File` is a primitive modelled on `json`: a JSONB-backed, wire-only value with no expression semantics, whose wire shape is the fixed record `FileRef = { url, key, contentType, size }`. The bytes live in an object store — a deployable hosting a `File`-bearing aggregate must bind a `kind: objectStore` dataSource (`storage blobs { type: localDisk }` or `s3`), else `loom.file-field-needs-object-storage`. Every backend then serves `POST /files` (multipart → `FileRef`) and `GET /files/{key}`; the page-side `FileUpload` / `FileLink` primitives are in [UI walker primitives](16-ui-walker-primitives.md).

```ddd
aggregate Order {
  reference: string
  attachment: File
}
// system level:
//   storage blobs { type: localDisk }
//   resource ordersFiles { for: Orders, kind: objectStore, use: blobs }
//   deployable api { … dataSources: [ordersState, ordersFiles] }
```

::: tabs backend
== node
```ts
// db/schema.ts
attachment: jsonb("attachment").notNull(),
// http/order.routes.ts — the FileRef wire record, expanded inline
attachment: z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() }),
```
== dotnet
```csharp
// Domain/Common — one shared record
public sealed record FileRef(string Url, string Key, string ContentType, long Size);
// Domain/Orders/Order.cs
public FileRef Attachment { get; private set; } = default!;
```
== java
```java
// features/orders/Order.java
FileRef attachment;
```
== python
```python
# app/domain/file_ref.py
class FileRef(TypedDict): ...
# app/db/schema.py
attachment: Mapped[FileRef] = mapped_column(JSONB)
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex
field :attachment, :map
```
::: end

## `X id` — cross-aggregate references

A reference to another aggregate is spelled `Target id` (`IdType`), never the bare aggregate name. The structural validator rejects a bare cross-aggregate type with `loom.bare-aggregate-in-type` (*References across aggregate boundaries need an id link — write 'Customer id' (or 'Customer id[]' for many-to-many)*) — a bare `NamedType` resolves only to enums, value objects, and entity parts in the *same* aggregate. `X id` lowers to the target's primary-key value type (always `guid`) and produces a real foreign key, an index, and, on the typed backends, a strongly-typed id wrapper.

```ddd
aggregate Customer { name: string }

aggregate Order {
  customer: Customer id
}
```

The reference is a `UUID` column with an FK constraint and an index:

```sql
"customer" UUID NOT NULL,
FOREIGN KEY ("customer") REFERENCES "orders"."customers" ON DELETE RESTRICT
-- …
CREATE INDEX "orders_customer_idx" ON "orders"."orders" ("customer");
```

The host member is a wrapped id, not a raw `Guid`/`UUID`:

::: tabs backend
== node
```ts
// db/schema.ts — plain uuid column; the id branding lives in the domain layer
customer: uuid("customer").notNull(),
// db/repositories/order-repository.ts rehydrates it: customer: Ids.CustomerId(root.customer)
```
== dotnet
```csharp
// Domain/Orders/Order.cs — strongly-typed CustomerId
public CustomerId Customer { get; private set; } = default!;
// OrderConfiguration.cs — EF value converter to/from the raw Guid column
builder.Property(x => x.Customer).HasConversion(v => v.Value, v => new CustomerId(v)).HasColumnName("customer");
```
== java
```java
// features/orders/Order.java — @AttributeOverride maps the CustomerId record's
// `value` onto the `customer` column
@AttributeOverride(name = "value", column = @Column(name = "customer"))
CustomerId customer;
```
== python
```python
# app/domain/order.py holds the wrapped id; the row column is a plain uuid string
customer: CustomerId
# app/db/schema.py
customer: Mapped[str] = mapped_column(Uuid(as_uuid=False))
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex — a plain :binary_id field …
field :customer, :binary_id
# … with the FK in the Ecto migration
add :customer, references(:customers, prefix: "orders", type: :uuid, on_delete: :restrict), null: false
```
::: end

On the wire the reference flattens to its id value (`customer: z.string()` / `Guid Customer` / `UUID customer` / `customer: str` / `format: :uuid`).

## Collections — `T[]`

A trailing `[]` makes the field an array. For scalar/enum elements this is a native array column.

```ddd
aggregate Order {
  tags: string[]
}
```

```sql
"tags" TEXT[] NOT NULL,
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
@JdbcTypeCode(SqlTypes.ARRAY)
@Column(name = "tags") List<String> tags;   // OrderResponse: List<String> tags
```
== python
```python
tags: Mapped[list[str]] = mapped_column(ARRAY(Text))   # OrderResponse: tags: list[str]
```
== elixir
```elixir
field :tags, {:array, :string}        # migration: add :tags, {:array, :text}, null: false
```
::: end

An array of **references** — `X id[]` — is different: enrichment derives a join-table association for it rather than an inline array column. See [`../payloads.md`](../payloads.md) and the association derivation in enrichment (phase ⑥). A `contains … : Part[]` is a child table, not an array ([Domain modeling](03-domain-modeling.md#entity-parts--contains)).

## Options — `T?`

A trailing `?` makes the field nullable: a `NULL`-able column and an optional/nullable host member and wire field. (`T?` is distinct from the `option` *carrier* below.) A `token` field may not be nullable (`loom.token-nullable`).

```ddd
aggregate Order {
  notes: string?
}
```

```sql
"notes" TEXT NULL,
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
notes: Mapped[str | None] = mapped_column(Text)   # OrderResponse: notes: str | None = None
```
== elixir
```elixir
field :notes, :string                 # migration: add :notes, :text, null: true
```
::: end

**Nullable receivers.** An intrinsic call on a `T?` receiver is rejected — every backend would emit a bare dereference (`this.path.trim()` on a `string | null`) that the generated project's own compiler refuses or that crashes at runtime:

```ddd
aggregate Order {
  notes: string?
  derived trimmed: string = notes.trim()                          // loom.intrinsic-nullable-receiver
  derived safe:    string = notes != null ? notes.trim() : ""     // OK — the ternary narrows
}
```

*'.trim()' can't be called on 'string?' — the receiver may be null and every backend emits a bare dereference. Guard it with a null-narrowing ternary.* The catalogue checks (`loom.intrinsic-unknown` / `-arity` / `-arg-type` / `-bare` / `-named-arg`) run on the unwrapped type, so a typo on a nullable receiver is caught too. Numeric widening composes through the optional (`int? → long?`), and the `null` literal is assignable to any `T?`.

## Generic carriers — `paged`, `envelope`, `option`

Three **carrier-bounded generic payloads** are built in, instantiated ML-postfix (the keyword follows its argument): `T paged`, `T envelope`, `T option`. A carrier may appear only in a **transport position** — a repository `find` return type, a `queryHandler` return type, or a payload field — never as a stored aggregate property (`loom.generic-position`: *A generic carrier ('paged') is a transport shape*). The argument must itself be a carrier (a primitive, an `X id`, an enum, a value object, or an aggregate, which projects through its `<Agg>Wire`); nesting two constructors (`Order envelope paged`) or a `slot` argument is rejected (`loom.generic-arg-not-carrier`). The pinned shapes:

```
paged(T)    → { items: T[]; page: int; pageSize: int; total: int; totalPages: int }   # 1-based
envelope(T) → { id: string; ts: datetime; body: T }
option(T)   → the 2-variant union  union[T, none]  (an untagged 200 / 404 as a find return)
```

```ddd
repository OrderRepo for Order {
  find recent(): Order paged
  find audit(): Order envelope
  find byRef(ref: string): Order option where this.ref == ref
}
```

> A list-shaped `find` (`Order paged`, `Order[]`) is **deprecated** in favour of a `criterion` passed to `Repo.run(…)` or a named `retrieval` (`loom.repository-find-deprecated`, a warning) — see [Repositories & queries](10-repositories-and-queries.md#retrieval). A single-row reconstitution find (`Order` / `Order?` / `Order option`) stays first-class. The carrier shapes below are unchanged by where the query is declared.

### `paged`

No backend serializes its framework-native paging type — each maps to the one DTO above, and every paged read auto-gains `page` / `pageSize` / `sort` / `dir` query controls (defaults `1` / `20` / `id` / `asc`, `pageSize` capped at 500).

::: tabs backend
== node
```ts
// http/order.routes.ts
export const OrderPaged = z.object({
  items: z.array(OrderResponse), page: z.number().int(), pageSize: z.number().int(),
  total: z.number().int(), totalPages: z.number().int(),
}).openapi("OrderPaged");
// db/repositories/order-repository.ts — count() + limit/offset, totalPages = ceil(total / pageSize)
```
== dotnet
```csharp
// Domain/Common — one shared record, reused by every paged find
public sealed record Paged<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total, int TotalPages);
// OrderRepository.Recent: CountAsync + OrderBy(EF.Property<object>(e, sortColumn)).Skip(offset).Take(pageSize)
```
== java
```java
// domain/common/Paged.java
public record Paged<T>(List<T> items, int page, int pageSize, int total, int totalPages) {}
// OrderRepositoryImpl.recent: jpa.recent(PageRequest.of(page - 1, pageSize, sort)) → new Paged<>(…)
```
== python
```python
# app/domain/paging.py
@dataclass(frozen=True)
class PagedResult[T]:
    items: list[T]; page: int; page_size: int; total: int; total_pages: int
# app/http/order_routes.py — OrderPaged(BaseModel): items / page / pageSize / total / totalPages
```
== elixir
```elixir
# lib/api_elixir/orders/order_repository.ex
def recent(page \\ 1, page_size \\ 20, sort \\ "id", dir \\ "asc") do
  query = from(record in ApiElixir.Orders.Order)
  total = Repo.aggregate(query, :count, :id)
  offset = (page - 1) * page_size
  # … order_by / limit(^page_size) / offset(^offset) / Repo.all() → {:ok, %{items:, page:, …}}
end
```
::: end

### `envelope`

The pinned contract is `envelope(T) → { id, ts, body }`. **Honest gap:** the repository layer knows the carrier (dotnet `public sealed record Envelope<T>(string Id, DateTime Ts, T Body)`, java `Envelope<Order> audit()`), but no backend projects the wrapper onto the route — node, dotnet, java and python return the bare body (`OrderResponse`, `404` when empty), and elixir's `audit/0` returns `Repo.all` → a JSON **array** of bodies:

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
```
== elixir
```elixir
# lib/api_elixir_web/controllers/order_controller.ex — a list, not a body
def audit(conn, _params) do
  with {:ok, records} <- Orders.audit_order(), do: json(conn, Enum.map(records, &serialize/1))
end
```
::: end

> Treat `{ id, ts, body }` as the carrier's intended contract, but do not rely on it: it is the least uniformly projected of the three carriers, and the five backends do not even agree on the unwrapped shape.

### `option`

`T option` is sugar for the 2-variant union `union[T, none]` and flows through the same machinery as `A or B`. Where that union lands decides its wire: as a **payload field** or an **operation return** it is the tagged `{ "type": "Order", … }` / `{ "type": "none" }` shape ([Payloads & unions](09-payloads-and-unions.md)); as a **find return** it takes the untagged absence path — the success variant is returned **directly** at `200` and `none` is a `404` ProblemDetails, wire-identical to `Order?`. All five backends agree by construction:

::: tabs backend
== node
```ts
// http/order.routes.ts — 200 OrderResponse | 404, no discriminator
const result = await repo.byRef(params.ref);
if (result == null) throw new AggregateNotFoundError("not_found");
return c.json(repo.toWire(result) as z.infer<typeof OrderResponse>, 200);
```
== dotnet
```csharp
// Application/Orders/Queries/ByRefQuery.cs
public sealed record ByRefQuery(string Ref) : IQuery<OrderResponse?>;
// Api/OrdersController.cs
var result = await _mediator.Send(new ByRefQuery(@ref));
if (result is null) throw new AggregateNotFoundException("not_found");
return Ok(result);
```
== java
```java
// features/orders/OrdersController.java
var r = service.byRef(ref);
if (r == null) { throw new AggregateNotFoundException("not_found"); }
return ResponseEntity.ok(r);
```
== python
```python
# app/http/order_routes.py
if (found := await repo.by_ref(ref)) is None:
    raise AggregateNotFoundError("not_found")
return repo.to_wire(found)
```
== elixir
```elixir
# lib/api_elixir_web/controllers/order_controller.ex
case Orders.by_ref_order(params["ref"]) do
  {:ok, nil} -> ProblemDetails.problem_response(conn, 404, "Not Found", "not_found")
  {:ok, record} -> json(conn, serialize(record))
end
```
::: end

The tagged-wire machinery — `z.discriminatedUnion("type", …)` / `[JsonPolymorphic]` / `@JsonTypeInfo` — backs the anonymous `A or B` union and the named `payload F = A | B` form in their payload-field and operation-return positions. The full union surface (variant kinds, precedence, position rules, the `loom.union-*` validators, the `Agg or <error>` find shape) lives in [Payloads & unions](09-payloads-and-unions.md) and [`../payloads.md`](../payloads.md).
