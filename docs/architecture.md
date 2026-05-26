# Architecture — system-level composition

> Companion to [`page-metamodel.md`](./page-metamodel.md).  That doc
> covers the page DSL surface (pages, components, scaffolding,
> state, match, lambdas).  This doc covers the **system-level
> layered composition model**: how domain, api contracts, storage
> instances, UIs, and deployables fit together.

The system DSL has five composable layers, each declared
independently.  Deployables are the explicit composition root.

```ddd
context     →   domain primitives (aggregates / workflows / views)
module      →   group of contexts                               [domain]

api         →   contract derived from a module                  [contract]
storage     →   typed storage instance                          [infra]
ui          →   declares api dependencies, renders pages        [consumer]

deployable  →   composes platform + modules + api + UI + storage [composition]
```

Read any single declaration and you see its full picture; no
implicit cross-references between layers.


## Domain layer

`module` and `context` define pure domain — aggregates,
repositories, workflows, views.  Persistence-agnostic; same
domain runs against Postgres in prod, in-memory in tests.

```ddd
module Sales {
  context Orders {
    aggregate Customer { name: string; email: string }
    repository Customers for Customer {
      find byEmail(email: string): Customer?
    }
    aggregate Order { customerId: Customer id; total: decimal }
    workflow checkout { input: { customerId: Customer id, items: int[] } }
  }
}
```


## API contracts

`api X from M` declares a contract derived from a module's
domain.  The api auto-exposes:

| Domain entity | Api operations |
|---|---|
| Aggregate `<X>` | `all`, `byId`, `create`, `update`, `delete` |
| Repository `<R> for X { find <name>(args): T }` | `<name>` (named query) |
| Workflow `<w>` | `<w>` (mutation) |
| View `<v>` | `<v>` (query) |

```ddd
api SalesApi from Sales
```

UIs reference apis via UI parameters (next section); backend
deployables `serves:` apis.


## Storage instances

`storage X { type: T }` declares a typed storage slot — reusable
across deployables.  v0 type enum:

| Category | Types |
|---|---|
| Transactional | `postgres`, `mysql`, `sqlite`, `inMemory` |
| Cache | `redis` |
| Search | `elastic`, `meilisearch` |
| Events | `kafka` |
| Analytics | `clickhouse`, `bigquery` |

```ddd
storage primarySql   { type: postgres }
storage hotCache     { type: redis    }
storage warehouse    { type: clickhouse }
```

Only `postgres` has full generator support today.  Other types
parse + validate but don't yet activate generator output.


## UI consumer

`ui X` declares pages, components, and **api parameters** —
local handles for the api contracts the UI needs.

```ddd
ui WebApp {
  api Sales: SalesApi             // local handle `Sales` of contract `SalesApi`
  api Mktg:  MarketingApi

  page CustomerList {
    route: "/customers"
    body: For { Sales.Customer.all.data, c => Card { c.name } }
  }

  page CustomerNew {
    route: "/customers/new"
    state { name: string = "" }
    body: Stack {
      Field { "Name", bind: name },
      Button {"Save",
        disabled: Sales.Customer.create.isPending,
        onClick: e => { Sales.Customer.create.mutate({ name }) }}
    }
  }
}
```

The `<param>.<aggregate>.<op>` body refs (e.g. `Sales.Customer.all`)
are validated at parse-validate time:

- `Sales` resolves to a declared UI api parameter.
- `Customer` resolves to an aggregate in the api's source module.
- `all` is a known operation (CRUD or repository find).

The walker auto-injects React Query hooks at page top following
a published naming rule:

| DSL body ref | Generated hook | Local var |
|---|---|---|
| `<agg>.all` | `useAll<Plural>()` | `<aggCamel>All` |
| `<agg>.byId(x)` | `use<Single>ById(x)` | `<aggCamel>ById` |
| `<agg>.create` | `useCreate<Single>()` | `<aggCamel>Create` |
| `<agg>.<finder>` | `use<Finder><Single>(args)` | `<aggCamel><Finder>` |

So `Sales.Customer.all.data` becomes:

```tsx
import { useAllCustomers } from "../api/customer";

const customerAll = useAllCustomers();
// ... customerAll.data ...
```

User can read the generated file and trace any DSL ref to its
runtime artifact.  No magic.


## Deployable composition

