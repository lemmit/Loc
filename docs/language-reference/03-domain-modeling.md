# 3. Domain modeling

The core building blocks of a bounded context: `aggregate` roots (and their header modifiers), `valueobject`s, nested `entity` parts joined via `contains`, `event`s, `enum`s, the field grammar — defaults, inline `check`s, access modifiers, and sensitivity tags — the set-level `unique (…)` invariant, and the application-layer `commandHandler` / `queryHandler` pair. Reach for this chapter when you need to know exactly what a declaration emits: which table, which DTO, which fields cross the wire.

> **Grammar:** `Aggregate`, `ValueObject`, `EntityPart`, `EventDecl`, `EnumDecl`, `Property`, `Containment`, `FieldAccess`, `SensitivityClause`, `Unique`, `CommandHandler`, `QueryHandler` · **Validators:** `loom.bare-aggregate-in-type`, `loom.cross-aggregate-entity-part`, `loom.entity-field-modifier`, `loom.entity-field-optional-collection`, `loom.token-nullable`, `loom.field-default-not-constant`, `loom.version-field-collision`, `loom.unique-unknown-field` / `-duplicate-column` / `-collection-field` / `-valueobject-field` / `-on-event-sourced` / `-missing-tenant-scope`, `loom.shape-on-event-sourced`, `loom.duplicate-field`, `loom.duplicate-enum-value`, `loom.valueobject-shadows-root`, `loom.enum-shadows-root`, `loom.query-handler-saves`, `loom.command-handler-multi-aggregate`, `loom.handler-missing-body` / `loom.extern-handler-has-body`, `loom.route-handler-unresolved` · scope provider in [`src/language/ddd-scope.ts`](../../src/language/ddd-scope.ts) · **Docs:** [`../language.md`](../language.md), [`../capabilities.md`](../capabilities.md)

Every backend reads the same fully-resolved IR, so the table layout is structurally identical across platforms — only the host-language member casing and idiom differ. The tabs below are **real generated output**; one system fixture with a `node`, `dotnet`, `java`, `python`, and `elixir` deployable over the same context (the `Order` aggregate carries `with crudish` so the create/update wire exists) produces every tab.

## `aggregate`

An `aggregate` is a consistency root. It owns a table, gets a synthetic `Name id` primary key automatically (you never declare `id`), and gets a repository. The id type is always `guid` (UUIDv7-minted) and is not configurable. The header has three regions:

```
(abstract)? aggregate Name (extends Base)?
    ( persistedAs: eventLog|state | shape: relational|embedded|document
    | inheritanceUsing: sharedTable|ownTable | crossTenant | audited )*   // order-independent
    (with Cap, macro(...))? { members }
```

