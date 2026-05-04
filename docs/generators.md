# Loom — Generator Reference

Per-platform reference for every file the generators emit and the
features they implement.  This document maps each DSL construct to its
output across all three platforms so you can answer questions like:

- "What does `aggregate Order` produce on .NET?"
- "Where does my `derived total: Money = …` end up in the React app?"
- "Does the Hono backend support per-DSL `find` with a `where` clause?"

For language syntax see [`language.md`](language.md); for architecture
see [`technical.md`](technical.md); for CLI / Docker / Playwright
workflow see [`tools.md`](tools.md).

---

## Cross-platform feature matrix

| Construct | TypeScript (Hono + Drizzle) | .NET (ASP.NET + EF + Mediator) | React (Vite + RQ + Mantine) |
| --- | --- | --- | --- |
| `enum` | `pgEnum`, exported union type | C# enum + EF `HasConversion<string>` | Zod `z.enum([...])` |
| `valueobject` | Class with invariant ctor + accessors; flattened columns in Drizzle | `record` with invariant ctor; `OwnsOne` in EF | Zod object schema, nested `<Fieldset>` in forms |
| `event` | TypeScript discriminated union; pushed via `_events.push` | `record` implementing `IDomainEvent`; pushed via `_events.Add` | (events are domain-internal; not surfaced to the SPA) |
| `aggregate` | Class with private state, factory, ops, derived getters, `pullEvents()` | Sealed class with private state, factory, ops, derived getters, `PullEvents()` | List + Detail + New page; api hooks |
| `entity` part | Same as aggregate but with `_parentId` | Same as aggregate; mapped via `OwnsMany` | Sub-table on detail page, master-detail row testids |
| `contains` (collection) | Drizzle table with `parent_id` FK; auto-loaded in repo | EF owned-collection; auto-loaded by tracker | Sub-table on detail; not editable in the create form |
| `derived` | Getter that calls into the expression | Computed property that calls into the expression | Read-only field on detail; included in the response Zod schema |
| `invariant` | Private `_assertInvariants()` called at the end of every mutator | Private `AssertInvariants()` called at the end of every mutator | (enforced server-side; surfaces as 400 in the UI) |
| `function` | Private method on the aggregate / part class | Private expression-bodied member | (server-only) |
| `operation` | Public method (or private if marked) that enforces preconditions, mutates state, queues events, and re-asserts invariants | Same shape; visibility honoured | Mantine button on the detail page; opens a modal whose form binds to `<Op>Request`; submit calls `use<Op><Agg>()` |
| `precondition` | `if (!cond) throw new DomainError(<source>)` | `if (!cond) throw new DomainException(<source>)` | (server-side; HTTP 400 surfaces as a Mantine error notification) |
| `emit` | `_events.push({ type: "X", … })` | `_events.Add(new X(...))` | (server-side) |
| `repository` find | Method on `<Agg>Repository`; convention-based predicate or TODO comment for `where` clauses | Method on `I<Agg>Repository`; LINQ `.Where(x => …)` for both convention and `where` forms | `use<FindName><Agg>(query)` React Query hook + a list-page filter mode (deferred; v1 emits the hook only) |
| Auto `findById` / `getById` | Yes — load root + parts in a transaction; `getById` throws on missing | Yes — `GetByIdAsync` returns `Order?`, `getById` is implicit via the controller raising 404 | `use<Agg>ById(id)` hook, used by the detail page |
| Auto `find all` | Yes — `GET /<plural>`, loads with master-detail | Yes — `GET /<plural>` via `GetAllQuery` + handler | `useAll<Agg>()` hook, used by the list page |
| `test "name" { … }` | Vitest at `domain/<aggregate>.test.ts` | xUnit at `Tests/<Plural>/<Aggregate>Tests.cs` | (n/a — backend-only) |
| `test e2e "name" against <backend> { … }` | Vitest at `<system>/e2e/<System>.e2e.test.ts` (typed fetch against the live HTTP) | (same file; targets the named .NET deployable) | (n/a — see UI variant below) |
| `test e2e "name" against <react-deployable> { … }` | (n/a — UI tests live in the react deployable) | (n/a) | Playwright spec at `<react-deployable>/e2e/<System>.ui.spec.ts`, routes through the auto-generated page objects |

