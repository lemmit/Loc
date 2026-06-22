# 5. Expressions

The one expression language shared by invariants, derived fields, operation bodies, repository `find` filters, view `bind` projections, and page bodies. Every backend consumes the *same* fully-resolved `ExprIR` — names already carry a `refKind`, member accesses a `receiverType`, calls a `callKind` — so the only thing that differs across targets is leaf spelling: operator syntax, money arithmetic, and collection-op shape. This chapter shows that divergence directly.

> **Grammar:** `MatchExpr` · `TernaryExpr` · `OrExpr`..`MultiplicativeExpr` · `UnaryExpr` · `PostfixExpr` / `PostfixSuffix` / `MemberSuffix` · `Lambda` · `LiteralExpr` · `MoneyLit` · `PrimitiveConversion` · `BuilderCall` · `CallArg` · **Validators:** expr typing in [`lower-expr.ts`](../../src/ir/lower/lower-expr.ts); shared dispatch in [`_expr/target.ts`](../../src/generator/_expr/target.ts) · **Docs:** [`../criterion.md`](../criterion.md), [`../language.md`](../language.md)

How the rest of the pipeline sees an expression: the 17-arm `ExprIR.kind` switch and **all** recursion live once in `renderExprWith` (`src/generator/_expr/target.ts`); each backend supplies only a leaf table (`TS_TARGET` / `CS_TARGET` / `JAVA_TARGET` / `PY_TARGET` / `ELIXIR_TARGET`). The eight divergence axes are: operator spelling, name casing, **money arithmetic**, collection ops, `refColl.contains` membership, regex, `ref` role, and `callKind` call syntax. Every example below puts the expression inside a `derived` field or repository `find` so it actually emits.

## Precedence & associativity

Standard C-family precedence, encoded as a rule cascade — lowest binds last:

```
TernaryExpr   ?:                       (lowest)
OrExpr        ||
AndExpr       &&
EqualityExpr  ==  !=
ComparisonExpr <  <=  >  >=
AdditiveExpr  +  -
MultiplicativeExpr *  /  %
UnaryExpr     !  -                      (prefix)
PostfixExpr   .member  .member(...)  (...)   (highest)
```

Binary chains are flat (`head` + parallel `ops[]` / `rest[]`), not recursive — so `a + b - c` is one `BinaryChain` node, left-associative on render. Parenthesise with `( … )` to override; the paren survives lowering as a `paren` node and re-emits verbatim.

## Literals

String, integer, decimal, boolean, `null`, plus the keyword literals `now()` and `money("…")`.

```ddd
context Demo {
  aggregate Sample {
    qty: int
    rate: decimal
    note: string
    seenAt: datetime
    derived greeting: string = note
    derived stamp: datetime = now()
  }
}
```

The `STRING` terminal strips its quotes (`"hi"` → the 3-char value `hi`), so anything emitting a string literal **re-quotes** (`JSON.stringify` or the target equivalent). `INT`/`DECIMAL` pass through as source-compatible numeric text; `now()` is the current-instant constructor.

::: tabs backend
== node
```ts
// now() → a JS Date
get stamp(): Date { return new Date(); }
```
== dotnet
```csharp
public DateTime Stamp => DateTime.UtcNow;
```
== java
```java
public java.time.OffsetDateTime stamp() { return java.time.OffsetDateTime.now(); }
```
== python
```python
@property
def stamp(self) -> datetime:
    return datetime.now(timezone.utc)
```
== elixir
```elixir
calculate :stamp, :utc_datetime, expr(DateTime.utc_now())
```
::: end

`money("10.50")` is its own literal (`MoneyLit`) — the string argument carries the precise decimal, parsed losslessly into each host's precise-decimal type (`decimal.js`, `System.Decimal`, `BigDecimal`, Python `Decimal`, Elixir `Decimal`). It is distinct from a lossy `decimal`; see [Money arithmetic](#money-arithmetic-closed).

List literals (`[3, 2, 1]`) are walker-config sugar (e.g. responsive `Grid { cols: [3, 2, 1] }`); no domain-expression position consumes one today.