The deployable is the **only** place layers compose.  Each
declaration is self-contained.

### Backend deployables

```ddd
deployable salesApi {
  platform: hono                  // runtime
  modules: Sales {                // domain
    primary: primarySql           // transactional persistence
    cache:   hotCache             // optional read-through cache
    search:  searchIndex          // optional fulltext index
    bi:      warehouse            // optional analytics export
  }
  serves: SalesApi                // contract this deployable implements
  port: 3000
}
```

The `serves:` field lists api contracts implemented by this
backend.  The `modules: <M> { role: <storage> }` block wires
each module's storage roles to declared storage instances.
`primary:` is required when the brace block is non-empty;
other roles (`cache`, `search`, `events`, `bi`) are optional.

Multiple modules + multiple roles are admissible:

```ddd
deployable monolithApi {
  platform: dotnet
  modules:
    Sales     { primary: salesPg,  bi: warehouse },
    Marketing { primary: mktgPg,   bi: warehouse }
  serves: SalesApi, MarketingApi
  port: 8080
}
```

Bare `modules: Sales, Marketing` (no brace block) is still
admissible for backward compat — generator falls back to a
default postgres + Drizzle setup.

### Frontend deployables

```ddd
deployable webApp {
  platform: static
  targets: salesApi               // the backend(s) this frontend talks to
  ui: WebApp {                    // bind UI params to backends
    Sales: salesApi               //   `Sales` ← salesApi (which serves SalesApi)
    Mktg:  marketingApi
  }
  port: 3002
}
```

The `ui: WebApp { Sales: salesApi, Mktg: marketingApi }` block
is the explicit composition: each UI api parameter (declared in
`ui WebApp { api Sales: SalesApi }`) is bound by name to a
backend deployable that supplies its contract.

**Validator obligations:**

- Every UI api parameter must have a binding in the deployable's
  ui-compose block.
- The bound backend must `serves:` the parameter's declared api.
- Misalignments produce parse-validate-time errors with
  source-location ranges.

Sugar form `ui: WebApp` (no compose-block) is only admissible
when the UI declares no api parameters.

### Fullstack deployables (`platform: phoenixLiveView`)

A `phoenixLiveView` deployable collapses backend + frontend into one
project.  It both `serves:` an Ash-derived API AND mounts a `ui:`,
without a peer `targets:` link.

```ddd
deployable phoenixApp {
  platform: phoenixLiveView
  modules:  Sales { primary: primarySql }
  serves:   SalesApi
  ui:       SalesAdmin
  port:     4000
}
```

Validator obligations specific to fullstack platforms:

- `targets:` is rejected — the deployable IS the backend.
- `framework:` (when explicit) must equal `phoenixLiveView`; pairing
  `platform: phoenixLiveView` with `framework: react` is rejected.
- `ui:` may be sugar (`ui: SalesAdmin`) or compose-block, same
  semantics as for frontend deployables.
- `design:` defaults to `ashPhoenix` (the built-in HEEx pack);
  custom packs that declare `format: "heex"` are admissible.

The platform contract knob `mountsUi: boolean` on `PlatformSurface`
(src/platform/surface.ts) decides UI-mount admissibility — adding a
new fullstack platform extends that field plus the `Platform` enum,
nothing else.


## End-to-end example

```ddd
system Acme {
  module Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { find byEmail(email: string): Customer? }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }

  ui WebApp {
    api Sales: SalesApi
    page Home {
      route: "/"
      body: Sales.Customer.all.isLoading
        ? Loader {}
        : For { Sales.Customer.all.data, c => Card { c.name } }
    }
  }

  deployable salesApi {
    platform: hono
    modules: Sales { primary: primarySql }
    serves: SalesApi
    port: 3000
  }

  deployable webApp {
    platform: static
    targets: salesApi
    ui: WebApp { Sales: salesApi }
    port: 3001
  }
}
```

What the reader gets from any single declaration:

| Read this... | ...and you know |
|---|---|
| `module Sales { ... }` | the domain — pure, persistence-agnostic |
| `api SalesApi from Sales` | the contract — derived from Sales |
| `storage primarySql { type: postgres }` | a typed storage instance, reusable |
| `ui WebApp { api Sales: SalesApi, ... }` | the UI takes Sales of contract SalesApi |
| `deployable salesApi` | what's served, what module fills it, where each role's data lives |
| `deployable webApp` | what UI runs, which backend fills each api param |