---

## TypeScript backend (`platform: hono`)

`generate ts` for legacy single-context sources; `generate system` for
deployables marked `platform: hono`.

### File map

For a context with aggregates `Order` (containing parts) and `Product`:

```
<deployable>/
├── package.json                     # deps: hono, @hono/node-server, @hono/zod-openapi, zod, drizzle-orm, pg
├── tsconfig.json
├── index.ts                         # pg Pool → drizzle → createApp(db) → @hono/node-server.serve
├── drizzle.config.ts                # Drizzle Kit config (db:generate, db:migrate, db:push, db:studio)
├── Dockerfile                       # multi-stage node:22-alpine; runtime serves `node out/index.js`
├── .dockerignore
├── certs/.gitkeep                   # proxy-CA escape hatch (drop *.crt files here at build time)
├── domain/
│   ├── ids.ts                       # branded id types: OrderId, OrderLineId, ProductId, …
│   ├── value-objects.ts             # enums + value-object classes with invariant ctors
│   ├── events.ts                    # discriminated event union + dispatcher type + Noop dispatcher
│   ├── errors.ts                    # DomainError, AggregateNotFoundError
│   ├── order.ts                     # Order class + OrderLine part class(es)
│   ├── order.test.ts                # vitest from `test "name" { … }` blocks (when present)
│   └── product.ts
├── db/
│   ├── schema.ts                    # Drizzle pgTable / pgEnum
│   └── repositories/
│       ├── order-repository.ts      # findById / getById / save / find* / all() / toWire
│       └── product-repository.ts
└── http/
    ├── index.ts                     # Hono app composer: CORS, /health, sub-routers, /openapi.json
    ├── order.routes.ts              # OpenAPIHono router with createRoute() + Zod request/response schemas
    └── product.routes.ts
```

### Per-aggregate detail

**`domain/<aggregate>.ts`** — class with:

- Private state fields, private constructor for rehydration
- `static <Agg>.create(input)` factory: allocates a fresh id, calls
  the constructor, runs invariants
- `static <Agg>._create(state)` for the repo to rehydrate from rows
- Public method per public operation; private method per private op
- Private method per `function`
- Getter per `derived`
- `private _assertInvariants()` invoked from every mutator
- `_events: DomainEvent[]` + `pullEvents()` drained by the repo

Entity parts are sibling classes in the same file with `_parentId`
set on construction; mutations on parts go through their parent's
operations.

**`http/<aggregate>.routes.ts`** — built by `routes-builder.ts`:

- Zod schemas for every value object, enum, and per-route DTO; named
  via `.openapi("Foo")` so they appear in `/openapi.json`'s
  `components.schemas`
- One route per shape:
  - `POST /` → create (body = `Create<Agg>Request`, returns `{id}`)
  - `GET /` → all (auto findAll; returns `<Agg>ListResponse`)
  - `GET /{id}` → findById (returns `<Agg>Response`)
  - `POST /{id}/<snake_op>` → operation (body = `<Op>Request`, returns 204)
  - `GET /<snake_find>` → user-declared find (query params = `<Find>Query`)
- Domain-error handler maps `DomainError` → 400, `AggregateNotFoundError` → 404

Response schemas carry the **full wire shape**: every field, every
contained part nested, every derived value, value objects as nested
objects.  Decimals are JSON numbers; datetimes are ISO strings.

**`db/repositories/<aggregate>-repository.ts`** — built by
`repository-builder.ts`:

- `findById(id)` — load root + every part collection in one
  transaction, hydrate aggregate
- `getById(id)` — same but throws `AggregateNotFoundError` on missing
- `save(aggregate)` — upsert root, diff-sync each contained collection
  (insert new + update existing + delete removed) in a transaction,
  drain events via `dispatcher.dispatch`
