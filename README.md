# Loom

A high-descriptive, Langium-based DSL for **Domain-Driven Design**.
Write your aggregates, value objects, invariants, and operations in
`.ddd` sources; mechanically generate idiomatic, runnable projects in
several platforms wired together as one `docker compose` stack:

- **TypeScript backend** — Hono (HTTP) + Drizzle ORM + Zod (with OpenAPI
  via `@hono/zod-openapi`)
- **.NET backend** — ASP.NET Core + EF Core + Mediator (martinothamar)
  + Swashbuckle (OpenAPI)
- **React frontend** — Vite + React Router + React Query + Zod + Mantine
  + Playwright page objects per aggregate
- **Phoenix LiveView (fullstack)** — Elixir + Ash + AshPostgres +
  AshPhoenix.LiveView in a single deployable that both serves an
  Ash-derived API (`serves:`) and mounts a `ui:` (HEEx via the
  `ashPhoenix` design pack)

The pipeline is fully type-safe end-to-end and DDD-faithful by construction:

```
   .ddd source
        │
        ▼      Langium parser & validator
   Loom AST
        │
        ▼      Lowering: name resolution, type inference, semantic shaping
   Loom IR     (platform-neutral, fully resolved)
        │
        ▼      Per-platform Handlebars templates + procedural builders
   TypeScript / C# / React project
        │
        ▼      .loomignore filter + writes
   Generated project on disk
```

## What you get

From a single `.ddd` source, `ddd generate system` emits a runnable
multi-deployable system:

```
<outdir>/
├── docker-compose.yml      # postgres + every deployable + healthchecks
├── db-init/00-create-databases.sql   # one db per deployable, no races
├── api/                    # .NET deployable: full domain + EF + Mediator + Swashbuckle
├── catalog_web/            # Hono deployable: domain + Drizzle + zod-openapi
├── web_app/                # React frontend: pages + RQ hooks + page objects
└── e2e/                    # generated DSL-level e2e tests against the live stack
```

Per aggregate every backend produces:

- Aggregate root + entity-part classes with private state, factories,
  invariant checks, derived properties, domain events
- Repository (find-by-id, save, find-all, plus user-declared finds)
  with full master-detail load/save and event dispatch
- HTTP routes / controllers wired through Mediator (for .NET) or
  type-validated Hono routes
- Wire-shape DTOs identical across backends (so the cross-platform
  OpenAPI cross-check passes)

Per aggregate the React frontend produces:

- List page (Mantine `<Table>` from `useAll<Agg>()`)
- Detail page (master-detail when there are contained parts; one
  Mantine modal-form button per public operation)
- Create page (Mantine form against the wire-shape Zod request schema)
- Typed React Query hooks per route, parsing responses with Zod
- Playwright page-object class per page, keyed off stable
  `data-testid` attributes — write a UI test top-down without
  hand-crafting selectors

## Install

```bash
npm install
npm run langium:generate    # generate the parser from ddd.langium
npm run build               # tsc
```

Requires Node 18+.

## CLI

```bash
ddd parse <file.ddd>                       # parse + validate, exit non-zero on errors
ddd generate ts <file.ddd> -o <outdir>     # emit a single Hono+Drizzle project
ddd generate dotnet <file.ddd> -o <outdir> # emit a single ASP.NET+EF+Mediator project
ddd generate system <file.ddd> -o <outdir> # emit every deployable + docker-compose.yml
```

Common flags:

| Flag | Effect |
| --- | --- |
| `-o, --out <dir>` | Output directory.  Created if missing. |
| `-w, --watch` | Re-run the generator on every save of the `.ddd` source. |
| `--dry-run` | Print the plan with `write` / `skip` annotations; touch nothing. |

`ddd parse` exits non-zero on validation errors.  All `generate`
sub-commands run validation first and refuse to emit if there are
errors.

## A taste of the language

