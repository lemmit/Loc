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
storage     →   typed physical store / service                     [infra]
resource    →   (context, kind) → storage binding + config         [infra]
ui          →   declares api dependencies, renders pages           [consumer]

deployable  →   composes platform + contexts + api + UI + resources  [composition]
```

Read any single declaration and you see its full picture; no
implicit cross-references between layers.

**File organisation is independent of this layering.** A project is
*one* `system`, but its members need not live in one file: any
`subdomain` and every deployment declaration (`storage` / `resource` /
`channelSource` / `ui` / `deployable` / `theme` / `user` / `test e2e`)
may be written at the top level of any `.ddd` file in the import graph
and composes into the project's single `system` — so a project can be
split one-file-per-subdomain with the deployment in its own file. See
[`proposals/implicit-system-composition.md`](old/proposals/implicit-system-composition.md).


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

`storage X { type: T }` declares a typed physical store or service —
reusable across deployables, contexts, and bindings.  `type:` names the
built-in **sourceType** that realizes it (see [`resources.md`](resources.md)).
v0 type enum:

| Category | Types |
|---|---|
| Transactional | `postgres`, `mysql`, `sqlite`, `inMemory` |
| Cache | `redis` |
| Search | `elastic`, `meilisearch` |
| Events | `kafka` |
| Analytics | `clickhouse`, `bigquery` |
| Object store | `s3` |
| Queue | `rabbitmq` |
| External API | `restApi` |

```ddd
storage primarySql   { type: postgres }
storage hotCache     { type: redis    }
storage files        { type: s3, config: { region: "eu-central-1", bucket: "app-files" } }
storage jobBus       { type: rabbitmq }
```

`postgres` has full persistence support; `s3` / `rabbitmq` / `restApi`
activate dev-compose sidecars + per-backend client emission (consumed
from workflows — see [`resources.md`](resources.md)).  The remaining
types parse + validate but don't yet activate generator output.  A
`config { k: v }` map carries vendor parameters, validated per sourceType.


## Resource bindings

`storage` says *what physical store exists*; `resource` (renamed from
`dataSource`) says *which context's data of which kind lands where*.
The split (D-STORAGE-SPLIT) means a single `storage` instance can back
multiple contexts (each in its own Postgres schema), and a single
context can route different data kinds (state vs eventLog vs cache)
to different stores.  The full model — sourceType registry, capabilities,
interfaces, and workflow-level consumption — is in [`resources.md`](resources.md);
this section covers the persistence-routing essentials.

```ddd
resource ordersState {
  for: Orders, kind: state, use: primarySql
  // optional: schema, tablePrefix, isolationLevel, ttl, every, retain, shape, config, …
}
resource ordersCache {
  for: Orders, kind: cache, use: hotCache, ttl: 60
}
```

The surface `kind:` matches the storage's sourceType via an enforced
compatibility matrix:

| Kind | Compatible storage types | Aggregate predicate |
|---|---|---|
| `state` | postgres, mysql, sqlite, inMemory | at least one `persistedAs(state)` aggregate (the default) |
| `eventLog` | postgres, mysql, sqlite, inMemory, kafka | at least one `persistedAs(eventLog)` aggregate |
| `snapshot` | postgres, mysql, sqlite, inMemory | at least one `persistedAs(eventLog)` aggregate (snapshot policy) |
| `cache` | redis, inMemory | any aggregate |
| `replica` | postgres, mysql, sqlite | any aggregate |
| `objectStore` | s3 | consumed from a workflow (`files.put(…)` etc.) |
| `queue` | rabbitmq | consumed from a workflow (`jobs.enqueue(…)`) |
| `api` | restApi | consumed from a workflow (`rates.get(…)`) |

Defaults applied at emit time:

- `schema:` omitted → defaults to `snake(contextName)` on relational stores; non-relational stores have no schema concept.
- `normalised:` omitted → defaults to `true` (relational tables).  `normalised: false` marks the `state` / `snapshot` data as one JSON document (D-DOCUMENT-AXIS); the document persistence *emission* is a later slice, so today the knob is parsed and carried but does not yet change generated output.

Backend deployables list which resources they wire up via the
`dataSources:` clause (see "Backend deployables" below).  The
validators enforce that every
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
  platform: node                       // runtime
  contexts: [Orders, Customers]        // domain contexts hosted
  dataSources: [ordersState, customersState, ordersCache]  // routing
  serves: SalesApi                     // contract this deployable implements
  port: 3000
}
```