- **prefix** — `abstract` (what the declaration *is*; see [Inheritance](08-inheritance-and-polymorphism.md), together with `extends` and `inheritanceUsing:`).
- **header region**, after the name, any order — `persistedAs:` the truth kind (default `state`), `shape:` the physical layout (default `relational`; `embedded` folds contained parts into JSONB columns, `document` stores the whole aggregate as one `(id, data, version)` JSONB row — `shape:` on an event-sourced aggregate is rejected, `loom.shape-on-event-sourced`), `crossTenant` (opts out of the tenant filter under a `tenancy by` system, [Tenancy](02-systems-and-topology.md#tenancy-by-userclaim-of-registry)), and `audited` (every public command records an `audit_records` row, [Observability & provenance](20-observability-provenance.md)).
- **`with`** — capabilities and macros mixed in ([Capabilities](11-capabilities-filters-stamps.md), [Macros](22-macros.md)).

```ddd
context Orders {
  aggregate Order {
    reference: string
  }
}
```

The implicit `id` is a branded/strongly-typed key (`guid` → UUID), the root gets a private constructor + a public `create(...)` factory + a `_create(state)` rehydrator, and a table is emitted with `id` as the primary key.

::: tabs backend
== node
```ts
// db/schema.ts — every context is its own Postgres schema
export const ordersSchema = pgSchema("orders");
export const orders = ordersSchema.table("orders", {
  id: uuid("id").primaryKey(),
  reference: text("reference").notNull(),
  version: integer("version").notNull(),      // implicit — see below
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
    public static Order Create(string reference)
    {
        var e = new Order();
        e.Id = new OrderId(Guid.CreateVersion7());
        // …
    }
}
```
== java
```java
// domain/ids/OrderId.java — an @Embeddable record; the table key is a UUID
public record OrderId(UUID value) implements Serializable {
    public static OrderId newId() {
        return new OrderId(Generators.timeBasedEpochGenerator().generate());
    }
}
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex
@primary_key {:id, UUIDv7, autogenerate: true}
@schema_prefix "orders"
schema "orders" do
  field :reference, :string
  field :version, :integer, default: 1
end
```
::: end

**Every state aggregate is optimistically versioned by default.** The macro expander splices the built-in `versioned` capability (`version: int token = 1`) onto every aggregate that is not `persistedAs: eventLog` and does not already carry it, so every table gets `version INTEGER NOT NULL DEFAULT 1`, every save is a guarded `UPDATE … WHERE id = $1 AND version = $2`, and a stale write answers **409**. The `version` field rides the wire as a `token` (read + echoed back). Declaring your own `version` field is allowed only as `version: int` — any other type collides (`loom.version-field-collision`: *field 'version' on aggregate 'Order' collides with Loom's optimistic-concurrency column, which is an 'int'*). See [`../capabilities.md`](../capabilities.md).

A `shape: document` aggregate keeps the same repository surface over a blob table:

```sql
CREATE TABLE "orders"."docs" (
  "id" UUID NOT NULL,
  "data" JSONB NOT NULL,
  "version" INTEGER NOT NULL,
  PRIMARY KEY ("id")
);
```

## `valueobject`

A `valueobject` is an immutable record with no identity, no table, and no repository of its own. It persists *inside* its owning aggregate — relationally as flattened, prefixed columns (`total: Money` → `total_amount`, `total_currency`), and on the wire as a nested object. Members are `Property` / `derived` / `invariant` / `function` / a nested `test` — never operations (a VO has no lifecycle). A VO may not share a name with an aggregate in the same context (`loom.valueobject-shadows-root`).

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
  readonly amount: number;
  readonly currency: Currency;
  constructor(amount: number, currency: Currency) {
    this.amount = amount;
    this.currency = currency;
  }
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
```java
// features/orders/Order.java — the owner remaps the embeddable's columns
@AttributeOverride(name = "amount",   column = @Column(name = "total_amount"))
@AttributeOverride(name = "currency", column = @Column(name = "total_currency"))
Money total;
```
== python
```python
# app/domain/value_objects.py — frozen dataclass
@dataclass(frozen=True)
class Money:
    amount: float
    currency: Currency
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex — a VO is a :map field on the owner's schema
field :total, :map

# lib/api_elixir_web/api/schemas/money.ex — the wire shape is an OpenApiSpex schema
OpenApiSpex.schema(%{
  title: "Money", type: :object,
  properties: %{amount: %OpenApiSpex.Schema{type: :number, format: :double},
                currency: ApiElixirWeb.Api.Schemas.Currency},
  required: [:amount, :currency]
})
```
::: end

> **Elixir divergence.** The other four backends emit a dedicated VO type and flatten its columns (`total_amount` / `total_currency`); the Elixir backend stores the VO as a single `:map` (JSONB) column `total` — in its Ecto schema *and* in its Ecto migration (`add :total, :map`). The *wire* (a nested `{ amount, currency }` object) is the cross-backend contract; the column layout is not.

## `entity` parts & `contains`

An `entity` part is a child entity with its own identity that has no independent existence — it lives only as a member of its aggregate. You declare the part inline, then bind it with `contains <name>: <Part>[]` (collection), `<Part>` (single), or `<Part>?` (optional); a plain field typed with the part (`lines: Line[]`) is the same containment with the keyword inferred. A containment carries only a name, `[]` and `?` — the value-property modifiers (`provenanced`, an access modifier, `= default`, `sensitive(...)`, `check`) are rejected on it (`loom.entity-field-modifier`), and `[]?` is rejected because an empty collection already encodes absence (`loom.entity-field-optional-collection`). The part gets its own child table keyed back to the parent via a `<parent>_id` foreign key with `ON DELETE CASCADE` and an index. A part may carry its own `Property` / `check` / `invariant` / `derived` / `function` / nested `contains`; a part declared in one aggregate cannot be contained by another (`loom.cross-aggregate-entity-part`).

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
export const lines = ordersSchema.table("lines", {
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
== java
```java
// features/orders/Order.java — owned, eagerly-loaded, orphan-removed
@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)
@JoinColumn(name = "order_id", nullable = false)
List<Line> lines = new ArrayList<>();
```
== python
```python
# app/domain/order.py — the check on Line's constructor
def _assert_invariants(self) -> None:
    if not (self._qty > 0):
        raise DomainError("Invariant violated: qty check qty > 0")
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex
has_many :lines, ApiElixir.Orders.Line, foreign_key: :order_id, on_replace: :delete

# lib/api_elixir/orders/line.ex
@derive {Jason.Encoder, only: [:id, :sku, :qty]}
schema "lines" do
  field :sku, :string
  field :qty, :integer
  belongs_to :order, ApiElixir.Orders.Order, foreign_key: :order_id, type: :binary_id
end
```
::: end

> **Elixir honest gap.** The part-level `check qty > 0` is enforced on node / dotnet / java / python (a constructor guard); the Elixir `Line.changeset/2` only `cast`s `[:sku, :qty]` and emits no `validate_*` for it. Root-level checks and `invariant`s do reach the changeset — the gap is specific to `entity` parts.

The generated SQL makes the parent/child shape explicit (node migration shown; the same DDL is rendered for every backend):

```sql
CREATE TABLE "orders"."lines" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "sku" TEXT NOT NULL,
  "qty" INTEGER NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("order_id") REFERENCES "orders"."orders" ON DELETE CASCADE
);
CREATE INDEX "lines_order_id_idx" ON "orders"."lines" ("order_id");
```

> Cross-*aggregate* links are **not** containment — they are `X id` reference fields (`productId: Product id`), enforced by `loom.bare-aggregate-in-type` (*References across aggregate boundaries need an id link — write 'Customer id' (or 'Customer id[]' for many-to-many)*). See [Type system](04-type-system.md) for `X id` and `X id[]` reference collections.

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
@org.jmolecules.event.annotation.DomainEvent
public record OrderPlaced(String orderId, BigDecimal total) implements DomainEvent {}
```
== python
```python
# app/domain/events.py — frozen dataclass with a class-level type tag
class OrderPlaced:
    type: ClassVar[str] = "OrderPlaced"
    order_id: str
    total: float

DomainEvent = OrderPlaced
```
== elixir
```elixir
# lib/api_elixir/orders/events/order_placed.ex
defmodule ApiElixir.Orders.Events.OrderPlaced do
  defstruct [:order_id, :total]
  @type t :: %__MODULE__{order_id: String.t(), total: Decimal.t()}
end
```
::: end

Raising one (`emit OrderPlaced { … }`) and the `apply(e: OrderPlaced) { … }` folding pass are covered in [Behavior & statements](06-behavior-and-statements.md); transporting one across deployables is [`channel`](14-apis-storage-resources-channels.md#channel--channelsource).

## `enum`

An `enum` is a closed set of bare-identifier values, referenced bare in expressions and defaults (`status := Confirmed`). It emits as a native enum on every backend and as a Postgres `pgEnum` / string-converted column for the DB layer — members re-quoted into string literals (the source `USD` arrives at the compiler as the 3-char string `USD`; see [Lexical structure](01-lexical-structure.md) §Literals). Duplicate members are `loom.duplicate-enum-value`; an enum may not share a name with an aggregate (`loom.enum-shadows-root`).

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
// Infrastructure/Persistence/Configurations/OrderConfiguration.cs — stored as its string name
builder.Property(x => x.Currency).HasConversion<string>().HasColumnName("currency");
```
== java
```java
// domain/enums/Currency.java
public enum Currency { USD, EUR, GBP }
```
```java
// features/orders/Order.java
@Enumerated(EnumType.STRING)
@Column(name = "currency")
Currency currency;
```
== python
```python
# app/domain/value_objects.py
class Currency(StrEnum):
    USD = "USD"
    EUR = "EUR"
    GBP = "GBP"
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex — an inline Ecto.Enum; members keep their case
field :currency, Ecto.Enum, values: [:USD, :EUR, :GBP]

# lib/api_elixir_web/api/schemas/currency.ex
OpenApiSpex.schema(%{title: "Currency", type: :string, enum: ["USD", "EUR", "GBP"]})
```
::: end

Member names are kept verbatim on every backend (`USD` on the wire everywhere; the shared DDL stores the column as `TEXT`).

## Fields (`Property`)

A field is `name: Type [provenanced | sensitive(...) | access]* [= default] [check Expr [message "…"]] [mask unless Expr]` — the three flag-like modifiers parse in any order; the default, the check, and the mask stay after them, in that order. A `= default` value seeds the field when the client omits it; `check Expr` is a per-field validation predicate lowered to an invariant. (`provenanced` is covered in [`../provenance.md`](../provenance.md); `mask unless` — the read-side redaction gate — in [Auth](17-auth.md).)

```ddd
context Orders {
  aggregate Order with crudish {
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
```ts
// domain/order.ts — and the factory coalesces it
static create(input: { reference: string; note?: string; /* … */ }): Order {
  return new Order({ id: Ids.newOrderId(), reference: input.reference, note: input.note ?? "pending", /* … */ });
}
```
== dotnet
```csharp
// Application/Orders/Requests/OrderRequests.cs — default on the record param
public sealed record CreateOrderRequest(
    [Required(AllowEmptyStrings = true)] string Reference,
    /* … */
    string Note = "pending");
// Domain/Orders/Order.cs — Create(…, string? note = null) { e.Note = note ?? "pending"; }
```
== python
```python
# app/http/order_routes.py — pydantic default
class CreateOrderRequest(BaseModel):
    reference: str
    note: str = "pending"
```
== elixir
```elixir
# lib/api_elixir/orders/order.ex — default on the Ecto field …
field :note, :string, default: "pending"
# lib/api_elixir/orders/order_changeset.ex — … and on the create changeset
|> __default(:note, "pending")
```
::: end

The example above is a **constant** default, so it lands on the wire as a
serializer default (zod `.default(...)`, a C# record `= …`, a pydantic default, an
Ecto `default:`). An **ambient** default the client can't precompute — `now()` or
`currentUser.<claim>` — is instead applied **per-request in the create path**:
the field is wire-**optional** and the create handler coalesces the value
(`body.createdAt ?? now()`), because a serializer default is evaluated once at
module load and would freeze every row to the server's boot time. See
[Server-sourced defaults](../actions.md#server-sourced-defaults--applied-per-request-in-the-create-path).
A default that reads a **sibling field** (`total: int = qty * 2`) is rejected —
`loom.field-default-not-constant` (*a field default is evaluated where no instance
exists yet — notably the create-request wire schema*); write a `derived` instead.

A `check` on a field is exactly the inline form of a member `invariant` — both lower to the constructor guard shown under `contains` above (`qty: int check qty > 0` → `if (!(this._qty > 0)) throw …`). See [Invariants, derived & functions](07-invariants-derived-functions.md) for the full invariant surface.

## Access modifiers

Every field carries an access modifier governing its role across three shapes: the **create** input, the **update** wire, and the **read** projection. `editable` (the default, no keyword) is full client read+write. The five explicit modifiers:

| Modifier | Read (response) | Create input | Update wire | Stored |
|---|---|---|---|---|
| `editable` *(default)* | ✓ | ✓ | ✓ | ✓ |
| `immutable` | ✓ | ✓ | ✗ (set once) | ✓ |
| `managed` | ✓ | ✗ (server seeds) | ✗ | ✓ |
| `token` | ✓ | ✗ | ✓ (echoed, like `id`) | ✓ |
| `internal` | ✗ (never via API) | ✗ | ✗ | ✓ (projections may read) |
| `secret` | ✗ (never disclosed) | ✓ | ✓ (write-only) | ✓ |

The synthetic `id` and the implicit `version` are `token`; a `token` field must be non-nullable (`loom.token-nullable`). `managed` fields are server-seeded in the `create` factory (`datetime` → now, `int` → `0`); `secret` and `internal` are dropped from the read projection.

```ddd
context Orders {
  aggregate Order with crudish {
    reference: string                  // editable (default)
    slug: string immutable             // set once at creation
    createdAt: datetime managed        // server stamps it; not client-writable
    version: int token                 // the optimistic-concurrency counter, spelled out
    couponCode: string secret          // accepted on write; never sent back
    internalScore: int internal        // hidden from clients
  }
}
```

The **create input** drops `managed` / `token` / `internal` (`createdAt`, `version`, `internalScore`) but keeps `secret` and `immutable` (`couponCode`, `slug`):

::: tabs backend
== node
```ts
// domain/order.ts — create takes only the client-writable fields;
// managed/token/internal are seeded server-side
static create(input: { reference: string; /* total, currency, note? */ slug: string; couponCode: string; email: string }): Order {
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
public static Order Create(string reference, Money total, Currency currency, string slug, string couponCode, string email, string? note = null)
// CreateOrderRequest record likewise: CouponCode + Slug present; CreatedAt/Version/InternalScore absent
```
== python
```python
# app/http/order_routes.py
class CreateOrderRequest(BaseModel):
    reference: str
    # …
    couponCode: str   # secret: accepted on input
    slug: str         # immutable: set on create
    email: str
    # createdAt / version / internalScore are NOT accepted
```
== elixir
```elixir
# lib/api_elixir/orders/order_changeset.ex — the update seam casts only the
# editable set: no slug (immutable), no version (token), no internal_score
@update_fields [:reference, :total, :currency, :note, :coupon_code, :email]
```
::: end

The **read projection** drops `secret` and `internal` (`couponCode`, `internalScore`) but keeps `managed` / `token` / `immutable` — on all five backends:

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — toWire() omits couponCode + internalScore
toWire(root: Order): unknown {
  return { id: root.id as string, reference: root.reference, /* total, currency, note */
           slug: root.slug, createdAt: (root.createdAt as Date).toISOString().replace(/\.?0+Z$/, "Z"),
           version: root.version, email: root.email, lines: /* … */ };
}
```
== dotnet
```csharp
// Application/Orders/Responses/OrderResponses.cs — no CouponCode, no InternalScore
public sealed record OrderResponse(
    [property: Required] Guid Id, [property: Required] string Reference, /* … */
    [property: Required] string Slug, [property: Required] string CreatedAt, [property: Required] int Version,
    [property: Required] string Email, [property: Required] IReadOnlyList<LineResponse> Lines);
```
== java
```java
// features/orders/OrderResponse.java — same omission
public record OrderResponse(UUID id, String reference, MoneyResponse total, Currency currency, String note,
    String slug, String createdAt, int version, String email, List<LineResponse> lines) { /* from(Order) */ }
```
== python
```python
# app/http/order_routes.py — OrderResponse omits couponCode + internalScore
class OrderResponse(BaseModel):
    id: str
    reference: str
    # …
    slug: str
    createdAt: str
    version: int
    email: str
    lines: list[LineResponse]
```
== elixir
```elixir
# lib/api_elixir_web/controllers/order_controller.ex — serialize/1 lists the wire fields
defp serialize(record) do
  %{"id" => record.id, "reference" => record.reference, "total" => serialize_money(record.total),
    "currency" => record.currency, "note" => record.note, "slug" => record.slug,
    "createdAt" => record.created_at, "version" => record.version, "email" => record.email,
    "lines" => Enum.map(record.lines || [], &serialize_line/1)}
end
```
::: end

## `unique (…)` — the set-level invariant

`unique (a, b)` declares a natural key: no two rows may share the listed tuple. It cannot run in the per-instance `_assertInvariants` floor, so the compiler **derives** its enforcement — a DB unique index (partial under `softDeletable`; tenant-scoped under `tenantOwned`, or `loom.unique-missing-tenant-scope`) plus a per-backend `23505 unique_violation → 409 Conflict` mapping. Columns are bare field names resolved against the aggregate (`loom.unique-unknown-field`, with a did-you-mean list; `loom.unique-duplicate-column`; a collection or value-object column is rejected — `loom.unique-collection-field` / `loom.unique-valueobject-field`); an event-sourced aggregate has no single table to constrain (`loom.unique-on-event-sourced`).

```ddd
context Orders {
  aggregate Order {
    reference: string
    unique (reference)
  }
}
```

```sql
CREATE UNIQUE INDEX "orders_reference_uq" ON "orders"."orders" ("reference");
```

::: tabs backend
== node
```ts
// http/index.ts — the app-level error boundary
if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23505")) {
  recordDomainFault("disallowed");
  return problem(409, "Conflict", "A record with these values already exists.");
}
```
== dotnet
```csharp
// Api/DomainExceptionFilter.cs
if (context.Exception is Npgsql.PostgresException { SqlState: "23505" }
    || (context.Exception is Microsoft.EntityFrameworkCore.DbUpdateException due
        && due.InnerException is Npgsql.PostgresException { SqlState: "23505" }))
{
    context.Result = Problem(context, 409, "Conflict", "A resource with these values already exists.", trace_id);
    context.ExceptionHandled = true;
    return;
}
```
== java
```java
// api/ApiExceptionAdvice.java — DataIntegrityViolationException, discriminated by SQLState
if ("23503".equals(sqlState(e))) { /* still referenced → 409 */ }
return respond(problem(409, "Conflict", "A resource with these values already exists.", request), 409);
```
== python
```python
# app/http/problem.py
@app.exception_handler(IntegrityError)
async def _integrity(request: Request, err: IntegrityError) -> JSONResponse:
    sqlstate = getattr(getattr(err, "orig", None), "sqlstate", None)
    if sqlstate == "23505":
        return problem(request, 409, "Conflict", "A resource with these values already exists.")
```
== elixir
```elixir
# lib/api_elixir/orders/order_changeset.ex — Ecto names the index so the
# constraint error lands on the changeset (→ 409 via ProblemDetails)
|> unique_constraint(:reference, name: "orders_reference_uq")
```
::: end

A **performance** index (non-unique) is not a domain fact — it lives on the storage binding as `resource … { index: [Order.reference, Line.(sku, qty)] }` ([APIs, storage & resources](14-apis-storage-resources-channels.md#resource)); the compiler suggests one when a `find … where` filters on an un-indexed column (`loom.index-suggestion`).

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
# lib/api_elixir/orders/order.ex — an Inspect protocol impl on the schema struct
defimpl Inspect, for: ApiElixir.Orders.Order do
  def inspect(record, _opts) do
    string("Order(" <> "id: " <> to_string(record.id) <> ", "
      <> "reference: " <> "'" <> record.reference <> "'" <> ", "
      <> "email: " <> "<redacted>" <> ", " <> # …
  end
end
```
::: end

The field is still stored and (subject to its access modifier) still crosses the API wire — `sensitive(...)` governs the *debug* representation, not the response projection. For read-side redaction on the wire use `mask unless <currentUser predicate>` ([Auth](17-auth.md)). See [`../language.md`](../language.md) §"Sensitivity" and [`../provenance.md`](../provenance.md) for the broader compliance surface.

## `commandHandler` & `queryHandler`

Application-layer handlers are context members — effectively a workflow `handle` lifted out when the orchestration touches a single aggregate. Both take a parameter list and a body in the ordinary statement vocabulary (load → mutate → save → return); a `queryHandler` always declares a return type and may not save (`loom.query-handler-saves`), a `commandHandler` may omit it and may touch only one aggregate (`loom.command-handler-multi-aggregate`). An `extern` handler is bodyless (`;`) and dispatches to a scaffolded, user-owned implementation file (`loom.extern-handler-has-body` / `loom.handler-missing-body`; [Externs](21-externs.md)). A handler reaches HTTP only through an explicit `route` on an `api` (`route POST "/orders/close" -> Orders.CloseOrder`; an unresolvable target is `loom.route-handler-unresolved`) — [APIs](14-apis-storage-resources-channels.md#api).

```ddd
context Orders {
  aggregate Order with crudish {
    reference: string
    operation close() { reference := reference + "-closed" }
  }
  repository Orders for Order { }
  command  CloseOrder    { orderId: Order id }
  response OrderResponse { reference: string }

  commandHandler CloseOrder(cmd: CloseOrder): OrderResponse {
    let o = Orders.getById(cmd.orderId)
    o.close()
    return o
  }
  queryHandler GetOrder(orderId: Order id): OrderResponse {
    let o = Orders.getById(orderId)
    return o
  }
}
// at system level:
//   api OrdersApi from Sales { route POST "/orders/close" -> Orders.CloseOrder }
```

::: tabs backend
== node
```ts
// http/ordersApi-routes.ts — one createRoute per `route`, body inlined
app.openapi(
  createRoute({
    method: "post", path: "/orders/close", tags: ["OrdersApi"], operationId: "ordersCloseOrder",
    request: { body: { content: { "application/json": { schema: z.object({ orderId: z.string().uuid() }) } } } },
    responses: { 200: { /* OrderResponse */ }, 400: { /* … */ }, 404: { /* … */ }, 415: { /* … */ } },
  }),
  async (httpCtx) => {
    const body = httpCtx.req.valid("json");
    const cmd = { orderId: Ids.OrderId(body.orderId) };
    const orders = new OrderRepository(db, events);
    const o = await orders.getById(cmd.orderId);
    o.close();
    await orders.save(o);
    return httpCtx.json(orders.toWire(o) as z.infer<typeof OrderResponse>, 200);
  },
);
```
== dotnet
```csharp
// Application/Orders/Commands/CloseOrderHandler.cs — a Mediator handler
public sealed class CloseOrderHandler : ICommandHandler<CloseOrderCommand, Order>
{
    public async ValueTask<Order> Handle(CloseOrderCommand command, CancellationToken cancellationToken)
    {
        var o = await _orders.GetByIdAsync(command.OrderId, cancellationToken)
            ?? throw new AggregateNotFoundException($"Order {command.OrderId} not found");
        o.Close();
        await _orders.SaveAsync(o, cancellationToken);
        return o;
    }
}
// Api/OrdersApiRoutesController.cs
[HttpPost("/orders/close")]
public async Task<IActionResult> CloseOrder([FromBody] CloseOrderBody body)
{
    var result = await _mediator.Send(new CloseOrderCommand(body.OrderId));
    return Ok(new OrderResponse(result.Id.Value, result.Reference, result.Version));
}
```
::: end

The multi-aggregate, long-running, and event-reacting forms are [`workflow`](13-workflows.md); the stateless cross-aggregate calculator is [`domainService`](23-domain-services-and-seeds.md).
