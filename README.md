# Loom

> **The speed of no-code. The keys to the codebase.**

Loom is a high-level DSL that lets you describe complete systems at the
altitude of a no-code platform &mdash; and walk away with real, owned
source code across five backends (**Hono**, **.NET**, **Phoenix
LiveView**, **Java/Spring Boot**, **Python/FastAPI**) and four frontends
(**React**, **Vue**, **Svelte**, **Angular**).  No vendor lock-in.  No
scaling cliff.  No drift between layers.  Just the model, a visual
builder, and full ownership of every line that's generated.

- All the speed of no-code
- All the source you'd write by hand
- Zero vendor lock-in

**Live site:** <https://lemmit.github.io/Loc/> — landing, browser
playground (typed editor + visual system builder + live preview +
in-browser test runner), and the full documentation set.

---

## At a glance

| | |
|---|---|
| **Backends** | Hono · .NET · Phoenix LiveView · Java/Spring Boot · Python/FastAPI |
| **Frontends** | React · Vue · Svelte · Angular |
| **Design systems** | Mantine · shadcn/ui · MUI · Chakra (React) · Vuetify · shadcnVue (Vue) · shadcnSvelte · Flowbite (Svelte) · Angular Material · Phoenix HEEx — swap any time |
| **Visual tools** | Typed editor · system builder · live preview · in-browser test runner |
| **Quality story** | `requirement` → `solution` → `testCase` → `test` → `ddd verify` → per-requirement Definition-of-Done verdicts |
| **LLM-safe** | One source of truth · validated before emission · refactor the model, regenerate the stack |

## Versus the alternatives

Every shortcut to building a system has a hidden tax &mdash; lock-in,
drift, framework jail, or a scaling cliff.  Loom is the row where
everything turns into a check mark:

- **vs no-code/low-code** (Bubble, Retool, OutSystems, Mendix,
  Appsmith): same minutes-to-first-prototype, but you own the source,
  there's no scaling cliff, no platform lock-in.
- **vs starter kits / frameworks** (Rails, Phoenix, Blitz, Wasp):
  same source ownership, but Loom is a single source of truth across
  *all* layers (frontend, backend, DB, tests) instead of one
  framework's conventions.
- **vs AI codegen** (Cursor projects, v0, Bolt, Lovable): same speed
  at the prompt, but no architectural drift after a few prompts &mdash;
  the model is the source of truth, the LLM can't hallucinate fields
  the model doesn't have or write a frontend that disagrees with its
  backend.

Full feature-by-feature comparison: <https://lemmit.github.io/Loc/#compare>.

## Quick example

