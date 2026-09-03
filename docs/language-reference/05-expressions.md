# 5. Expressions

The one expression language shared by invariants, derived fields, operation bodies, repository `find` filters, `criterion` predicates, projection `select` clauses, and page bodies. Every backend consumes the *same* fully-resolved `ExprIR` — names already carry a `refKind`, member accesses a `receiverType`, calls a `callKind` — so the only thing that differs across targets is leaf spelling: operator syntax, money arithmetic, and collection-op shape. This chapter shows that divergence directly.

> **Grammar:** `Expression` (`Lambda` · `MatchExpr` · `TernaryExpr`), `OrExpr`..`MultiplicativeExpr`, `UnaryExpr`, `PostfixExpr` / `PostfixSuffix` (`MemberSuffix` / `CallSuffix`), `CallArg`, `PrimaryExpr` (`LiteralExpr`, `MoneyLit`, `NowExpr`, `ThisRef`, `IdRef`, `NameRef`, `ParenExpr`, `ListLit`, `TemplateString` / `TemplateHole`, `PrimitiveConversion`, `BuilderCall`, `ObjectLit`, `RetrievalLiteral`), `MatchSubject` (`AwaitExpr`), `VariantArm` · **Validators:** `loom.ternary-condition` / `loom.ternary-branches`, `loom.intrinsic-*`, `loom.interp-format-unknown` / `loom.interp-hole-type`, `loom.duration-arity` / `loom.duration-arg-type`, `loom.distinct-non-scalar` / `loom.avg-non-numeric` / `loom.join-non-string` / `loom.reduction-non-comparable` / `loom.bare-collection-accessor`, `loom.collection-op-in-ui` / `loom.frontend-collection-op-unsupported`, `loom.user-visible-concat`, `loom.match-*`, `loom.unknown-name` / `loom.unknown-member`, `loom.call-arg-count` / `loom.call-arg-type` (`src/language/validators/types.ts`, `temporal.ts`, `template.ts`, `match.ts`, `i18n-strings.ts`, `statements.ts`) · **Lowering:** [`lower-expr.ts`](../../src/ir/lower/lower-expr.ts); shared dispatch in [`_expr/target.ts`](../../src/generator/_expr/target.ts) · **Docs:** [`../stdlib.md`](../stdlib.md), [`../criterion.md`](../criterion.md), [`../language.md`](../language.md)

How the rest of the pipeline sees an expression: the `ExprIR.kind` switch and **all** recursion live once in `renderExprWith` (`src/generator/_expr/target.ts`); each backend supplies only a leaf table (`TS_TARGET` / `CS_TARGET` / `JAVA_TARGET` / `PY_TARGET` / `ELIXIR_TARGET`). The union has **21 kinds** today — `literal`, `this`, `id`, `ref`, `member`, `method-call`, `call`, `action-ref`, `lambda`, `new`, `object`, `list`, `authz-filter`, `paren`, `unary`, `binary`, `ternary`, `convert`, `duration`, `i18nFormat`, `match` (`src/ir/types/loom-ir.ts`). The leaf-divergence axes are: operator spelling, name casing, **money arithmetic**, collection ops, `refColl.contains` membership, regex, `ref` role, and `callKind` call syntax. Every example below puts the expression inside a `derived` field or repository `find` so it actually emits; the outputs were generated from one scratch system with one deployable per backend (`node bin/cli.js generate system expr.ddd -o out`).

## Precedence & associativity

Standard C-family precedence, encoded as a rule cascade — lowest binds last. `Expression` itself is `Lambda | MatchExpr | TernaryExpr`, so a lambda or a `match` is a whole-expression form (an argument, a `derived` body), never a binary operand.

```
Lambda / MatchExpr / TernaryExpr  x => …   match { … }   ?:   (lowest)
OrExpr        ||
AndExpr       &&
EqualityExpr  ==  !=
ComparisonExpr <  <=  >  >=
AdditiveExpr  +  -
MultiplicativeExpr *  /  %
UnaryExpr     !  -                      (prefix)
PostfixExpr   .member  .member(...)  (...)   (highest)
```

Binary chains are flat in the AST (`head` + parallel `ops[]` / `rest[]`), not recursive — `a + b - c` is one `BinaryChain` node that lowering folds left-associatively into nested `binary` IR nodes. Parenthesise with `( … )` to override; the paren survives lowering as a `paren` node and re-emits verbatim.

## Literals

