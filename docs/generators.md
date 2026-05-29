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

To see one identical domain lowered onto every backend, pick the
**Storefront** trio from the playground dropdown — `storefront-system`
(Hono + React), `storefront-dotnet` (.NET + embedded SPA), and
`storefront-phoenix` (Elixir/Ash + LiveView). All three share the same
aggregate tree (`Order` → `OrderLine` + `Money`), `Wallet` aggregate,
and transactional `checkout` saga, so diffing their output is the
fastest way to read this matrix concretely.

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
| `X id[]` (reference collection) | Auto-derived many-to-many **join table** (composite PK enforces set semantics); save diff-syncs join rows, `.contains(param)` lowers to an `inArray` subquery against the join table. The join table also carries an `ordinal` column written on every `+=`, but the wire contract is unordered — see "What the generators don't do" below. | EF Core join entity + `DbSet<JoinEntity>` (composite PK + `Ordinal`); `GetByIdAsync` loads via the join entity, `SaveAsync` diff-syncs, `.contains(param)` lowers to `_db.<JoinDbSet>.Any(...)`. (Phoenix/Ash backend: `many_to_many ... through <JoinResource>` + a `calculate :<field>, {:array, :uuid}, expr(<rel>.id)`; `.contains` lowers to `exists(<rel>, id == ^arg(:<param>))`.) | `X id[]` appears in the wire shape as `string[]`; populated/displayed via the response, but no first-class editor yet |
| `derived` | Getter that calls into the expression | Computed property that calls into the expression | Read-only field on detail; included in the response Zod schema |
| `invariant` | Private `_assertInvariants()` called at the end of every mutator | Private `AssertInvariants()` called at the end of every mutator | (enforced server-side; surfaces as 400 in the UI) |
| `provenanced` property | `domain/provenance.ts` SDK + `recordTrace(...)` after each write; `ddd snapshot` captures rule snapshots to `.loom/snapshots/*.loomsnap.json` | (keyword parsed; no trace code emitted) | (n/a — wire shape unaffected) |
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
contained part nested, every derived value (except the reserved
`inspect` derived, which stays host-language-only — see below),
value objects as nested objects.  Decimals are JSON numbers;
datetimes are ISO strings.

**Aggregate stringification hooks**: when an aggregate declares
`derived inspect: string = ...` (auto-injected when omitted), each
backend emits a host-language debug-string hook that delegates to
the `inspect` value — `public override string ToString()` (.NET,
auto-invoked by `$"{x}"` / `Console.WriteLine`), `toString()` +
`[Symbol.for("nodejs.util.inspect.custom")]` (TS, auto-invoked by
`String(x)` / `${x}` / `console.log`), and a public
`def inspect(record)` module function (Phoenix, **invoked
explicitly** as `MyApp.Catalog.Customer.inspect(record)` — Ash 3.x
auto-derives the `Inspect` protocol for every resource module, so
the loom-emitted form lives at the module-function level to avoid a
`redefining module Inspect.<...>` collision under `mix compile
--warnings-as-errors`).  Honours `sensitive(...)` field tags by
substituting `<redacted>` for the value while keeping the field
name in the structural output.  VO-typed fields are inlined
structurally one level deep — `price: Money` shows as
`price: Money(amount: 99, currency: 'USD')` rather than the opaque
`price: [Money]` placeholder; further nesting (VO inside VO,
arrays, optionals) falls back to the placeholder so the expression
stays bounded and self-recursive VO shapes can't cycle.  A
`sensitive(...)` tag on the parent's VO-typed field redacts the
whole VO; per-field `sensitive(...)` inside the VO redacts only
that slot.  Never reached by `string(aggregate)` or implicit
`"x " + aggregate` — the user-facing form is `derived display:
string = ...` (opt-in), routed through the Loom expression layer
and the React Select picker.

**`db/repositories/<aggregate>-repository.ts`** — built by
`repository-builder.ts`:

- `findById(id)` — load root + every part collection in one
  transaction, hydrate aggregate
- `getById(id)` — same but throws `AggregateNotFoundError` on missing
- `save(aggregate)` — upsert root, diff-sync each contained collection
  (insert new + update existing + delete removed) **and each
  reference-collection join table** (delete removed pairs; upsert
  current pairs carrying their `ordinal` position so reorders persist)
  in a transaction, drain events via `dispatcher.dispatch`
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

Every `X id[]` reference-collection field on an aggregate also gets
its own join table, `snake(owner)_snake(field)` (e.g. `trainer_party`,
`trainer_caught`) — two FK columns (`<owner>_id` text not null,
`<target>_id` text not null), an `ordinal integer not null` carrying
the collection's position, a composite primary key `(owner_fk,
target_fk)`, and an index on the target FK so the reverse membership
subquery (`this.party.contains(pokemon)`) stays index-backed.  The
field is **not** persisted as a column on the owner table.

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

**`src/pages/<plural>/list.tsx`** — built by `body-walker.ts` +
`pages-emitter.ts` (the legacy `pages-builder.ts` archetype renderer
has been removed; bodies — scaffolded or hand-written — all route
through the walker now):

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
| `money` | `<TextInput inputMode="decimal">` | Precise-decimal field — value is a `Decimal` from `decimal.js`; number-mode inputs lose precision via `1e10` notation. |
| `string` / `guid` | `<TextInput>` | |
| `bool` | `<Switch>` | Manual `checked` / `onChange` since Mantine `<Switch>` accepts event-based onChange. |
| `datetime` | `<TextInput type="datetime-local">` | Native datetime input — Mantine's `<DateTimePicker>` is harder to drive from Playwright; users can swap via `.loomignore` for richer UX. |
| `enum` | `<Select allowDeselect={false}>` | Explicit `value` / `onChange` / `error` (Mantine Select calls onChange with `(value, option)`, not an event, so `getInputProps` can't be spread directly).  `allowDeselect={false}` keeps required fields from being cleared by a click on the already-selected option. |
| `valueobject` | `<Fieldset legend>` with one input per VO field | Sub-inputs use the `name.subField` form for nested binding. |
| `array<part>` | (omitted from the create form) | Parts are added via operations, not the create form. |

### `data-testid` map

The body-walker sprinkles a stable `data-testid` on every
interactive element so the page-objects-builder can write
selector-free test code. Walker-stdlib primitives accept an explicit
`testid:` named arg; the walker threads it through the rendered
component.

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

### Design pack selection

The file map above is for the default `design: "mantine"`.  Picking a
different pack swaps the rendered component library, the
`package.json` dep set, and the theme bootstrapping — the rest of the
project (routing, RQ hooks, page objects, smoke tests) is identical.

| Family | Path | Versions shipped | Component library | Latest (bareword resolves to) |
|---|---|---|---|---|
| `mantine` | `designs/mantine/` | v7, v9 | `@mantine/*` | `mantine@v9` |
| `shadcn` | `designs/shadcn/` | v3, v4 | Tailwind + Radix primitives | `shadcn@v4` |
| `mui` | `designs/mui/` | v5, v7 | `@mui/material` | `mui@v7` |
| `chakra` | `designs/chakra/` | v2, v3 | `@chakra-ui/react` | `chakra@v3` |
| `ashPhoenix` | `designs/ashPhoenix/` | v3 | HEEx components — Phoenix LiveView only | `ashPhoenix@v3` |

Pack selection per platform when `design:` is omitted:

| Platform | Default family |
|---|---|
| `react`, `static`, fullstack `dotnet` (with `ui:`) | `mantine` |
| `phoenixLiveView` | `ashPhoenix` (forced — only HEEx pack supported) |
| `hono`, backend-only `dotnet` | none (no UI mount) |

Picking a pack also locks in a **stack** (a coherent React + router +
Zod + Vite + TypeScript dep bundle).  Each pack version declares its
stack in its `pack.json`; the bundler reads that declaration and
emits the matching `package.json`.  See
[`design-packs.md`](design-packs.md) for the full pack authoring
surface, including the stack catalogue (v1/v2/v3) and the recipe for
adding a new pack version.

A bareword `design: "mantine"` resolves to the family's current default
version; pinning is via `family@version` (e.g. `design: "mui@v5"`).
The per-version folder under `designs/<family>/<vN>/` is what the
bundler actually loads.

---

## Phoenix LiveView fullstack (`platform: phoenixLiveView`)

`generate system` for deployables marked `platform: phoenixLiveView`.
Single project that both serves an Ash-derived API (when `serves:` is
populated) AND mounts a `ui:` rendered as Phoenix LiveView modules.
Owns its own Postgres database (`needsDb: true`).

### File map

For a fullstack `phoenixApp` with `contexts: [Sales]` + matching
`dataSources: [salesState]`, `serves: SalesApi`, `ui: SalesAdmin`:

```
phoenix_app/
├── mix.exs                                       # phoenix, phoenix_live_view, ash, ash_postgres, ash_phoenix
├── .formatter.exs
├── Dockerfile                                    # multi-stage hexpm/elixir → debian, mix release
├── .dockerignore
├── config/{config,dev,prod,runtime}.exs          # Phoenix + Ecto + Ash config
├── priv/repo/
│   ├── migrations/<ts>_create_<table>.exs        # one per aggregate, stable ordering, FK indexes
│   └── seeds.exs
├── rel/{env.sh.eex,overlays/bin/server}          # release scaffolding
├── lib/phoenix_app/
│   ├── application.ex                            # supervision tree: Repo, Endpoint, PubSub
│   ├── repo.ex                                   # Ecto.Repo
│   └── sales/                                    # one folder per BoundedContext
│       ├── customer.ex                           # Ash.Resource per aggregate
│       ├── order.ex
│       ├── order_line.ex                         # entity-part as embedded resource
│       ├── order_status.ex                       # enums as Ash.Type.Enum
│       ├── money.ex                              # value objects as Ash.Type.NewType / embedded
│       ├── events/order_confirmed.ex             # plain defstruct modules
│       ├── workflows/place_order.ex              # code-interface fns wrapping Ash.transaction
│       └── views/active_orders.ex                # Ash.Query.filter on read action
│   └── sales.ex                                  # use Ash.Domain — resource list + code interfaces
├── lib/phoenix_app_web.ex                        # __using__ macro
└── lib/phoenix_app_web/
    ├── endpoint.ex                               # Phoenix.Endpoint
    ├── router.ex                                 # `live "<route>", <Page>Live` per PageIR
    ├── components/
    │   ├── core_components.ex                    # <.input>, <.button>, <.modal>, <.simple_form>, <.table>
    │   ├── layouts.ex                            # use Phoenix.Component
    │   └── layouts/{root,app}.html.heex
    └── live/
        ├── customer_list_live.ex                 # one per scaffolded PageIR
        ├── customer_new_live.ex
        └── customer_detail_live.ex
```

### Per-aggregate detail

Aggregate IR maps onto Ash:

| IR | Ash construct |
|---|---|
| `aggregate X { … }` | `Ash.Resource` with `postgres { table "<plural>"; repo <App>.Repo }` |
| `field: T` | `attribute :<snake>, <ash-type>, allow_nil?: <bool>` |
| `contains lines: OrderLine[]` | `relationships do has_many :lines, <App>.<Ctx>.OrderLine end` |
| `derived total: Money = expr` | `calculations do calculate :total, Money, expr(<lowered>) end` |
| `invariant <pred> when <guard>` | `validations do validate <pred>, where: [<guard>] end` |
| `operation op(args) { body }` | `actions do update :<snake_op>, accept: […], change <body-lowered> end` |
| `valueobject Money { … }` | embedded `Ash.Resource` (composite) or `Ash.Type.NewType` (single-field) |
| `event LineAdded { … }` | plain `defstruct` module under `<Ctx>.Events.<Event>` |
| `repository finds: find byCustomer(...) where ...` | `read :by_customer do argument :customer_id, :uuid; filter expr(...) end` |
| `workflow placeOrder(...) { ... }` | code-interface module with `Ash.transaction(<App>.<Ctx>, fn -> with … end)` |
| `view ActiveOrders = Order where …` | thin module wrapping `Order |> Ash.Query.filter(…)` |
| `emit OrderConfirmed { … }` | `Phoenix.PubSub.broadcast(<App>.PubSub, "events", %Events.OrderConfirmed{…})` |

### Per-page detail

PageIR maps onto LiveView:

| IR | LiveView construct |
|---|---|
| `page X { route, body }` | `defmodule <App>Web.<X>Live do use <App>Web, :live_view end` at `lib/<app>_web/live/<x>_live.ex` |
| `state { step: int = 0 }` | `socket.assigns.step`; initialised in `mount/3` via `assign(socket, :step, 0)` |
| `state.step := 1` (in lambda) | `assign(socket, :step, 1)` inside generated `handle_event/3` |
| `match { p => v; else => fallback }` | `cond do p -> v; true -> fallback end` (or `<%= cond do … end %>` in HEEx) |
| `requires <pred>` (page) | guard in `handle_params/3` (v0 stub: bind only; full guard is a follow-up) |
| `navigate(<P>, {…})` | `push_navigate(socket, to: ~p"/route?…")` |
| Scaffolded body | `pack.render("page-list" \| "page-new" \| "page-detail", vm)` → HEEx inline in `render/1` |
| Pack-emitted Playwright page object | `e2e/pages/<x>.ts` — same testid-keyed shape as React; HEEx HTML is selector-compatible |

The framework-specific seams (state read/write, hook hoisting,
`match`, `navigate`, helper imports) live behind the `WalkerTarget`
interface in `src/generator/_walker/target.ts` — see
[page-metamodel.md §16](page-metamodel.md#16-liveview-lowering-platform-phoenixliveview)
for the full mapping table.

---

## System orchestration

`generate system` (in `src/system/index.ts`) runs each deployable
through its respective backend, scoped to its hosted contexts, and
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
| `dotnet` | 8080 | `ConnectionStrings__Default=Host=db;Port=5432;Database=<slug>;…` | yes | `/ready` |
| `hono` | 3000 | `DATABASE_URL=postgres://…/<slug>` | yes | `/ready` |
| `react` / `static` | 3000 | `VITE_API_BASE_URL=http://localhost:<target.port>` | no | `/` |
| `phoenixLiveView` | 4000 | `DATABASE_URL=ecto://…/<slug>`, `SECRET_KEY_BASE`, `PHX_HOST`, `PHX_SERVER=true`, `PORT=4000` | yes | `/health` |

The platform contract decides UI mount admissibility and DB ownership
via two `PlatformSurface` flags (`src/platform/surface.ts`):
`mountsUi` (true on `react`, `static`, `phoenixLiveView`) and
`needsDb` (true on `dotnet`, `hono`, `phoenixLiveView`).  The system
orchestrator consults these instead of hardcoding platform names, so
adding a new platform extends the registry + the two flags only.

### Per-deployable databases

The init script `db-init/00-create-databases.sql` creates one
database per backend deployable.  Each backend's connection string
points to its own DB.  This sidesteps a real bug observed on .NET:
EF Core's `EnsureCreated` is all-or-nothing per database, so two
backends sharing one DB silently leave the loser-of-the-race's
tables uncreated.  React deployables don't connect to a DB and don't
appear in the init script.

### Migrations

Schema changes flow through a platform-neutral **MigrationsIR**
([`src/ir/types/migrations-ir.ts`](../src/ir/types/migrations-ir.ts))
built by diffing the current source against a checked-in snapshot at
`.loom/snapshots/<Subdomain>.snapshot.json`.  The builder
([`src/system/migrations-builder.ts`](../src/system/migrations-builder.ts))
computes one `MigrationsIR` per `(subdomain, storage)` pair owned by a
deployable (`migrationsOwner` enrichment in
`src/ir/enrich/enrichments.ts`).  Backends only translate steps to
their syntax via the per-platform emitters listed below — they never
recompute the schema themselves.  Shared SQL rendering for the two
Postgres-backed emitters lives in
[`src/system/sql-pg.ts`](../src/system/sql-pg.ts).

| Backend | Emits | Applied by |
| --- | --- | --- |
| Phoenix | `priv/repo/migrations/<ts>_<name>.exs` (Ecto DSL) | `mix ash.migrate` at boot via the existing release config |
| Hono | `db/migrations/<version>_<name>.sql` + `db/migrations/meta/_journal.json` | Drizzle's runtime migrator: `await migrate(db, { migrationsFolder })` in `index.ts` reads the journal + .sql files, tracks state in `__drizzle_migrations`.  `npm run db:migrate` (drizzle-kit migrate) works out of band |
| .NET | `Migrations/<Version>_<Name>.cs` (`migrationBuilder.Sql(@"...")`) | `db.Database.Migrate()` in `Program.cs` after `builder.Build()`; no `ModelSnapshot` is emitted — Loom owns SQL generation, so `dotnet ef migrations add` is never run and the runtime migrator is happy without one |

Phoenix stays in Ecto DSL because its output is Elixir.  Hono and
.NET share `src/system/sql-pg.ts` for bit-identical Postgres DDL.

Initial regen of an output tree emits one "Initial" migration per
subdomain per backend.  Subsequent regens diff against the snapshot and
emit one new dated file per backend covering just the delta — adding
a property produces a single `ALTER TABLE … ADD COLUMN …` per
backend, with the snapshot's `lastVersion` bumped so the next run's
filename sorts after.

Regenerating against an unchanged tree is a no-op: the diff is empty
and the emitters skip.  Column renames are not detected (drop+add);
operators wanting a real rename use `.loomignore` to hand-edit the
emitted file or fold the rename into the next migration.

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

- **Authentication / authorization**: no opinion.  Add via
  `.loomignore` on `Program.cs` (.NET) or `http/index.ts` (Hono).
- **Pagination on `findAll`**: returns every row.  Adding pagination
  is a future syntax extension (`find all(skip: int, take: int)`).
- **Multi-target frontends**: a `react` deployable has exactly one
  `targets:`.  Hosting against several APIs is deferred.
- **Typeahead lookups for `X id` form fields**: rendered as plain
  text inputs.  A future enhancement could resolve `Customer id`
  to a `<Select>` populated from `useAllCustomers()`.
- **Ordering on `X id[]` collections**: the wire contract is
  unordered — a relational join table is naturally a set, and the
  three backends realise that differently (TS/Drizzle and .NET/EF
  happen to write a per-row `ordinal` and load `ORDER BY ordinal`;
  Phoenix/Ash leaves ordinal at the column default and returns rows
  in whatever order Postgres yields).  Treat `party[0]` as "some
  element of `party`," not "the first element of `party`."  When
  position is part of the domain (a battle slot, a draft pick
  number), model it as an explicit ordinal field on a separate child
  aggregate instead of relying on collection order — that's the
  honest spelling and aligns with set semantics across all backends.
- **Server-side rendering**: client-only Vite.  Next.js variant
  would be a separate platform.
- **Generated CI / k8s manifests**: project-init concerns, not
  derived from the `.ddd` source.

These are all addressable as either generator extensions or
`.loomignore`-pinned customizations.
