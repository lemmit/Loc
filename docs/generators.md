# Loom — Generator Reference

Per-platform reference for every file the generators emit and the
features they implement.  This document maps each DSL construct to its
output across the five backends and five frontends so you can answer questions like:

- "What does `aggregate Order` produce on .NET?"
- "Where does my `derived total: Money = …` end up in the React app?"
- "Does the Hono backend support per-DSL `find` with a `where` clause?"

For language syntax see [`language.md`](language.md); for architecture
see [`technical.md`](technical.md); for CLI / Docker / Playwright
workflow see [`tools.md`](tools.md).

To see one identical domain lowered onto every backend, pick the
**Storefront** trio from the playground dropdown — `storefront-system`
(Hono + React), `storefront-dotnet` (.NET + embedded SPA), and
`storefront-elixir` (Elixir/Phoenix LiveView). All three share the same
aggregate tree (`Order` → `OrderLine` + `Money`), `Wallet` aggregate,
and transactional `checkout` saga, so diffing their output is the
fastest way to read this matrix concretely.

---

## Cross-platform feature matrix

The persistence stack shown per column is the **default** adapter (Drizzle on
node, EF Core on .NET). Persistence is a selectable realization axis —
`platform: dotnet { persistence: dapper }`, `platform: node { persistence:
mikroorm }` — see the "Realization axes" section of [`platforms.md`](platforms.md).
The alternates (`dapper`, `mikroorm`) share the domain layer below and only
swap the repository/schema layer; both are now at full parity with their
default (M-T6.9) — see [`platforms.md`](platforms.md) → "Realization axes".

> **Scope note.** The construct-by-construct matrix below tracks the three
> reference platforms (TypeScript/Hono, .NET, React) for readability — it maps
> each DSL construct to its *emitted shape* in idiom. The other backends —
> **Python/FastAPI**, **Java/Spring Boot**, and **Elixir/Phoenix** — and the
> other frontends — **Vue**, **Svelte**, and **Angular** — consume the same
> `LoomModel` / `wireShape` IR contract and emit the analogous constructs in
> their own idiom. See [`platforms.md`](platforms.md) for the full registered
> set.

### Five-backend feature parity