## Scaffold expands to walker stdlib (Slice C2 / D1)

The `scaffold modules: M` directive (page-metamodel §10) keeps
working — but as **compile-time sugar**.  Synthesised pages now
lower to explicit walker-stdlib bodies via
`src/ir/scaffold-expander.ts`:

```
scaffold aggregates: Order
  ↓ (AST expander synthesises pages with scaffoldOrigin)
page OrderList { route: "/orders"  body: List { of: Order } }
  ↓ (IR-level scaffold expander rewrites body)
page OrderList {
  route: "/orders"
  body: Stack {
    Breadcrumbs { Anchor { "Home", to: "/" }, Text { "Orders" } },
    Toolbar {Heading { "Orders", level: 2 },
            Button { "New order", to: "/orders/new", testid: ... }},
    QueryView {of: Sales.Order.all,
              loading: Skeleton { count: 5 },
              error: Alert { "Couldn't load orders" },
              empty: Empty { "No orders yet." },
              data: rows => Paper { Table { rows, … } }},
    testid: "orders-list"
  }
}
  ↓ (single walker emit path)
src/pages/orders/list.tsx
```

There is **one** codegen path: the walker.  The legacy
archetype renderers (`renderListPage`, `renderDetailPage`,
`renderNewPage`, etc.) and their per-pack templates
(`page-list.hbs`, `page-detail.hbs`, etc.) were deleted in
Slice D1.

A migrated `examples/acme.ddd` (PR #94) demonstrates the new
shape end-to-end.


## What the validator catches

| Misalignment | Error |
|---|---|
| `api X from MissingModule` | "api 'X' references undeclared module 'MissingModule'" |
| Two `api X` declarations | "Duplicate api 'X'" |
| `api X: NoSuchApi` in UI | "ui '<U>' references undeclared api 'NoSuchApi'" |
| Body ref `Sales.NoAggregate.all` | "Aggregate 'NoAggregate' not found in api 'SalesApi'" |
| Body ref `Sales.Customer.allll` | "Operation 'allll' is not declared on aggregate 'Customer'.  Available: all, byId, create, ..." |
| `serves:` on a frontend platform | "'serves:' is only valid on a backend deployable" |
| Backend doesn't serve a bound api | "Deployable 'X' does not 'serves: Y'" |
| Missing UI param binding | "Deployable 'D' is missing a binding for ui parameter 'X: Y'" |
| Duplicate storage names | "Duplicate storage 'X'" |
| Module brace block missing primary | "Module 'X' must include a 'primary: <storage>' binding" |


## Generator wiring (today)

| Layer | Generator-side |
|---|---|
| `module`, `context`, aggregate fields | Drizzle schema, Hono routes, .NET commands (existing) |
| `api X from M` | Per-aggregate `api/<name>.ts` with React Query hooks (existing scaffold output) |
| `storage X { type: postgres }` | Drizzle config + Phoenix/Hono/.NET Postgres migrations (see [`migrations-design.md`](migrations-design.md)) |
| `storage X { type: <other> }` | Parses + validates; no generator output yet |
| UI `api X: Y` parameter + body refs | Walker hook injection (slices 11.24–11.25) |
| Deployable `serves:` / `ui: X { ... }` | Validator + composition checks (slice 11.26) |
| Deployable `modules: X { primary: Y }` | Validator + IR (slice 11.27); the `primary` binding hints at the migration owner (`ModuleIR.migrationsOwner`), though each needsDb deployable currently still emits its own migration files against its own per-slug compose DB |


## Slice trail

The shipped architecture is the result of slices 11.24–11.27
+ housekeeping (11.28–11.29).  Each slice ships an isolated,
testable piece:

- **11.24** — `api X from M` declaration + UI `api X: Y` parameter + walker hook injection
- **11.25** — Validator for api refs (cross-ref resolution, op existence, suggestions)
- **11.26** — Backend `serves:` + frontend `ui: WebApp { Param: backend }` compose-block
- **11.27** — `storage X { type: T }` + per-module storage map on backend deployable
- **11.28** — Architecture integration test + acme.ddd migration
- **11.29** — Button `disabled:` / `loading:` + object literal expressions
