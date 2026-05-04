# Loom

A high-descriptive, Langium-based DSL for **Domain-Driven Design**.  Write
your aggregates, value objects, invariants, and operations in `.ddd`
sources; generate idiomatic, runnable code for either:

- **TypeScript** — Hono (HTTP) + Drizzle ORM + zod
- **.NET** — ASP.NET Core + EF Core + [Mediator](https://github.com/martinothamar/Mediator)

The pipeline is fully type-safe end-to-end:

```
   .ddd source
        │
        ▼      Langium parser & validator
   Loom AST
        │
        ▼      Lowering: name resolution, type inference, semantic shaping
   Loom IR     (platform-neutral)
        │
        ▼      Per-platform Handlebars templates + recursive expression renderer
   TypeScript / C# project
```

## Install

```bash
npm install
npm run langium:generate
npm run build
```

## CLI

```bash
ddd parse <file.ddd>                       # parse + validate, exit non-zero on errors
ddd generate ts <file.ddd> -o <outdir>     # emit TS project (Hono + Drizzle)
ddd generate dotnet <file.ddd> -o <outdir> # emit .NET project (ASP.NET + EF + Mediator)
```

## A taste of the language

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

      function subtotalAmount(): decimal = unitPrice.amount * quantity

      derived subtotal: Money =
        Money(subtotalAmount(), unitPrice.currency)

      invariant quantity > 0
    }
  }

  repository Orders for Order {
    find byCustomer(customerId: Id<Customer>): Order[]
  }
}
```

## Language reference

### Top-level declarations

| Form | Purpose |
| --- | --- |
| `context Foo { … }` | A bounded context.  Files can hold one or more. |
| `enum Status { A, B, C }` | A finite enumeration of named values. |
| `valueobject Money { … }` | An immutable record with optional invariants and derived members. |
| `event OrderConfirmed { … }` | A flat record raised via `emit`. |
| `aggregate Order [ids guid|int|long|string] { … }` | An aggregate root with implicit `Id<Order>`. |
| `repository Orders for Order { find … }` | Repository declaration with optional `find` queries. |

### Identity

- `aggregate Order { … }` and `entity OrderLine { … }` (only inside an
  aggregate) implicitly declare an `Id<…>` type and an `id` field.
- Cross-aggregate references are by id: `customerId: Id<Customer>`.
- Override the underlying value type with `aggregate Order ids int { … }`.

### Aggregate / part members

- `name: TypeRef` — a property.
- `contains name: PartName[]` (or non-collection) — a containment with
  auto-derived parent FK.
- `derived name: TypeRef = Expression` — a computed read-only property.
- `invariant Expression [when Expression]` — a `bool` predicate that
  must hold; checked after every mutation.
- `function name(params): TypeRef = Expression` — pure helper; callable
  from any expression in the same aggregate.
- `operation name(params) { … }` — public mutating method (only on the
  root).  Add `private operation` to keep it internal to the aggregate.

### Statements (in operation bodies)

- `precondition Expression` — runtime check; fails to a 400 over HTTP.
- `name := Expression` — assignment to a property reachable from the root.
- `coll += value` / `coll -= value` — collection mutation.
- `emit EventName { field: Expression, … }` — raise a domain event.
- `let name = Expression` — local binding.
- `helperName(args)` / `privateOp(args)` — call a helper or private op.

### Expressions

Pragmatic core: literals, references, member access, `+ - * / %`,
comparisons, `&& || !`, ternary, lambdas, collection ops (`count`, `sum`,
`all`, `any`, `where`, `first`, `firstOrNull`), `new PartName { … }`,
value-object constructor calls, `now()`.

## Project layout

```
src/
  language/        # Langium grammar, scope provider, validator, type system
  ir/              # Loom IR (semantic, platform-neutral) + lowering
  generator/
    typescript/    # Hono + Drizzle backend (templates + repository builder)
    dotnet/        # ASP.NET + EF + Mediator backend (templates + helpers)
  cli/             # ddd parse / ddd generate
  util/            # naming helpers
examples/          # sample .ddd sources
test/              # parsing, validation, and generator tests
```

## Documentation

- [`docs/language.md`](docs/language.md) — formal language reference
  (declarations, types, expressions, statements, validation rules).
- [`docs/tools.md`](docs/tools.md) — CLI usage, `.loomignore` escape
  hatch, watch mode, migration workflow with native tools.
- [`docs/technical.md`](docs/technical.md) — architecture: AST → IR →
  templates, design rationale, how to extend the language or add a
  backend.

## Status

19 vitest tests cover parsing, validation, both generators, and the
CLI (`.loomignore`, `--dry-run`).  Generated TypeScript type-checks
under strict `tsc`; the generated vitest suite passes.  Generated
.NET requires the .NET SDK to build; the `.csproj` wires Mediator
source-generation, EF Core, design-time migrations, and xUnit hooks.

See `experience_gathered.md` for a running retrospective of the
project — gotchas, design trade-offs, and refactor notes.