- `all()` — auto-included; loads all rows and hydrates with parts
- `<find>(...)` — one method per user-declared `find`; convention-
  based predicate or a TODO comment for `where` clauses (Drizzle has
  no general lambda → SQL translator)
- `toWire(root)` — domain → wire DTO projection used by route
  handlers

**`db/schema.ts`** — Drizzle `pgTable` per aggregate root and per
contained part (parts get a `parent_id` FK), `pgEnum` per enum,
value-object fields flattened into prefix-named columns
(`price_amount`, `price_currency`).

**`http/index.ts`** — composer:

- `app.use("*", cors())` (permissive; pin in `.loomignore` for prod)
- `app.get("/health", ...)`
- `app.route("/<plural>", <agg>Routes(new <Agg>Repository(db, events)))`
- `app.doc("/openapi.json", { openapi: "3.1.0", … })`

---

## .NET backend (`platform: dotnet`)

`generate dotnet` for legacy single-context sources; `generate system`
for deployables marked `platform: dotnet`.

### File map

```
<deployable>/
├── <Namespace>.csproj               # net8.0, EF Core, Mediator source-gen, Swashbuckle, EF Tools
├── Program.cs                       # AddDbContext, AddMediator, AddCors, AddSwaggerGen, MapControllers,
│                                    # camelCase JSON, EnsureCreated, /health
├── Dockerfile                       # multi-stage dotnet/sdk → dotnet/aspnet
├── .dockerignore
├── certs/.gitkeep                   # proxy-CA escape hatch
├── Domain/
│   ├── Common/DomainException.cs
│   ├── Ids/                         # OrderId.cs, OrderLineId.cs, ProductId.cs, …
│   ├── Enums/                       # one .cs per enum + a _namespace.cs marker so empty namespaces compile
│   ├── ValueObjects/                # one .cs per value object + _namespace.cs marker
│   ├── Events/
│   │   ├── IDomainEvent.cs
│   │   └── OrderConfirmed.cs        # one .cs per event
│   └── Orders/                      # one folder per aggregate (plural)
│       ├── Order.cs                 # aggregate root class
│       ├── OrderLine.cs             # entity-part classes
│       └── IOrderRepository.cs      # interface
├── Application/
│   └── Orders/
│       ├── Requests/OrderRequests.cs    # CreateOrderRequest, AddLineRequest, …
│       ├── Responses/OrderResponses.cs  # OrderResponse, OrderLineResponse, MoneyResponse, CreateOrderResponse
│       ├── Commands/                    # one Command + Handler per public operation + Create<Agg>
│       │   ├── CreateOrderCommand.cs
│       │   ├── CreateOrderHandler.cs
│       │   ├── ConfirmCommand.cs
│       │   ├── ConfirmHandler.cs
│       │   ├── AddLineCommand.cs
│       │   └── AddLineHandler.cs
│       └── Queries/                     # one Query + Handler per find (incl. auto findById / all)
│           ├── GetOrderByIdQuery.cs
│           ├── GetOrderByIdHandler.cs
│           ├── AllQuery.cs
│           ├── AllHandler.cs
│           ├── ByCustomerQuery.cs
│           └── ByCustomerHandler.cs
├── Infrastructure/
│   ├── Persistence/
│   │   ├── AppDbContext.cs              # DbSet<Order>, DbSet<Product>, …
│   │   └── Configurations/
│   │       ├── OrderConfiguration.cs    # IEntityTypeConfiguration: OwnsMany lines, OwnsOne for VOs, HasConversion for ids/enums
│   │       └── ProductConfiguration.cs
│   ├── Repositories/
│   │   ├── OrderRepository.cs           # implements IOrderRepository: GetByIdAsync, SaveAsync, All, …
│   │   └── ProductRepository.cs
│   └── Events/NoopDomainEventDispatcher.cs
├── Api/
│   ├── DomainExceptionFilter.cs         # DomainException → 400, AggregateNotFoundException → 404
│   ├── OrdersController.cs              # [HttpPost], [HttpGet], [HttpPost("{id}/<op>")], [HttpGet("<find>")]
│   └── ProductsController.cs
└── Tests/<Namespace>.Tests/             # xUnit project — emitted only when `test` blocks exist
    ├── <Namespace>.Tests.csproj
    └── Orders/OrderTests.cs
```