```ddd
system Acme {

  module Sales {
    context Orders {

      enum OrderStatus { Draft, Confirmed, Shipped, Cancelled }

      valueobject Money {
        amount: decimal
        currency: string
        invariant amount >= 0
        invariant currency.length == 3
      }

      event OrderConfirmed { order: Order id, at: datetime }

      aggregate Order {
        customerId: string
        status: OrderStatus
        placedAt: datetime
        contains lines: OrderLine[]

        derived total: Money =
          Money(lines.sum(l => l.subtotal.amount), "USD")

        invariant lines.count > 0 when status == Confirmed

        function isMutable(): bool = status == Draft

        operation addLine(productId: Product id, qty: int, price: Money) {
          precondition isMutable()
          precondition qty > 0
          lines += new OrderLine { productId: productId, quantity: qty, unitPrice: price }
        }

        operation confirm() {
          precondition isMutable()
          precondition lines.count > 0
          status := Confirmed
          emit OrderConfirmed { order: id, at: now() }
        }

        entity OrderLine {
          productId: Product id
          quantity: int
          unitPrice: Money
          derived subtotal: Money =
            Money(unitPrice.amount * quantity, unitPrice.currency)
          invariant quantity > 0
        }
      }

      repository Orders for Order {
        find byCustomer(customerId: string): Order[]
      }
    }
  }

  module Catalog {
    context Products {
      aggregate Product { sku: string, price: Money }
    }
  }

  // .NET API hosting both modules.
  deployable api { platform: dotnet, modules: Catalog, Sales, port: 8080 }

  // Hono API hosting just the Catalog module — exists so the
  // cross-platform OpenAPI parity check has a peer to diff against.
  deployable catalogWeb { platform: hono, modules: Catalog, port: 3000 }

  // React SPA against the .NET api.  Modules inherited from `targets:`.
  deployable webApp { platform: react, targets: api, port: 3001 }

  test e2e "create then confirm an order" against api {
    let prod = api.products.create({ sku: "W-1", price: { amount: 5.0, currency: "USD" } })
    let ord = api.orders.create({ customerId: "cust-001", status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
    api.orders.addLine(ord, { productId: prod.id, qty: 3 })
    api.orders.confirm(ord)
    let read = api.orders.getById(ord)
    expect read.status == "Confirmed"
    expect read.lines.length == 1
  }
}
```

`ddd generate system <file>.ddd -o ./out` → multi-project tree above
+ `docker compose up -d` → running system on ports 8080 / 3000 / 3001
+ `cd out/web_app/e2e && npm install && npx playwright test` →
generated UI tests pass against the live system.

## Examples

Four `.ddd` sources under [`examples/`](examples/) demonstrate
the language at increasing complexity:

| Example | Highlights |
| --- | --- |
| [`sales.ddd`](examples/sales.ddd) | Single-context DDD basics — `Order` aggregate with `OrderLine` parts, `Money` value object, `OrderStatus` enum, `OrderConfirmed` event, repository with `byCustomer` find, test blocks. |
| [`banking.ddd`](examples/banking.ddd) | Optional fields, multiple aggregates with cross-references via `X id`, richer `where`-filter on a repository find. |
| [`inventory.ddd`](examples/inventory.ddd) | Nested parts, explicit `ids guid` override on an aggregate. |
| [`acme.ddd`](examples/acme.ddd) | Full system mode — modules, four deployables (.NET API, Hono catalog, .NET catalog, React frontend), cross-platform OpenAPI parity, DSL-level e2e tests.  See the [annotated walkthrough](examples/acme.md) for a five-minute tour. |

## Project layout

```
src/
  language/              # Langium grammar, scoping, validator, type system, LSP
  ir/                    # Loom IR (platform-neutral) + AST → IR lowering
  generator/
    typescript/          # Hono + Drizzle backend (templates + builders)
    dotnet/              # ASP.NET + EF + Mediator backend (templates + helpers)
    react/               # React + RQ + Zod + Mantine frontend (page-objects builder)
  system/                # Multi-deployable orchestrator + docker-compose + e2e render
  cli/                   # ddd parse / ddd generate {ts|dotnet|system}
  util/                  # naming helpers (pascal / camel / snake / plural)
test/                    # vitest suites (130+ tests) + opt-in docker-compose e2e
examples/                # sample .ddd sources (sales, inventory, acme)
docs/                    # full reference documentation
bin/cli.js               # bin shim
vscode/                  # VS Code extension (LSP client + grammar + commands)
```

## VS Code extension

