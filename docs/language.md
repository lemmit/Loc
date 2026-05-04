# Loom — Language Reference

Loom is a high-descriptive DSL for **Domain-Driven Design**.  A `.ddd`
source describes one or more bounded contexts, each containing the
familiar DDD primitives — aggregates, value objects, enums, events,
repositories — with strongly-typed invariants, operations, and a small
expression language.

This document defines the language formally.  For the architectural
view (AST → IR → templates) see [`technical.md`](technical.md); for CLI
and tooling see [`tools.md`](tools.md).

---

## Lexical structure

- **Comments**: `// line` and `/* block */`.
- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`.  Case-sensitive.
- **String literals**: double-quoted, standard backslash escapes.
- **Number literals**: `INT` (`/[0-9]+/`) and `DECIMAL` (`/[0-9]+\.[0-9]+/`).
- **Whitespace** and comments are ignored between tokens.

Reserved keywords:

```
context  enum  valueobject  aggregate  entity  contains  ids
event  repository  for  find  where
derived  invariant  when  function  operation  private
precondition  emit  let  expect  expectThrows  test  new
true  false  null  this  id  Id
int  long  decimal  string  bool  datetime  guid
```

---

## Top-level declarations

A file is one or more bounded contexts:

```
context Sales {
    // declarations...
}
```

Inside a context, the following kinds of declarations may appear, in any
order:

| Form | Purpose |
| --- | --- |
| `enum Name { A, B, C }` | Closed enumeration; values are referenced bare. |
| `valueobject Name { … }` | Immutable record with optional invariants and derived members. |
| `aggregate Name [ids guid\|int\|long\|string] { … }` | Aggregate root with implicit `Id<Name>` field. |
| `event Name { field: Type, … }` | Flat record raised via `emit`. |
| `repository Name for Aggregate { find … }` | Repository declaration with optional find queries. |

### Identity and `Id<X>`

`aggregate Order { … }` implicitly declares an identity field `id` of
type `Id<Order>`.  Likewise each `entity Foo { … }` declared inside an
aggregate implicitly has an `id: Id<Foo>` plus an implicit parent
reference.

Cross-aggregate references are written as `Id<Other>`:

```
customerId: Id<Customer>
```

The underlying value type defaults to `guid`; override per-aggregate:

```
aggregate Order ids int { … }
```

### Aggregate / entity-part members

Inside an aggregate or an `entity` part:

| Form | Notes |
| --- | --- |
| `name: TypeRef` | Property. |
| `contains name: PartName[]` | Containment of a part declared within the same aggregate; collection. |
| `contains name: PartName` | Containment, single. |
| `derived name: TypeRef = Expression` | Computed read-only property. |
| `invariant Expression [when Expression]` | `bool` predicate; checked after every mutation. Optional `when` is a guard. |
| `function name(params): TypeRef = Expression` | Pure helper; callable from any expression in the same aggregate. |
| `operation name(params) { … }` | Public mutating method (root only). |
| `private operation name(params) { … }` | Mutating method, only callable from within the same aggregate root. |
| `entity Name { … }` | Nested part declaration (inside an aggregate). |
| `test "name" { … }` | Test block; lowers to vitest / xUnit (root only). |

Entity parts may declare any of the above except `operation` and `test`
(those live on the root).

### Type references

```
TypeRef = BaseType ('[]')? ('?')?
BaseType = PrimitiveType | 'Id' '<' Identifier '>' | NamedType
PrimitiveType = 'int' | 'long' | 'decimal' | 'string' | 'bool' | 'datetime' | 'guid'
NamedType = Identifier      // resolves to enum / valueobject (only)
```

`Id<X>` resolves to either an aggregate or an entity-part declared in
scope.  `NamedType` resolves to enums and value objects; aggregates are
*never* referenced by their bare name in cross-aggregate properties —
use `Id<X>` instead.

`T[]` denotes a collection; `T?` denotes an optional value.

---

## Expression language

Pragmatic core, similar to a subset of TypeScript / C# expressions.

### Literals

| Kind | Examples |
| --- | --- |
| String | `"hello"` |
| Integer | `0`, `42` |
| Decimal | `1.5`, `0.0` |
| Boolean | `true`, `false` |
| Null | `null` |
| Now | `now()` — current `datetime` |

### References

| Form | Resolves to |
| --- | --- |
| `id` | the implicit identity of the enclosing aggregate or part. |
| `this` | the enclosing aggregate / part / value object. |
| `name` | a parameter, `let`-binding, lambda parameter, property of `this`, derived member, helper `function`, or enum value (in lookup order). |

### Composite

| Form | Notes |
| --- | --- |
| `a.b` | Member access. |
| `a.b(x, y)` | Method call (collection ops, helper functions). |
| `f(args)` | Free call (helper function or value-object constructor). |
| `(expr)` | Grouping. |
| `-x`, `!x` | Unary. |
| `a + b`, `a - b`, `a * b`, `a / b`, `a % b` | Arithmetic. |
| `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b` | Comparison. |
| `a && b`, `a \|\| b` | Logical. |
| `cond ? a : b` | Ternary. |
| `x => expr` | Lambda (only valid as a collection-op argument). |
| `new PartName { field: expr, … }` | Construct a contained part; `id` and parent `parentId` are auto-injected. |
| `Money(amount, currency)` | Value-object constructor. |

### Collection operators

When the receiver type is `T[]`:

| Form | Returns | Notes |
| --- | --- | --- |
| `xs.count` | `int` | Length. |
| `xs.sum(x => expr)` | type of `expr` | Reduction; element-typed. |
| `xs.all(x => expr)` | `bool` | Universal quantifier. |
| `xs.any(x => expr)` | `bool` | Existential quantifier. |
| `xs.where(x => expr)` | `T[]` | Filter. |
| `xs.first` | `T` | First element (assumes non-empty). |
| `xs.firstOrNull` | `T?` | First or `null`. |

### Numeric widening

Within arithmetic, `int < long < decimal`.  An `int` is assignable to
`long` or `decimal`; a `long` to `decimal`.

---

## Statements (in operation bodies)

| Form | Purpose |
| --- | --- |
| `precondition Expression` | Runtime check; failure throws a domain error (HTTP 400). |
| `lhs := Expression` | Assignment to a property reachable from `this`.  Derived properties are not assignable. |
| `coll += value` | Append to a contained collection. |
| `coll -= value` | Remove from a contained collection. |
| `emit EventName { field: expr, … }` | Raise a domain event; drained by the repository on `save`. |
| `let name = Expression` | Local binding for the rest of the operation body. |
| `helperName(args)` | Call a helper `function` or `private operation` of the same aggregate. |

---

## Tests

Each aggregate may declare zero or more `test` blocks at the root level:

```ddd
test "money literal builds" {
    let m = Money(10.5, "USD")
    expect m.amount == 10.5
    expect m.currency == "USD"
}