## Arithmetic & widening

`+ - * / %` on numeric types. `int < long < decimal` widen implicitly; mixing in a `money` operand is a type error unless every operand is `money` (money arithmetic is closed — below). String `+` is concatenation, but a non-string operand must be made explicit with `string(x)` (see [Conversions](#conversions)).

```ddd
aggregate Order {
  subtotal: money
  taxRate: decimal
  qty: int
  derived qtyLabel: string = "qty=" + string(qty)
}
```

`"qty=" + string(qty)` — note the explicit `string(...)`; bare `"qty=" + qty` is rejected by the binary type checker.

::: tabs backend
== node
```ts
get qtyLabel(): string { return "qty=" + String(this._qty); }
```
== dotnet
```csharp
public string QtyLabel => "qty=" + this.Qty.ToString(System.Globalization.CultureInfo.InvariantCulture);
```
== java
```java
public String qtyLabel() { return "qty=" + String.valueOf(this.qty); }
```
== python
```python
@property
def qty_label(self) -> str:
    return "qty=" + str(self._qty)
```
== elixir
```elixir
calculate :qty_label, :string, expr("qty=" <> to_string(record.qty))
```
::: end

## Money arithmetic (closed)

Money is the headline divergence axis. The DSL `money` type maps to a precise-decimal host type, and the backends split into two camps: **.NET and Python** use native operators (their decimal type overloads them precisely); **TypeScript, Java, and Elixir** route through a method/library call because their decimal type does *not* do precise math under `+`/`*`.

```ddd
aggregate Order {
  subtotal: money
  taxRate: decimal
  derived tax: money   = subtotal * taxRate
  derived total: money = subtotal + tax
}
```

The same two lines, `subtotal * taxRate` and `subtotal + tax`:

::: tabs backend
== node
```ts
// decimal.js: operators are methods (plus/minus/times/div/mod)
get tax(): Decimal { return this._subtotal.times(this._taxRate); }
get total(): Decimal { return this._subtotal.plus(this.tax); }
```
== dotnet
```csharp
// System.Decimal: native operators, precise
public decimal Tax => this.Subtotal * this.TaxRate;
public decimal Total => this.Subtotal + this.Tax;
```
== java
```java
// BigDecimal: add/subtract/multiply; divide needs an explicit MathContext
public BigDecimal tax() { return this.subtotal.multiply(this.taxRate); }
public BigDecimal total() { return this.subtotal.add(this.tax()); }
```
== python
```python
# decimal.Decimal: native operators, precise
@property
def tax(self) -> Decimal: return self._subtotal * self._tax_rate
@property
def total(self) -> Decimal: return self._subtotal + self.tax
```
== elixir
```elixir
# Decimal library: Decimal.mult / Decimal.add
calculate :tax, :decimal, expr(Decimal.mult(record.subtotal, record.tax_rate))
calculate :total, :decimal, expr(Decimal.add(record.subtotal, record.tax))
```
::: end

Money **comparison** diverges the same way — `subtotal > money("100.00")`:

::: tabs backend
== node
```ts
this._subtotal.gt(new Decimal("100.00"))
```
== dotnet
```csharp
this.Subtotal > 100.00m
```
== java
```java
this.subtotal.compareTo(new BigDecimal("100.00")) > 0
```
== python
```python
self._subtotal > Decimal("100.00")
```
== elixir
```elixir
Decimal.compare(record.subtotal, Decimal.new("100.00")) == :gt
```
::: end

Java division emits `divide(r, MathContext.DECIMAL128)` (a bare `BigDecimal.divide` throws on non-terminating expansions); the `==`/`!=`/`<`… set maps to `compareTo(...) </==/> 0`. Elixir ordering maps to `Decimal.compare(...) == :gt` (and `in [:lt, :eq]` for `<=`).

## Comparison, logical & unary

`< <= > >= == !=` and `&& || !` over comparable operands; prefix `!` (boolean) and `-` (negate).

```ddd
aggregate Order {
  subtotal: money
  qty: int
  derived isBig: bool = subtotal > money("100.00") && qty >= 5
}
```

::: tabs backend
== node
```ts
// == / != become === / !== in TS; && passes through
get isBig(): boolean { return this._subtotal.gt(new Decimal("100.00")) && this._qty >= 5; }
```
== dotnet
```csharp
public bool IsBig => this.Subtotal > 100.00m && this.Qty >= 5;
```
== java
```java
public boolean isBig() { return this.subtotal.compareTo(new BigDecimal("100.00")) > 0 && this.qty >= 5; }
```
== python
```python
# && / || render as Python's and / or
@property
def is_big(self) -> bool:
    return self._subtotal > Decimal("100.00") and self._qty >= 5
```
== elixir
```elixir
calculate :is_big, :boolean,
  expr(Decimal.compare(record.subtotal, Decimal.new("100.00")) == :gt and record.qty >= 5)
```
::: end

The leaf differences here: TS rewrites `==`→`===`, Python/Elixir spell `&&`→`and`, and non-money `==`/`>=` stay as native operators on every backend.

## Ternary & `match`

`cond ? a : b` is the inline conditional. `match { c1 => v1, c2 => v2, else => f }` is its predicate-arm form — the first arm whose `cond` is `true` wins; the optional `else` is the fallthrough.

```ddd
aggregate Order {
  qty: int
  status: Status
  derived label: string = qty > 0 ? "has items" : "empty"
  derived stage: string = match {
    status == Status.Draft  => "draft",
    status == Status.Placed => "placed",
    else                    => "done"
  }
}
```

`match` has no native equivalent on most backends, so it lowers to a **right-folded chain of ternaries** — except Elixir, which renders a real `cond do` block:

::: tabs backend
== node
```ts
get label(): string { return this._qty > 0 ? "has items" : "empty"; }
get stage(): string {
  return (this._status === Status.Draft ? "draft" : (this._status === Status.Placed ? "placed" : "done"));
}
```
== dotnet
```csharp
public string Label => this.Qty > 0 ? "has items" : "empty";
public string Stage => (this.Status == Status.Draft ? "draft" : (this.Status == Status.Placed ? "placed" : "done"));
```
== java
```java
public String label() { return this.qty > 0 ? "has items" : "empty"; }
public String stage() { return (this.status == Status.Draft ? "draft" : (this.status == Status.Placed ? "placed" : "done")); }
```
== python
```python
# ternary becomes `a if cond else b`; match folds into nested ternaries
@property
def label(self) -> str:
    return ("has items" if self._qty > 0 else "empty")
@property
def stage(self) -> str:
    return ("draft" if self._status == Status.Draft else ("placed" if self._status == Status.Placed else "done"))
```
== elixir
```elixir
calculate :label, :string, expr(if record.qty > 0, do: "has items", else: "empty")
calculate :stage, :string, expr(cond do
  record.status == :draft  -> "draft"
  record.status == :placed -> "placed"
  true                     -> "done"
end)
```
::: end

## Member access & calls

`a.b` reads a member; `a.b(x)` is a method call; bare `f(x)` is a free / function call. The chain rule is `PrimaryExpr (MemberSuffix | CallSuffix)+`. Every call is tagged at lowering with a `callKind` (`value-object-ctor`, `function`, `private-operation`, `free`, `domain-service`, `resource-op`) and every `ref` with a `refKind` (`param` / `let` / `this-prop` / `enum-value` / `current-user` / …), so the backend never re-resolves — it just spells the resolved form.

Field reads inside a body may be written bare (`subtotal`) or `this`-qualified (`this.subtotal`); both lower to a `this-prop` ref. A bare backing-field read becomes `this._field` (private) inside the aggregate class on TS, the public getter on .NET/Java, etc. Enum members render as `Enum.Member` (`Status.Draft` → `Status.Draft` / `:draft` on Elixir). `CallArg` admits an optional `name:` prefix (`Form(state: order)`) for named arguments — threaded into `argNames`; renderers that don't care ignore it.

## Collection operators

The closed set over a list-typed receiver: `.count`, `.sum`, `.all`, `.any`, `.where`, `.first`, `.firstOrNull`, `.contains`. Each is flagged `isCollectionOp` at lowering and lowered to the host's idiom — there is no shared runtime.

```ddd
aggregate Order {
  contains lines: Line[]
  derived lineCount: int    = lines.count
  derived grandTotal: money = lines.sum(l => l.amount)
  derived allPositive: bool = lines.all(l => l.amount > money("0.00"))
  entity Line { amount: money }
}
```

::: tabs backend
== node
```ts
get lineCount(): number { return this._lines.length; }
get grandTotal(): Decimal { return (this._lines).reduce((acc, x) => acc + ((l) => l.amount)(x), 0); }
get allPositive(): boolean { return (this._lines).every((l) => l.amount > new Decimal("0.00")); }
```
== dotnet
```csharp
public int LineCount => this.Lines.Count;
public decimal GrandTotal => (this.Lines).Sum(l => l.Amount);
public bool AllPositive => (this.Lines).All(l => l.Amount > 0.00m);
```
== java
```java
public int lineCount() { return this.lines.size(); }
public BigDecimal grandTotal() { return this.lines.stream().map(l -> l.amount()).reduce(BigDecimal.ZERO, BigDecimal::add); }
public boolean allPositive() { return this.lines.stream().allMatch(l -> l.amount() > new BigDecimal("0.00")); }
```
== python
```python
@property
def line_count(self) -> int: return len(self._lines)
@property
def grand_total(self) -> Decimal:
    return sum((lambda l: l.amount)(__x) for __x in self._lines)
@property
def all_positive(self) -> bool:
    return all((lambda l: l.amount > Decimal("0.00"))(__x) for __x in self._lines)
```
== elixir
```elixir
calculate :line_count, :integer, expr(Enum.count(record.lines))
calculate :grand_total, :decimal, expr(Enum.sum(Enum.map(record.lines, fn l -> l.amount end)))
calculate :all_positive, :boolean, expr(Enum.all?(record.lines, fn l -> l.amount > Decimal.new("0.00") end))
```
::: end

Mapping summary: `.count` → `.length` / `.Count` / `.size()` / `len()` / `Enum.count`; `.sum(λ)` → `reduce` / `.Sum(λ)` / `stream().map().reduce()` / `sum(… for …)` / `Enum.sum(Enum.map(…))`; `.where(λ)` → `.filter` / `.Where().ToList()` / `[x for x in … if …]` / `Enum.filter`; `.first`/`.firstOrNull` → `[0]` / `.First()` / `List.first`. The lambda-bearing ops in money expressions still inherit the money-comparison gap above — Java/TS emit a native `>` on the precise-decimal operand inside the lambda, which is the same honest limitation noted in [Money arithmetic](#money-arithmetic-closed).

### `.contains` — membership over a reference collection

`.contains(x)` is the eighth divergence axis on its own, because inside a **repository `find` filter** over a `X id[]` reference collection it is *not* an in-memory scan — it lowers to a join-table query against the auto-derived association.

```ddd
aggregate Product {
  name: string
  tags: Tag id[]
}
repository Products for Product {
  find taggedWith(t: Tag id): Product[] where tags.contains(t)
}
```

The `where tags.contains(t)` filter:

::: tabs backend
== node
```ts
// Drizzle: a subquery over the product_tags join table
async taggedWith(t: Ids.TagId): Promise<Product[]> {
  const rootRows = await this.db.select().from(schema.products).where(
    inArray(schema.products.id,
      this.db.select({ id: schema.productTags.productId })
        .from(schema.productTags).where(eq(schema.productTags.tagId, t))));
  // …hydrate associations, return
}
```
== dotnet
```csharp
// EF Core: an EXISTS over the join DbSet
public async Task<List<Product>> TaggedWith(TagId t, CancellationToken cancellationToken = default)
{
    var result = await _db.Products
        .Where(x => _db.ProductTagses.Any(__j => __j.ProductId == x.Id && __j.TagId == t))
        .ToListAsync(cancellationToken);
    return result;
}
```
== elixir
```elixir
# Ash filter: exists over the auto-generated many_to_many relationship
read :tagged_with do
  argument :t, :uuid
  filter expr(exists(tags_through, id == ^arg(:t)))
end
```
::: end

(Java and Python emit the analogous backend's join query.) Outside a `find` filter — a `.contains(x)` over an in-memory list — the same op falls back to the plain membership idiom: `.includes` / `.Contains` / `.contains` / `x in list` / `Enum.member?`.

## Lambdas

`x => expr` (single-expression body, the only form domain-logic backends render) or `x => { stmt* }` (block body, page-event-handler territory — React/Vue only). Lambdas are pure; their body renders with the outer `this` still in scope. They appear as the argument to a collection op (`l => l.amount` above) and in page event wiring.

```ddd
derived grandTotal: money = lines.sum(l => l.amount)
```

renders the lambda inline in each backend's collection-op call — `(l) => l.amount` (TS), `l => l.Amount` (.NET), `l -> l.amount()` (Java), `lambda l: l.amount` (Python), `fn l -> l.amount end` (Elixir), as shown under [Collection operators](#collection-operators). Block-body lambdas never reach a domain-logic renderer; the TS target emits a guarded placeholder if one ever does.

## Conversions

The explicit, infallible widening/projection vocabulary — `string(x)`, `long(x)`, `decimal(x)`, `money(x)` — required where the strict binary checker won't widen implicitly (string concat with a non-string; bridging a typed `decimal` into `money`; the lossy `decimal(moneyValue)` projection). Admitted pairs: `string ← {int,long,decimal,money,bool}`, `long ← int`, `decimal ← {int,long,money}`, `money ← {int,long,decimal}`. Fallible parses (`int("42")`, `datetime("…")`) are deliberately **not** in the vocabulary yet.

```ddd
aggregate Money {
  cents: decimal
  qty: int
  derived asMoney: money = money(cents)
  derived label: string  = string(qty)
}
```

The per-(from, target) leaf decides the idiom — e.g. `money(decimalField)`:

::: tabs backend
== node
```ts
// number → decimal.js Decimal
new Decimal(this._cents)
```
== python
```python
# str-wrap avoids float artifacts
Decimal(str(self._cents))
```
== dotnet
```csharp
// money IS System.Decimal in C#, so money(decimalField) is a no-op
this.Cents
// (money(intField) instead casts: (decimal)x)
```
::: end

`string(x)` is `String(x)` / `.ToString(InvariantCulture)` / `String.valueOf(x)` / `str(x)` / `to_string(x)`; `decimal(moneyValue)` is the only lossy one (TS `.toNumber()`, narrowing the precise decimal back to `number`). .NET treats `money` and `decimal` as the same `System.Decimal`, so conversions between them are no-ops.

## Magic references

Three identifiers resolve specially in expression position, plus the implicit `this`:

| Reference | Meaning | renders as |
|---|---|---|
| `this` | the aggregate/VO instance | the receiver name (`this`, or a row var `r` in a view bind) |
| `id` | the instance's identity | `this._id` (TS, inside) / `this.Id` / `record.id` |
| `currentUser` | the authenticated user-claim shape | the per-request `currentUser` param/local each emitter materialises |
| `permissions.<name>` | a permission predicate (`currentUser.permissions.contains(x)`) | the resolved permission check |

`this` is byte-identical across backends (handled in `renderExprWith` itself, not the target table). `id` and `currentUser` are leaf-resolved: `id` reads the private backing field inside the class and the public getter outside (view bind projections swap `this` for the external row variable). See [`../auth.md`](../auth.md) for how `currentUser` / `permissions` thread through the request.

---

Filters in repository `find` clauses, criteria, and views are this same expression language under a different validator lens (they must be *queryable* — translatable to SQL/Ash). See [`../criterion.md`](../criterion.md) for the predicate-specification surface and the queryability rules; [Statements](06-statements.md) for the `:=` / `+=` / `let` / `emit` forms that expressions appear inside.