### Per-aggregate detail

**`Domain/<Plural>/<Aggregate>.cs`** — sealed class with:

- `public <Agg>Id Id { get; private set; }`
- Private setter on every property; parameterless ctor for EF
- `public static <Agg> Create(...)` factory
- Public method per public op; private method per private op
- Private expression-bodied member per `function`
- Computed property per `derived`
- `private void AssertInvariants()` invoked from every mutator
- `private readonly List<IDomainEvent> _events` + `PullEvents()`

**`Infrastructure/Persistence/Configurations/<Aggregate>Configuration.cs`** —
`IEntityTypeConfiguration<<Aggregate>>`:

- `OwnsMany` per contained collection (parts as owned entities)
- `OwnsOne` per value-object property
- `HasConversion` for ids and enums

**`Application/<Plural>/Commands/...`** — for every public DSL
operation: a `record` Command implementing `ICommand<TResponse>` plus
a Handler that loads the aggregate, invokes the method, saves.
Preconditions are checked **inside** the aggregate, never duplicated
in the handler.

**`Application/<Plural>/Queries/...`** — for every `find` (including
auto `findById` and `all`): a `record` Query + a Handler that calls
the repository and projects through `<Agg>Mapper.ToDto(...)` (lives
in the Responses module via `dto-mapping.ts`).

**`Application/<Plural>/Requests/<Aggregate>Requests.cs`** — wire-shape
records: `Create<Agg>Request`, `<Op>Request` per public op,
`<Vo>Request` per used value object.  Datetimes are `string` on the
wire (Hono parity); the controllers parse with
`DateTimeStyles.AssumeUniversal | AdjustToUniversal` → UTC.

**`Application/<Plural>/Responses/<Aggregate>Responses.cs`** — wire-
shape records (`<Agg>Response`, `<Part>Response`, `<Vo>Response`,
`Create<Agg>Response`).  Datetimes round-trip via
`ToUniversalTime().ToString("o")` so .NET's spec matches Hono's.

**`Api/<Plural>Controller.cs`** — `[ApiController]` with one route per
shape; converts wire-DTOs to commands, dispatches via `IMediator`,
returns DTOs.  `DomainExceptionFilter` turns precondition failures
into HTTP 400 and missing-aggregate into 404.

**`Program.cs`** — hosting entry:

- `AddDbContext<AppDbContext>` over `ConnectionStrings:Default`
- `AddMediator` (source-gen)
- `AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>`
- `AddScoped<I<Agg>Repository, <Agg>Repository>` per aggregate
- `AddControllers().AddJsonOptions(...)` — camelCase property naming
- `AddCors` (permissive default; pin to tighten in prod)
- `AddSwaggerGen` (`/swagger/v1/swagger.json`)
- `app.MapGet("/health", ...)` + `UseCors() / UseSwagger() / MapControllers()`
- `db.Database.EnsureCreated()` on first scope (per-deployable DB,
  no race — see [`tools.md`](tools.md#per-deployable-databases))

---

## React frontend (`platform: react`)

`generate system` for deployables marked `platform: react`.  No
single-deployable CLI entry — react frontends only make sense in
`system` mode where they can resolve a `targets:` peer.

### File map

For a frontend `webApp` targeting `api` (which hosts Order + Product):

```
web_app/
├── package.json                     # deps: react, react-router-dom, @tanstack/react-query, zod,
│                                    # @mantine/* (core, hooks, form, notifications, dates, modals),
│                                    # mantine-form-zod-resolver
├── tsconfig.json + tsconfig.node.json
├── vite.config.ts                   # @vitejs/plugin-react, dev/preview both bind 0.0.0.0:3000
├── index.html
├── Dockerfile                       # multi-stage node:22-alpine; runtime: vite preview
├── .dockerignore                    # excludes e2e/, dist/, playwright-report/, test-results/
├── certs/.gitkeep
├── src/
│   ├── main.tsx                     # MantineProvider + QueryClientProvider + Router + Notifications + ModalsProvider
│   ├── App.tsx                      # AppShell + <Routes>: home, /<plural>, /<plural>/new, /<plural>/:id
│   ├── api/
│   │   ├── client.ts                # fetch wrapper, ApiError
│   │   ├── config.ts                # API_BASE_URL = http://localhost:<target.port> (overridable via VITE_API_BASE_URL)
│   │   ├── order.ts                 # Zod schemas + RQ hooks
│   │   └── product.ts
│   └── pages/
│       ├── home.tsx                 # link cards per aggregate
│       ├── orders/
│       │   ├── list.tsx             # /orders — Mantine <Table> from useAllOrders
│       │   ├── new.tsx              # /orders/new — Mantine form on Create<Agg>Request
│       │   └── detail.tsx           # /orders/:id — fields + parts + operation buttons (modal-form per op)
│       └── products/
│           ├── list.tsx
│           ├── new.tsx
│           └── detail.tsx
└── e2e/                             # standalone Playwright suite (separate package.json so the
    │                                # runtime image stays slim — @playwright/test isn't pulled into prod)
    ├── package.json                 # @playwright/test, @types/node
    ├── tsconfig.json                # includes ../src/api/**/*.ts so page objects can use response types
    ├── playwright.config.ts         # baseURL = http://localhost:3001 (override via E2E_BASE_URL)
    ├── smoke.spec.ts                # auto-generated: every aggregate's list page loads
    └── pages/                       # auto-generated page-object classes
        ├── order.ts                 # OrderListPage / OrderNewPage / OrderDetailPage
        └── product.ts
```

### Per-aggregate detail

**`src/api/<aggregate>.ts`** — built by `api-builder.ts`:

- Zod schemas for every value object, enum, and per-route DTO:
  - `<Vo>Schema`, `<Enum>Schema`
  - `Create<Agg>Request`, per-op `<Op>Request`, per-find `<Find>Query`
  - `<Part>Response`, `<Agg>Response`, `<Agg>ListResponse`
- React Query hooks:
  - `useAll<Agg>()` → `useQuery(["<plural>"], …)`, parses with `<Agg>ListResponse`
  - `use<Agg>ById(id)` → `useQuery(["<plural>", id], …)`, `enabled: !!id`
  - `useCreate<Agg>()` → `useMutation`, invalidates `["<plural>"]` on success
  - `use<Op><Agg>(id)` → `useMutation`, invalidates `["<plural>", id]` and `["<plural>"]` on success
  - `use<FindName><Agg>(query)` → `useQuery` per user-declared find (the auto `all` find is the dedicated `useAll<Agg>` hook above)

All hooks parse the response with the matching Zod schema before
returning, so callers get type-checked, validated data.

**`src/pages/<plural>/list.tsx`** — built by `pages-builder.ts`:

- Mantine `<Table>` with one column per primitive / enum field
- Each row links to `/<plural>/<id>`
- "Create" button routes to `/<plural>/new`
- `data-testid` on every interactive element (see table below)

**`src/pages/<plural>/new.tsx`**:

- Mantine `<form>` over the `Create<Agg>Request` schema
- One Mantine input per required aggregate field — see Mantine input
  mapping below
- `useForm` + `zodResolver(Create<Agg>Request)` for validation
- Submit calls `useCreate<Agg>()`; success navigates to detail; error
  surfaces via `@mantine/notifications`

**`src/pages/<plural>/detail.tsx`**:

- Loads via `use<Agg>ById(id)`
- Mantine `<Card>` with field display (one per primitive / enum / VO field)
- Sub-`<Table>` per `contains` collection (master-detail)
- One Mantine `<Button>` per public operation; click opens a Mantine
  modal whose form binds to the matching `<Op>Request` schema
- Submit calls the matching mutation hook; success closes the modal
  and shows a notification; error surfaces via notification
- React Query invalidation runs on success so the page reflects the
  new state automatically

### Mantine input mapping

Form-input emission walks the field type:

| Type | Mantine component | Notes |
| --- | --- | --- |
| `int` / `long` | `<NumberInput allowDecimal={false}>` | |
| `decimal` | `<NumberInput decimalScale={2} fixedDecimalScale>` | |
| `string` / `guid` | `<TextInput>` | |
| `bool` | `<Switch>` | Manual `checked` / `onChange` since Mantine `<Switch>` accepts event-based onChange. |
| `datetime` | `<TextInput type="datetime-local">` | Native datetime input — Mantine's `<DateTimePicker>` is harder to drive from Playwright; users can swap via `.loomignore` for richer UX. |
| `enum` | `<Select allowDeselect={false}>` | Explicit `value` / `onChange` / `error` (Mantine Select calls onChange with `(value, option)`, not an event, so `getInputProps` can't be spread directly).  `allowDeselect={false}` keeps required fields from being cleared by a click on the already-selected option. |
| `valueobject` | `<Fieldset legend>` with one input per VO field | Sub-inputs use the `name.subField` form for nested binding. |
| `array<part>` | (omitted from the create form) | Parts are added via operations, not the create form. |

### `data-testid` map

The pages-builder sprinkles a stable `data-testid` on every
interactive element so the page-objects-builder can write
selector-free test code.

| Element | testid pattern |
| --- | --- |
| List page root | `<plural>-list` |
| List "Create" button | `<plural>-list-create` |
| List row | `<plural>-row-<id>` |
| List row link to detail | `<plural>-row-<id>-link` |
| List cell | `<plural>-row-<id>-<field>` |
| New page root | `<plural>-new` |
| New form input | `<plural>-new-input-<field>` (nested for VOs: `…-<field>-<voField>`) |
| New "Create" submit | `<plural>-new-submit` |
| Detail page root | `<plural>-detail` |
| Detail field display (primitive) | `<plural>-detail-<field>` |
| Detail enum badge | `<plural>-detail-<field>` (on `<Badge tt="unset">`) |
| Detail VO sub-field display | `<plural>-detail-<field>-<voField>` |
| Operation button | `<plural>-op-<opName>` |
| Operation modal form | `<plural>-op-<opName>-form` |
| Operation modal input | `<plural>-op-<opName>-input-<field>` |
| Operation modal submit | `<plural>-op-<opName>-submit` |
| Contained-part subtable | `<plural>-detail-<containment>` |
| Contained-part row | `<plural>-detail-<containment>-row-<id>` |
| Contained-part row cell | `<plural>-detail-<containment>-row-<id>-<field>` |

### Page-object classes

`page-objects-builder.ts` emits one TS module per aggregate at
`<deployable>/e2e/pages/<aggregate>.ts`.  Each module exports three
classes that mirror the page set:

```ts
export class <Agg>ListPage {
  static readonly url = "/<plural>";
  constructor(public readonly page: Page);
  goto(): Promise<this>;
  create(): Promise<<Agg>NewPage>;
  row(id: string): Locator;
  open(id: string): Promise<<Agg>DetailPage>;
  expectRow(id: string): Promise<void>;
}

export class <Agg>NewPage {
  static readonly url = "/<plural>/new";
  constructor(public readonly page: Page);
  goto(): Promise<this>;
  fill(input: Partial<Create<Agg>Request>): Promise<this>;
  submit(): Promise<<Agg>DetailPage>;
}

export class <Agg>DetailPage {
  constructor(public readonly page: Page, public readonly id: string);
  goto(): Promise<this>;
  field<K extends keyof <Agg>Response>(name: K): Promise<string>;
  // For each `contains <name>: Part[]`:
  <name>Row(id: string): Locator;
  <name>Count(): Promise<number>;
  // For each public operation `op(p1: T1, …)`:
  op(input: <Op>Request): Promise<this>;
}
```

The `fill()` body branches per type — `selectOption` for enums (via
the dropdown), `.fill()` for text inputs, `.click()` toggles for
bools, slice-to-`YYYY-MM-DDTHH:mm` for datetime — and walks
nested VO fields.

---

## System orchestration

`generate system` (in `src/system/index.ts`) runs each deployable
through its respective backend, scoped to its module subset, and
writes everything to a flat tree:

```
<outdir>/
├── api/                  # one folder per deployable
├── catalog_web/
├── web_app/
├── docker-compose.yml    # postgres + every deployable + healthchecks
├── db-init/
│   └── 00-create-databases.sql  # CREATE DATABASE per backend deployable
└── e2e/                  # generated DSL-level e2e suite (vitest+fetch)
    ├── package.json
    ├── tsconfig.json
    └── <System>.e2e.test.ts
```

### Per-platform compose service shape

| Platform | Internal port | Env | Depends on `db` | Healthcheck path |
| --- | --- | --- | --- | --- |
| `dotnet` | 8080 | `ConnectionStrings__Default=Host=db;Port=5432;Database=<slug>;…` | yes | `/health` |
| `hono` | 3000 | `DATABASE_URL=postgres://…/<slug>` | yes | `/health` |
| `react` | 3000 | `VITE_API_BASE_URL=http://localhost:<target.port>` | no | `/` |

### Per-deployable databases

The init script `db-init/00-create-databases.sql` creates one
database per backend deployable.  Each backend's connection string
points to its own DB.  This sidesteps a real bug observed on .NET:
EF Core's `EnsureCreated` is all-or-nothing per database, so two
backends sharing one DB silently leave the loser-of-the-race's
tables uncreated.  React deployables don't connect to a DB and don't
appear in the init script.

### `test e2e` lowering

A `test e2e "name" against <deployable> { … }` block lowers via
`src/system/e2e-render.ts` into typed fetch calls in
`<outdir>/e2e/<System>.e2e.test.ts`:

| DSL form | Lowered to |
| --- | --- |
| `api.<aggregate>.create({ … })` | `__post(\`${base}/<plural>\`, {…})` |
| `api.<aggregate>.getById(idExpr)` | `__get(\`${base}/<plural>/${idExpr}.id\`)` (`.id` auto-appended for known `let`-bindings) |
| `api.<aggregate>.<op>(idExpr, body?)` | `__post(\`${base}/<plural>/${idExpr}.id/<op_snake>\`, body ?? {})` |
| `api.<aggregate>.<find>(args)` | `__getQuery(\`${base}/<plural>/<find_snake>\`, args)` |

`expect <expr>` becomes `expect(<expr>).toBe(true)`;
`expectThrows <expr>` becomes
`expect(() => <expr>).toThrow()`.

---

## What the generators don't do

Out of scope for v1 (intentional):

- **Migrations**: deferred to the native tools (Drizzle Kit, EF Core
  migrations).  The dev compose uses `EnsureCreated` /
  `db:push`-style flow; production projects swap to migration-driven
  workflow via `.loomignore` (see [`tools.md`](tools.md)).
- **Authentication / authorization**: no opinion.  Add via
  `.loomignore` on `Program.cs` (.NET) or `http/index.ts` (Hono).
- **Pagination on `findAll`**: returns every row.  Adding pagination
  is a future syntax extension (`find all(skip: int, take: int)`).
- **Multi-target frontends**: a `react` deployable has exactly one
  `targets:`.  Hosting against several APIs is deferred.
- **Typeahead lookups for `Id<X>` form fields**: rendered as plain
  text inputs.  A future enhancement could resolve `Id<Customer>`
  to a `<Select>` populated from `useAllCustomers()`.
- **Server-side rendering**: client-only Vite.  Next.js variant
  would be a separate platform.
- **Generated CI / k8s manifests**: project-init concerns, not
  derived from the `.ddd` source.

These are all addressable as either generator extensions or
`.loomignore`-pinned customizations.