test "negative money rejected" {
    expectThrows Money(-1.0, "USD")
}
```

Inside a test body the standard operation statements are allowed plus:

| Form | Lowers to |
| --- | --- |
| `expect Expression` | vitest `expect(<expr>).toBe(true)` / xUnit `Assert.True(<expr>)`. |
| `expectThrows Expression` | vitest `expect(() => <expr>).toThrow()` / xUnit `Assert.Throws<DomainException>(() => <expr>)`. |

Test blocks emit one file per aggregate:
- TS: `domain/<aggregate>.test.ts` (vitest).
- .NET: `Tests/<Plural>/<Aggregate>Tests.cs` (xUnit).

---

## Repositories

```ddd
repository Orders for Order {
    // convention-based: parameter names match aggregate properties.
    find byCustomer(customerId: Id<Customer>): Order[]

    // explicit predicate; `this` refers to the aggregate root.
    find activeForCustomer(forCustomer: Id<Customer>): Order[]
        where this.customerId == forCustomer && this.status == Draft
}
```

Each `find` declaration becomes a method on the generated repository
plus a Mediator query in the .NET backend.

- **TypeScript**: when no `where` is given, parameters are equality-
  matched against aggregate columns and lowered to a Drizzle
  `where(eq(...))`.  When `where` is given, the IR expression is
  rendered into a TODO-comment and the user implements the predicate
  manually (Drizzle has no general lambda → SQL translator).
- **.NET**: both forms lower to a LINQ `.Where(x => …)` predicate and
  pass through EF Core to SQL.

`findById` and `getById` are auto-generated for every aggregate
(no need to declare them in the repository).

---

## Validation rules

The validator runs after parsing and reports errors for:

- `precondition` and `invariant` expressions whose type is not `bool`.
- Field / parameter / call / member-access type mismatches.
- Assignment to a derived property.
- `emit` payloads that don't match the event's declared shape.
- Unknown / out-of-scope `Id<X>` targets.
- `contains` referencing a part that belongs to a different aggregate.
- Operations or `test` blocks declared outside an aggregate root.

Warnings (non-fatal):

- Self-recursive operation calls (often unintentional).
- `emit` payloads missing optional fields.

---

## A complete example

```ddd
context Sales {

    enum OrderStatus { Draft, Confirmed, Shipped, Cancelled }

    valueobject Money {
        amount: decimal
        currency: string
        invariant amount >= 0
        invariant currency.length == 3
    }

    event OrderConfirmed { order: Id<Order>, at: datetime }

    aggregate Customer { name: string, email: string }
    aggregate Product  { sku: string, price: Money }

    aggregate Order {
        customerId: Id<Customer>
        status: OrderStatus
        placedAt: datetime
        contains lines: OrderLine[]

        derived total: Money =
            Money(lines.sum(l => l.subtotal.amount), "USD")

        invariant lines.count > 0 when status == Confirmed

        function isMutable(): bool = status == Draft

        operation addLine(productId: Id<Product>, qty: int, price: Money) {
            precondition isMutable()
            precondition qty > 0
            lines += new OrderLine {
                productId: productId, quantity: qty, unitPrice: price
            }
        }

        operation confirm() {
            precondition isMutable()
            precondition lines.count > 0
            status := Confirmed
            emit OrderConfirmed { order: id, at: now() }
        }

        entity OrderLine {
            productId: Id<Product>
            quantity: int
            unitPrice: Money
            derived subtotal: Money =
                Money(unitPrice.amount * quantity, unitPrice.currency)
            invariant quantity > 0
        }

        test "money literal builds" {
            let m = Money(10.5, "USD")
            expect m.amount == 10.5
            expect m.currency == "USD"
        }
    }

    repository Orders for Order {
        find byCustomer(customerId: Id<Customer>): Order[]
    }
}
```
