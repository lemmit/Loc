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

A file is one or more **bounded contexts** (legacy, single-deployable
mode) or one or more **systems** (deployment-plan mode):

```ddd
// Legacy: bare context — generates a single project of the platform
// chosen at the CLI (`generate ts` / `generate dotnet`).
context Sales {
    // declarations...
}

// System: groups modules and deployables.  `generate system` emits
// every deployable as its own project plus a docker-compose.yml.
system Acme {
    module Catalog { context Products { … } }
    module Sales   { context Orders   { … } }
    deployable api { platform: dotnet, modules: Catalog, Sales, port: 8080 }
    deployable web { platform: hono,   modules: Catalog,         port: 3000 }
}
```

The two forms can coexist in one file but typically you'd use one or
the other.

### Inside a `system`

| Form | Purpose |
| --- | --- |
| `module Name { … }` | Groups one or more bounded contexts under a name.  A module is a logical unit; it doesn't directly produce code. |
| `deployable name { platform: dotnet\|hono, modules: A, B, port: N, auth: required? }` | A concrete artefact: one project, one HTTP server, one DbContext, listening on `port`.  Selects which modules to ship.  Optional `auth: required` enables JWT-decode middleware on this deployable; see [`auth.md`](auth.md). |
| `deployable name { platform: react, targets: <other-deployable>, port: N }` | A frontend deployable: a Vite-built React + RQ + Zod + Mantine SPA whose API base URL is wired to `targets`'s port.  Modules are inherited from the target. |
| `context Name { … }` | Allowed directly inside a system; treated as if it were in an implicit `_default` module. |
| `test e2e "name" against <deployable> { … }` | End-to-end test that runs against the named deployable's HTTP API; lowers to a vitest file at the system output root. |
| `user { id: string, role: string, … }` | System-wide JWT-claim shape decoded by the verifier hook.  At most one per system; required when any deployable opts in via `auth: required`.  The `currentUser` magic identifier in operation / workflow / view-bind expressions is typed against this shape.  See [`auth.md`](auth.md). |

A module may appear in any number of deployables — its code is inlined
into each.  For v1 there is no shared-library / npm-workspace shape;
duplication is the trade-off for simplicity.

Cross-module type references (`Id<X>`, value-object usage, enum values)
work freely as long as both types are reachable from the same
deployable's module set.  The Langium scope provider exports all
named declarations — aggregates, entity parts, value objects, enums —
across module boundaries within the same source file.

A module body may also include one or more
`permissions { ... }` blocks declaring typed permission identifiers
used in operation / workflow expression bodies.  The
`permissions.<name>` magic identifier lowers to the runtime string
`<lowercase-module>.<name>`; see [`auth.md`](auth.md).

#### Deployable platforms

| `platform:` | Stack |
| --- | --- |
| `dotnet` | ASP.NET Core + EF Core + Mediator (martinothamar) + Swashbuckle.  Default port 8080. |
| `hono`   | Hono + Drizzle ORM + Zod with `@hono/zod-openapi`.  Default port 3000. |
| `react`  | Vite + React Router + React Query + Zod + Mantine + Playwright page objects.  Default port 3001. |

Backend deployables (`dotnet`, `hono`) declare `modules:`; the
generator scopes the project to those modules' contexts.  React
deployables declare `targets: <other-deployable>` instead — the
frontend's API base URL is wired to the target's port and its module
set is inherited from the target so pages exactly cover the API
surface.  See [`generators.md`](generators.md) for what each
platform emits per aggregate.

### Inside a context

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

#### Reference collections — `Id<X>[]`

A field typed as a collection of references to another aggregate is a
**many-to-many** relation:

```
aggregate Trainer {
  party:  Id<Pokemon>[]
  caught: Id<Pokemon>[]
}
```

No grammar keyword switches it on — any aggregate field whose type is
`Id<X>[]` is a reference collection.  Semantically it is an ordered set
of references: the same target appears at most once per owner, and the
collection's order is preserved across a persistence round-trip.

Mutate the collection from operations with `+=` / `-=`:

```
operation addToParty(pokemon: Id<Pokemon>) {
  precondition party.count < 6
  party += pokemon
}
```