A sibling [`vscode/`](vscode/) package ships a minimal VS Code
extension that bundles the Loom language server.  Install it locally
from a built `.vsix`:

```sh
cd vscode
npm install
npm run build
npm run package      # produces loom-ddd-0.1.0.vsix
code --install-extension loom-ddd-0.1.0.vsix
```

What you get: syntax highlighting, hover with inferred types,
go-to-definition (including member access), type-driven completion,
workspace symbols (Cmd+T), and a "Loom: Generate from current file"
command palette entry.  See [`vscode/README.md`](vscode/README.md)
for details.

## Documentation

[`docs/README.md`](docs/README.md) is the canonical doc index — a
short signposted reading list across language, generators, features,
tooling, and internals.  The headline reference docs:

| Doc | Contents |
| --- | --- |
| [`docs/language.md`](docs/language.md) | Formal language reference — declarations, types, expressions, statements, validation rules, e2e test syntax. |
| [`docs/page-metamodel.md`](docs/page-metamodel.md) | The `ui` / `page` / `component` / `scaffold` surface and the closed walker-stdlib primitive set. |
| [`docs/architecture.md`](docs/architecture.md) | System-level composition — `module`, `deployable`, `api`, `storage`, `ui` and how they wire together. |
| [`docs/generators.md`](docs/generators.md) | Per-platform feature matrix — what each backend emits, file-by-file. |
| [`docs/tools.md`](docs/tools.md) | CLI usage, `.loomignore`, watch mode, migration workflow, Docker, Playwright UI tests, OpenAPI cross-check, proxy CAs. |
| [`docs/technical.md`](docs/technical.md) | Pipeline architecture: AST → IR → backend emit; design rationale; how to extend the language or add a backend. |

Per-feature references — [`auth.md`](docs/auth.md),
[`views.md`](docs/views.md), [`workflow.md`](docs/workflow.md),
[`extern.md`](docs/extern.md),
[`capabilities.md`](docs/capabilities.md),
[`scaffold-macros.md`](docs/scaffold-macros.md),
[`provenance.md`](docs/provenance.md),
[`observability.md`](docs/observability.md),
[`traceability.md`](docs/traceability.md),
[`conformance.md`](docs/conformance.md),
[`migrations-design.md`](docs/migrations-design.md) — plus
[`platforms.md`](docs/platforms.md) for the backend registry and
[`design-packs.md`](docs/design-packs.md) for the design-pack
authoring guide.  [`license-faq.md`](docs/license-faq.md) covers
usage terms.

In-flight design work lives under [`docs/plans/`](docs/plans/) and
[`docs/proposals/`](docs/proposals/); empirical snapshots live under
[`docs/audits/`](docs/audits/) — none of these are authoritative for
what ships today.

Plus [`experience_gathered.md`](experience_gathered.md) — running
retrospective of design choices and gotchas; worth reading before
non-trivial changes.

## Status

- 49 vitest unit tests cover parsing, validation, all three generators,
  the system orchestrator, the CLI, and the cross-platform OpenAPI
  contract.
- Opt-in `LOOM_E2E=1` suite (3 tests) builds the generated docker
  stack, smoke-tests `/health`, runs the generated DSL e2e against
  the live system, and diffs both backends' OpenAPI specs.
- Generated projects compile under their respective toolchains —
  `npx tsc --noEmit` on Hono / React, `dotnet build` on .NET, `vite
  build` on React, `npx playwright test` on the UI suite.

## License

The **generator** in this repository is licensed under
[`FSL-1.1-Apache-2.0`](LICENSE) — Functional Source License 1.1 with
an Apache 2.0 future license.  Source-available for any non-competing
use today; converts to a true open-source license (Apache 2.0) two
years after publication.

The **code Loom generates** (everything `ddd generate` writes into
`<outdir>/`) is licensed to you under the **MIT License** — the CLI
emits a `LICENSE` file at the output-directory root that says so
explicitly.  Production users can ship generated projects without
inheriting any FSL terms.

For the full posture — what counts as Competing Use, how runtime
helpers are licensed when they ship inside generated projects, and
what to tell legal/procurement — see
[`docs/license-faq.md`](docs/license-faq.md).
