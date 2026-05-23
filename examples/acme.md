# Demo: Acme — product catalog + sales orders, end to end

Five-minute tour of what Loom can do.  The source is
[`acme.ddd`](acme.ddd) — 158 lines that produce a multi-deployable
system with .NET + Hono backends, a React frontend, a docker-compose
stack, DSL-level e2e tests, and Playwright UI specs.

## 60-second tour

```sh
# Build Loom + generate the Acme system into /tmp/acme.
npm install
npm run build
node bin/cli.js generate system examples/acme.ddd -o /tmp/acme

# Bring it up.  First boot ~90s for image builds; second ~10s.
cd /tmp/acme
docker compose up -d --wait

# Hit the API.
curl -X POST http://localhost:8080/products \
    -H 'Content-Type: application/json' \
    -d '{"sku":"WIDGET-1","price":{"amount":9.99,"currency":"USD"}}'

# Open the React frontend.
open http://localhost:3001
```

That's it.  No hand-written controllers, no migrations, no Mantine
forms.  The .ddd source is the single source of truth.

## What's in the source

`acme.ddd` declares a `system` with two **modules**, four
**deployables**, and a handful of **e2e tests**.  Each part of the
file maps to something concrete in the output:

### Module: Catalog

```ddd
valueobject Money {
    amount: decimal
    currency: string
    invariant amount >= 0
    invariant currency.length == 3
}

aggregate Product {
    sku: string
    price: Money
    invariant sku.length > 0
}

repository Products for Product {
    find bySku(sku: string): Product? where this.sku == sku
}
```

What you get from these 13 lines:

| File (TS, Hono backend) | Role |
| --- | --- |
| `domain/value-objects.ts` | `Money` class with constructor-checked invariants |
| `domain/product.ts` | `Product` class with private setters + `Product.create({sku, price})` factory |
| `domain/ids.ts` | Branded `ProductId` type + `newProductId()` smart constructor |
| `db/schema.ts` | Drizzle `pgTable` with `id`, `sku`, `price_amount`, `price_currency` columns |
| `db/repositories/product-repository.ts` | `findById`, `findBySku`, `save`, `findAll` (the auto-included `all`) |
| `http/product.routes.ts` | OpenAPI-typed `POST /products`, `GET /products/:id`, `GET /products/by_sku?sku=…` |

The .NET deployable produces the same wire shape against EF Core +
ASP.NET + Mediator command/query handlers.

### Module: Sales

```ddd
enum OrderStatus { Draft, Confirmed, Shipped, Cancelled }

event OrderConfirmed { order: Id<Order>, at: datetime }

aggregate Order {
    customerId: string
    status: OrderStatus
    placedAt: datetime
    contains lines: OrderLine[]

    invariant lines.count > 0 when status == Confirmed

    function isMutable(): bool = status == Draft

    operation addLine(productId: Id<Product>, qty: int) {
        precondition isMutable()
        precondition qty > 0
        lines += new OrderLine {
            productId: productId, quantity: qty
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
        invariant quantity > 0
    }
}
```

Highlights:

- **`contains lines: OrderLine[]`** introduces an entity-part.  Loom
  generates the parent FK, the join, the upsert in `save`, and the
  whole-tree load in `findById` — no `OrderLineId` plumbing in the
  source.
- **Invariants** check at every state transition.  The
  `lines.count > 0 when status == Confirmed` guard runs on every
  mutator; violations throw `DomainException` (mapped to HTTP 400).
- **`function`** is pure — usable from invariants, derived, other
  operations.
- **`operation`** is the only thing that mutates state.  Each one
  becomes a `POST /orders/:id/<op>` endpoint with a Zod-validated
  request body.
- **`emit`** populates a `_domainEvents` list drained by the
  repository on `save` and dispatched to a configurable bus.

### Cross-aggregate references — by id only

```ddd
entity OrderLine {
    productId: Id<Product>   // not `product: Product`
    quantity: int
}
```