String, integer, decimal, boolean, `null`, the keyword literals `now()` and `money("…")`, list literals `[a, b]`, and backtick templates (see [String interpolation](#string-interpolation)).

```ddd
aggregate Sample {
  qty: int
  note: string
  derived greeting: string = note
  derived seenNow: datetime = now()
  derived xs: string[] = ["a", "b"]
}
```

The `STRING` terminal strips its quotes (`"hi"` → the 3-char value `hi`), so anything emitting a string literal **re-quotes** (`JSON.stringify` or the target equivalent). `INT`/`DECIMAL` pass through as source-compatible numeric text; `now()` is the current-instant constructor.

::: tabs backend
== node
```ts
get seenNow(): Date { return new Date(); }
get xs(): string[] { return ["a", "b"]; }
```
== dotnet
```csharp
public DateTime SeenNow => DateTime.UtcNow;
```
== java
```java
public Instant seenNow() {
    return Instant.now();
}
```
== python
```python
@property
def seen_now(self) -> datetime:
    return datetime.now(UTC)
```
== elixir
```elixir
# derived fields are rendered inline in the controller's serializer map
"seenNow" => DateTime.utc_now(),
```
::: end

`money("10.50")` is its own literal (`MoneyLit`) — the string argument carries the precise decimal, parsed losslessly into each host's precise-decimal type (`decimal.js`, `System.Decimal`, `BigDecimal`, Python `Decimal`, Elixir `Decimal`). It is distinct from a lossy `decimal`; see [Money arithmetic](#money-arithmetic-closed).

`[]` is one keyword token (the array marker in `string[]`), so an empty list literal is written either `[]` or `[ ]` — both parse (`ListLit`). A bare `{ a: 1 }` (`ObjectLit`) is only meaningful in e2e test bodies as a request payload; a typed construction is `Name { … }` (`BuilderCall`, see [Statements](06-behavior-and-statements.md#let--emit)).

## String concatenation

`+` with a `string` operand is concatenation. The other operand is **implicitly stringified** when its type has a canonical string form — `int` / `long` / `decimal` / `money` / `bool`, an `enum`, an `X id`, or an aggregate that declares `derived display`. Anything else (`datetime`, a value object, a collection) is rejected by the binary type checker (`Operator '+' has incompatible operand types …`); wrap it in a `derived` that formats it, or convert with `string(x)`. The explicit and implicit forms lower identically:

```ddd
aggregate Order {
  qty: int
  derived qtyLabel: string = "qty=" + string(qty)   // same output as "qty=" + qty
}
```

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
public String qtyLabel() {
    return "qty=" + String.valueOf(this.qty);
}
```
== python
```python
@property
def qty_label(self) -> str:
    return "qty=" + str(self._qty)
```
== elixir
```elixir
"qtyLabel" => "qty=" <> to_string(record.qty),
```
::: end

In a **user-visible page slot** (`Text { "Order " + name }`, a `title:`, a button label, …) string concatenation is an error — `loom.user-visible-concat` — because a fixed English prefix cannot be reordered by a translator. Write a backtick template instead (`` `Order {name}` ``), which extracts to an ICU catalog entry; see [String interpolation](#string-interpolation) and [UI pages](15-ui-pages-structure.md).

## Arithmetic & widening

`+ - * / %` on numeric types. `int < long < decimal` widen implicitly, and **`/` on two integers widens to `decimal`** (`qty / 2` is a `decimal`; declaring it `int` is a type error). Mixing in a `money` operand follows the closed rules below. Sensitivity tags (`sensitive(...)`) flow through arithmetic and concatenation.

## Money arithmetic (closed)

Money is the headline divergence axis. The type checker admits exactly:

```
money ± money                → money
money × {int|long|decimal}   → money   (commutative)
money ÷ {int|long|decimal}   → money
anything else involving money → rejected
```

A bare numeric **literal** beside a money operand is promoted to `money` first, so `price * 2` is rejected today as `money × money` — write `price * decimal(2)` or bind the scalar to a typed field/parameter. (`money × money`, `money ÷ money` and `money % x` are all rejected — `Operator '/' has incompatible operand types: left is 'money', right is 'money'`; plain `decimal ÷ decimal` is ordinary arithmetic and stays admitted.)

Each backend keeps **one representation rule** for the two types, and the rendered arithmetic follows from it:

| backend | `money` | `decimal` | mixed `money × decimal` site |
|---|---|---|---|
| node | `decimal.js` `Decimal` | `number` | `Decimal` methods (`plus`/`minus`/`times`/`div`/`mod`), the `number` operand is accepted as-is |
| dotnet | `decimal` | `decimal` | native operators |
| java | `BigDecimal` | `BigDecimal` | `add`/`subtract`/`multiply`/`divide(…, MathContext.DECIMAL128)` |
| python | `Decimal` | `float` | the `float` is re-wrapped: `Decimal(str(x))` |
| elixir | `Decimal` | `Decimal` | `Decimal.mult`/`add`/… |

`decimal` narrows at the wire boundary on the typed-serializer backends (`double` on .NET/Java, `Decimal.to_float` on Elixir, `float` in Python), while `money` stays a string — see [The type system](04-type-system.md#money--precise-column-string-on-the-wire).

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
// decimal.js: operators are methods
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
public BigDecimal tax() {
    return this.subtotal.multiply(this.taxRate);
}
public BigDecimal total() {
    return this.subtotal.add(this.tax());
}
```
== python
```python
# decimal is a float; it is re-wrapped at the arithmetic site so Decimal never meets float
@property
def tax(self) -> Decimal:
    return self._subtotal * Decimal(str(self._tax_rate))
@property
def total(self) -> Decimal:
    return self._subtotal + self.tax
```
== elixir
```elixir
"tax" => __money_round(Decimal.mult(record.subtotal, record.tax_rate)),
```
::: end

Money **comparison** diverges the same way. In a derived field, `subtotal > money("100.00")`:

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

Inside a repository `find … where subtotal > money("100.00")` the same predicate is pushed down to the query layer instead — `gt(schema.orders.subtotal, "100.00")` (Drizzle), `x.Subtotal > 100.00m` (EF), `where e.subtotal > 100.00` (JPQL), `OrderRow.subtotal > Decimal("100.00")` (SQLAlchemy), `where: record.subtotal > 100.00` (Ecto). Java division emits `divide(r, MathContext.DECIMAL128)` (a bare `BigDecimal.divide` throws on non-terminating expansions), and the `==`/`!=`/`<`… set maps to `compareTo(...) </==/> 0`; Elixir native code maps `<=` to `Decimal.compare(...) in [:lt, :eq]`.

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
public boolean isBig() {
    return this.subtotal.compareTo(new BigDecimal("100.00")) > 0 && this.qty >= 5;
}
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
"isBig" => Decimal.compare(record.subtotal, Decimal.new("100.00")) == :gt and record.qty >= 5,
```
::: end

The leaf differences here: TS rewrites `==`→`===`, Python/Elixir spell `&&`→`and`, and non-money `==`/`>=` stay as native operators on every backend.

## Ternary & `match`

`cond ? a : b` is the inline conditional. The condition must be `bool` (`loom.ternary-condition`) and the branches must **join** — one assignable to the other, both numeric, an optional and its inner, or a `null` literal against an optional (`loom.ternary-branches`: `qty > 0 ? "a" : 1` has no join). A ternary whose condition is a null test **narrows** the tested name in the then-branch, so `note2 != null ? note2.toUpper() : "none"` is the sanctioned way to call an intrinsic on a `string?` (see [Scalar intrinsics](#scalar-intrinsics)).

`match { c1 => v1, c2 => v2, else => f }` is the predicate-arm form — the first arm whose `cond` is `true` wins; the optional `else` is the fallthrough. `match subject { Variant b => v, … }` is the **variant-match** form over an `or`-union value: each arm names a variant type and optionally binds it (narrowed); the subject must be a simple name or member read, not a call (`loom.match-subject-not-simple` — bind it with `let` first), must be a union (`loom.match-non-union-subject`), and must cover every variant or carry `else` (`loom.match-non-exhaustive`, `loom.match-unknown-variant`, `loom.match-duplicate-variant`). See [Payloads & unions](09-payloads-and-unions.md) for unions and [UI primitives](16-ui-walker-primitives.md#match-in-markup--the-ternaryblock-split) for `match` in markup.

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
get stage(): string { return (this._status === Status.Draft ? "draft" : (this._status === Status.Placed ? "placed" : "done")); }
```
== dotnet
```csharp
public string Label => this.Qty > 0 ? "has items" : "empty";
public string Stage => (this.Status == Status.Draft ? "draft" : (this.Status == Status.Placed ? "placed" : "done"));
```
== java
```java
public String label() {
    return this.qty > 0 ? "has items" : "empty";
}
public String stage() {
    return (this.status == Status.Draft ? "draft" : (this.status == Status.Placed ? "placed" : "done"));
}
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
"label" => if record.qty > 0, do: "has items", else: "empty",
"stage" => cond do
    record.status == :Draft -> "draft"
    record.status == :Placed -> "placed"
    true -> "done"
  end,
```
::: end

## Member access & calls

`a.b` reads a member; `a.b(x)` is a method call; bare `f(x)` is a free / function call. The chain rule is `PrimaryExpr (MemberSuffix | CallSuffix)+`, optionally closed by an `ignoring` clause on a repository read (see [Repositories](10-repositories-and-queries.md#ignoring--capability-filter-bypass)). Every call is tagged at lowering with a `callKind` — `function`, `workflow-fn`, `value-object-ctor`, `private-operation`, `resource-op`, `remote-api-op`, `repo-read`, `domain-service`, `action`, `store-action`, `free` — and every `ref` with a `refKind` — `param`, `let`, `lambda`, `this-prop`, `this-vo-prop`, `this-derived`, `helper-fn`, `workflow-fn`, `enum-value`, `current-user`, `resource`, `store-field`, `match-binding` — so the backend never re-resolves; it just spells the resolved form.

Field reads inside a body may be written bare (`subtotal`) or `this`-qualified (`this.subtotal`); both lower to a `this-prop` ref. A bare backing-field read becomes `this._field` (private) inside the aggregate class on TS, the public getter on .NET/Java, `self._field` in Python, `record.field` on Elixir. Enum members render as `Status.Draft` (`:Draft` on Elixir). Calls are arity- and type-checked (`loom.call-arg-count` / `loom.call-arg-type`); an unresolved name or member is `loom.unknown-name` / `loom.unknown-member`. `CallArg` admits an optional `name:` prefix (`Form(state: order)`) for named arguments — threaded into `argNames`; renderers that don't care ignore it.

A call to a sibling `function` or `private operation` is a bare `recompute()` in the source and lowers to `this.recompute()` (TS/.NET/Java) or `self._recompute()` (Python); see [Behavior](06-behavior-and-statements.md#operation--a-mutating-method).

## Scalar intrinsics

Primitive receivers carry a closed method catalogue ([`../stdlib.md`](../stdlib.md), regenerate with `npm run docs:stdlib`): `string` — `.length` (a member, not a call), `trim`, `toUpper`, `toLower`, `substring`, `startsWith`, `endsWith`, `contains`, `replace`, `split`, plus the regex test `matches(re)`; `int`/`long` — `abs`, `min`, `max`, `divTrunc`; `decimal`/`money` — `abs`, `min`, `max`, `round(places?)`, `floor`, `ceil`; `datetime` — `startOfDay`. The catalogue is validated at the call site: `toUpper("x")` → `loom.intrinsic-arity`, `note.shout()` → `loom.intrinsic-unknown` (the message lists what *is* available), a bare `note.toUpper` → `loom.intrinsic-bare`, `startsWith(s: "a")` → `loom.intrinsic-named-arg`, `startsWith(3)` → `loom.intrinsic-arg-type`, and any intrinsic on a `T?` receiver → `loom.intrinsic-nullable-receiver` (guard it with a null-narrowing ternary).

```ddd
aggregate Order {
  note: string
  subtotal: money
  derived shout: string   = note.toUpper()
  derived rounded: money  = subtotal.round(2)
  derived isCode: bool    = note.matches("^[A-Z]{3}$")
}
```

::: tabs backend
== node
```ts
get shout(): string { return this._note.toUpperCase(); }
get rounded(): Decimal { return this._subtotal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP); }
get isCode(): boolean { return /^[A-Z]{3}$/.test(this._note); }
```
== dotnet
```csharp
public string Shout => this.Note.ToUpperInvariant();
public decimal Rounded => Math.Round(this.Subtotal, 2, MidpointRounding.AwayFromZero);
public bool IsCode => Regex.IsMatch(this.Note, "^[A-Z]{3}$");
```
== java
```java
public String shout() {
    return this.note.toUpperCase(java.util.Locale.ROOT);
}
public BigDecimal rounded() {
    return this.subtotal.setScale(2, java.math.RoundingMode.HALF_UP);
}
public boolean isCode() {
    return MATCHES_PATTERN_0.matcher(this.note).find();   // a hoisted static Pattern
}
```
== python
```python
@property
def shout(self) -> str:
    return self._note.upper()
@property
def rounded(self) -> Decimal:
    return self._subtotal.quantize(Decimal(1).scaleb(-(2)), rounding="ROUND_HALF_UP")
@property
def is_code(self) -> bool:
    return re.search("^[A-Z]{3}$", self._note) is not None
```
== elixir
```elixir
"shout" => String.upcase(record.note),
"rounded" => __money_round(Decimal.round(record.subtotal, 2, :half_up)),
"isCode" => Regex.match?(~r/^[A-Z]{3}$/, record.note),
```
::: end

`string.length` counts **Unicode code points** on every backend (`[...s].length` / `EnumerateRunes().Count()` / `codePoints().count()` / `len(s)` / a charlist length) — see [Invariants](07-invariants-derived-functions.md#length-counts-code-points).

## Collection operators

The closed set over a list-typed receiver: `.count`, `.first`, `.firstOrNull`, `.distinct` (members, no parens), `.sum(λ)`, `.all(λ)`, `.any(λ)`, `.where(λ)`, `.map(λ)`, `.sortBy(λ, desc?)`, `.min(λ)`, `.max(λ)`, `.avg(λ)`, `.take(n)`, `.skip(n)`, `.join(sep)`, `.contains(x)`. Typing: `count` → `int`; `sum`/`map` → the lambda's body type; `min`/`max`/`firstOrNull` → optional; `avg` → `money?` for a money projection else `decimal?`. Gates: `.sum` without a lambda is `loom.bare-collection-accessor`; `.distinct` over entities / id references is `loom.distinct-non-scalar`; `.join` over a non-string list is `loom.join-non-string`; `.min`/`.max` over a non-comparable projection is `loom.reduction-non-comparable`; `.avg` over a non-numeric one is `loom.avg-non-numeric`. Each is flagged `isCollectionOp` at lowering and lowered to the host's idiom — there is no shared runtime.

**Backend-only.** In a page or component expression only `.map` (and `.join`) render; every other op is `loom.collection-op-in-ui` / `loom.frontend-collection-op-unsupported` — compute it in a `derived`, a `find`, or a `projection` and bind the result.

```ddd
aggregate Order {
  notes: string[]
  contains lines: Line[]
  derived lineCount: int    = lines.count
  derived grandTotal: money = lines.sum(l => l.amount)
  derived allPositive: bool = lines.all(l => l.amount > money("0.00"))
  derived bigLines: Line[]  = lines.where(l => l.amount > money("10.00"))
  derived maxAmount: money? = lines.max(l => l.amount)
  derived noteList: string  = notes.join(", ")
  derived hasTag: bool      = notes.contains("vip")
  entity Line { amount: money }
}
```

::: tabs backend
== node
```ts
get lineCount(): number { return this._lines.length; }
get grandTotal(): Decimal { return (this._lines).reduce((acc, x) => acc.plus(((l) => l.amount)(x)), new Decimal(0)); }
get allPositive(): boolean { return (this._lines).every((l) => l.amount.gt(new Decimal("0.00"))); }
get bigLines(): Line[] { return (this._lines).filter((l) => l.amount.gt(new Decimal("10.00"))); }
get maxAmount(): Decimal | null { return ((this._lines).length ? (this._lines).map((l) => l.amount).reduce((__a, __b) => (__b.gt(__a) ? __b : __a)) : null); }
get noteList(): string { return (this._notes).join(", "); }
get hasTag(): boolean { return (this._notes).includes("vip"); }
```
== dotnet
```csharp
public int LineCount => this.Lines.Count;
public decimal GrandTotal => (this.Lines).Sum(l => l.Amount);
public bool AllPositive => (this.Lines).All(l => l.Amount > 0.00m);
public List<Line> BigLines => (this.Lines).Where(l => l.Amount > 10.00m).ToList();
public decimal? MaxAmount => ((this.Lines).Count == 0 ? (decimal?)null : (this.Lines).Max(l => l.Amount));
public string NoteList => string.Join(", ", (this.Notes));
public bool HasTag => (this.Notes).Contains("vip");
```
== java
```java
public int lineCount() { return this.lines.size(); }
public BigDecimal grandTotal() { return this.lines.stream().map(l -> l.amount()).reduce(BigDecimal.ZERO, BigDecimal::add); }
public boolean allPositive() { return this.lines.stream().allMatch(l -> l.amount().compareTo(new BigDecimal("0.00")) > 0); }
public List<Line> bigLines() { return this.lines.stream().filter(l -> l.amount().compareTo(new BigDecimal("10.00")) > 0).toList(); }
public BigDecimal maxAmount() { return this.lines.stream().map(l -> l.amount()).max(java.util.Comparator.naturalOrder()).orElse(null); }
public String noteList() { return String.join(", ", this.notes); }
public boolean hasTag() { return this.notes.contains("vip"); }
```
== python
```python
def line_count(self) -> int: return len(self._lines)
def grand_total(self) -> Decimal: return sum(((lambda l: l.amount)(__x) for __x in self._lines), Decimal(0))
def all_positive(self) -> bool: return all((lambda l: l.amount > Decimal("0.00"))(__x) for __x in self._lines)
def big_lines(self) -> list[Line]: return [__x for __x in self._lines if (lambda l: l.amount > Decimal("10.00"))(__x)]
def max_amount(self) -> Decimal | None: return max(((lambda l: l.amount)(__x) for __x in self._lines), default=None)
def note_list(self) -> str: return ", ".join(self._notes)
def has_tag(self) -> bool: return "vip" in self._notes
```
== elixir
```elixir
"lineCount" => Enum.count(record.lines),
"grandTotal" => __money_round(Enum.reduce(Enum.map(record.lines, fn l -> l.amount end), Decimal.new(0), &Decimal.add/2)),
"allPositive" => Enum.all?(record.lines, fn l -> Decimal.compare(l.amount, Decimal.new("0.00")) == :gt end),
"bigLines" => Enum.filter(record.lines, fn l -> Decimal.compare(l.amount, Decimal.new("10.00")) == :gt end),
"maxAmount" => __money_round(Enum.max(Enum.map(record.lines, fn l -> l.amount end), &(Decimal.compare(&1, &2) != :lt), fn -> nil end)),
"noteList" => Enum.join(record.notes, ", "),
"hasTag" => Enum.member?(record.notes, "vip"),
```
::: end

`.first` / `.firstOrNull` diverge per backend: `xs[0]` / `(xs[0] ?? null)` (TS), `.First()` / `.FirstOrDefault()` (.NET), `xs.get(0)` / `xs.stream().findFirst().orElse(null)` (Java), `xs[0]` / `(xs[0] if xs else None)` (Python), `List.first(xs)` for both (Elixir). Money-typed lambdas ride the money rules above (Java `compareTo`, TS `.gt`, Elixir `Decimal.compare`), so a `.sum` over money seeds `new Decimal(0)` / `BigDecimal.ZERO` / `Decimal(0)` rather than `0`.

### `.contains` — membership over a reference collection

`.contains(x)` is its own divergence axis, because inside a **repository `find` filter** over a `X id[]` reference collection it is *not* an in-memory scan — it lowers to a join-table query against the auto-derived association.

```ddd
aggregate Product {
  name: string
  tags: Tag id[]
}
repository Products for Product {
  find taggedWith(t: Tag id): Product[] where tags.contains(t)
}
```

The `where tags.contains(t)` filter (a bespoke list `find` is a deprecation warning, `loom.repository-find-deprecated` — a `criterion` + `run` is the preferred spelling, see [Repositories](10-repositories-and-queries.md); the predicate lowers the same way):

::: tabs backend
== node
```ts
// Drizzle: a subquery over the product_tags join table
async taggedWith(t: Ids.TagId): Promise<Product[]> {
  const rootRows = await this.db.select().from(schema.products).where(inArray(schema.products.id, this.db.select({ id: schema.productTags.productId }).from(schema.productTags).where(eq(schema.productTags.tagId, t))));
  // …hydrate associations, return
}
```
== dotnet
```csharp
// EF Core: an EXISTS over the join DbSet
public async Task<List<Product>> TaggedWith(TagId t, CancellationToken cancellationToken = default)
{
    var result = await _db.Products.Where(x => _db.ProductTagses.Any(__j => __j.ProductId == x.Id && __j.TagId == t)).ToListAsync(cancellationToken);
    return result;
}
```
== java
```java
// Spring Data JPQL on the element collection
@Query("select e from Product e where exists (select 1 from e.tags tags_m where tags_m = :t)")
List<Product> taggedWith(@Param("t") TagId t);
```
== python
```python
# SQLAlchemy: EXISTS over the join-table row model
rows = (await self._session.execute(select(ProductRow).where(select(ProductTagsRow).where(ProductTagsRow.product_id == ProductRow.id, ProductTagsRow.tag_id == t).exists()))).scalars().all()
```
== elixir
```elixir
# Ecto: join through the many_to_many assoc
query =
  from(record in ExApi.Orders.Product,
    join: join_row in assoc(record, :tags),
    where: join_row.id == ^t,
    distinct: true
  )
```
::: end

Outside a `find` filter — a `.contains(x)` over an in-memory list — the same op falls back to the plain membership idiom: `.includes` / `.Contains` / `.contains` / `x in list` / `Enum.member?` (shown as `hasTag` above).

## Lambdas

`x => expr` (single-expression body, the only form domain-logic backends render) or `x => { stmt* }` (block body — page event-handler territory, and even there an effect belongs in a named `action`, see `loom.effect-in-lambda` in [UI pages](15-ui-pages-structure.md#state--derived--action)). Lambdas are pure; their body renders with the outer `this` still in scope. They appear as the argument to a collection op (`l => l.amount` above) and in page event wiring.

```ddd
derived grandTotal: money = lines.sum(l => l.amount)
```

renders the lambda inline in each backend's collection-op call — `(l) => l.amount` (TS), `l => l.Amount` (.NET), `l -> l.amount()` (Java), `lambda l: l.amount` (Python), `fn l -> l.amount end` (Elixir), as shown under [Collection operators](#collection-operators).

## Temporal arithmetic — `duration`

`days(n)`, `hours(n)`, `minutes(n)` — the **three** unit constructors of the ambient `temporal` prelude ([`src/util/temporal.ts`](../../src/util/temporal.ts)) — build a `duration`, a closed temporal algebra with `datetime`: `datetime ± duration → datetime`, `datetime − datetime → duration`, `duration ± duration → duration`, `duration × int → duration`. The constructor takes exactly one `int` (`loom.duration-arity`; `days(1.5)` is `loom.duration-arg-type` — write the finer unit, `hours(36)`). There is no `months`/`years`: a `duration` is an **absolute** millisecond span with a fixed width per unit, so every backend renders it without calendar arithmetic; calendar-relative offsets would need a distinct type. The constructors are not keywords either — they are free calls that become `duration` nodes only when the name resolves to nothing else, so a user `function days(...)` shadows the builtin. `duration` is expression-only: it is not in the grammar's `PrimitiveType` rule, so there are no `duration` fields. The `DURATION` token (`15s`, `5m`) is only the `every:` cadence of a `timerSource`, not an expression literal.

```ddd
aggregate Order {
  seenAt: datetime
  derived due: datetime = seenAt + days(3)
}
```

::: tabs backend
== node
```ts
// a duration is milliseconds
get due(): Date { return new Date((this._seenAt).getTime() + (((3) * 86400000))); }
```
== dotnet
```csharp
public DateTime Due => this.SeenAt + TimeSpan.FromDays(3);
```
== java
```java
public Instant due() {
    return this.seenAt.plus(Duration.ofDays(3));
}
```
== python
```python
@property
def due(self) -> datetime:
    return self._seen_at + timedelta(days=(3))
```
== elixir
```elixir
"due" => DateTime.add(record.seen_at, ((3) * 86400000), :millisecond),
```
::: end

## String interpolation

A backtick template `` `Order {qty} x {note}` `` (`TemplateString`) interleaves literal segments with `{expr}` holes. It lowers to plain concatenation of the segments and the `string()`-converted holes, so no backend sees a new node. A hole must be a string or an implicitly stringifiable value — the same set as [concatenation](#string-concatenation); a bare `datetime` hole is `loom.interp-hole-type`. A literal brace is `\{` / `\}`, a literal backtick `` \` ``.

A hole may carry an **ICU format suffix** (`TemplateHole.format`): `{total, number, ::currency/USD}`, `{n, plural, one {# item} other {# items}}`, `{kind, select, …}`, `{when, date, short}`. The suffix narrows the hole — `number`/`plural` need a numeric, `date`/`time` need a `datetime` (which *lifts* the datetime rejection), `select` takes any stringifiable value; an unknown format word is `loom.interp-format-unknown`. In a page slot the template extracts to the i18n catalog and renders through `t()`; in domain code it is concatenation:

```ddd
aggregate Order {
  qty: int
  note: string
  derived summary: string = `Order {qty} x {note}`
}
```

::: tabs backend
== node
```ts
get summary(): string { return "Order " + String(this._qty) + " x " + this._note; }
```
== dotnet
```csharp
public string Summary => "Order " + this.Qty.ToString(System.Globalization.CultureInfo.InvariantCulture) + " x " + this.Note;
```
== java
```java
public String summary() {
    return "Order " + String.valueOf(this.qty) + " x " + this.note;
}
```
== python
```python
@property
def summary(self) -> str:
    return "Order " + str(self._qty) + " x " + self._note
```
== elixir
```elixir
"summary" => "Order " <> to_string(record.qty) <> " x " <> record.note,
```
::: end

## Conversions

The explicit, infallible widening/projection vocabulary — `string(x)`, `long(x)`, `decimal(x)`, `money(x)` (`PrimitiveConversion`). Admitted pairs: `string ← {int,long,decimal,money,bool}`, `long ← int`, `decimal ← {int,long,money}`, `money ← {int,long,decimal}`. Fallible parses (`int("42")`, `datetime("…")`) are deliberately **not** in the vocabulary. The per-(from, target) leaf decides the idiom:

```ddd
aggregate Order {
  subtotal: money
  taxRate: decimal
  derived asDecimal: decimal = decimal(subtotal)   // the one lossy projection
  derived asMoney: money     = money(taxRate)
}
```

::: tabs backend
== node
```ts
get asDecimal(): number { return this._subtotal.toNumber(); }
get asMoney(): Decimal { return new Decimal(this._taxRate); }
```
== dotnet
```csharp
// money IS System.Decimal in C#, so both directions are no-ops
public decimal AsDecimal => this.Subtotal;
public decimal AsMoney => this.TaxRate;
```
== java
```java
// both are BigDecimal — no-ops
public BigDecimal asDecimal() { return this.subtotal; }
public BigDecimal asMoney() { return this.taxRate; }
```
== python
```python
@property
def as_decimal(self) -> float:
    return float(self._subtotal)
@property
def as_money(self) -> Decimal:
    return Decimal(str(self._tax_rate))   # str-wrap avoids float artifacts
```
== elixir
```elixir
"asDecimal" => __decimal_num(record.subtotal),   # Decimal.to_float at the wire
"asMoney" => __money_round(record.tax_rate),
```
::: end

`string(x)` is `String(x)` / `.ToString(InvariantCulture)` / `String.valueOf(x)` / `str(x)` / `to_string(x)`; `money(intField)` on .NET casts `(decimal)x`.

## `await`

`await` is admitted in exactly one position: the subject of a variant `match` (`match await Orders.Order.place() { … }`) inside a page or component `action`. It marks the remote command's async boundary so its `or`-union result is matched; a bare remote mutating call in an action body is `loom.missing-effect-marker`. `await` is a soft keyword, so a field named `await` still parses. See [Statements](06-behavior-and-statements.md#match--the-effect-form-variant-match) and [`../actions.md`](../actions.md).

## Magic references

Three identifiers resolve specially in expression position, plus the implicit `this`:

| Reference | Meaning | renders as |
|---|---|---|
| `this` | the aggregate/VO instance | the receiver name (`this` / `self` / `record`) |
| `id` | the instance's identity | `this._id` (TS, inside) / `this.Id` / `record.id`; unreadable inside a `create` body (`loom.this-id-in-create`) |
| `currentUser` | the authenticated user-claim shape (`refKind: current-user`) | the per-request `currentUser` param/local each emitter materialises |
| `permissions.<name>` | a permission from the module catalogue | rewritten at lowering to the **string literal** of its runtime name (`"Projects.manageProjects"`), so `currentUser.permissions.contains(permissions.x)` is a plain membership test |

`this` is byte-identical across backends (handled in `renderExprWith` itself, not the target table). Inside a `capability` body, `Self id` names the implementing aggregate (`loom.self-outside-capability` elsewhere). See [Auth](17-auth.md#currentuser--claim-access-in-domain-logic) for how `currentUser` / `permissions` thread through the request, and the `loom.current-user-needs-auth-ui` / `loom.guard-principal-without-auth` gates that require a bound principal on the hosting deployable.

---

Filters in repository `find` clauses, criteria, and projections are this same expression language under a different validator lens (they must be *queryable* — translatable to SQL/Ecto; a non-queryable predicate is `loom.find-where-not-queryable` / `loom.retrieval-where-not-queryable` / `loom.projection-where-not-queryable`, one code per read surface). See [`../criterion.md`](../criterion.md) for the predicate-specification surface and the queryability rules; [Statements](06-behavior-and-statements.md) for the `:=` / `+=` / `let` / `emit` forms that expressions appear inside.