The `serves:` field lists api contracts implemented by this
backend.  The `contexts:` field names which bounded contexts this
deployable hosts.  The `dataSources:` field lists the
system-scope `resource` decls that route those contexts'
persistence — see "Resource bindings" above.

Validators enforce:

- Every hosted `(context, aggregate.persistedAs)` pair (the
  `persistedAs(…)` value *is* the resource kind) must have a matching
  resource listed (no under-binding).
- Every listed resource must cover at least one aggregate in the
  hosted contexts (no dead binding — warning, not error).
- Every resource's `for: <ctx>` must be in this deployable's
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

### Fullstack deployables (`platform: elixir`)

An `elixir` deployable collapses backend + frontend into one
project.  It both `serves:` a context-derived API AND mounts a `ui:`,
without a peer `targets:` link.

```ddd
deployable phoenixApp {
  platform: elixir
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
  `platform: elixir` with `framework: react` is rejected.
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
  resource ordersState { for: Orders, kind: state, use: primarySql }

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
    platform: node
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
| `resource ordersState { for: Orders, kind: state, use: primarySql }` | which context's data of which kind lands where |
| `ui WebApp { api Sales: SalesApi, ... }` | the UI takes Sales of contract SalesApi |
| `deployable salesApi` | what's served, which contexts hosted, which resources wire them up |
| `deployable webApp` | what UI runs, which backend fills each api param |


## Scaffold expands to walker stdlib (Slice C2 / D1)

The `scaffold subdomains: [M]` directive (page-metamodel §10) keeps
working — but as **compile-time sugar**.  Synthesised pages now
lower to explicit walker-stdlib bodies via
`src/ir/lower/walker-primitive-expander.ts`, called at the end of
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
| Duplicate resource names | "Duplicate resource 'X'" |
| Backend hosts an aggregate with no matching resource | "Deployable 'X' hosts aggregate 'C.A' (persistedAs: state, needs resource kind: state) but lists no matching resource." |
| resource kind ↔ storage type mismatch | "resource 'X' kind 'cache' is incompatible with storage 'pg' of type 'postgres'.  kind 'cache' requires a storage of type inMemory or redis." |
| resource listed but covers no aggregate (warning) | "Deployable 'X' lists resource 'Y' (kind: eventLog) for context 'C', but no aggregate is eventSourced — this binding routes no data." |
| Knob incompatible with kind | "resource 'X': 'ttl' is only meaningful on kind: cache.  Got kind: state." |


## Generator wiring (today)

| Layer | Generator-side |
|---|---|
| `subdomain`, `context`, aggregate fields | Drizzle schema, Hono routes, .NET commands (existing) |
| `api X from <Ctx>` | Per-aggregate `api/<name>.ts` with React Query hooks (existing scaffold output) |
| `storage X { type: postgres }` | Drizzle config + Phoenix/Hono/.NET Postgres migrations via the platform-neutral MigrationsIR (`src/ir/types/migrations-ir.ts` + `src/system/migrations-builder.ts`); per-backend emitters in `src/generator/<backend>/emit/migrations*.ts` (one per backend — `elixir`, `typescript`, `dotnet`, `python`, `java`) |
| `storage X { type: <other> }` | Parses + validates; no generator output yet |
| `resource X { for: C, kind: state, use: Y, schema: "...", tablePrefix: "..." }` | EF Core `ToTable("name", "schema")`, Drizzle `pgSchema("...").table(...)`, Ecto `@schema_prefix "..." + schema "prefix_..."`.  Schema defaults to `snake(contextName)` when omitted on a relational store. |
| `resource X { ..., isolationLevel: <level> }` | Default isolation for transactional workflows in the bound context, overridden by per-workflow `transactional(<level>)`. |
| `resource X { ..., ttl/every/retain/readonly/keyPrefix: ... }` | Validated for shape and compatibility; emitters do not yet consume — the IR validator warns at emit time so authors don't believe no-op knobs have effect. |
| `resource X { for: C, kind: objectStore\|queue\|api, use: Y }` | Per-backend client module + dev-compose sidecar; consumed from workflows via the verb vocabulary.  See [`resources.md`](resources.md). |
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