Aggregates only reference each other by id.  The DSL enforces this:
write `Id<Product>` and you get a typed FK; write `Product` and the
validator stops you.  This is the DDD invariant ("aggregates compose
by id, not by reference") baked into the grammar.

### Deployables — one source, three runtime shapes

```ddd
deployable api          { platform: dotnet, modules: Catalog, Sales, port: 8080 }
deployable catalogApi   { platform: dotnet, modules: Catalog,         port: 8081 }
deployable catalogWeb   { platform: hono,   modules: Catalog,         port: 3000 }
deployable webApp       { platform: react,  targets: api,             port: 3001 }
```

Three platforms, four projects, one `docker-compose.yml` that wires
them together with a shared postgres.  Three notable wrinkles:

1. **`api` and `catalogApi` are both .NET, but with different module
   sets.**  Loom's per-deployable module restriction means `api`
   compiles in `Sales.OrderConfirmed` while `catalogApi` doesn't —
   the same `.ddd` source produces different binaries by slicing.
2. **`catalogApi` (.NET) and `catalogWeb` (Hono) serve the same
   bounded context on different runtimes.**  Loom's
   `<outdir>/.loom/wire-spec.json` artifact + the cross-platform
   contract check in CI guarantee both backends emit identical wire
   shapes.
3. **`webApp` declares `targets: api`** — it inherits its module
   set from the backend it talks to.  Pages, hooks, and types
   (Zod schemas + page objects) cover Catalog *and* Sales because
   `api` does.

## Tests — declared in `.ddd`, run against the live stack

```ddd
test e2e "create then confirm an order with one line" against api {
    let prod = api.products.create({ sku: "WIDGET-2", price: { amount: 5.0, currency: "USD" } })
    let ord  = api.orders.create({ customerId: "cust-001", status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
    api.orders.addLine(ord, { productId: prod.id, qty: 3 })
    api.orders.confirm(ord)
    let read = api.orders.getById(ord)
    expect(read.status).toBe("Confirmed")
    expect(read.lines.length).toBe(1)
}
```

This lowers to a vitest spec at `e2e/Acme.e2e.test.ts` that talks
HTTP+JSON to the `api` deployable.  The magic identifier `api`
resolves to whichever deployable the test is `against`; method calls
on `api.<aggregate>.<verb>(...)` lower to typed `fetch` calls keyed
off the same Zod schemas the backend emits.

UI tests targeting the `webApp` deployable lower to Playwright via
auto-generated page objects:

```ddd
test e2e "create then confirm an order via UI" against webApp {
    let prod = ui.products.create({ sku: "WIDGET-UI-1", price: { amount: 5.0, currency: "USD" } })
    let ord  = ui.orders.create({ customerId: "cust-ui", status: "Draft", placedAt: "2024-01-01T00:00" })
    ui.orders.addLine(ord, { productId: prod.id, qty: 3 })
    ui.orders.confirm(ord)
    let read = ui.orders.getById(ord)
    expect(read.status).toBe("Confirmed")
    expect(read.lines.length).toBe(1)
}
```

Becomes `web_app/e2e/Acme.ui.spec.ts`.  No selectors, no waits,
no fixture juggling — `ui.<aggregate>` resolves to a generated page
object with type-safe `.fill(...)` / `.submit()` / `.expect*(...)`
methods.

## Try the inner loop

Edit `examples/acme.ddd` and re-generate with `--watch`:

```sh
node bin/cli.js generate system examples/acme.ddd -o /tmp/acme --watch
# > Watching examples/acme.ddd for changes…
# (edit acme.ddd: rename a property, save)
# > Wrote 16 file(s) in /tmp/acme, unchanged: 116
# (edit acme.ddd: only fix a comment, save)
# > Wrote 0 file(s) in /tmp/acme, unchanged: 132
```

Loom diffs every generated file against what's already on disk and
only rewrites the ones that *actually* changed.  Vite + `dotnet
watch` running in the compose stack see only the mtimes that
moved and reload precisely those modules — typically <1s from save
to "the page reflects your edit".

If your edit fails to parse, the watch loop reports the error and
keeps watching:

```
> Watching examples/acme.ddd for changes…
examples/acme.ddd:42:13 error: Could not resolve reference to NamedDecl named 'Producrt'.
1 error(s), 0 warning(s).
> Watching examples/acme.ddd for changes…
```

Fix the typo, save again, and Loom regenerates from the next
successful parse.

## VS Code experience

Install the [`vscode/`](../vscode/) extension and open `acme.ddd`
in VS Code:

- **Hover** any reference (`Id<Product>`, `OrderLine`, `Money`,
  `OrderStatus.Confirmed`) to see its inferred type.
- **Cmd+click** any cross-reference or member access (`order.lines`)
  to jump to its declaration.
- **Type `.`** on a typed receiver to see its members.  Try it on
  `this.lines.` inside an Order operation — you'll see `count`,
  `sum`, `all`, `any`, `where`, `first`, `firstOrNull`.
- **Cmd+T** finds aggregates / parts / value objects / enums across
  every `.ddd` file in the workspace.
- **Cmd+Shift+P → "Loom: Generate from current file"** runs the CLI
  against the current `.ddd` source.

## What the generated tree looks like

```
/tmp/acme/
├── docker-compose.yml          # 4 services + postgres + db-init
├── db-init/00-create-databases.sql
├── .loom/wire-spec.json        # diffable wire contract
│
├── api/                        # .NET — full module set
│   ├── Domain/Products/        # Product aggregate, ProductId, Money
│   ├── Domain/Orders/          # Order, OrderLine, OrderConfirmed event
│   ├── Application/            # Mediator commands + handlers
│   ├── Infrastructure/         # EF DbContext, repositories
│   ├── Api/                    # ASP.NET controllers
│   ├── Program.cs              # DI + hosting
│   └── Api.csproj
│
├── catalog_api/                # .NET — Catalog only
├── catalog_web/                # Hono — Catalog only (TS+Drizzle)
│
├── web_app/                    # React + Vite + RQ + Mantine
│   ├── src/api/                # generated hooks + Zod schemas
│   ├── src/pages/              # one page per aggregate
│   ├── e2e/pages/              # Playwright page objects
│   └── e2e/Acme.ui.spec.ts     # generated UI test
│
└── e2e/                        # vitest e2e against the API
    └── Acme.e2e.test.ts
```

132 files, zero hand-written.

## Pinning customizations: `.loomignore`

When you do hand-edit a generated file, list it in `.loomignore`
(gitignore syntax) at the system root and Loom won't overwrite it on
the next regen.  Example:

```
api/Program.cs           # custom DI
web_app/src/pages/       # bespoke page layouts
```

Anything matching the patterns is reported as `skipped (.loomignore)`
in the regen summary.

## Going further

- [`docs/language.md`](../docs/language.md) — formal grammar
  reference.
- [`docs/generators.md`](../docs/generators.md) — per-platform
  feature matrix.
- [`docs/technical.md`](../docs/technical.md) — pipeline architecture
  (parse → IR → enrichment → generation → write).
- [`docs/tools.md`](../docs/tools.md) — CLI deep-dive: `.loomignore`,
  watch mode, migration workflow, OpenAPI cross-check, Playwright
  setup, proxy CAs.
- Other examples:
  [`sales.ddd`](sales.ddd) (single context, every grammar
  construct), [`banking.ddd`](banking.ddd) (cross-aggregate
  references with richer `where` filters), [`inventory.ddd`](inventory.ddd)
  (smallest valid system).
