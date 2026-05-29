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
subdomain   →   group of contexts                                  [domain]

api         →   contract derived from a subdomain                  [contract]
storage     →   typed physical store                               [infra]
dataSource  →   (context, kind) → storage routing                  [infra]
ui          →   declares api dependencies, renders pages           [consumer]

deployable  →   composes platform + contexts + api + UI + dataSources [composition]
```

Read any single declaration and you see its full picture; no
implicit cross-references between layers.


## Domain layer

`subdomain` and `context` define pure domain — aggregates,
repositories, workflows, views.  Persistence-agnostic; same
domain runs against Postgres in prod, in-memory in tests.

```ddd
subdomain Sales {
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

`api X from <Subdomain>` declares a contract derived from a
subdomain's domain.  The api auto-exposes:

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

`storage X { type: T }` declares a typed physical store — reusable
across deployables, contexts, and bindings.  v0 type enum:

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


## DataSource bindings

`storage` says *what physical store exists*; `dataSource` says
*which context's data of which kind lands where*.  The split
(D-STORAGE-SPLIT) means a single `storage` instance can back
multiple contexts (each in its own Postgres schema), and a single
context can route different data kinds (state vs eventLog vs cache)
to different stores.

```ddd
dataSource ordersState {
  for: Orders, kind: state, use: primarySql
  // optional: schema, tablePrefix, isolationLevel, ttl, every, retain, normalised, …
}
dataSource ordersCache {
  for: Orders, kind: cache, use: hotCache, ttl: 60
}
```

Kinds (`state`, `eventLog`, `snapshot`, `cache`, `replica`) match
storage types via an enforced compatibility matrix:

| Kind | Compatible storage types | Aggregate predicate |
|---|---|---|
| `state` | postgres, mysql, sqlite, inMemory | at least one `persistedAs(state)` aggregate (the default) |
| `eventLog` | postgres, mysql, sqlite, inMemory, kafka | at least one `persistedAs(eventLog)` aggregate |
| `snapshot` | postgres, mysql, sqlite, inMemory | at least one `persistedAs(eventLog)` aggregate (snapshot policy) |
| `cache` | redis, inMemory | any aggregate |
| `replica` | postgres, mysql, sqlite | any aggregate |

Defaults applied at emit time:

- `schema:` omitted → defaults to `snake(contextName)` on relational stores; non-relational stores have no schema concept.
- `normalised:` omitted → defaults to `true` (relational tables).  `normalised: false` marks the `state` / `snapshot` data as one JSON document (D-DOCUMENT-AXIS); the document persistence *emission* is a later slice, so today the knob is parsed and carried but does not yet change generated output.

Backend deployables list which dataSources they wire up (see
"Backend deployables" below).  The validators enforce that every
hosted `(context, persistence-kind)` pair has a matching binding,
that every listed binding actually routes data, and that knob/kind/
storage triples are coherent.

A derived view of the resolved routing is emitted to
`.loom/datasources.md` — see [`loom-artifacts.md`](loom-artifacts.md).


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
- `Customer` resolves to an aggregate in the api's source subdomain.
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
  platform: hono                       // runtime
  contexts: [Orders, Customers]        // domain contexts hosted
  dataSources: [ordersState, customersState, ordersCache]  // routing
  serves: SalesApi                     // contract this deployable implements
  port: 3000
}
```

The `serves:` field lists api contracts implemented by this
backend.  The `contexts:` field names which bounded contexts this
deployable hosts.  The `dataSources:` field lists the
system-scope `dataSource` decls that route those contexts'
persistence — see "DataSource bindings" above.

Validators enforce:

- Every hosted `(context, aggregate.persistedAs)` pair (the
  `persistedAs(…)` value *is* the dataSource kind) must have a matching
  dataSource listed (no under-binding).
- Every listed dataSource must cover at least one aggregate in the
  hosted contexts (no dead binding — warning, not error).
- Every dataSource's `for: <ctx>` must be in this deployable's
  `contexts:`.

Multiple contexts hosted by one deployable is the common case:

```ddd
deployable monolithApi {
  platform: dotnet
  contexts: [Orders, Marketing]
  dataSources: [ordersState, marketingState, ordersAuditLog]
  serves: SalesApi, MarketingApi
  port: 8080
}
```

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
  contexts: [Orders]
  dataSources: [ordersState]
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
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { find byEmail(email: string): Customer? }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  dataSource ordersState { for: Orders, kind: state, use: primarySql }

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
    contexts: [Orders]
    dataSources: [ordersState]
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
| `subdomain Sales { ... }` | a logical grouping; the domain lives in its `context` children |
| `context Orders { aggregate Customer { ... } }` | the domain — pure, persistence-agnostic |
| `api SalesApi from Sales` | the contract — derived from a subdomain |
| `storage primarySql { type: postgres }` | a typed physical store |
| `dataSource ordersState { for: Orders, kind: state, use: primarySql }` | which context's data of which kind lands where |
| `ui WebApp { api Sales: SalesApi, ... }` | the UI takes Sales of contract SalesApi |
| `deployable salesApi` | what's served, which contexts hosted, which dataSources wire them up |
| `deployable webApp` | what UI runs, which backend fills each api param |


## Scaffold expands to walker stdlib (Slice C2 / D1)

The `scaffold subdomains: [M]` directive (page-metamodel §10) keeps
working — but as **compile-time sugar**.  Synthesised pages now
lower to explicit walker-stdlib bodies via
`src/ir/walker-primitive-expander.ts`, called at the end of
`lowerModel` as the final sub-pass of lowering (see
[`docs/technical.md`](./technical.md) phase ⑤c):

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
| `api X from MissingSub` | "api 'X' references undeclared subdomain 'MissingSub'" |
| Two `api X` declarations | "Duplicate api 'X'" |
| `api X: NoSuchApi` in UI | "ui '<U>' references undeclared api 'NoSuchApi'" |
| Body ref `Sales.NoAggregate.all` | "Aggregate 'NoAggregate' not found in api 'SalesApi'" |
| Body ref `Sales.Customer.allll` | "Operation 'allll' is not declared on aggregate 'Customer'.  Available: all, byId, create, ..." |
| `serves:` on a frontend platform | "'serves:' is only valid on a backend deployable" |
| Backend doesn't serve a bound api | "Deployable 'X' does not 'serves: Y'" |
| Missing UI param binding | "Deployable 'D' is missing a binding for ui parameter 'X: Y'" |
| Duplicate storage names | "Duplicate storage 'X'" |
| Duplicate dataSource names | "Duplicate dataSource 'X'" |
| Backend hosts an aggregate with no matching dataSource | "Deployable 'X' hosts aggregate 'C.A' (persistedAs: state, needs dataSource kind: state) but lists no matching dataSource." |
| dataSource kind ↔ storage type mismatch | "dataSource 'X' kind 'cache' is incompatible with storage 'pg' of type 'postgres'.  kind 'cache' requires a storage of type inMemory or redis." |
| dataSource listed but covers no aggregate (warning) | "Deployable 'X' lists dataSource 'Y' (kind: eventLog) for context 'C', but no aggregate is eventSourced — this binding routes no data." |
| Knob incompatible with kind | "dataSource 'X': 'ttl' is only meaningful on kind: cache.  Got kind: state." |


## Generator wiring (today)

| Layer | Generator-side |
|---|---|
| `subdomain`, `context`, aggregate fields | Drizzle schema, Hono routes, .NET commands (existing) |
| `api X from <Ctx>` | Per-aggregate `api/<name>.ts` with React Query hooks (existing scaffold output) |
| `storage X { type: postgres }` | Drizzle config + Phoenix/Hono/.NET Postgres migrations (see [`migrations-design.md`](migrations-design.md)) |
| `storage X { type: <other> }` | Parses + validates; no generator output yet |
| `dataSource X { for: C, kind: state, use: Y, schema: "...", tablePrefix: "..." }` | EF Core `ToTable("name", "schema")`, Drizzle `pgSchema("...").table(...)`, AshPostgres `schema "..." + table "prefix_..."`.  Schema defaults to `snake(contextName)` when omitted on a relational store. |
| `dataSource X { ..., isolationLevel: <level> }` | Default isolation for transactional workflows in the bound context, overridden by per-workflow `transactional(<level>)`. |
| `dataSource X { ..., ttl/every/retain/readonly/keyPrefix: ... }` | Validated for shape and compatibility; emitters do not yet consume — the IR validator warns at emit time so authors don't believe no-op knobs have effect. |
| UI `api X: Y` parameter + body refs | Walker hook injection (slices 11.24–11.25) |
| Deployable `serves:` / `ui: X { ... }` | Validator + composition checks (slice 11.26) |
| Deployable `contexts:` / `dataSources:` | IR-level coverage validator (every hosted (context, kind) pair must have a matching binding; every listed binding must cover at least one aggregate).  `migrationsOwner` derives one backend per subdomain for schema-migration emission. |


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
- **D-STORAGE-SPLIT** — replaced 11.27's `modules: M { primary: storage }` block with system-scope `dataSource Name { for: C, kind: K, use: storage, … }` decls + `deployable.contexts: [...] dataSources: [...]`.  Adds the kind/storage compatibility matrix, the (context, kind) coverage validator, and the per-decl knob validator (PRs #698, #699, #701, #702).