Which of the five domain-logic backends **emits** each gated feature vs. **fails
fast** at validate. A cell is `✓` (emitted, build-gate-verified), `🚫` (gated —
the validator rejects the combination with the named `loom.*` diagnostic, a
reviewed decision), or `⚠` (partial — see the note). Elixir runs on plain
Ecto/Phoenix only (the Ash foundation was removed; `foundation: ash` is a
validation error). This grid is the **live** view, derived from the
validator gate sets in `src/ir/validate/checks/` and frozen against drift by
[`test/platform/backend-parity-gates.test.ts`](../test/platform/backend-parity-gates.test.ts)
(a backend can't be silently *ungated-and-unemitting* — the F1 class of bug).
The dated baseline write-up is
[`audits/backend-feature-parity-2026-06.md`](audits/backend-feature-parity-2026-06.md);
remaining gaps + sequencing are in
[`plans/backend-parity-plan.md`](old/plans/backend-parity-plan.md).

| Feature | node | dotnet | java | python | elixir | Gate set |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| Event-sourced storage `persistedAs(eventLog)` | ✓ | ✓ | ✓ | ✓ | ✓ | `EVENT_SOURCING_BACKENDS` |
| Event-sourced **workflow** (saga appliers) | ✓ | ✓ | ✓ | ✓ | 🚫 | `EVENT_SOURCING_WORKFLOW_BACKENDS` |
| TPH inheritance `inheritanceUsing(sharedTable)` | ✓ | ✓ | ✓ | ✓ | ✓ | `TPH_CAPABLE` |
| TPC inheritance `inheritanceUsing(ownTable)` | ✓ | ✓ | ✓ | ✓ | ✓ | (universal) |
| Discriminated unions / generic carriers (`paged`/`envelope`) | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_UNION_BACKENDS` |
| `when` canCommand gate + `can_<op>` query | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_WHEN_BACKENDS` |
| Exception-less returns (`op(): X or NotFound`) | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_RETURN_BACKENDS` |
| Capability `filter` — relational (non-principal) | ✓ | ✓ | ✓ | ✓ | ✓ | `LIMITED_FAMILIES` |
| Capability `filter` — principal (`currentUser`/tenancy) | ✓ | ✓ | ✓ | 🚫 | ✓ | system-checks.ts |
| Provenanced fields (runtime trace) | ✓ | ✓ | ✓ | ✓ | ✓ | `PROVENANCE_BACKENDS` |
| Per-operation `audited` | ✓ | ✓ | 🚫 | 🚫 | 🚫 | `AUDIT_OP_BACKENDS` |
| Audited **lifecycle** (`audited create`/`destroy`) | ✓ | 🚫 | 🚫 | 🚫 | 🚫 | `AUDIT_LIFECYCLE_BACKENDS` |
| Audit/context stamping (`with audit`) | ✓ | ✓ | ✓ | ✓ | ✓ | (universal) |

Open gaps (tracked in the plan): principal Python filters (W1b), per-op/
lifecycle `audited` beyond node/dotnet (W3), and event-sourced workflow
(saga applier) support on Elixir (W4).

| Construct | TypeScript (Hono + Drizzle) | .NET (ASP.NET + EF + Mediator) | React (Vite + RQ + Mantine) |
| --- | --- | --- | --- |
| `enum` | `pgEnum`, exported union type | C# enum + EF `HasConversion<string>` | Zod `z.enum([...])` |
| `valueobject` | Class with invariant ctor + accessors; flattened columns in Drizzle | `record` with invariant ctor; `OwnsOne` in EF | Zod object schema, nested `<Fieldset>` in forms |
| `event` | TypeScript discriminated union; pushed via `_events.push` | `record` implementing `IDomainEvent`; pushed via `_events.Add` | (events are domain-internal; not surfaced to the SPA) |
| `aggregate` | Class with private state, factory, ops, derived getters, `pullEvents()` | Sealed class with private state, factory, ops, derived getters, `PullEvents()` | List + Detail + New page; api hooks |
| `entity` part | Same as aggregate but with `_parentId` | Same as aggregate; mapped via `OwnsMany` | Sub-table on detail page, master-detail row testids |
| `abstract aggregate` + `extends` / `inheritanceUsing` | **TPC** (`ownTable`): standalone Drizzle table per concrete; a read-only `<Base>Repository.findAll()` union reader + `<Base>` discriminated-union type. **TPH** (`sharedTable`, default): one shared table + `kind` discriminator + nullable per-concrete columns; `<Base> id` refs + base reader supported. | **TPC**: `abstract class <Base>` carrying shared fields, concretes `: <Base>`, EF `Ignore<<Base>>()` (each concrete maps standalone); read-only `I<Base>Repository` / `<Base>Repository` → `IReadOnlyList<<Base>>`. **TPH** (`sharedTable`): one shared table via EF Core native `HasDiscriminator<string>("kind")`; the abstract base owns the shared `Id` and `DbSet<<Base>>`, concretes inherit it (own columns only); `<Base> id` refs + base reader supported. | Concrete subtypes carry the merged base fields in their wire shape; no base-specific page. |
| `persistedAs(eventLog)` + `apply(...)` (event sourcing) | Append-only `<agg>_events` stream table (`stream_id, version, type, data, occurred_at`); appliers render as a `_apply(ev)` fold + `_fromEvents(id, events)` rehydrator; `emit` records **and** folds; `create` builds an empty shell + runs its emit-only body (POST body = create params); repository folds the stream on load and appends pending events on save (fold-from-zero MVP). Both node persistences supported — **Drizzle** (default) and **MikroORM** (EntityManager event store + `<agg>_events` `EntitySchema`). | EF Core **and** Dapper supported — `<agg>_events` table (on the `DbContext` / raw Npgsql), C# `_Apply<Event>` methods + `_FromEvents` rehydrator + `_Apply` dispatch switch; EF-only, **not** a dedicated Marten backend (D-DOCUMENT-AXIS). The persistence-agnostic fold + CQRS create chain are reused across both. | (n/a — wire shape unchanged) |
| `contains` (collection) | Drizzle table with `parent_id` FK; auto-loaded in repo | EF owned-collection; auto-loaded by tracker | Sub-table on detail; not editable in the create form |
| `X id[]` (reference collection) | Auto-derived many-to-many **join table** (composite PK enforces set semantics); save diff-syncs join rows, `.contains(param)` lowers to an `inArray` subquery against the join table. The join table also carries an `ordinal` column written on every `+=`, but the wire contract is unordered — see "What the generators don't do" below. | EF Core join entity + `DbSet<JoinEntity>` (composite PK + `Ordinal`); `GetByIdAsync` loads via the join entity, `SaveAsync` diff-syncs, `.contains(param)` lowers to `_db.<JoinDbSet>.Any(...)`. (Phoenix/Ecto backend: a `many_to_many` association through the `<join>` table + the id-array wire shape projected from the loaded association, set on create/update via `put_assoc`; `.contains` lowers to an `EXISTS` subquery against the join table.) | `X id[]` appears in the wire shape as `string[]`; populated/displayed via the response, but no first-class editor yet |
| `derived` | Getter that calls into the expression | Computed property that calls into the expression | Read-only field on detail; included in the response Zod schema |
| `invariant` | Private `_assertInvariants()` called at the end of every mutator | Private `AssertInvariants()` called at the end of every mutator | (enforced server-side; surfaces as 400 in the UI) |
| `provenanced` property | `domain/provenance.ts` SDK + `recordTrace(...)` after each write; `ddd snapshot` captures rule snapshots to `.loom/snapshots/*.loomsnap.json` | `Domain/Common/ProvLineage.cs` SDK + inline lineage capture after each write; co-located `<field>_provenance` jsonb column; `provenance_records` flushed in the EF save transaction; current lineage exposed on `<Agg>Response`. **Elixir** emits the same shape — the `<App>.Provenance` SDK (process-dictionary trace buffer + `flush/1`), a co-located `<field>_provenance` jsonb column, inline capture at each named-op write site, and a `provenance_records` flush inside the save `Repo.transaction`. | (n/a — wire shape unaffected) |
| `function` | Private method on the aggregate / part class | Private expression-bodied member | (server-only) |
| `operation` | Public method (or private if marked) that enforces preconditions, mutates state, queues events, and re-asserts invariants | Same shape; visibility honoured | Mantine button on the detail page; opens a modal whose form binds to `<Op>Request`; submit calls `use<Op><Agg>()` |
| `precondition` | `if (!cond) throw new DomainError(<source>)` | `if (!cond) throw new DomainException(<source>)` | (server-side; HTTP 400 surfaces as a Mantine error notification) |
| `emit` | `_events.push({ type: "X", … })` | `_events.Add(new X(...))` | (server-side) |
| `repository` find | Method on `<Agg>Repository`; `where` clauses lower to Drizzle predicates (`lowerToDrizzle`) over the queryable subset, paramless finds fall back to convention-matching | Method on `I<Agg>Repository`; LINQ `.Where(x => …)` for both convention and `where` forms | `use<FindName><Agg>(query)` React Query hook + a list-page filter bar (one input per `where` param) that drives the hook, falling back to `useAll<Agg>()` when unfiltered |
| `criterion` (inline use-site) | Predicate body re-lowered + substituted at each `where` / invariant / precondition (same Drizzle predicate as a hand-written filter) | Same — inlined into the LINQ `.Where(...)` / guard | (server-side; not surfaced) |
| `criterion` reified by a `retrieval` or `find` `where` | Module-level predicate fn `<name>Criterion = (args) => <Drizzle predicate>`, called by `run<Name>` and the matching `find` (one fn, deduped across both) | `Criterion<T>` (`IsSatisfiedBy` + `ToExpression()`) fed into the retrieval's Ardalis `Specification<T>` bundle and a `find`'s `.Where(crit.ToExpression())` (EF); a parameterised SQL fragment on Dapper. (Phoenix/Ecto backend: a shared `<name>_criterion/1` query fragment (an Ecto `dynamic`) the read filters by — one fragment shared by retrieval + find.) | (n/a — wire shape unchanged) |
| `retrieval` (named query bundle) | `run<Name>(args, page?)` on `<Agg>Repository` — `where` + `.orderBy(...)` + `.limit/.offset` paging | `Run<Name>Async(args, page?, ct)` — `.WithSpecification(spec).ApplyPaging(page).ToListAsync(ct)` (EF) / parameterised SQL (Dapper). (Phoenix/Ecto: a context query function + `limit`/`offset` page.) | (n/a — backend-only) |
| Auto `findById` / `getById` | Yes — load root + parts in a transaction; `getById` throws on missing | Yes — `GetByIdAsync` returns `Order?`, `getById` is implicit via the controller raising 404 | `use<Agg>ById(id)` hook, used by the detail page |
| Auto `find all` | Yes — `GET /<plural>`, loads with master-detail | Yes — `GET /<plural>` via `GetAllQuery` + handler | `useAll<Agg>()` hook, used by the list page |
| `test "name" { … }` | Vitest at `domain/<aggregate>.test.ts` | xUnit at `Tests/<Plural>/<Aggregate>Tests.cs` | (n/a — backend-only) |
| `test e2e "name" against <backend> { … }` | Vitest at `<system>/e2e/<System>.e2e.test.ts` (typed fetch against the live HTTP) | (same file; targets the named .NET deployable) | (n/a — see UI variant below) |
| `test e2e "name" against <react-deployable> { … }` | (n/a — UI tests live in the react deployable) | (n/a) | Playwright spec at `<react-deployable>/e2e/<System>.ui.spec.ts`, routes through the auto-generated page objects |

---

## TypeScript backend (`platform: node`)

`generate ts` for legacy single-context sources; `generate system` for
deployables marked `platform: node`.

### File map

For a context with aggregates `Order` (containing parts) and `Product`:

```
<deployable>/
├── package.json                     # deps: hono, @hono/node-server, @hono/zod-openapi, zod, drizzle-orm, pg
├── tsconfig.json
├── index.ts                         # pg Pool → drizzle → createApp(db) → @hono/node-server.serve
├── scheduler.ts                     # timerSource jobs (when the deployable owns any) — see "Timer sources"
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

### Timer sources (`timerSource`)

A system-scope `timerSource { for: <Event>, cron: "…" | every: <dur> }`
(scheduling.md) fires a plain domain event on a wall-clock cadence; workflows
react through the existing `on`/`create … by` triggers. When a deployable owns a
timer (its subdomain is the for-event's `migrationsOwner`), the Hono backend
emits `scheduler.ts` and wires it at boot. **Phase 2** splits the two cadences by
where durability matters:

- **`cron:` timers → pg-boss** (a Postgres-backed durable job queue). pg-boss
  owns single-fire across replicas natively (no advisory lock), persists each
  run, and **retries a failed body with backoff** (`retryLimit: 3`,
  `retryBackoff: true`). The schedule (`boss.schedule`) and worker (`boss.work`)
  live in the app's own Postgres.
- **Missed-window catch-up.** pg-boss does *not* back-fill a cron boundary that
  elapsed while every replica was down (its `shouldSendIt` only sends when the
  last boundary is < 60s old). A self-owned `loom_timer_runs` watermark (created
  by the scheduler on boot, like pg-boss creates its own schema — *not* in the
  domain MigrationsIR) drives a **coalesce-once catch-up**: on the *first* boot
  it records a baseline without retro-firing (a fresh deploy must not replay
  history); on a later boot, if the previous boundary is > 60s old and later than
  the last recorded run, it replays that boundary **exactly once** (a 20-minute
  outage over four 5-minute boundaries fires one catch-up, not four).
- **`every:` (sub-minute) timers → in-process** `setInterval` + a
  transaction-scoped `pg_try_advisory_xact_lock` (single-fire) with a `running`
  no-overlap guard. Durability is meaningless for a high-frequency poll
  (resume-at-next-tick is correct) and pg-boss cron is minute-granularity.
- **Dispatch.** The tick event is constructed (id fields minted, `at` stamped)
  and dispatched through the same in-process dispatcher the sagas use, so an
  `on`/`create` reactor fires with no new machinery.
- **Observability.** `timer_fired` / `timer_skipped_overlap` /
  `timer_lock_contended` / `timer_emit_failed` / `timer_catchup` on the catalog.

**Delivery semantics (multi-pod).** Still **at-least-once**: pg-boss gives
single-fire per boundary and durable retry, but a clock-skewed peer or a
catch-up replay can re-deliver, so **tick reactors must be idempotent** (the
same contract event reactors already carry). Exactly-once-per-instant is not a
goal — at-least-once + idempotent reactors is the contract.

A deployable owning no timer emits no `scheduler.ts`, no `pg-boss` dep, and no
boot wiring — byte-identical to before.

**Phase-2 durable drivers (M-T4.1).** The advisory-lock path above is the
*in-process* tier — correct for `every:` (sub-minute) cadences but at-least-once.
`cron:` timers additionally get a **durable, store-coordinated** driver per
backend, so a boundary missed while every replica was down is replayed once on
recovery (missed-run catch-up) and fires exactly once across replicas
(single-fire), with retries. Each backend uses its ecosystem's Postgres-native
job store: **node → pg-boss**, **.NET → Hangfire**, **Java → JobRunr**,
**Python → procrastinate**, **Elixir → Oban**. The `every:` tier stays the
in-process interval loop + `pg_try_advisory_xact_lock` on every backend.

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
`String(x)` / `${x}` / `console.log`), a public
`def inspect(record)` module function (Phoenix, **invoked
explicitly** as `MyApp.Catalog.Customer.inspect(record)` — the
loom-emitted form lives at the module-function level to avoid an
`Inspect`-protocol collision under `mix compile
--warnings-as-errors`), a `__repr__` (Python, auto-invoked by
`repr(x)` / f-strings), and a `toString()` override (Java).  Honours `sensitive(...)` field tags by
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
- `<find>(...)` — one method per user-declared `find`; a `where`
  clause lowers to a Drizzle predicate (`lowerToDrizzle` in
  `repository-find-predicate.ts`) over the queryable subset
  (comparisons, `&&`/`||`, `!`, bare-boolean columns, value-object
  sub-columns, `currentUser.<field>`, enum values, and
  `<refColl>.contains(x)` join-table subqueries); a paramless find
  falls back to convention-matching its params to columns. The IR
  validator (`firstNonQueryableNode`) gates `where` clauses to exactly
  this subset, so lowering never silently drops a predicate.
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
├── <Namespace>.csproj               # net10.0, EF Core 10, Mediator source-gen, Swashbuckle, EF Tools
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
- `AddSwaggerGen` — spec at `/openapi.json` (aligned across backends)
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
│   │   ├── config.ts                # API_BASE_URL = /api (relative, same-origin); window.__LOOM_API_BASE__ or VITE_API_BASE_URL override
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

#### Stores (`store Cart { state … action … }`)

A top-level `ui` member `store Cart { state { … } action … }` (a shared
client-side container, sibling to page/component — named-actions-and-stores.md
§3) emits one **Zustand** module per store at `src/stores/<snake>.ts`:
`export const useCart = create<CartState>((set) => ({ …fields, …actions }))`.
The action bodies reuse the **same** `:=`/`+=` statement lowering a page action
does, targeting Zustand's `set((s) => ({ … }))` instead of a `useState` setter
(`zustand` is added to the generated `package.json`). At a use site a
page/component references the store by **dotted name** — `Cart.lines` (a
`store-field` read) and `Cart.clear()` (a `store-action` call). Each consuming
shell derives its store dependency from those resolved refs (derive-don't-
stamp), imports `useCart`, and hoists one selector binding per used member
(`const lines = useCart((s) => s.lines)`); the body / action handlers reference
the bare local. v1 stores are **in-memory only** — the `persist:`/`sync:`
lifetime ladder has no grammar surface yet (those words collide with common
identifiers), though the IR + a `loom.store-lifetime-unsupported` gate carry it
for the persistence follow-up. Validator gates: a store action can't call a
view-scoped effect (`navigate`/`toast` — `loom.store-action-view-effect`), a
page can't write store state inline (`loom.store-state-inline-write`), and a
store→store call cycle is rejected (`loom.store-action-cycle`).

**Phoenix LiveView** also ships stores (the `loom.store-on-liveview-unsupported`
gate was lifted): a `store Cart { … }` emits a dedicated
`lib/<app>_web/stores/cart.ex` module — a `defstruct` carrying the state fields
(with their defaults) plus one public pure function per action
(`def clear(%__MODULE__{} = state), do: %{state | …}`). Each LiveView page that
touches the store seeds one per-process assign in `mount/3`
(`|> assign(:cart, %Cart{})` + an `alias <App>Web.Stores.Cart`); a `Cart.count`
read renders `@cart.count` (template) / `socket.assigns.cart.count` (handler),
and a `Cart.clear()` call renders `|> update(:cart, &Cart.clear/1)` (0 args) or
`|> update(:cart, fn c -> Cart.add(c, sku) end)` (with args). Because each store
is its own per-page assign, a store action calling a **different** store's
action is gated (`loom.store-cross-store-on-liveview-unsupported`) — same-store
action→action composition is fine (a pure in-module call).

Vue/Svelte/Angular store-module emit is a fan-out follow-up and throws loudly
until ported.

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
| `vue` | `vuetify` |
| `svelte` | `shadcnSvelte` |
| `angular` | `angularMaterial` |
| `phoenixLiveView` | `ashPhoenix` (forced — only HEEx pack supported) |
| `node`, backend-only `dotnet` | none (no UI mount) |

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

## Svelte frontend (`platform: svelte`)

The second frontend generator (`src/generator/svelte/`).  Emits a
Svelte 5 / SvelteKit **static SPA** per svelte deployable —
`@sveltejs/adapter-static` with `ssr = false` and an `index.html`
fallback, served by `vite preview` in docker exactly like the React
SPA.  Pages flow through the **same shared markup walker** the React
generator uses (`src/generator/_walker/walker-core.ts`) with
`svelteTarget` + a svelte-format design pack (`shadcnSvelte` default,
`flowbite`); see D-SVELTE-FRONTEND in [`decisions.md`](decisions.md).

| Concern | Emission |
|---|---|
| Routing | SvelteKit file routing — `/orders/:id` → `src/routes/(app)/orders/[id]/+page.svelte`; route groups `(app)` (chrome) / `(bare)` (`layout: none`) carry the layout selectors.  A named `layout <Name>` lowers to its own route group `(<name>)/+layout.svelte`, rendering the header/sidebar/footer slots around `{@render children()}`; pages selecting it via `layout: <Name>` route into that group (`src/generator/svelte/layouts-emitter.ts`). |
| Data | `@tanstack/svelte-query` v6 factories with the React hook names (`useAllCustomers`, …) — `createQuery(() => opts)` returns a runes-reactive object with the `.data`/`.isPending`/`.mutate` surface.  Zod schemas are byte-identical with the react modules (shared `src/generator/_frontend/zod-schemas.ts`). |
| State | `let x = $state<T>(init)`; walker `:=` writes lower to plain assignments; page `title:` becomes a `$effect`.  Money page-state imports `decimal.js` so `Decimal` initial values compile (matches the react fix). |
| Forms | Hand-rolled runes + zod helper (`src/lib/forms.svelte.ts`): `createForm(schema, defaults)` → `values` (deep-reactive bind targets), `errors` (dotted-path map), `submit`, `applyServerErrors` (RFC 7807 422 decode).  Field templates bind `form.values.<path>`. |
| Operation modals | Page-scope `{#snippet <op>OpModal(form)}` blocks after the markup — one component per `.svelte` file means module scope lands in the template; `primitive-modal` renders `{@render <op>OpModal(<op>Form)}`. |
| Realtime | `realtime` channels emit a `RealtimeHandlers.svelte` that subscribes via a `$effect` to `src/lib/api/realtime.ts` (shared transport contract `src/generator/_frontend/realtime.ts`), surfacing a `realtime-toast` on events — parity with the react realtime client. |
| Extern hatch | `extern function` → a typed signature stub `src/lib/extern/<name>.signature.ts` re-exported through `$lib/<name>`.  `extern component` → a forwarding `<Name>.svelte` wrapper rendering `<Impl {...props} />` against a typed `<Name>.props.ts` (slots typed as `Snippet`). |
| e2e | Same testid-keyed Playwright surface as react: page objects from the shared `_frontend` builders (api imports root at `src/lib/api`), smoke spec, fixtures, config.  `test e2e … against <svelte deployable>` lowers to a Playwright ui spec, gated at runtime by `generated-svelte-e2e.yml` (`vite preview` + the spec). |
| Embedding | Every backend host can embed the SvelteKit SPA (`framework: svelte` on the ui binding).  dotnet/java fullstack hosts mount it under `ClientApp/` (Dockerfile copies `build/` → wwwroot); phoenix mounts it under `assets/` served at `/app`, with `kit.paths.base = "/app"` so asset URLs resolve (the fleet-wide base-path fix also covers react/vue). |
| CI | `generated-svelte-build.yml` — per `{example × pack}`: `npm install` + `svelte-check --fail-on-warnings` + `vite build` (`npm run test:svelte-build` locally); `generated-svelte-e2e.yml` adds the runtime preview + Playwright gate. |

## Vue frontend (`platform: vue`)

The structural mirror of the React frontend, driven by the SAME shared
markup walker (`src/generator/_walker/`) through `vueTarget` and the
SAME `_frontend/` api/workflows module builders (only the
TanStack Query import specifier differs).  Design packs: `vuetify`
(default) and `shadcnVue` (reka-ui + Tailwind 4, source-copy).  See
[D-VUE-FRONTEND](decisions.md) and `docs/old/plans/vue-frontend-plan.md`.

### File map (deltas vs the React project)

```
web_app/
├── package.json            # vue, vue-router, @tanstack/vue-query, zod (+ vuetify/@mdi or
│                           # reka-ui/tailwindcss/cva/clsx/tailwind-merge/lucide-vue-next)
├── vite.config.ts          # @vitejs/plugin-vue (+ @tailwindcss/vite and the @ alias on shadcnVue)
├── src/
│   ├── main.ts             # createApp + router + VueQueryPlugin (+ vuetify instance / globals.css)
│   ├── App.vue             # app chrome + <router-view/> + onErrorCaptured boundary
│   ├── router.ts           # createRouter(createWebHistory) route table + NotFound catch-all
│   ├── theme.ts            # createVuetify tokens (vuetify) / `export {}` stub (shadcnVue — CSS vars)
│   ├── lib/form.ts         # useLoomForm — vee-validate useForm over the shared zod schema (local toTypedSchema) + per-field error map
│   ├── lib/format.ts       # formatting FUNCTIONS (the React packs' format components, fn-style)
│   ├── lib/toast.ts        # channels only: reactive pushToast() queue the app-shell host renders
│   ├── api/realtime.ts     # channels only: EventSource client (broadcast wire → subscribeRealtime)
│   ├── components/RealtimeHandlers.vue  # channels only: renderless on-mount switch → pushToast
│   ├── components/<Name>.vue # user components — typed defineProps SFC, walked <template>
│   ├── lib/<extern>.ts + lib/extern/<extern>.signature.ts  # extern frontend fns (shim + signature)
│   ├── components/ui/      # shadcnVue only: source-copied SFCs + index.ts barrel
│   ├── layouts/<Name>.vue + layouts/DefaultLayout.vue  # named layouts only: chrome moves out of App.vue, router nests
│   └── pages/**/*.vue      # SFC pages — <script setup lang="ts"> + walked <template>
└── e2e/                    # identical harness/page objects to React (testid/DOM only)
```

### Key behaviours

- vue-query handles hoist as `reactive(useX(...))` so nested refs
  (`.data`, `.isPending`) read uniformly in template + script.
- Forms: `useLoomForm(schema, drafts)` — vee-validate's `useForm` over
  the shared zod schema (adapted by a locally-emitted `toTypedSchema`,
  since `@vee-validate/zod`'s peer pins zod 3 while the stack is zod 4);
  create forms, operation `v-dialog`s (the pack-owned `op-dialog`
  template), and workflow run-forms are wired.
- Operation/find hook args, navigate, match-in-child-position, and
  state reads/writes all flow through the `WalkerTarget` seams —
  zero forked walker code.
- Backend hosts (dotnet / java / phoenix) embed a `framework: vue` ui
  exactly like a React one (`vue` ∈ STATIC_BUNDLE_FRAMEWORKS).
- User components (`component <Name>(p: T)`) emit `src/components/<Name>.vue`
  (typed `defineProps`, walked body); an `extern` component emits a typed
  `<Name>.props.ts` + a `<Name>.ts` re-export shim (call sites import
  `components/<Name>` without the `.vue`).  Extern frontend functions emit
  the shared signature + conformance shim (`tsc` is the fail-fast).
- Channels (`on <channel>.<Event>`) emit the SSE client, a renderless
  `RealtimeHandlers.vue`, and a `pushToast()` queue the app-shell renders
  (a `<v-alert>` stack on vuetify, an `Alert` stack on shadcnVue).
- Find-filter live-refetch: a parameterised `find` hook takes a
  `MaybeRefOrGetter<Query>` (queryKey tracks `computed(toValue(query))`)
  and the list page passes `() => ({ … })`, so a bound filter input
  re-fetches (React re-renders, so its hook stays a plain object param).
- A `component` body can host a `CreateForm`/`WorkflowForm` (the
  `useLoomForm` + mutation wiring transplants from the page shell);
  operation forms (Action dialogs) inside a component also work — the
  op-dialog host + per-op LoomForm transplant from the page shell, with
  the instance `idExpr` read off the aggregate-typed prop (`order.id` →
  `props.order.id`).
- Named layouts (`layout <Name> { header / main / footer }`) restructure
  into nested vue-router routes: the layout SFC's inner `<router-view />`
  is the `main` outlet, `layout: none` mounts top-level, and the default
  chrome moves to `src/layouts/DefaultLayout.vue` with App.vue a thin
  host.  Default-only uis keep the flat chrome-in-App.vue shape.
- A `slot` param on an extern component maps to a typed `<Name>Slots`
  contract (for `defineSlots`), kept out of `<Name>Props` (Vue slots are
  `<slot>` template content, not props).
- No known gaps — full parity with the React page DSL, with compile-time
  (`LOOM_VUE_BUILD`) and runtime (`LOOM_VUE_E2E`) CI coverage.

## Angular frontend (`platform: angular`)

The fourth frontend generator (`src/generator/angular/`).  Emits a **standalone
Angular 22 SPA** per angular deployable — `bootstrapApplication` + `appConfig`
(no NgModules), built with the `@angular/build:application` builder and served
the same `vite preview`-style way as the other SPAs in docker.  Pages flow
through the **same shared markup walker** the React / Vue / Svelte generators use
(`src/generator/_walker/walker-core.ts`) with `angularTarget` + the
`angularMaterial` design pack.  See `docs/old/plans/angular-frontend-plan.md`.

Angular renders **idiomatic Angular**, not a transliterated React app: standalone
`@Component`s, signals/`computed` for view state, typed Reactive Forms, and —
for server state — **TanStack Angular Query** (`injectQuery` / `injectMutation`),
the senior-Angular-idiomatic caching layer, so reads share a query cache (dedup +
caching) and mutations invalidate exactly the keys the generator knows they touch.
Several walker seams fork the shared (React-shaped) emission rather than reuse it —
each is opt-in (only `angularTarget` implements it), so the other three frontends
stay byte-identical (`pipeline-layering` + the full suite gate this).

| Concern | Emission |
|---|---|
| Pages | Each `page` becomes a standalone `@Component` under `src/app/pages/<slug>.component.ts` with an inline `template`.  The route table (`src/app/app.routes.ts`) maps `/orders/:id` → the component via `provideRouter`; a wildcard `**` mounts `NotFound`.  The app shell (`app.component.ts`) derives the sidebar from the page set. |
| State / derived | `state { x: T = init }` → `readonly x = signal(init)` (read `x()`, write `x.set(…)`); the `:=` walker write lowers to `.set(…)`.  `derived n = expr` → `readonly n = computed(() => …)` (signal reads `this.`-prefixed in the class-field initialiser). |
| Events | Angular `(click)` binds a **statement**, not a function value (and forbids arrow functions) — the `renderEventHandler` seam inlines the lambda body (`(click)='count.set(count() + 1)'`). `Button(to:)` routes through `renderNavigateExpr` → `router.navigateByUrl(<to>)`. |
| Data | **TanStack Angular Query**: per aggregate `src/api/<agg>.ts` ships an `@Injectable` `HttpClient` service (the raw requests) + factories the page-shell hoists as component fields — `useAll<Agg>s` / `use<Agg>ById` return `injectQuery` results (cached, keyed `["<tag>"]` / `["<one>", id]`; byId is `enabled: !!id` so it stays idle until the route param resolves), and `useCreate<Agg>` / `use<Op><Agg>` return `injectMutation` results whose `onSuccess` calls `queryClient.invalidateQueries` on exactly the affected keys.  Signals are *called* (`handle.data()` / `handle.isPending()`); the `renderQueryDataAccess` seam defaults a collection read to `[]` (`(handle.data() ?? [])`).  The `QueryClient` is provided once in `app.config.ts` (`provideTanStackQuery`).  byId reads bind the route param from the `ActivatedRoute` snapshot. |
| Forms | Idiomatic **typed Reactive Forms** (the `renderCreateForm` / `renderOperationForm` / `renderWorkflowForm` seams), not react-hook-form: `CreateForm(of:)`, standalone `OperationForm(of:,op:)` / `OperationForm(<inst>.<op>)`, and `WorkflowForm(runs:)` each emit a `[formGroup]` / `(ngSubmit)` shell over a `FormGroup` of `nonNullable` `FormControl`s (per-field Material inputs from `src/generator/angular/form-fields.ts`), submit → `mutateAsync(getRawValue())` (op/workflow wrap as `{ id, input }`) → navigate (the create mutation invalidates the list, so it refetches).  `DestroyForm(of:)` → a confirm-delete `mat-raised-button` (`renderDestroyForm` seam) wired to `useDelete<Agg>`.  So the pack ships **no** `field-input-*` / `form-of` templates — the Angular required-primitive surface is display/layout/input only. |
| Operations | `Action(inst.op)` → a "dumb template" button (`renderAction` seam): `(click)="on<Op><Agg>()"` + `[disabled]="<localVar>.isPending()"`, with an `async on<Op><Agg>()` method that reads the record id inside (a `?.id` guard + early return), `await`s `<localVar>.mutateAsync({ id, input })`, then runs the optional `then:` effect (`this.`-prefixed).  `Modal { OperationForm(…) }` → a **signal-toggled** inline Reactive Form (`renderModal` seam): the trigger captures the record id into an `<op>Id` signal and flips `<op>Open`; an `@if (<op>Open())` block holds the op `FormGroup`; submit reads the id signal, `mutateAsync({ id, input })`s, then closes. |
| Page stub | Only a page with **no body** (route/title-only) renders a title stub; every form / action / read primitive now renders a real body.  The `pageNeedsDeferredFeatures` predicate is defence-in-depth (the shared react-hook-form `formOfs` / `actionMutations` sinks are never populated on Angular — each primitive forks via its `render<X>Form` seam), and `validateRequired` keeps any unsupported construct a compile error rather than a codegen crash. |
| CI | `generated-angular-build.yml` — per `{case × pack}` (`minimal` / `scaffold` / `showcase` × `angularMaterial`): `npm install` + `ng build` (the Angular CLI typechecks + bundles in one step; `npm run test:angular-build` locally). |

## Feliz frontend (`platform: feliz`)

The fifth frontend generator (`src/generator/feliz/`).  Emits a **Feliz
(F#/Fable/Elmish) SPA** per feliz deployable, built with `dotnet fable` + vite
(not the vite-only static pipeline of the JS frontends).  Pages flow through the
**same shared markup walker** the other frontends use
(`src/generator/_walker/walker-core.ts`) via `feliz-target.ts` — but Feliz is
the one frontend whose embedded language is **F#, not JS**, so instead of
consuming the wire shape only, it supplies its own F# expression leaves
(`src/generator/feliz/fs-expr.ts`, the `FS_LEAVES` table) through the shared
`emitExpr` dispatcher.  See `docs/old/plans/feliz-frontend-build.md`.

| Concern | Emission |
|---|---|
| Architecture | **Elmish MVU** — a `Model` record, a `Msg` union, and an `update` fn per page (`update-emit.ts`); page-level `state {}` fields become `Model` fields and `:=` writes lower to `Msg` dispatch + an `update` arm. |
| Expressions | Rendered to F# via `FS_LEAVES` (`fs-expr.ts`) — `==`→`=`, `null`→`None`, list `[ a; b ]`, anonymous records `{| n = v |}` — the F# sibling of the JS-family `jsExprLeaves`. |
| Data / wire | Decodes the JSON wire shape into F# records (`wire.ts`); a paged `.all` decodes the envelope's `items` to a `'T list` (so the Model holds a list, page 1). |
| Design | The **daisyUI** pack — real Tailwind + daisyUI build (`styles.css` + `tailwind.config.js`), a `design: "<theme>"` theme picker over the built-in daisyUI theme set (default `corporate`), and a persistent app-shell `navbar` for multi-page routed UIs. |
| Forms | Controlled string form state on the Model + per-field blur validation with inline errors (#1944); required/whole-form submit gate. |
| CI | `generated-feliz-build.yml` — real `dotnet fable` + `vite build` + a Playwright smoke against the built bundle. |

Known frontier (M-T1.16): modal open-state, typed in-flight form state, enum DU wire decoder, per-page sub-models, multi-param routes; and the interactive-`Table` sort/pagination/filter seams degrade (Elmish needs Set-Msg/update plumbing) rather than emit.

## Flutter mobile (`platform: flutter`, `framework: flutter`)

The **mobile axis** — a new development branch outside the web-target matrix, not
a sixth web SPA.  `src/generator/flutter/` emits a **Dart/Flutter (Material 3)
app on Riverpod** per flutter deployable.  Like Feliz it is **self-hosting** (own
SDK build, not the vite static pipeline) so it hosts only its own
`framework: flutter` UI.

**One Dart source, three build surfaces.**  The emitted project's `Makefile`
builds **web** (`make web` → `flutter build web`, the surface compose serves via
the emitted nginx `Dockerfile`), **Android** (`make apk`), and **iOS**
(`make ipa`) from the same UI — "web-vs-native is a build target, not a modelling
mode."  The native `android/`/`ios/` folders are SDK-owned boilerplate and are
**not** vendored; `make prepare` (`flutter create --platforms=…`) materialises
them on demand.  Compose serves only the web surface (mobile artifacts aren't a
compose concern), and **CI gates only the web build** — see the CI row.  Structurally Flutter is a **Feliz clone**: a
non-JSX, function-call-tree target (`Column(children: [ … ])`) that rides the
**same shared markup walker** (`walker-core.ts`) through `flutter-target.ts` +
a Dart expression-leaf table, and — like Feliz — supplies its own `interChildSeparator`
seam because Dart list literals are comma-separated.

| Concern | Emission |
|---|---|
| Architecture | **Riverpod** — each page with `state {}`/actions projects an immutable `<Page>State` + a `<Page>Notifier extends Notifier<State>` (`riverpod-emit.ts`); named actions become notifier methods (`state = state.copyWith(…)`), and the page is a `ConsumerWidget` binding `ref.watch`/`ref.read`.  App root wraps `ProviderScope`. |
| Wire models | `lib/models.dart` — a Dart class + `fromJson`/`toJson` per aggregate/VO/event; discriminated payload unions emit a **Dart-3 `sealed class`** + tag-switching factory (exhaustive `switch`, the analogue of Loom's `match`). |
| Data / reads | `QueryView` resolves to a Riverpod `FutureProvider` (`reads-emit.ts`) that `GET`s the collection (unwrapping the paged `{items}` envelope) or a `FutureProvider.family` for byId; the widget renders `AsyncValue.when(loading/error/data)` with `empty:` folded in.  `For` lowers to `.map(...).toList()`. |
| Forms | `CreateForm`/`OperationForm`/`DestroyForm` render self-contained `StatefulWidget`s in `lib/forms.dart` (`forms-emit.ts`) — typed field widgets by wire type (`TextFormField`/`SwitchListTile`/`DropdownButtonFormField`/`showDatePicker`, value objects flattened), a foreign-key `X id` becomes a runtime-loaded dropdown (`initState` GETs `/<target-collection>`, options labelled by the target's derived `display`), `GlobalKey<FormState>` validation, `http` POST/PUT/DELETE via `apiUri`, pop-on-success. |
| Design | The procedural **flutterMaterial** pack (`src/generator/flutter/pack.ts`, Feliz-`pack.ts` model — emits Material widget trees, no `.hbs`). |
| CI | `generated-flutter-build.yml` — real `flutter analyze` + `flutter build web` on an interactive showcase (state + reads + forms + routing). **Web only** — no gate compiles the native `apk`/`ipa` surface, so native-only regressions aren't caught per-PR (tracked in `docs/new-plan/T1-…` / the Flutter parity proposal). |

`Modal { trigger: Button(…), OperationForm(of:, op:) }` renders as a trigger `ElevatedButton` whose `onPressed` opens an `AlertDialog` wrapping the op-form widget (`showDialog`); the op-form pops its own route on success, dismissing the dialog.  `WorkflowForm(runs: <wf>)` renders as a `StatefulWidget` (like `CreateForm`) that POSTs the workflow params to the command route `/workflows/<wf>`.

`match await <api>.<Agg>.<op>()` (async effect) projects an **async Riverpod Notifier method** (`Future<void> <action>(String id) async`): it POSTs the instance op to `/<coll>/$id/<op>`, reifies a non-2xx ProblemDetails back into the error variant (clobbering the wire `type` tag), then a Dart-3 `switch` over `result['type']` reifies each arm via `fromJson` and runs the arm body as a `state.copyWith` write.  The page-shell binds the action as an id-capturing closure (`final <a> = () => notifier.<a>(id);`) so the button's bare `<a>()` call is unchanged (`riverpod-emit.ts`).

A scalar array form field (`tags: string[]` / `scores: int[]`) renders as a repeatable add/remove row list (one `TextEditingController` per row, managed in state; numeric arrays parse each row on submit).

A user `component Foo(params) { body }` emits a Dart widget into `lib/components.dart` (`component-emit.ts`); an invocation `Foo(a: x)` renders as a widget constructor call and the page imports `../components.dart`.  A **stateless** component (value params, no own state) becomes a `StatelessWidget` (one final field per param, the walked body as `build`).  A **stateful** component (`state {}` + named `action`s) becomes a `StatefulWidget` whose `State` holds an immutable `<Comp>Model` (the same data-class shape a Riverpod page projects), built in `initState`, exposes each param as a `widget.<param>` getter, and wraps each action body in `setState` — reusing the page path's `renderNotifierStmt` (a write is `state = state.copyWith(field: value)`).  State is **per-instance** (each `Foo(...)` its own `State`), which a shared Riverpod provider would get wrong.  Only USED, no-read components are emitted; an `extern` component, a `derived` binding, an async-effect (`match await`) action, or a read-bearing / slot / children component falls back to the diagnostic comment.

An array-of-value-object form field (`lines: LineItem[]`) renders each row as a group of `TextFormField`s over the VO's scalar sub-fields (a `List<List<TextEditingController>>` in state), submitting a `{sub: value, …}` map per row — when every sub-field is text/numeric (a bool/enum/datetime/nested sub-field defers the whole array).

Known frontier: VO-array fields with non-scalar sub-fields, and the remaining user-component variants (extern / slot / children / derived / read-bearing / async-effect actions), are deferred (fall back to a diagnostic comment — never broken Dart).  Inline `:=` state writes in render-tree lambdas are rejected upstream (`loom.effect-in-lambda`); named-action writes emit through the Riverpod Notifier — a nested target (`draft.address.zip := v`) folds into an immutable `copyWith` chain (`state.draft.copyWith(address: state.draft.address.copyWith(zip: v))`), so every wire model carries a `copyWith`.  (End-to-end record-typed page state additionally needs the `VO.create({…})` state initializer, a separate universal gap — see `docs/old/proposals/nested-state-writes-copywith-frontends.md`.)  See `docs/old/plans/flutter-mobile-implementation.md`.

## Phoenix LiveView fullstack (`platform: elixir`)

`generate system` for deployables marked `platform: elixir`.
Single project that both serves a context-derived API (when `serves:` is
populated) AND mounts a `ui:` rendered as Phoenix LiveView modules.
Owns its own Postgres database (`needsDb: true`). Plain Ecto/Phoenix —
the Ash foundation was removed (and with it the `foundation:` axis, which had
collapsed to a single value everywhere; a would-be `foundation:` clause no
longer parses).

### File map

For a fullstack `phoenixApp` with `contexts: [Sales]` + matching
`dataSources: [salesState]`, `serves: SalesApi`, `ui: SalesAdmin`:

```
phoenix_app/
├── mix.exs                                       # phoenix, phoenix_live_view, ecto, ecto_sql, postgrex
├── .formatter.exs
├── Dockerfile                                    # multi-stage hexpm/elixir → debian, mix release
├── .dockerignore
├── config/{config,dev,prod,runtime}.exs          # Phoenix + Ecto config
├── priv/repo/
│   ├── migrations/<ts>_create_<table>.exs        # one per aggregate, stable ordering, FK indexes
│   └── seeds.exs
├── rel/{env.sh.eex,overlays/bin/server}          # release scaffolding
├── lib/phoenix_app/
│   ├── application.ex                            # supervision tree: Repo, Endpoint, PubSub
│   ├── repo.ex                                   # Ecto.Repo
│   ├── request_context.ex                        # ambient exec-context carrier (Plug → Logger.metadata: correlation_id/scope_id/actor_id) — see architecture/request-context.md
│   └── sales/                                    # one folder per BoundedContext
│       ├── customer.ex                           # Ecto.Schema per aggregate
│       ├── order.ex
│       ├── order_line.ex                         # entity-part as embedded_schema
│       ├── order_status.ex                       # enums as Ecto.Enum
│       ├── money.ex                              # value objects as embedded_schema / custom Ecto.Type
│       ├── events/order_confirmed.ex             # plain defstruct modules
│       ├── workflows/place_order.ex              # context fns wrapping Repo.transaction
│       ├── dispatcher.ex                         # in-process event router (when a channel carries a subscribed event)
│       ├── workflows/order_fulfillment_state.ex  # saga-state Ecto.Schema (correlation-keyed)
│       ├── workflows/order_fulfillment/start_order_placed.ex   # event-create starter handle/1
│       └── workflows/order_fulfillment/on_shipment_requested.ex # on(...) reactor handle/1
│   └── sales.ex                                  # context module — schema list + public functions
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

Aggregate IR maps onto Ecto/Phoenix:

| IR | Ecto/Phoenix construct |
|---|---|
| `aggregate X { … }` | `Ecto.Schema` (`schema "<plural>" do … end`) + a `base_changeset/2`; persisted via `<App>.Repo` |
| `field: T` | `field :<snake>, <ecto-type>` + `validate_required` for non-optional |
| `contains lines: OrderLine[]` | `has_many :lines, <App>.<Ctx>.OrderLine` (relational) or `embeds_many :lines, …` (embedded) |
| `derived total: Money = expr` | a `def total(record)` function over the struct (`<lowered>`) |
| `invariant <pred> when <guard>` | a `validate_change` / conditional validator in `base_changeset` |
| `operation op(args) { body }` | a context function `def <snake_op>(record, params)` (precondition + `put_change` + `Repo.update`) |
| `valueobject Money { … }` | embedded `embedded_schema` (composite) or a custom `Ecto.Type` (single-field) |
| `event LineAdded { … }` | plain `defstruct` module under `<Ctx>.Events.<Event>` |
| `repository finds: find byCustomer(...) where ...` | a context query function `def by_customer(customer_id) = Repo.all(from … where: …)` |
| `workflow placeOrder(...) { ... }` | a context function wrapping `Repo.transaction(fn -> with … end)` |
| `emit OrderConfirmed { … }` | `Phoenix.PubSub.broadcast(<App>.PubSub, "events", %Events.OrderConfirmed{…})`; inside an in-process dispatch handler, `emit` re-enters `<Ctx>.Dispatcher.dispatch(%Events.OrderConfirmed{…})` so choreography chains run. |
| `on(e: Event)` reactor / event-triggered `create(e: Event) by …` (channel-carried) | one `<Ctx>.Workflows.<Wf>.On<Event>` / `.Start<Event>` module with `handle(event)`, routed by a per-context `<Ctx>.Dispatcher` that pattern-matches each event struct. Correlation persists through a `<Wf>State` `Ecto.Schema` keyed by the correlation field (`create` loads-or-allocates, `on` routes-or-drops + logs `event_unrouted`). An event-triggered-only workflow emits no `run/2` / HTTP route / UI form page. See [`workflow.md`](workflow.md) §Triggers and [`channels.md`](old/proposals/channels.md). |
| `abstract aggregate Party` + `extends` (TPC) | base emits no schema; each concrete is a standalone `Ecto.Schema` on its own table; the context module gains `list_parties/0` (the union of the concrete `list_<concrete>/0` reads). |
| `abstract aggregate Party` + `inheritanceUsing(sharedTable)` (TPH) | the concretes share one table: each concrete `Ecto.Schema` declares `schema "<base_plural>"`, a `:kind` string field defaulted to its own name, and every read self-filters on `where: c.kind == "<Concrete>"` so it reads/writes only its rows. The base owns no schema; the context module gains the same polymorphic `list_parties/0` union reader. See [`phoenix-tph-emission.md`](old/proposals/phoenix-tph-emission.md). |
| `persistedAs(eventLog)` + `apply(...)` (event sourcing) | **Supported** (`src/generator/elixir/vanilla/eventsourced-emit.ts`): an append-only `<agg>_events` stream + `apply` fold + rehydrator, the elixir sibling of the node/.NET/python/java event stores. |
| `shape(document)` persistence | **Supported (CRUD + finds/ops — DEBT-07; Route A)** — `src/generator/elixir/vanilla/document-emit.ts`: the whole aggregate persists as one jsonb blob in an `(id, data, version)` table, where `data` is a **typed `embeds_one :data, <Agg>.Data` embed** cast via `cast_embed` (the same `validate_required` / invariant validators the relational `base_changeset` runs); reads merge `data` back over the id. **Custom finds** filter in memory (`Repo.all |> Enum.filter`), **named operations** run their body, pure **`function`s** compile, and **returning ops** (`: A or B`) emit the tagged tuple — all in **struct mode** over the loaded `row.data` struct (Route A slices 1–2 deleted the old string-keyed `docMap` fork), incl. value-object-subfield reads. The residual (audited/provenanced ops, collection mutation, derived / dereferenced-entity / collection-method reads, paged/union finds) stays gated (`loom.vanilla-document-unsupported`). `shape(embedded)` (DEBT-32, `src/generator/elixir/vanilla/schema-emit.ts`): each entity part is an Ecto `embedded_schema` module the root `embeds_many`s (value objects fold to `:map`), stored inline in the parent's jsonb column — a containment-mutating op (`lines += Line{…}`) appends the struct + `put_embed`s; `contains` on a *relational*-shape aggregate stays gated (`loom.vanilla-containment-unsupported`). |
| `test "…" { … }` | **ExUnit** → `test/<ctx>/<agg>_test.exs` (`use ExUnit.Case, async: true`) + a once-per-project `test/test_helper.exs`. (`src/generator/elixir/vanilla/tests-emit.ts`) ports the full Loom idiom onto a **pure domain core** emitted on the aggregate module (`domain-core-emit.ts`): `def create(attrs) = base_changeset \|> Ecto.Changeset.apply_action(:insert)` and `def <op>(record, params)` = precondition + in-memory mutation — both Repo-free. So `Agg.create({…})` → `{:ok, p} = Agg.create(%{…})`, `expect(create({bad})).toThrow()` → `assert {:error, _} = …`, `o.op(x)` → `o = Agg.op(o, %{…})`, precondition `toThrow` → `assert_raise`, field reads → `assert ==` (money/decimal via `Decimal`). Verified green under `mix test` with no DB. A **value-object construction invariant** (`expect(Money{…}).toThrow()`) lowers to the VO's validating constructor — `assert {:error, _} = Money.new(%{…})` (F5; `valueobject-emit.ts` emits `<VO>.new/1`, and the aggregate `base_changeset` runs it via `validate_vo` so the invariant is enforced at the real create/update path, not just in tests). A `config/test.exs` is emitted so `mix test` can load (never copied into the prod image). See [`docs/audits/test-parity-generated-backends.md`](audits/test-parity-generated-backends.md). |

### Per-page detail

PageIR maps onto LiveView:

| IR | LiveView construct |
|---|---|
| `page X { route, body }` | `defmodule <App>Web.<X>Live do use <App>Web, :live_view end` at `lib/<app>_web/live/<x>_live.ex` |
| `state { step: int = 0 }` | `socket.assigns.step`; initialised in `mount/3` via `assign(socket, :step, 0)` |
| `state.step := 1` (in lambda) | `assign(socket, :step, 1)` inside generated `handle_event/3` |
| `match { p => v; else => fallback }` | `cond do p -> v; true -> fallback end` (or `<%= cond do … end %>` in HEEx) |
| `requires <pred>` (page) | full `handle_params/3` guard — when the predicate fails it `put_flash(:error, "forbidden")` + `push_navigate`s to `/` (the read-side UI analogue of an operation's `requires`; `liveview-emit.ts`) |
| `navigate(<P>, {…})` | `push_navigate(socket, to: ~p"/route?…")` |
| `on <channel>.<Event>(e) { toast(…) refetch(Agg) }` (ui-level realtime, channels.md Part I) | **native** — no SSE client. `mount/3` `if connected?(socket), do: Phoenix.PubSub.subscribe(<App>.PubSub, "events")` (the same topic every domain `emit` broadcasts on); one `handle_info(%<App>.<Ctx>.Events.<Event>{} = e, socket)` clause per subscribed event type → `toast(<expr>)` becomes `put_flash(:info, …)`, `refetch(Agg)` re-runs the page's `list_<agg>s` / `get_<agg>` load (no-op when the page doesn't display it), plus a `handle_info(_msg, socket)` catch-all. The reactor/saga path uses direct `Dispatcher.dispatch/1` calls (never this PubSub topic), so it is untouched. A ui with no `on` handlers emits byte-identical output (`liveview-emit.ts` + `realtime-liveview.ts`). |
| Scaffolded body | `pack.render("page-list" \| "page-new" \| "page-detail", vm)` → HEEx inline in `render/1` |
| Pack-emitted Playwright page object | `e2e/pages/<x>.ts` — same testid-keyed shape as React; HEEx HTML is selector-compatible |

The framework-specific seams (state read/write, hook hoisting,
`match`, `navigate`, helper imports) live behind the `WalkerTarget`
interface in `src/generator/_walker/target.ts` — see
[page-metamodel.md §16](page-metamodel.md#16-liveview-lowering-platform-phoenixliveview)
for the full mapping table.

---

## Java backend (`platform: java`)

Spring Boot 4.1 / Spring Data JPA (Hibernate) / Postgres, built with
Gradle (Kotlin DSL, Boot plugin + BOM import, Java 25 toolchain; no
wrapper jar is committed — the generator emits text only, and the
Dockerfile/CI/dev environments provide Gradle ≥ 9.1 — required for the
Java 25 toolchain — or run `gradle wrapper` once).  Emission
lives in `src/generator/java/`; the surface is `src/platform/java.ts`
(`java@v1`).  Per-aggregate placement routes through the layout adapter
(`byFeature` default — package-by-feature; `byLayer` — package-by-layer),
which owns BOTH the package and the file path.

Per deployable it emits:

| Piece | Files |
|---|---|
| Project shell | `build.gradle.kts` + `settings.gradle.kts` (Boot plugin; jMolecules, springdoc, Flyway when migrations exist), `Application.java`, `application.yml` (datasource via `SPRING_DATASOURCE_*` env), multi-stage Gradle `Dockerfile` |
| Domain | typed-id records (`@Embeddable`, `newId()`), enums (DSL-cased constants — the wire), VO records running invariants in the compact constructor, event records implementing a `DomainEvent` marker (jMolecules-annotated), aggregate/part classes with package-private fields + record-style accessors, `create(...)` factory, `pullEvents()`, positional part `_create` factories |
| Persistence | JPA annotations mirroring the shared `MigrationsIR` schema (`@EmbeddedId` typed ids, flattened-VO `@AttributeOverride`s, unidirectional `@OneToMany` containments with `nullable = false` join columns, `@ElementCollection` join tables for `X id[]` + value collections, `@MappedSuperclass` TPC bases); repository triple — domain port (`save`/`findById`/`getById`/`findAll`/`delete` + declared finds), Spring Data interface with `@Query` JPQL finds, `@Repository` impl mapping misses to 404 |
| Migrations | `MigrationsIR` → Flyway `db/migration/V<ts>.<n>__*.sql` via the shared Postgres-SQL renderer |
| API | `@RestController` per aggregate (`POST /` 201 `{id}`+Location, `GET /{id}`, `GET /`, `POST /{id}/<op_snake>` 204, `GET /<find_snake>`, `DELETE /{id}`), DTO records in `wireShape` order (money/datetime as strings), wire validators from the shared invariant classifier → 422 RFC 7807 with `errors[]`, `@RestControllerAdvice` (400/403/404/422/500 problem+json), springdoc `/openapi.json` brought to cross-backend parity by an `OpenApiContractCustomizer` (named `<Agg>ListResponse` array wrappers, RFC 7807 error responses, named enum components, empty request bodies for param-less ops, per-component `required` sets, `Workflow` operationId suffixes) |
| Auth | `auth: required` + `user {}` → typed `User` record, `UserVerifier` boundary + accept-all dev stub, 401 filter, ThreadLocal accessor; `currentUser` threads into ops as a trailing parameter |
| Workflows | `POST /workflows/<snake>` via a per-context `@Service` (loops over `Repo.run(...)` retrievals incl. the call-site `page:` tuple, workflow-level `emit` logging the `domain_event` envelope) |
| Retrievals / criteria | reified criteria → `<Agg>Criteria` `Specification<T>` factories (java consumes `CriterionIR` directly — the first backend to); `run<Name>` port methods: an exact-criterion-ref retrieval rides `JpaSpecificationExecutor.findAll(spec, Sort)`, composed `where`s fall back to `@Query` JPQL with `order by`; paged runs via the `OffsetLimitPageRequest` Pageable |
| Paged finds | `find x(): T paged` → `Paged<T>` envelope over Spring Data `Pageable` (1-based, `page=1&pageSize=20` defaults) |
| Exception-less returns | `operation f(): X or NotFound` → sealed domain union + variant records, Jackson-polymorphic `<U>Response` wire DTO (`type` tag), controller switch: error variants → RFC-7807 `ProblemDetail` at their mapped status, success → 200 |
| Inheritance | TPC via `@MappedSuperclass`; TPH (`sharedTable`) via JPA `SINGLE_TABLE` — the base owns the shared table + `@DiscriminatorColumn("kind")`, concretes carry `@DiscriminatorValue` and share the base `<Base>Id` |
| Single containments | hidden owning `_parent` `@OneToOne` on the part (JPA has no unidirectional one-to-one with the FK on the part table) + inverse `mappedBy` with cascade/orphanRemoval on the root |
| Seeding | `seed` blocks → `<Ctx>SeedRunner` `ApplicationRunner`: domain rows through `create(...)` + the port save, raw rows as schema-qualified INSERTs, ship-once `__loom_seed` marker (`default` always, others via `LOOM_SEED`) |
| Capability filters | non-principal predicates → Hibernate `@SQLRestriction` (static SQL on every SELECT) on relational + `shape(embedded)` roots, in-app `findAll().stream()` for `shape(document)`; **principal** (tenancy) predicates → SpEL-principal JPQL clause AND-ed into the scoped `findAll`/`findById` overrides + finds/retrievals |
| Fullstack (`ui:`) | controllers move under `/api`, `SpaWebConfig` serves the SPA bundle (`UI_DIR`, index.html fallback), React project under `ClientApp/`, node stage in the Dockerfile; the auth filter guards `/api/*` only |
| Extern ops | per-op handler interface + throwing dev-stub `@Component`; service runs `check<Op>` → handler → invariants → save |
| Tests | `test "…"` → JUnit 5 classes under `src/test/java` |
| Observability | always-on catalog envelope as flat JSON on stdout (`server_starting` … `server_drained`, request bracket) |

Expression rendering is the `JAVA_TARGET` leaf table over the shared
`ExprTarget` dispatcher: BigDecimal method arithmetic with `compareTo`
comparisons, `Objects.equals` reference equality, `Instant` ordering via
`isBefore`/`isAfter`, find-anywhere regex via `Pattern…find()`, Streams
collection ops with type-directed `sum` reduction.

**Not yet implemented — every gap fails fast at validate time** (never a
silent downgrade): the reserved `axon` event-store adapter and `jooq`
persistence adapter (both `stubAdapter` — the default JPA persistence
*does* emit `persistedAs(eventLog)`), `hosts:` UI
hosting (`loom.java-fullstack-unsupported` — the `ui:` embedded-SPA
mount is implemented), resource-op clients, a **principal-referencing
capability filter on a non-relational aggregate**
(`loom.context-filter-unsupported` — each half ships alone; only the
actor + jsonb intersection is deferred), and provenance/audited (gated —
no runtime emitted; the node and .NET backends do implement these).  See
`docs/old/plans/java-backend-implementation.md` for the execution record.

**Value-object read-model fields ARE implemented.** A VO-typed
workflow-instance field or projection row field emits
its `<Vo>Response` record co-located in the consuming package
(`application.workflows` for instance/projection reads), the read-model analogue of an
aggregate response's nested VO records.  Only an *entity* (containment
part) read-model field stays gated
(`loom.java-workflow-instance-field-unsupported` /
`loom.java-projection-field-unsupported`) — a defensive backstop, since a
part type never resolves in workflow / projection scope.

Discriminated unions (payload fields / operation returns; union *finds* take
the untagged optional-style path — see `payloads.md`), `shape(document)` /
`shape(embedded)` persistence, event-sourced (`persistedAs(eventLog)`)
JPA streams, and non-principal capability filters on those non-relational
shapes are all **implemented** (java is in `SUPPORTED_UNION_BACKENDS`
and `EVENT_SOURCING_BACKENDS`; `PLATFORM_SAVING_SHAPES.java` carries all
three shapes).

---

## Python backend (`platform: python`)

FastAPI / SQLAlchemy 2 (typed declarative, async) / asyncpg / Postgres,
managed by **uv** (Python 3.12) and held to `ruff check` + `mypy
--strict` + `pytest` by the `LOOM_PYTHON_BUILD` gate.  Emission lives in
`src/generator/python/`; the surface is `src/platform/python.ts`
(`python@v1`; `python` is the only spelling — the `fastapi` platform alias
was retired the way `phoenix`/`hono` were).  Async end-to-end: `async def`
handlers over a per-request
`AsyncSession` — repositories `flush()`, the session dependency commits
once after the handler returns, so multi-save workflows are atomic by
construction.

Per deployable it emits:

| Piece | Files |
|---|---|
| Project shell | `pyproject.toml` (uv, pinned deps, ruff/mypy/pytest config), `app/main.py` (lifespan: verifier/extern asserts → migrations → seeds; CORS; `/health` + `/ready`), `app/settings.py`, `app/db/engine.py`, `python:3.12-slim + uv` Dockerfile |
| Domain | `NewType`-branded str ids, `StrEnum`s, VO classes with invariant ctors, frozen-dataclass events + dispatcher protocol, aggregate/part classes (private state, `@property` accessors, `create` factory, `pull_events()`) |
| Persistence | `app/db/schema.py` SQLAlchemy models (`Mapped[...]`, dataSource-routed `__table_args__` schema, `Uuid(as_uuid=False)` ids, flattened VO columns, join tables), per-aggregate repositories (`find_by_id`/`get_by_id`/`all`/declared finds/`save` diff-sync/`to_wire` from `wireShape`), `where` clauses lowered to SQLAlchemy predicates incl. correlated-EXISTS `contains` |
| Migrations | `MigrationsIR` → `migrations/*.sql` via the shared Postgres-SQL renderer + `app/db/migrate.py`, a `__loom_migrations`-tracked boot-time runner (also `python -m app.db.migrate`) |
| API | APIRouter per aggregate (`POST /` 201 `{id}`, `GET /`, `GET /{id}`, `POST /{id}/<op_snake>` 204, `GET /<find_snake>`, `DELETE /{id}` with 409), Pydantic wire DTOs in `wireShape` order, named `<Agg>ListResponse` array components, paged carriers, discriminated-union operation returns (union finds are untagged, optional-style), RFC 7807 handlers (+ §3.2 `errors[]` on 422), the shared per-route error matrix re-keyed to `application/problem+json` by an `install_openapi` post-processor |
| Inheritance / ES | TPC + TPH (`kind`-scoped shared table, base readers), `persistedAs(eventLog)` append-only stream + applier folds |
| Sagas | `app/dispatch.py` in-process dispatcher when a channel routes a subscribed event — `create(e) by …` load-or-allocates the persisted correlation row, `on(e) by …` routes or drops + logs `event_unrouted`; handler emits re-enter |
| Auth | `auth: required` + `user {}` → `app/auth/` (frozen `User` dataclass, verifier registry, middleware with the cross-backend bypass list) + a dev-stub verifier registered in `main.py`; `current_user` threads into ops/finds/workflows as a trailing parameter |
| Seeds / extern | `app/db/seed.py` (`__loom_seed` ship-once marker, LOOM_SEED gating, schema-qualified raw INSERTs); `app/domain/<agg>_handlers.py` extern registries (TypedDict requests, dev-stubs, boot verify) with routes running load → `check_<op>` → handler → `assert_invariants` → save |
| Fullstack | `ui:` embeds the React SPA (dotnet parity): routers under `/api/*`, ClientApp/ generation, wwwroot FileResponse fallback, multi-stage Dockerfile |
| Tests | `test "…"` → pytest under `tests/` (synthetic admin actor threads into gated ops) |
| Observability | `app/obs/` — flat-JSON catalog envelope (`ts`/`level`/`event`/`request_id`) on stdout, lifecycle bracket, request bracket middleware with `x-request-id` correlation, fault warns in the problem handlers |

Expression rendering is the `PY_TARGET` leaf table over the shared
`ExprTarget` dispatcher: native `Decimal` money arithmetic,
comprehension-shaped collection ops, `re.search` regex, snake_case
member folding.

Conformance: a `pythonApi` deployable ships in `examples/showcase.ddd`
and the e2e OpenAPI cross-check compares it pairwise against Hono /
.NET / Phoenix / Java (all five backends are diffed — strict in
`conformance-parity.yml`).

Resource verb clients (`objectStore` → boto3, `queue` → aio-pika,
`api` → httpx, `mailer` → aiosmtplib) are emitted under
`app/resources/<sourceType>.py`; workflow / saga `<resource>.<verb>(...)`
calls import + await them. (Cross-backend the mailer client is
`nodemailer` / `MailKit` / `Swoosh` / Jakarta Mail — see
[`resources.md`](resources.md) for the full kind × backend matrix.)

**Not yet implemented** (fails fast / follow-ups): durable-channel
outbox tier, `--trace` domain instrumentation, and provenance/audited
(gated — no runtime emitted; the node and .NET backends do implement
these).  `shape(document)` / `shape(embedded)` persistence (all three
shapes are in `PLATFORM_SAVING_SHAPES.python`) and `when` can-queries
(python is in `SUPPORTED_WHEN_BACKENDS`) are **implemented**.

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
| `node` | 3000 | `DATABASE_URL=postgres://…/<slug>` | yes | `/ready` |
| `react` / `static` (also `vue`, `svelte`) | 3000 | `VITE_API_BASE_URL=…/api` (build-time base override; the bundle defaults to a relative `/api`) + `VITE_API_PROXY_TARGET=http://<backend-svc>:<port>` | no | `/` |
| `phoenixLiveView` | 4000 | `DATABASE_URL=ecto://…/<slug>`, `SECRET_KEY_BASE`, `PHX_HOST`, `PHX_SERVER=true`, `PORT=4000` | yes | `/health` |

**Frontend same-origin in compose.** A vite-served frontend's built bundle
fetches `/api` **relative**, and its image runs `vite preview`. So compose
injects `VITE_API_PROXY_TARGET` (→ the target backend's compose **service**,
e.g. `http://api:3000`, not `localhost`) and the generated `vite.config.ts`
proxies `/api` to it on **both** `server` (dev) and `preview` (the compose
runtime). Result: one origin, no CORS, no separate API host — the compose twin
of the k8s same-origin Ingress. (Local `vite dev` falls back to the baked
`http://localhost:<port>` target.)

The platform contract decides UI mount admissibility and DB ownership
via two `PlatformSurface` flags (`src/platform/surface.ts`):
`mountsUi` (true on `react`, `static`, `phoenixLiveView`) and
`needsDb` (true on `dotnet`, `node`, `phoenixLiveView`).  The system
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
[`src/generator/sql-pg.ts`](../src/generator/sql-pg.ts).

| Backend | Emits | Applied by |
| --- | --- | --- |
| Phoenix | `priv/repo/migrations/<ts>_<name>.exs` (Ecto DSL) | `mix ecto.migrate` at boot via the existing release config |
| Hono | `db/migrations/<version>_<name>.sql` + `db/migrations/meta/_journal.json` | Drizzle's runtime migrator: `await migrate(db, { migrationsFolder })` in `index.ts` reads the journal + .sql files, tracks state in `__drizzle_migrations`.  `npm run db:migrate` (drizzle-kit migrate) works out of band |
| .NET | `Migrations/<Version>_<Name>.cs` (`migrationBuilder.Sql(@"...")`) | `db.Database.Migrate()` in `Program.cs` after `builder.Build()`; no `ModelSnapshot` is emitted — Loom owns SQL generation, so `dotnet ef migrations add` is never run and the runtime migrator is happy without one |

Phoenix stays in Ecto DSL because its output is Elixir.  Hono and
.NET share `src/generator/sql-pg.ts` for bit-identical Postgres DDL.

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

`expect(<x>).<matcher>(…)` lowers to the native matcher;
`expect(<call>).toThrow()` becomes
`expect(() => <call>).toThrow()`.

---

## What the generators don't do

Out of scope for v1 (intentional):

- **Production identity provider**: `auth: required` + a `user {}`
  block emit a *first-class* auth surface on every backend — a typed
  principal, a request boundary (401), `requires` 403 gates on
  operations / pages, `currentUser`/tenancy capability filters,
  and an OIDC turnkey verifier — but the default verifier is an
  accept-all **dev stub**.  Wiring a real IdP (or replacing the stub)
  is the deployment's job; see [`auth.md`](auth.md).  (Fine-grained RBAC
  beyond predicate `requires` is not modelled.)
- **Pagination on `findAll`**: returns every row.  Adding pagination
  is a future syntax extension (`find all(skip: int, take: int)`).
- **Multi-target frontends**: a `react` deployable has exactly one
  `targets:`.  Hosting against several APIs is deferred.
- **Typeahead lookups for `X id` form fields**: rendered as plain
  text inputs.  A future enhancement could resolve `Customer id`
  to a `<Select>` populated from `useAllCustomers()`.
- **Ordering on `X id[]` collections**: the wire contract is
  unordered — a relational join table is naturally a set, and the five
  backends realise that differently.  TS/Drizzle and .NET/EF happen to
  write a per-row `ordinal` and load `ORDER BY ordinal`.  Phoenix/Ecto,
  Java/JPA, and Python/SQLAlchemy treat `Target id[]` as a set with no
  ordinal column at all (Java: `@ElementCollection` join table, no
  `@OrderColumn`, `jpa-annotations.ts:158`; Python: the ref-collection
  join table carries no ordinal, `repository-builder.ts:60`), returning
  rows in whatever order Postgres yields.  Either way the contract is
  unordered — treat `party[0]` as "some
  element of `party`," not "the first element of `party`."  When
  position is part of the domain (a battle slot, a draft pick
  number), model it as an explicit ordinal field on a separate child
  aggregate instead of relying on collection order — that's the
  honest spelling and aligns with set semantics across all backends.
- **Server-side rendering**: client-only Vite.  Next.js variant
  would be a separate platform.
- **Generated CI pipelines**: project-init concerns, not derived from
  the `.ddd` source.  (k8s manifests are no longer on this list — the
  opt-in `generate system --k8s` flag emits a Helm chart + raw manifests;
  see [`kubernetes.md`](kubernetes.md).)

These are all addressable as either generator extensions or
`.loomignore`-pinned customizations.