A complete `.ddd` source &mdash; domain, deployables across three
runtimes, an end-to-end test:

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

  // Pick a runtime per deployable.  Switch any time.
  deployable api    { platform: node,            modules: Sales, Catalog, port: 3000 }
  deployable apiNet { platform: dotnet,          modules: Sales, Catalog, port: 8080 }
  deployable apiPhx { platform: elixir, modules: Sales, Catalog, port: 4000 }

  // React frontend targets any backend; design pack swappable.
  deployable webApp {
    platform: react
    targets:  api          // switch to apiNet or apiPhx anytime
    design:   shadcn       // or mantine, mui, chakra
    port:     3001
  }

  test e2e "create and confirm an order" against api {
    let prod = api.products.create({ sku: "W-1", price: { amount: 5.0, currency: "USD" } })
    let ord  = api.orders.create({ customerId: "c-1", status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
    api.orders.addLine(ord, { productId: prod.id, qty: 3 })
    api.orders.confirm(ord)
    let read = api.orders.getById(ord)
    expect read.status == "Confirmed"
    expect read.lines.length == 1
  }
}
```

`ddd generate system acme.ddd -o ./out` → runnable multi-project tree
+ `docker-compose.yml` + healthchecks + generated migrations + e2e
suite.  `docker compose up -d` → everything running on ports
3000 / 8080 / 4000 / 3001.

## Install

```bash
npm install
npm run langium:generate    # generate the parser from src/language/ddd.langium
npm run build               # tsc -b
```

Requires Node 18+.

## CLI

```bash
ddd parse <file.ddd>                       # parse + validate, exit non-zero on errors
ddd generate ts     <file.ddd> -o <out>    # single Hono project (legacy single-context mode)
ddd generate dotnet <file.ddd> -o <out>    # single .NET project (legacy)
ddd generate system <file.ddd> -o <out>    # full multi-deployable tree + docker-compose.yml
ddd snapshot        <file.ddd> -o <out>    # capture immutable .loom/snapshots/<ts>-<guid>.loomsnap.json (provenance rule snapshot)
ddd verify          <file.ddd> -o <out>    # run generated test suites + roll results into .loom/verification.{json,md}
```

Common flags:

| Flag | Effect |
| --- | --- |
| `-o, --out <dir>` | Output directory.  Created if missing. |
| `-w, --watch` | Re-run the generator on every save of the `.ddd` source (legacy `generate ts` / `generate dotnet` only). |
| `--dry-run` | Print the plan with `write` / `skip` annotations; touch nothing. |

`ddd parse` exits non-zero on validation errors.  All `generate`
sub-commands run validation first and refuse to emit if there are
errors.

## What's in the box

**Four runtimes from one source.** Hono (TypeScript), ASP.NET Core
(.NET), Phoenix LiveView (Elixir, plain Ecto/Phoenix), React frontend.  Pick per
deployable.  Switch any time.  Identical API contracts; idiomatic
per-runtime output.

**Five design packs.** Mantine, shadcn/ui, MUI, Chakra, and Phoenix
HEEx ship in-tree.  The page DSL is identical; only the rendering
changes.  Bring your own &mdash; design packs are just templates
against a small page contract.

**Browser playground.** Typed editor with LSP support, visual system
builder for deployables and modules, live preview of the generated
app booting in a sandboxed iframe, in-browser test runner.  Same
`.ddd` source across all views.  Open it at
<https://lemmit.github.io/Loc/playground/>.

**Built-in traceability.** Declare `requirement`, `solution`, and
`testCase` alongside your domain.  Executable tests link back to test
cases; `ddd verify` rolls results into per-requirement
Definition-of-Done verdicts in `.loom/verification.{md,json}`.  No
separate Jira/CI/git triangulation.

**LLM-safe by construction.** One source of truth across frontend,
backend, database, and tests &mdash; they regenerate together.  The DSL
is small enough to fit in a prompt.  Validation gates catch
hallucinated fields and out-of-scope references before any code is
emitted.

**Per-aggregate generation.** Aggregate roots with private state,
factories, invariant checks, derived properties, domain events.
Repositories with `find-by-id`, `save`, `find-all`, plus your finds,
all with master-detail load/save.  HTTP routes per operation and find.
Generated migrations (Drizzle / EF Core / Ecto).  Generated UI pages
(list, detail, create) with a modal-form button per public operation.
Generated end-to-end tests against the live stack &mdash; the same DSL
test runs against whichever runtime you point it at.

## Examples

| Example | Highlights |
| --- | --- |
| [`sales.ddd`](examples/sales.ddd) | DDD basics &mdash; `Order` aggregate with `OrderLine` parts, `Money` value object, `OrderStatus` enum, `OrderConfirmed` event, repository with `byCustomer` find, test blocks. |
| [`banking.ddd`](examples/banking.ddd) | Optional fields, multiple aggregates with cross-references via `X id`, richer `where`-filter on a repository find. |
| [`inventory.ddd`](examples/inventory.ddd) | Nested parts, explicit `ids guid` override on an aggregate. |
| [`money-primitive.ddd`](examples/money-primitive.ddd) | The `Money` primitive and how decimal arithmetic is preserved across backends. |
| [`provenance.ddd`](examples/provenance.ddd) | `provenanced` fields + the runtime trace SDK for explaining business decisions. |
| [`roster.ddd`](examples/roster.ddd) | `X id[]` association collections and the join tables generated for them. |
| [`sales-ui.ddd`](examples/sales-ui.ddd) | UI-focused &mdash; explicit pages, the page DSL, scaffolding macros. |
| [`acme.ddd`](examples/acme.ddd) | Full system mode &mdash; multi-deployable, OpenAPI parity-checked.  See the [annotated walkthrough](examples/acme.md). |
| [`acme-order-explicit.ddd`](examples/acme-order-explicit.ddd) | Hand-written equivalent of `scaffold aggregates: Order`; asserted byte-equivalent in CI. |
| [`showcase.ddd`](examples/showcase.ddd) | Multi-pack design showcase; exercised by the design-pack matrix in CI. |

## Project layout

```
src/
  language/        # Langium grammar, scoping, themed validators, type system, LSP, .ddd printer
  macros/          # macro pipeline — expander, registry, authoring API, stdlib (scaffold/audit/softDelete/crudish)
  ir/              # IR types, lowering, enrichment, validation
  generator/
    typescript/    # Hono backend (procedural emitters + builders)
    dotnet/        # ASP.NET Core + EF Core + Mediator backend
    phoenix-live-view/   # Phoenix LiveView backend (plain Ecto/Phoenix, HEEx walker)
    react/         # React frontend + walker target + page-object generator
    _packs/        # design-pack discovery + loader (Mantine/shadcn/MUI/Chakra/ashPhoenix)
    _walker/       # cross-framework walker registry + WalkerTarget contract
    _obs/          # observability catalog + per-backend log renderers
  platform/        # PlatformSurface registry + version pinning (node@v4, dotnet, react, elixir)
  system/          # multi-deployable orchestrator + docker-compose + .loom/ artifact bundle
  verify/          # ddd verify rollup (joins test results onto traceability)
  cli/             # bin entry point
  util/            # naming + code-building helpers

packages/          # published workspaces: @loom/core · @loom/backend-hono-v4 · @loom/ui-test-driver
web/               # browser playground (editor, system builder, live preview, test runner)
vscode/            # VS Code extension (LSP client)
designs/           # 5 design packs — mantine, shadcn, mui, chakra, ashPhoenix
stacks/v{1,2,3}/   # versioned generated-project dependency manifests
test/              # vitest suites + opt-in docker e2e
examples/          # sample .ddd sources
docs/              # full reference documentation
```

## VS Code extension

The sibling [`vscode/`](vscode/) package ships a minimal VS Code
extension that bundles the Loom language server.  Install locally
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
workspace symbols (Cmd+T), a "Loom: Generate from current file"
command, and an "Unfold macro" code action that rewrites a
`with X(...)` clause into its expanded source in place.  See
[`vscode/README.md`](vscode/README.md) for details.

## Documentation

[`docs/README.md`](docs/README.md) is the canonical doc index.
The headline references:

| Doc | Contents |
| --- | --- |
| [`language.md`](docs/language.md) | Formal language reference &mdash; declarations, types, expressions, statements, validation rules, e2e test syntax. |
| [`page-metamodel.md`](docs/page-metamodel.md) | The `ui` / `page` / `component` / `scaffold` surface and the closed walker-stdlib primitive set. |
| [`architecture.md`](docs/architecture.md) | System-level composition &mdash; `module`, `deployable`, `api`, `storage`, `ui` and how they wire together. |
| [`generators.md`](docs/generators.md) | Per-platform feature matrix &mdash; what each backend emits, file-by-file. |
| [`design-packs.md`](docs/design-packs.md) | Design-pack authoring guide; how to add your own pack version. |
| [`platforms.md`](docs/platforms.md) | Backend registry, `family@version` pinning, the `PlatformSurface` contract. |
| [`tools.md`](docs/tools.md) | CLI usage, `.loomignore`, watch mode, Docker workflow, OpenAPI parity check, proxy CAs. |

Per-feature references &mdash; [`auth.md`](docs/auth.md),
[`views.md`](docs/views.md),
[`workflow.md`](docs/workflow.md),
[`extern.md`](docs/extern.md),
[`capabilities.md`](docs/capabilities.md),
[`scaffold-macros.md`](docs/scaffold-macros.md),
[`provenance.md`](docs/provenance.md),
[`observability.md`](docs/observability.md),
[`traceability.md`](docs/traceability.md),
[`conformance.md`](docs/conformance.md),
[`migrations-design.md`](docs/migrations-design.md) &mdash; plus
[`macro-api.md`](docs/macro-api.md) for the macro authoring surface,
[`loom-artifacts.md`](docs/loom-artifacts.md) for the `.loom/`
derived-artifact directory, and
[`license-faq.md`](docs/license-faq.md) for usage terms.

In-flight design lives under [`docs/old/plans/`](docs/old/plans/); empirical
snapshots live under [`docs/audits/`](docs/audits/); unadopted
proposals live under `docs/old/proposals/` (not deployed to the docs
site; [browse on GitHub](https://github.com/lemmit/Loc/tree/main/docs/old/proposals)).

Plus [`experience_gathered.md`](experience_gathered.md) &mdash; running
retrospective of design choices and gotchas; worth reading before
non-trivial changes.

## Status

- **213 test files / 2,300+ tests** cover parsing, validation, all
  four backends, the system orchestrator, the CLI, design-pack
  rendering, and the cross-platform OpenAPI parity harness.
- **Opt-in suites** gated on `LOOM_E2E=1` /
  `LOOM_TS_BUILD=1` / `LOOM_REACT_BUILD=1` / `LOOM_DOTNET_BUILD=1` /
  `LOOM_PHOENIX_BUILD=1` / `LOOM_OBS_E2E*=1` build and boot the
  generated stacks against real toolchains (vitest, tsup, tsc,
  `dotnet build /warnaserror`, `mix compile --warnings-as-errors`).
- **CI matrix** generates every example against every design pack and
  `tsc --noEmit`s the React output; .NET output is `dotnet build
  /warnaserror`'d; Phoenix output is compiled against plain Ecto/Phoenix
  in an Elixir docker image.

## License

The **generator** in this repository is licensed under
[`FSL-1.1-Apache-2.0`](LICENSE) &mdash; Functional Source License 1.1
with an Apache 2.0 future license.  Source-available for any
non-competing use today; converts to a true open-source license
(Apache 2.0) two years after publication.

The **code Loom generates** (everything `ddd generate` writes into
`<outdir>/`) is licensed to you under the **MIT License** &mdash; the
CLI emits a `LICENSE` file at the output-directory root that says so
explicitly.  Production users can ship generated projects without
inheriting any FSL terms.

For the full posture &mdash; what counts as Competing Use, how runtime
helpers are licensed when they ship inside generated projects, and
what to tell legal/procurement &mdash; see
[`docs/license-faq.md`](docs/license-faq.md).