Membership is queryable from a repository `find ... where` (see
[Repositories](#repositories) below).

Reference collections are **not** the same as containment.
`contains lines: OrderLine[]` declares entity parts that live and die
with the parent — a child table joined on `parent_id`.  `Id<X>[]` is a
list of references to a *different* aggregate that outlives any one
owner — persisted as a separate join table when the backend supports
it (see [`docs/generators.md`](generators.md)).

### Aggregate / entity-part members

Inside an aggregate or an `entity` part:

| Form | Notes |
| --- | --- |
| `name: TypeRef [display] [provenanced] [check Expr]` | Property, with optional modifiers (in this order). `display` marks the human-readable label field; `provenanced` records assignment lineage (below); `check Expr` is a per-field validation predicate. |
| `contains name: PartName[]` | Containment of a part declared within the same aggregate; collection. |
| `contains name: PartName` | Containment, single. |
| `derived name: TypeRef = Expression` | Computed read-only property. |
| `invariant Expression [when Expression]` | `bool` predicate; checked after every mutation. Optional `when` is a guard. |
| `function name(params): TypeRef = Expression` | Pure helper; callable from any expression in the same aggregate. |
| `operation name(params) { … }` | Public mutating method (root only). |
| `private operation name(params) { … }` | Mutating method, only callable from within the same aggregate root. |
| `operation name(params) extern { precondition … }` | Public op whose business decision lives in user code; body must contain only `precondition` statements. See `extern.md`. |
| `view name = Aggregate where filter` | Shorthand: saved query, source's wire shape.  Exposed at `GET /views/<snake>`. |
| `view name { fields ... from Aggregate where? bind ... }` | Full form: declared output shape with bind-expression projections.  See `views.md`. |
| `entity Name { … }` | Nested part declaration (inside an aggregate). |
| `test "name" { … }` | Test block; lowers to vitest / xUnit (root only). |

Entity parts may declare any of the above except `operation` and `test`
(those live on the root).

#### Provenanced fields

Mark a stored field `provenanced` to capture the lineage of every value it
holds:

```
aggregate Order ids guid {
  total: int provenanced
  operation reprice(qty: int, price: int) {
    total := qty * price - discount   // write-site #1
  }
  operation applyDiscount(amount: int) {
    total := quantity * unitPrice - amount   // write-site #2
  }
}
```

Each distinct assignment site (`:=`, `+=`, `-=`) to a provenanced field is a
**rule snapshot** — the RHS expression captured both as source text and as the
resolved IR. Snapshots are content-addressed by a `snapshotId`; identical
expressions at different sites collapse to one snapshot.

The capture is an explicit, separate step from code generation:

```
ddd snapshot path/to/system.ddd -o out
# → out/.loom/snapshots/<ts>-<guid>.loomsnap.json  (one entry per write-site)
```

The TypeScript/Hono backend additionally emits a `domain/provenance.ts`
runtime SDK and a `recordTrace(...)` call after each write, so a value can be
traced back to the snapshot that produced it at runtime. Provenance is a
TypeScript/Hono feature; other backends parse the keyword but emit no trace
code. See `examples/provenance.ddd` for a runnable backend example and the
`Provenance System` playground example for the same domain as a Hono + React
system.

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
| `xs.contains(x)` | `bool` | Membership.  Renders to `Array.includes` (TS) / `Enumerable.Contains` (.NET).  Also admitted in repository `where` clauses when `xs` is a `this`-rooted `Id<X>[]` reference collection — see [Repositories](#repositories). |

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

## End-to-end tests against a deployable

Inside a `system`, declare `test e2e` blocks that exercise a running
deployable through HTTP:

```ddd
test e2e "create then confirm an order" against api {
    let prod = api.products.create({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } })
    let ord = api.orders.create({ customerId: "cust-001", status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
    api.orders.addLine(ord, { productId: prod.id, qty: 3 })
    api.orders.confirm(ord)
    let read = api.orders.getById(ord)
    expect read.status == "Confirmed"
    expect read.lines.length == 1
}
```

The magic identifier `api` resolves to the named deployable's HTTP
surface.  Member-access chains describe the call shape:

| Form | Lowers to |
| --- | --- |
| `api.<aggregate>.create({ … })` | `POST /<plural>` with the body. |
| `api.<aggregate>.getById(idExpr)` | `GET /<plural>/{id}`. |
| `api.<aggregate>.<operation>(idExpr, body?)` | `POST /<plural>/{id}/<op_snake>` with the body (or `{}` if absent). |
| `api.<aggregate>.<find>(args)` | `GET /<plural>/<find_snake>?…` with args as query string. |

When an argument is a previously bound `let` name (typically the result
of a `create` call), `.id` is appended automatically — `api.x.getById(p)`
becomes `GET /x/{p.id}`.

Bare object literals `{ a: 1, b: "x" }` are allowed inside test bodies
(elsewhere in the DSL only `new <PartName> { … }` is permitted).  They
serialize to JSON as the request body.

The generated vitest file lives at `<system>/e2e/<SystemName>.e2e.test.ts`
in the output directory.  Endpoints default to the docker-compose ports;
override per environment via `E2E_<DEPLOYABLE>_BASE` env vars.

### UI e2e tests against a react deployable

The same `test e2e` syntax targets a frontend deployable as long as
the body uses the `ui` identifier instead of `api`:

```ddd
test e2e "create then confirm an order via UI" against webApp {
    let prod = ui.products.create({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } })
    let ord = ui.orders.create({ customerId: "cust-001", status: "Draft", placedAt: "2024-01-01T00:00" })
    ui.orders.addLine(ord, { productId: prod.id, qty: 3 })
    ui.orders.confirm(ord)
    let read = ui.orders.getById(ord)
    expect read.status == "Confirmed"
    expect read.lines.length == 1
}
```

The test kind is implied by the target deployable's platform —
`react` deployables get a Playwright spec routed through the auto-
generated page objects (`<react-deployable>/e2e/pages/<aggregate>.ts`);
backend deployables get the vitest+fetch path described above.

The DSL surface is identical to api e2e (`ui.<aggregate>.<verb>(...)`);
only the lowering differs:

| Form | Lowers to |
| --- | --- |
| `ui.<aggregate>.create({ … })` | `<Agg>ListPage.goto() → create() → fill({…}) → submit()`; returns `{ id }` like the api version. |
| `ui.<aggregate>.getById(idExpr)` | `<Agg>DetailPage.goto(idExpr.id)` plus eager `field("…")` reads of every primitive / enum / VO field, plus `<containment>.length` accessors per contained collection.  The result behaves like the api JSON: `read.status` is a string, `read.lines.length` is a number. |
| `ui.<aggregate>.<operation>(idExpr, body?)` | `<Agg>DetailPage.goto(idExpr.id) → <opName>(body ?? {})` — opens the operation modal, fills it, submits. |

The generated Playwright spec lives at
`<react-deployable>/e2e/<SystemName>.ui.spec.ts`.  Run via the existing
Playwright config in that directory (`npx playwright test` from
`<react-deployable>/e2e/`).

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
  lowered to Drizzle operators (`eq`/`ne`/`lt`/`lte`/`gt`/`gte`/
  `and`/`or`/`not`/`inArray`) over `this.<col>` and
  `this.<vo>.<sub>` references, including the membership form
  `this.<refColl>.contains(param)` against an `Id<X>[]` join table.
  The queryable-subset validator rejects shapes that don't fit (e.g.
  `.count`, `.any`, lambdas) with a clear diagnostic.
- **.NET**: both forms lower to a LINQ `.Where(x => …)` predicate and
  pass through EF Core to SQL.

A repository `where` clause may use `this.<refColl>.contains(param)` to
query membership over an `Id<X>[]` reference collection — for example,
`find holdingInParty(pokemon: Id<Pokemon>): Trainer[] where
this.party.contains(pokemon)`.  The TypeScript backend lowers this to
an `inArray(...subquery...)` against the field's join table; other
collection operations (`.count`, `.any`, `.where`, …) remain rejected
by the queryable-subset validator.

`findById` and `getById` are auto-generated for every aggregate
(no need to declare them in the repository).  An auto-included
`find all(): T[]` is also added to every aggregate's repository, so
both backends always expose `GET /<plural>` and the React frontend
always has a list page to render.  Declaring your own `find all(...)`
in the DSL overrides the implicit one.

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
- A `platform: react` deployable without a `targets:` field, or
  pointing `targets:` at another `react` deployable.
- A non-react deployable using `targets:` (only valid on frontends).

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
