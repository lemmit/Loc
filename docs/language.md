# Loom — Language Reference

Loom is a high-descriptive DSL for **Domain-Driven Design**.  A `.ddd`
source describes one or more bounded contexts, each containing the
familiar DDD primitives — aggregates, value objects, enums, events,
repositories, projections, workflows, policies — with strongly-typed
invariants, operations, and a small expression language.

This document defines the language formally.  For the architectural
view (AST → IR → emitters) see [`technical.md`](technical.md); for CLI
and tooling see [`tools.md`](tools.md).

---

## Lexical structure

- **Comments**: `// line` and `/* block */` (hidden terminals — never reach
  the AST).
- **Identifiers**: `ID` is `/[_a-zA-Z][\w_]*/`.  Case-sensitive, ASCII-word.
  One lexical gotcha: the `TRACE_ID` terminal (`US-001`, `AC-12` — used by
  `requirement` / `testCase` / `verifies`) is tried before `ID`, so an
  **unspaced** `x-1` lexes as a trace id, not a subtraction.  House style
  spaces binary operators (`x - 1`), which sidesteps it.
- **String literals**: `STRING` is `/"(\\.|[^"\\])*"/` — double-quoted,
  standard backslash escapes.  Langium strips the delimiters (`"USD"`
  arrives as the 3-char `USD`); emitters re-quote.
- **Interpolated strings**: backtick-delimited `` `Order {n}` `` with `{expr}`
  holes and an optional ICU format suffix per hole — see
  [String interpolation](#string-interpolation).
- **Number literals**: `INT` (`/[0-9]+/`) and `DECIMAL` (`/[0-9]+\.[0-9]+/`).
  `money("10.50")` is the precise-decimal literal (a `STRING` argument).
- **Duration literal** `DURATION` (`/[0-9]+(ms|s|m|h|d)/`, e.g. `15s`) is
  accepted **only** as a `timerSource`'s `every:` cadence.  In expressions a
  span is built by the `days(n)` / `hours(n)` / `minutes(n)` constructors
  instead — see [Temporal arithmetic](#temporal-arithmetic).
- **Whitespace** and comments are ignored between tokens.
- **Member separators**: `aggregate` / `entity` / `valueobject` members are
  **newline-separated** — a comma is rejected (`Expecting token of type '}'
  but found ','`).  `event` fields, `enum` values, and every clause-style
  block (`deployable`, `resource`, `storage`, `ui: X { … }` bindings, …)
  accept commas **or** newlines.  When in doubt, **use newlines**: they are
  accepted everywhere.

#### Keywords — hard vs. soft

Loom keeps the *hard*-reserved set to declaration heads, type names and
expression keywords (`context`, `aggregate`, `entity`, `event`, `repository`,
`find`, `where`, `derived`, `invariant`, `unique`, `function`, `operation`,
`create`, `destroy`, `apply`, `precondition`, `requires`, `emit`, `let`,
`return`, `for`, `in`, `if`, `match`, `else`, `expect`, `test`, `when`,
`extends`, `abstract`, `private`, `extern`, `audited`, `mask`, `unless`,
`true`, `false`, `null`, `this`, `now`, `id`, `Self`, and the primitive
type names `int long decimal money string bool datetime guid json File`,
plus the system-level heads — `system`, `subdomain`, `deployable`,
`storage`, `api`, `ui`, `component`, `theme`, `user`,
`auth`, `policy`, `projection`, `workflow`, `capability`, `seed`,
`criterion`, `domainService`, `commandHandler`, `queryHandler`, `channel`,
`channelSource`, `timerSource`, `requirement`, `solution`, `testCase`,
`layout`, `import`).  None of these can name a **field**; a handful
(`api`, `ui`, `component`, `policy`, `id`, `contains`, `permissions`,
`create`, `destroy`) are nonetheless admitted as parameter / argument
names or bare expression refs by the per-rule extras described next.

Everything else that acts as a keyword *somewhere* is a **soft keyword** —
reserved only where its own rule begins, and admitted as an ordinary
identifier elsewhere.  The grammar factors the shared set into one rule,
`CommonSoftKeywords` (`state`, `kind`, `payload`, `command`, `query`,
`response`, `error`, `paged`, `envelope`, `option`, `or`, `money`,
`parent`, `title`, `body`, `sort`, `select`, `join`, `group`, `filter`,
`stamp`, `store`, `schema`, `ttl`, `use`, `write`, `migration`, `tenancy`,
`immutable` / `managed` / `token` / `internal` / `secret`, …), composed
into every *value* position: a field name (`Property.name`), a parameter /
argument / clause name (`LooseName`), a bare reference in an expression
(`NameRefIdent`), an assignment target (`LValueIdent`) and a member name
after `.`.  Each of those rules adds a few position-specific extras — for
example `await` is admissible as a **field** / parameter name but not as a
bare expression ref (it is the `match await` marker there); `api`, `route`,
`component`, `menu`, `section`, `link`, `targets`, `framework`, `design`,
`ui`, `page` … are admissible as parameter / argument names and expression
refs but — apart from `page` — **not** as field names (`aggregate Order {
route: string }` is a parse error); `of`, `allow`, `deep`, `global`,
`policy`, `persistence` are soft only as parameter / clause names.  The source of
truth is the rule set in `src/language/ddd.langium`, pinned by
`test/language/keyword-identifier-completeness.test.ts`.

```ddd
context Orders {
  aggregate Order {
    state: string        // page-DSL `state {}` keyword — soft as a field
    kind: string         // resource clause key — soft as a field
    payload: string      // context-level `payload` head — soft as a field
    parent: Order id?    // requirement-hierarchy keyword — soft as a field
    money: int           // even the primitive-type name is soft as a name
    write: int           // the policy verb — soft as a field
  }
}
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

// System: groups subdomains and deployables.  `generate system` emits
// every deployable as its own project plus a docker-compose.yml.
system Acme {
    subdomain Catalog { context Products { … } }
    subdomain Sales   { context Orders   { … } }
    storage primary { type: postgres }
    resource productsState { for: Products, kind: state, use: primary }
    resource ordersState   { for: Orders,   kind: state, use: primary }
    deployable api {
        platform: dotnet, contexts: [Products, Orders],
        dataSources: [productsState, ordersState], port: 8080
    }
    deployable web {
        platform: node, contexts: [Products],
        dataSources: [productsState], port: 3000
    }
}
```

The two forms can coexist in one file but typically you'd use one or
the other.

What may sit at the **file root** (grammar `ModelMember`): `system`,
`subdomain`, `context`, the ambient shared-kernel types (`valueobject`,
`enum`, `payload`-family records, `component`, expression-form `function`,
`capability`), a `migration "…" { … }` ledger block, the traceability
declarations (`requirement` / `solution` / `testCase`), a unit
`test "…" for <Subject> { … }`, and every deployment-shape member
(`deployable`, `storage`, `resource`, `channelSource`, `ui`, `layout`,
`theme`, `user`, `auth`, `api`, `test e2e`) — root-level deployment members
compose into the project's single `system`, so deployment can live in its
own file.

### Multi-file projects: `import` and root-level shared types

A project may be split across multiple `.ddd` files.  An entry file
(conventionally `main.ddd`) declares per-file path-based imports; the
project loader walks the import graph transitively from the entry
file and treats every reachable document as one project.

```ddd
// main.ddd
import "./shared/money.ddd"
import "./orders.ddd"

system Shop {
    subdomain Sales { context Orders { … } }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
        platform: node, contexts: [Orders], dataSources: [ordersState]
    }
}
```

```ddd
// shared/money.ddd — declared at model root, ambient across files.
valueobject Money {
    amount: decimal
    currency: string
}

enum Currency { USD, EUR, GBP }
```

```ddd
// orders.ddd
context Orders {
    aggregate Order {
        total: Money            // root-level Money resolves here
        currency: Currency
    }
}
```

Rules:

- Imports are relative to the importing file (`"./other.ddd"` is
  resolved against the directory containing the file with the
  `import`).
- The import graph defines the project.  Files nobody imports are not
  part of the project (no autodiscovery).
- **`valueobject`, `enum`, `payload`-family records, `capability`,
  expression-form `function`, and `component` may appear at the model
  root.**  They form an implicit shared kernel — visible workspace-wide
  from every importing file.  Value objects, enums and payloads resolve
  into every context's type space; top-level `component` declarations
  resolve from every page body in every ui in every system (ui-scope
  components shadow on name collision).  See
  [`page-metamodel.md`](page-metamodel.md) §5.1.
- Aggregates, events, repositories, projections, workflows, handlers and
  policies stay inside a context.
- Cross-context aggregate references are **not** changed by this
  feature.  Today's rule applies: `X id` only resolves to an
  aggregate in the same context.
- Workspace-level uniqueness: root-level VO / enum names, system
  names, and context names must each be unique across the whole
  project.  A context-local VO / enum that shadows a root-level one
  is a hard error.
- `generate system <main.ddd>` is the multi-file-aware entry point.
  Legacy `generate ts` / `generate dotnet` keep their single-file
  semantics.

See [`tools.md`](tools.md) for the CLI side; the original design
rationale (stages, work items, deferred cross-context features) is
preserved at [`plans/multi-file-source.md`](old/plans/multi-file-source.md).

### Inside a `system`

| Form | Purpose |
| --- | --- |
| `subdomain Name { … }` | Groups one or more bounded contexts under a name.  A subdomain is a logical unit; it doesn't directly produce code.  Was named `module` before the D-STORAGE-SPLIT rename. |
| `deployable name { platform: dotnet\|node\|elixir\|python\|java, contexts: [A, B], dataSources: [X, Y], port: N, … }` | A **backend** deployable: one project, one HTTP server, one DbContext, listening on `port`.  `contexts:` names which bounded contexts this deployable hosts; `dataSources:` lists the system-scope `resource` decls that route those contexts' persistence (every hosted aggregate must have a matching binding — see the `resource` row below; the clause keyword stays `dataSources:` for compatibility).  Further clauses, all order-independent: `serves: <Api>` (which api contracts it exposes), `channels: [<channelSource>, …]` (broker bindings — [`channels.md`](channels.md)), `ui: <Ui>` / `ui: <Ui> { Param: <deployable>, … }` (mount a UI on a fullstack host — `elixir` renders it as HEEx, `dotnet` / `java` embed a SPA), `hosts: [...]`, `auth: required` (JWT-decode middleware + verifier seam — [`auth.md`](auth.md)), `design: <pack>`, `favicon: "…"`.  `platform:` accepts a bareword or a quoted `"family@version"` pin (`"node@v4"`), optionally followed by a **realization block** `{ persistence: …, directoryLayout: … }` — the only two axes that remain (see [Deployable platforms](#deployable-platforms)). |
| `deployable name { platform: react\|vue\|svelte\|angular\|feliz\|flutter, targets: <backend>, ui: <Ui>, port: N }` | A **frontend** deployable.  `targets:` names the backend whose API base URL it is wired to and whose hosted contexts it inherits; a `ui:` binding is **required** (every page flows through the page metamodel — `ui Web with scaffold(subdomains: [...]) { }` is the bulk-CRUD shape).  The four static-bundle hosts (react / vue / svelte / angular) render a `ui` of any of those four `framework:`s; `feliz` (F#/Fable/Elmish) and `flutter` (Dart/Riverpod) host only their own.  Optional `auth: ui` mounts the login redirect + route guard under a system `auth { … }`. |
| `context Name { … }` | Allowed directly inside a system; treated as if it were in an implicit `_default` subdomain. |
| `test e2e "name" against <deployable> [verifies <TestCase>] { … }` | End-to-end test that runs against the named deployable — HTTP (vitest + fetch) for a backend, Playwright page objects for a frontend; lowers to `<system>/e2e/<System>.e2e.test.ts` / `<frontend>/e2e/<System>.ui.spec.ts`.  See [End-to-end tests](#end-to-end-tests-against-a-deployable). |
| `user { id: string, role: string, … }` | System-wide JWT-claim shape decoded by the verifier hook.  At most one per system; required when any deployable opts in via `auth: required` and by an `auth { … }` block (`loom.auth-without-user`).  The `currentUser` magic identifier in operation / workflow / find / projection expressions is typed against this shape.  See [`auth.md`](auth.md). |
| `auth { provider: …, oidc { issuer: …, clientId: … }, sessions: cookie\|jwt, claims: { … }, enforcement: denyByDefault\|opt }` | System-wide OIDC configuration: who issues the token and how its claims map onto the `user { … }` shape.  At most one per system; needs a `user` block.  Generates the token verifier + `/auth/*` handshake (PKCE, refresh rotation).  See [`auth.md`](auth.md). |
| `tenancy by user.<claim> of <RegistryAggregate>` | Multi-tenant partitioning: names the claim that partitions data and the aggregate that is the tenant registry.  Pairs with the `tenantOwned` / `tenantRegistry` capabilities, the per-aggregate `crossTenant` marker and the `policy { allow deep\|global … }` ladder; every aggregate must take an explicit stance (`loom.tenancy-stance-unmarked`).  See [`tenancy.md`](tenancy.md). |
| `theme { primary: "#…", radius: "md", … }` | System-wide visual identity — design tokens consumed by the react / vue / svelte / angular frontends and the Phoenix LiveView shell (feliz and flutter render their own toolkit defaults and ignore it).  At most one per system.  Colour properties (`primary`, `secondary`, `accent`, `success`, `warning`, `error`, `neutral`) accept CSS hex values (`#RGB` / `#RRGGBB` / `#RRGGBBAA`).  `radius` is one of `none / sm / md / lg / xl`.  `fontFamily` and `fontFamilyMono` are free-form strings.  `colorScheme` is `light / dark / auto`.  Unknown property names and invalid values are validator errors. |
| `api Name [with …] from <Subdomain> [{ urlStyle: literal\|resource, <statuses>, <routes> }]` | First-class API contract derived from a subdomain's domain (aggregates expose `all / byId / create / update / delete`, repositories expose their finds, workflows expose mutations).  Backend deployables `serves:` an api; UIs reference one via `api X: <ApiName>` parameters; the optional body adds `httpStatus <Error> -> <code>` mappings and hand-written routes (`route GET\|POST\|PUT\|PATCH\|DELETE "/path" -> <handler>`) over `commandHandler` / `queryHandler` declarations.  See [`architecture.md`](architecture.md). |
| `storage Name { type: <sourceType>, connection: env("…")\|service(x)\|secret(x)\|literal("…"), config: { k: v } }` | Typed physical store / service reusable across deployables.  `type:` names the built-in **sourceType**: relational `postgres` / `mysql` / `sqlite` / `inMemory`, `redis`, search `elastic` / `meilisearch`, `kafka`, `clickhouse` / `bigquery`, object stores `s3` / `localDisk`, queues `rabbitmq` / `nats`, `restApi`, mailers `smtp` / `ses` / `sendgrid`.  `postgres` is the fully-supported state store; the others activate dev-compose sidecars + client emission per the kind × sourceType matrix in [`resources.md`](resources.md). |
| `resource Name { for: <Ctx>, kind: <k>, use: <storage>\|<api>, … }` | The configured binding (renamed from `dataSource`) from a bounded context's data of kind `state` / `eventLog` / `snapshot` / `cache` / `replica` / `objectStore` / `queue` / `api` / `mailer` to a physical `storage` (or, for `kind: api`, a sibling `api` served in the same system — a typed client).  Optional knobs: `schema`, `tablePrefix`, `keyPrefix`, `ttl`, `every`, `retain`, `isolationLevel`, `readonly`, `shape`, `index: [Entity.col, Entity.(a, b)]`, `config { … }`.  Every backend deployable hosting an aggregate must list a matching `resource` under its `dataSources:` field.  See [`resources.md`](resources.md) for the full model (sourceTypes, kinds, capabilities, interfaces) and workflow-level consumption. |
| `channelSource Name { for: <channel>, use: <storage> }` / `timerSource Name { for: <Event>, cron: "…" \| every: 15s, in: "<tz>", overlap: allow }` | System-scope transports: a `channelSource` binds a context `channel` to a broker `storage` (redis / rabbitmq / kafka) and is attached to deployables via `channels:` ([`channels.md`](channels.md)); a `timerSource` is a cron / cadence tick that raises the named event into a context (`loom.timer-*`; the target aggregate must be state-based — `loom.timer-needs-state`). |
| `ui Name [with scaffold(...)] { framework: react\|vue\|svelte\|angular\|feliz\|flutter\|phoenixLiveView, … }` | Block of pages, components, stores, areas, menu, and api / channel parameters that a deployable binds via `ui:`.  See [`page-metamodel.md`](page-metamodel.md). |
| `layout Name { … }` | A reusable page shell (header / sidebar / footer slots) a `ui` renders through.  See [`page-metamodel.md`](page-metamodel.md). |
| `capability Name { … }` | A pure mixin (fields — which may be typed `Self id` — plus `filter` / `stamp` contributions) applied to aggregates via `with Name` / `implements Name`; also declarable at file root.  See [`capabilities.md`](capabilities.md). |
| `function name(params): T = Expr` | An ambient expression-form helper — same rule as at file root; see [Top-level helper functions](#top-level-helper-functions). |

A subdomain (and the bounded contexts it groups) may appear in any
number of deployables — its code is inlined into each.  For v1 there
is no shared-library / npm-workspace shape; duplication is the
trade-off for simplicity.

Cross-context type references (`X id`, value-object usage, enum
values) work freely as long as both types are reachable from the same
deployable's hosted context set.  The Langium scope provider exports
all named declarations — aggregates, entity parts, value objects,
enums — across subdomain / context boundaries within the same source
file.

A subdomain body may also include one or more
`permissions { ... }` blocks declaring typed permission identifiers
used in operation / workflow expression bodies — optionally with an
`implies` closure (`admin implies [read, write]`;
`loom.permission-implies-*`).  The `permissions.<name>` magic identifier
lowers to the runtime string `<lowercase-subdomain>.<name>`; see
[`auth.md`](auth.md).

#### Deployable platforms

| `platform:` | Stack |
| --- | --- |
| `dotnet` | ASP.NET Core + EF Core + Mediator (martinothamar) + Swashbuckle.  Default port 8080. |
| `node`   | Hono + Drizzle ORM + Zod with `@hono/zod-openapi` (bareword resolves to the `hono@v5` package; `"node@v4"` pins the previous one).  Default port 3000. |
| `elixir` | Phoenix + plain Ecto (the Ash foundation was removed).  A fullstack host: mounts a `framework: phoenixLiveView` ui as HEEx (`coreComponents` / `daisyui` packs).  The old `platform: phoenix` / `phoenixLiveView` aliases were retired — `elixir` is the only spelling.  Default port 4000. |
| `python` | FastAPI + SQLAlchemy 2 + Pydantic.  Default port 8000. |
| `java`   | Spring Boot + Spring Data JPA + Hibernate.  Default port 8081. |
| `react`  | Vite + React Router + React Query + Zod + Playwright page objects; design packs `mantine` (default) / `shadcn` / `mui` / `chakra`.  Default port 3001. |
| `vue`    | Vite + vue-router + vue-query + Zod (`vuetify` / `shadcnVue`).  Default port 3002. |
| `svelte` | Svelte 5 / SvelteKit static SPA + svelte-query + Zod (`shadcnSvelte` / `flowbite`).  Default port 3003. |
| `angular` | Angular SPA (`angularMaterial` / `primeng` / `spartanNg`).  Default port 3004. |
| `feliz`  | F# / Fable / Elmish (MVU) SPA built by `dotnet fable` + vite, daisyUI styling.  Hosts only `framework: feliz`.  Default port 3005. |
| `flutter` | Dart / Flutter + Riverpod; the web bundle is served by compose, and the same Dart source builds native Android / iOS via the project Makefile.  Hosts only `framework: flutter`.  Default port 3006. |
| `static` | A UI-only static host — lowers through the `react` path. |

Backend deployables (`dotnet`, `node`, `elixir`, `python`, `java`) declare
`contexts: [...]` (which bounded contexts they host) and
`dataSources: [...]` (the system-scope `resource` decls that route
those contexts' persistence).  Frontend deployables (`react`, `vue`,
`svelte`, `angular`, `feliz`, `flutter`) declare
`targets: <backend-deployable>` instead — the frontend's API base URL
is wired to the target's port and its hosted contexts are inherited
from the target so pages exactly cover the API surface.

The optional **realization block** after a backend `platform:` carries
exactly two axes — `persistence:` (e.g. `efcore` / `dapper` on `dotnet`,
`drizzle` / `mikroorm` on `node`) and `directoryLayout:`.  The former
`foundation:` / `application:` / `transport:` / `runtime:` clauses were
removed and no longer parse.

```ddd
deployable api {
    platform: dotnet { persistence: dapper }
    contexts: [Orders], dataSources: [ordersState], port: 8080
}
```

See [`platforms.md`](platforms.md) for the registry and adapter menus,
[`resources.md`](resources.md) for the storage/resource model, and
[`generators.md`](generators.md) for what each platform emits per
aggregate.

### Inside a context

Inside a context, the following kinds of declarations may appear, in any
order:

| Form | Purpose |
| --- | --- |
| `enum Name { A, B, C }` | Closed enumeration; values are referenced bare. |
| `valueobject Name { … }` | Immutable record with optional invariants and derived members. |
| `[abstract] aggregate Name [extends Base] [persistedAs: eventLog\|state] [shape: relational\|embedded\|document] [inheritanceUsing: sharedTable\|ownTable] [crossTenant] [audited] [with Cap, Macro(...)] { … }` | Aggregate root with implicit `Name id` field (always a `guid` — there is no `ids` clause; see the identity note below).  `abstract` **leads** (what the declaration *is*); the header region after the name is **order-independent** (how it *participates*): `persistedAs: …` picks the primary truth kind (default `state`); `shape: …` picks the saving shape (default `relational`) — **`relational`** = table-per-entity; **`embedded`** = queryable root row + contained parts folded into one JSONB column; **`document`** = the whole aggregate as one opaque JSONB blob (`id, data, version`), emitted on all five backends (a `shape:` a backend can't emit is a validation error); `inheritanceUsing:` picks TPH vs TPC (below); `crossTenant` opts shared-reference data out of the tenant filter under a `tenancy by` system ([`tenancy.md`](tenancy.md)); `audited` records an `audit_records` row for every public command (the aggregate-wide form of the per-command `audited` flag).  A trailing `with …` clause mixes in capabilities and macros ([`capabilities.md`](capabilities.md), [`scaffold-macros.md`](scaffold-macros.md)). |
| `event Name { field: Type, … }` | Flat record raised via `emit`. |
| `payload Name { … }` / `command` / `query` / `response` / `error` / `payload U = A \| B` | Transport records and discriminated unions — the workflow / handler command surface and `or`-union return arms.  See [`payloads.md`](payloads.md). |
| `repository Name for Aggregate { find … }` | Repository declaration with optional find queries (see [Repositories](#repositories)). |
| `criterion Name(params) of Aggregate = Expr` / `retrieval Name of Aggregate { where: …, sort: […], loads: […] }` | Reusable, SQL-inlinable predicate specifications and the named list-read shapes `Repo.run(...)` consumes.  See [`criterion.md`](criterion.md). |
| `projection Name[(params)] [keyed by <field>] [requires Expr] { <fields> from <Source> [as x] [where …] [ignoring …] [join Agg as a on …] [group by …] select f = …, … }` / `projection Name keyed by k { <fields> on(e: Event) [by e.key] { … } }` | A read model: **query-time** (a `select` over an aggregate / projection / workflow source — optional `where`, `join`, `group by`, whole-table aggregation, paged reads) or **folded** (`on(e: Event)` arms folding a stream into a keyed row).  Exposed as `GET /projections/<name>` and readable from pages.  ~50 `loom.projection-*` gates; see [`language-reference/10-repositories-and-queries.md`](language-reference/10-repositories-and-queries.md) and [`scaffold-macros.md`](scaffold-macros.md) (`scaffoldDashboard`). |
| `workflow Name { create(...) …, handle …, on(e: Event) …, function … }` | Context-level orchestration across aggregates, with `create` / `handle` / `on` reactors and workflow-local state.  See [`workflow.md`](workflow.md). |
| `[extern] commandHandler Name(cmd: Cmd)[: Response] { … }` / `[extern] queryHandler Name(q: Query): Response { … }` | Application-layer handlers — a single-aggregate `handle` lifted out of a workflow (load → mutate → save → `return`), routable from an `api { … }` body.  `queryHandler` must not save (`loom.query-handler-saves`); `commandHandler` touches one aggregate (`loom.command-handler-multi-aggregate`).  An `extern` handler is bodyless (`;`) — see [`extern.md`](extern.md). |
| `domainService Name { operation calc(...): T { … } }` | A stateless, pure cross-aggregate calculator.  See [`domain-services.md`](domain-services.md). |
| `channel Name { carries: [Event, …], delivery: broadcast\|queue, retention: ephemeral\|log\|work, key: field }` | Publisher-side contract for how a context's events are transported (paired with a system `channelSource`).  See [`channels.md`](channels.md). |
| `seed [dataset] [raw] { Aggregate { field: value, … } … }` | Declarative first-boot rows (one `Aggregate { … }` object literal per row; `raw` writes table-level inserts).  `loom.seed-*`.  See [`language-reference/23-domain-services-and-seeds.md`](language-reference/23-domain-services-and-seeds.md). |
| `filter … ` / `stamp … ` / `implements Cap` | Context-level capability contributions (a query filter, a write stamp, a typed capability application) propagated to every aggregate in the context.  See [`capabilities.md`](capabilities.md). |
| `test "name" for <Aggregate\|ValueObject\|DomainService\|Context> { … }` | A unit test hoisted beside its subject (`for` names the home; a test nested inside its subject needs no `for` — `loom.test-redundant-for` / `loom.test-needs-target`). |
| `policy [Name] { allow [write] local\|deep\|global on Aggregate … }` | Read/write-scope ladder for `tenantOwned` aggregates under a tenant hierarchy — widens the tenant floor to the caller's org subtree (`deep`) or root-org subtree (`global`); the optional `write` verb gates instance mutations. The name is optional; one rule per aggregate. See [tenancy.md](tenancy.md) → "The `policy {}` read ladder". |
| `policy [Name] { deny [write] on Aggregate … }` | **Deny-wins carve-out** (Phase 4): removes access to an aggregate. `deny on X` denies READ (X becomes invisible → empty / 404; writes fail too since the write load reuses the read filter); `deny write on X` denies WRITE only (reads stay, mutations 404). All-or-nothing at the aggregate (no level word); applied after the `allow` passes, so deny wins. Not restricted to `tenantOwned`. Diagnostics: `loom.policy-deny-unknown-aggregate`, `loom.policy-deny-duplicate`, `loom.policy-deny-shadows-allow` (warning). See [auth.md](auth.md) → "Deny carve-outs". |
| `policy Name(params): bool ( = Expr \| { Expr } )` | **Named policy function** (P3.2): a reusable, ambient boolean authorization predicate (sees `currentUser` + its own parameters), referenced from a `requires PolicyName(args)` gate and inlined there like a `criterion … of bool`. Parentheses are required (they distinguish it from the `policy {}` block form). See [auth.md](auth.md) → "Named policy functions". |

### Identity and `X id`

`aggregate Order { … }` implicitly declares an identity field `id` of
type `Order id`.  Likewise each `entity Foo { … }` declared inside an
aggregate implicitly has an `id: Foo id` plus an implicit parent
reference.

Cross-aggregate references are written as `Other id`:

```
customerId: Customer id
```

The underlying value type is always `guid`, and there is **no `ids` clause** —
`ids int|long|string` were removed (no backend implemented id generation for a
non-guid primary key, so declaring one produced an app that collided on the
second insert), and the no-op `ids guid` spelling was removed with the rest of
the header normalization (M-T5.17). `aggregate Order ids guid { … }` is a
parse error; write `aggregate Order { … }`. See
[`docs/old/plans/non-guid-id-http-params.md`](old/plans/non-guid-id-http-params.md).

#### Reference collections — `X id[]`

A field typed as a collection of references to another aggregate is a
**many-to-many** relation:

```
aggregate Trainer {
  party:  Pokemon id[]
  caught: Pokemon id[]
}
```

No grammar keyword switches it on — any aggregate field whose type is
`X id[]` is a reference collection.  **Semantically it is a set of
references**: the same target appears at most once per owner (the join
table's composite `(owner_id, target_id)` primary key enforces this),
and **iteration order is not part of the contract** — different
backends may return the list in different orders, even across reads
of the same row.  If a position is part of the domain (e.g. a battle
slot number where slot 1 attacks first), model it as a separate
ordinal field on a dedicated child aggregate rather than relying on
list order.

Mutate the collection from operations with `+=` / `-=`:

```
operation addToParty(pokemon: Pokemon id) {
  precondition party.count < 6
  party += pokemon
}
```

Membership is queryable from a repository `find ... where` (see
[Repositories](#repositories) below).

Reference collections are **not** the same as containment.
`contains lines: OrderLine[]` (or, equivalently, the `contains`-less
`lines: OrderLine[]` — see below) declares entity parts that live and
die with the parent — a child table joined on `parent_id`.  `X id[]` is
a list of references to a *different* aggregate that outlives any one
owner — persisted as a separate join table when the backend supports
it (see [`docs/generators.md`](generators.md)).

### Aggregate inheritance

An aggregate may extend a shared base so subtypes carry a common field set and
can be queried polymorphically:

| Form | Notes |
| --- | --- |
| `abstract aggregate <Name> { … }` | A base that is never instantiated: no table / repository / routes of its own. May declare fields and `derived` getters; may **not** declare `create` / `operation` behaviour or a `repository`. |
| `aggregate <X> extends <Base> { … }` | A concrete subtype. `<Base>` must be an `abstract aggregate` in the same context. Inherits the base's fields (merged into the wire shape ahead of its own; an own field shadows a like-named base field). |
| `inheritanceUsing: sharedTable\|ownTable` | Header modifier (on the base, optionally per concrete) choosing the table-mapping strategy. Default `sharedTable` (TPH). `ownTable` (TPC) emits a standalone table per concrete. |

`find all <Base>` returns the polymorphic union of all subtypes via a per-backend
reader. TPC (`ownTable`) is emitted on every backend; TPH (`sharedTable`) is
emitted on all five backends. See
[`inheritance.md`](inheritance.md) for the per-backend emission, the validation
rules, and the deferred patterns.

### Aggregate / entity-part members

Inside an aggregate or an `entity` part:

| Form | Notes |
| --- | --- |
| `name: TypeRef [provenanced] [sensitive(tags)] [access] [= default] [check Expr [message "…"]] [mask unless Expr]` | Property, with optional modifiers. `provenanced`, `sensitive(...)`, and `access` parse in **any order** relative to each other; `= default`, `check`, and `mask unless` must come **after** all three, in that order (an unconsumed flag keyword after an in-progress default risks the expression greedily swallowing it — `access`'s keywords double as valid identifiers). `provenanced` records assignment lineage (below); `sensitive(...)` tags the field for log-redaction / inspect; `access` is one of `immutable / managed / token / internal / secret` (default: `editable` — see [Field access modifiers](#field-access-modifiers) below); `check Expr` is a per-field validation predicate (optional author-written `message`); `mask unless <currentUser-predicate>` redacts the field to `null` on the wire unless the caller satisfies the predicate (`loom.field-mask-*`; see [`auth.md`](auth.md) → "Field masking"). |
| `contains name: PartName[]` | Containment of a part declared within the same aggregate; collection. |
| `contains name: PartName` | Containment, single (required). |
| `contains name: PartName?` | Containment, single (optional) — the part may be absent at runtime; serialised as a nullable wire field.  `[]?` is rejected: an empty collection already encodes absence. |
| `name: PartName[]` / `name: PartName` / `name: PartName?` | **`contains` is optional.** A field whose type is a locally-declared `entity` part *is* a containment — `lines: OrderLine[]` means exactly what `contains lines: OrderLine[]` means (an entity part is owned by its root, never held by value). The keyword stays valid for readers who want the composition boundary spelled out; both spellings lower identically. Only what `contains` carries applies — a name, `[]`, and `?`; the value-property modifiers (`provenanced` / access / `= default` / `sensitive(...)` / `check`) are rejected on an entity-typed field (`loom.entity-field-modifier`). `X id` remains required for cross-aggregate references — `id` is a type constructor (the field is a key, not the entity), which is why *it* is never inferred. |
| `derived name: TypeRef = Expression` | Computed read-only property. |
| `derived display: string = Expression` | **Reserved** — declares the aggregate's user-facing label.  When present, `string(aggregate)` and implicit `"x " + aggregate` compile to a member access on this derived; React Select pickers use it for option text.  Without it, those expressions are compile errors. |
| `derived inspect: string = Expression` | **Reserved** — declares the aggregate's developer-facing debug form.  Auto-generated when omitted (structural form, sensitive fields shown as `<redacted>`).  Backends emit it as `ToString()` / `[util.inspect.custom]` / `Inspect` so debugger watches, exceptions, and logger output get a useful representation. |
| `[private] invariant Expression [when Expression] [message "…"]` | `bool` predicate; checked after every mutation. Optional `when` is a guard; `message` is the user-facing text (also the i18n key). `private` keeps the rule off the wire-layer schemas (Zod / FluentValidation / OpenAPI) — it runs only in the domain floor. |
| `unique (a, b)` | Set-level natural-key invariant — derived into a DB unique index (partial under `softDeletable`) plus a per-backend 23505 → 409 mapping (`loom.unique-*`). |
| `function name(params): TypeRef = Expression` | Pure helper (expression form); callable from any expression in the same aggregate. Stays SQL-inlinable like a `criterion`. |
| `function name(params): TypeRef { … }` | Pure helper (block form); `let` + branch (ternary/`match`) + bug-regime `precondition`/`requires`, ending in `return` (`loom.function-block-no-return`). Still **pure** — no mutation, no `emit`, no repository / operation / domain-service / extern call (the IR validator rejects each). **Not queryable** (a block-form call is rejected in a `where` / `criterion` filter). |
| `[private] operation name(params) [extern] [audited] [: ReturnType] [requires Expr] [when Expr] { … }` | Mutating method (root only). `private` = callable only from within the same aggregate root (no route). `audited` records an `audit_records` row per call. `: A or B` declares an exception-less outcome returned via `return` (an `error` variant maps to a ProblemDetails status — [`payloads.md`](payloads.md)). `requires` is the authorization gate (403; [`auth.md`](auth.md)). |
| `operation name(params) extern { precondition … }` | Public op whose business decision lives in user code; body must contain only `precondition` statements. See [`extern.md`](extern.md). |
| `operation name(params) when <pred> { … }` | **canCommand state gate** ([`criterion.md`](criterion.md), use site 2): `<pred>` is a pure bool predicate over the aggregate's own state — referencing an operation parameter is an error (move argument-aware checks into a `precondition`); evaluated against the loaded instance before the body. False → 409 "Disallowed" ProblemDetails; a side-effect-free `GET /{id}/can_<op>` companion returns `{ allowed }` for UI enablement (so `when` on a `private` operation is rejected — nothing could read it). Named criteria / aggregate functions inline like any bool position. Supported on all five backends. Distinct from `requires` (auth, 403) and `precondition` (domain validity, 422). |
| `create [name](params) [audited] { … }` | Lifecycle factory — the body populates a fresh `this`; the unnamed form is the aggregate's canonical creator (the `POST /<plural>` route takes its params). See [`language-reference/06-behavior-and-statements.md`](language-reference/06-behavior-and-statements.md). |
| `destroy [name][(params)] [audited] { … }` | Lifecycle terminator — loaded by id, the body runs (a throw aborts removal), then the framework removes the row; the unnamed `destroy { }` is the canonical `DELETE`. |
| `apply(e: <Event>) { … }` | **Event-sourcing fold** (only on a `persistedAs: eventLog` aggregate).  Folds one emitted event type into state — a pure transition: assignments / collection mutations / `let` only, no `emit`, no side-effecting calls, no guards (`loom.applier-impure`).  One `apply` per event type.  See the event-sourcing note below. |
| `filter …` / `stamp …` / `implements Cap` | Aggregate-level capability contributions — a read-side query filter, a write-side stamp, a typed capability application.  See [`capabilities.md`](capabilities.md). |
| `entity Name { … }` | Nested part declaration (inside an aggregate). |
| `test "name" { … }` | Unit test block nested in the aggregate; also declarable beside it as `test "…" for <Aggregate>` (root, context, or a `tests/*.ddd` file). Lowers per backend — see [Tests](#tests). |

Entity parts may declare only `contains`, properties, `derived`,
`invariant`, and `function` — no `operation` / `create` / `destroy` /
`apply` / `unique` / `test` (those live on the root).  A `valueobject`
admits properties, `derived`, `invariant`, `function`, and nested `test`
blocks.

##### Constructing values vs. aggregates

Two things you declare are instantiated two different ways, and mixing them
up is the first off-happy-path surprise:

| You built a… | Construct it with | Why |
|---|---|---|
| `valueobject` / `entity` part | `Money { amount: 1, currency: "USD" }` — a **brace literal** | A plain immutable record; the `{ … }` is the whole value. |
| `aggregate` root | `Order.create({ … })` — the **`create` factory** | An aggregate has identity + invariants; construction must run the `create` action so those are enforced and the create wire shape (not the raw field set) is honoured. |

```ddd
test "build them" {
  let m = Money { amount: 5, currency: "USD" }      // value object — brace literal
  let o = Order.create({ customerId: "c1", total: m })  // aggregate — factory call
}
```

Writing `Order { … }` in an expression position is an error — since #2005 the
diagnostic points you at `Order.create({ … })` rather than the older generic
"unknown builder type". The factory input follows the **create-input** column
of the [access-modifier matrix](#field-access-modifiers): a `managed` field
like `createdAt` is off it, so `Order.create({ createdAt: … })` is rejected.

#### Event sourcing — `persistedAs: eventLog` + `apply(...)`

An aggregate marked `persistedAs: eventLog` in its header is **event-sourced**:
its truth is an append-only event stream, and its state is a fold of that
stream. The body contract differs from a state-based aggregate, and the
compiler enforces it (in the IR validator and live in the editor):

- **Command bodies decide and emit.** `operation` / `create` / `destroy`
  bodies may run `precondition`s and `emit` events, but must **not** mutate
  `this` directly — the state change is the applier's job.
- **Appliers fold.** Each `apply(e: <Event>) { … }` reflects one event type
  into state, using assignments / collection mutations / `let` only (a pure,
  replayable fold — no `emit`, no calls, no guards). There is at most one
  applier per event type, and **every emitted event needs a matching
  applier** (or the transition is recorded but never reflected).
- **`emit` records and folds.** At runtime an `emit` both appends to the
  stream and applies the fold, so the in-memory aggregate is consistent for
  the command's response.
- **Construction is a creation event.** An event-sourced aggregate is built
  by its `create` action, whose emit-only body raises the creation event; the
  factory runs that body against a fresh, empty instance so construction goes
  through the same record-and-fold path. The POST body is the create's
  params (the command shape), not the field set. At most one `create` (the
  canonical creator); an aggregate with none is constructed out-of-band and
  exposes no create route.

```
event Opened { account: Account id, owner: string }
event Deposited { account: Account id, amount: int }

aggregate Account persistedAs: eventLog {
  owner: string
  balance: int
  create open(owner: string) {
    emit Opened { account: id, owner: owner }   // construct via creation event
  }
  operation deposit(amount: int) {
    precondition amount > 0
    emit Deposited { account: id, amount: amount }   // decide + emit
  }
  apply(e: Opened) { owner := e.owner  balance := 0 }   // fold (initialises)
  apply(e: Deposited) { balance := balance + e.amount }   // fold
}
```

Storage emission ships on **node, .NET, Python, Java, and Phoenix** (plain
Ecto/Phoenix): an event-sourced aggregate persists to an append-only
`<agg>_events` table, constructs and mutates through emitted events, and
rehydrates by folding the stream on load. See `generators.md` for the
per-backend matrix and `docs/old/proposals/workflow-and-applier.md` for the roadmap.

#### Provenanced fields

Mark a stored field `provenanced` to capture the lineage of every value it
holds:

```
aggregate Order {
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
traced back to the snapshot that produced it at runtime. The provenance
runtime (co-located lineage column, per-write trace capture, transactional
`provenance_records` flush) is emitted on all five backends — node, .NET,
Java, Python, and elixir (plain Ecto/Phoenix); the frontends render a `?`
disclosure over it (`ProvenanceInfo`). See [`provenance.md`](provenance.md),
`examples/provenance.ddd` for a runnable backend example and the
`Provenance System` playground example for the same domain as a Hono + React
system.

### Field access modifiers

Every property gets an **access modifier** that governs how it
participates in input DTOs, the update wire shape, and API
read exposure.  The grammar form is

```
name: TypeRef [provenanced] [sensitive(...)] [immutable|managed|token|internal|secret]
```

`provenanced` and `sensitive(...)` may appear in any order around the
access modifier — `name: TypeRef managed provenanced sensitive(pii)`
parses the same as the canonical order above.

The default — no keyword — is `editable`.  The five keywords (and
the implicit `editable`) form this matrix:

| Modifier | Client read | In `create(...)` input | In `update(...)` input | In UI-read payloads |
|---|---|---|---|---|
| `editable` *(default)* | ✓ | ✓ | ✓ | ✓ |
| `immutable` | ✓ | ✓ | ✗ (server rejects) | ✓ |
| `managed` | ✓ | ✗ (server owns it) | ✗ | ✓ |
| `token` | ✓ | ✗ | ✗ body — sent as an optimistic-concurrency *precondition* (like `id`/`version`) | ✓ |
| `internal` | ✗ (never exposed via API) | ✗ | ✗ | ✓ (the UI may read it) |
| `secret` | ✗ (never disclosed) | ✓ | ✓ (write-only) | ✗ |

This table is not prose that can drift from behaviour — each column is a
projection function in `src/ir/enrich/wire-projection.ts` that every backend
shares: **Client read** = `forApiRead`, **create input** = `forCreateInput`,
**update input** = `forUpdateInput` (with `token` fields split out by
`forPreconditionInput`), **UI-read payloads** = `forUiRead`. If a generated
`create({ … })` / read DTO surprises you, this is the authority.

> **Common gotcha.** Passing a `managed` field into `.create({ … })` (e.g.
> `Task.create({ createdAt: now() })`) is rejected — `managed` is server-owned
> and off the create input. Likewise a scaffolded/custom page that renders an
> `internal` or `secret` field (`row.isDeleted`, `row.tenantId`) won't type-check
> against the API-read DTO, which omits them. Both are the same rule read off the
> two ✗ columns above.

Examples:

```ddd
aggregate User {
  email: string                            // editable (default)
  createdAt: datetime managed              // server stamps it
  passwordHash: string secret              // accepted on create + update; never sent back
  version: int token                       // round-tripped for optimistic concurrency
  isDeleted: bool internal                 // hidden from clients; UI may read
  slug: string immutable                   // set once at creation, never updated
}
```

The aggregate's synthetic `id` is hardcoded to `token` access — it's
read-only from the client's perspective but must be echoed on
update.  `X id` foreign-key references default to `editable` (the
client supplies them on create) regardless of the target's identity
access.  Reference-collection fields (`T id[]`) are persisted via a
join table and follow the default.

The macro stdlib uses these modifiers to scope its emissions:
`auditable` declares `createdAt`/`updatedAt` as `managed`,
`softDeletable` declares `isDeleted` as `internal`.  The
`writableUpdateFields` macro helper consumes the modifier matrix
when synthesising `crudish`'s `update` operation — see
[`scaffold-macros.md`](scaffold-macros.md).

### Sensitivity tags

`sensitive(tag1, tag2, ...)` marks a property as carrying sensitive
data.  Tags are free identifiers; nothing in the compiler treats
them specially today — they are opaque metadata reserved for
external tooling (audit reports, log redaction policies, schema
discovery for compliance).

Conventional tag names (not enforced):

| Tag | Meaning |
|---|---|
| `pii` | Personally identifiable information (name, email, phone, address). |
| `phi` | Protected health information (HIPAA-adjacent). |
| `cred` | Credentials (passwords, API keys, tokens). |
| `audited` | The field's value lineage should be retained for audit. |

```ddd
aggregate Patient {
  fullName: string sensitive(pii)
  diagnosis: string sensitive(pii, phi)
  ssn: string sensitive(pii, audited) secret    // sensitive + secret access
}
```

A field's `derived inspect` output redacts sensitive fields by
default — the auto-generated structural form prints
`<redacted>` for any property carrying any sensitivity tag.  A
user-supplied `derived inspect = …` is rendered verbatim; the user
opts out of redaction by writing their own debug form.

### Type references

```
TypeRef       = TypeAtom ('or' TypeAtom)*                  // anonymous union
TypeAtom      = BaseType GenericCtor* ('[]')? ('?')?
GenericCtor   = 'paged' | 'envelope' | 'option'             // ML-postfix carriers
BaseType      = PrimitiveType | SlotType | ActionType | SelfType | IdType | NamedType
IdType        = Identifier 'id'                // cross-aggregate FK
NamedType     = Identifier                     // bare name
SelfType      = 'Self'                         // the host aggregate, inside a capability
PrimitiveType = 'int' | 'long' | 'decimal' | 'money' | 'string' | 'bool' | 'datetime' | 'guid' | 'json' | 'File'
SlotType      = 'slot'                         // element-shaped param marker — UI-only
ActionType    = 'action' ('(' TypeRef ')')?    // callback-shaped param marker — UI-only
MoneyLit      = 'money' '(' STRING ')'         // precise-decimal literal
```

The postfix carriers fold left (`string envelope paged` is
`paged(envelope(string))`) and bind tighter than `or`, as do `[]` / `?`:
`string or int option` is `string or (int option)`.  `A or B` and the named
`payload U = A | B` form are the discriminated-union surface (tagged `type`
on the wire) — see [`payloads.md`](payloads.md).  `File` is the uploaded-file
type backing `FileUpload` / `FileLink` (needs an `objectStore` resource —
`loom.file-field-needs-object-storage`; see [`resources.md`](resources.md)).
`Self id` is valid only inside a `capability` body, where it stands for a
reference to the host aggregate (`parent: Self id?` in `tenantRegistry`) — the
expander rewrites it to `<Host> id` when the capability is spliced in.

`json` is an **opaque JSON blob** — Loom does not model its interior.
It maps to Postgres `JSONB` (Drizzle `jsonb`, EF `System.Text.Json.JsonElement`,
Ecto `:map`), TS `unknown`, Zod `z.unknown()`, and a freeform `object`
in the OpenAPI/wire spec (a leaf — never expanded or structurally
diffed).  Reach for a `valueobject` instead when the shape is known.
See [`document-and-json-hierarchies.md`](old/proposals/document-and-json-hierarchies.md)
(D-DOCUMENT-AXIS).

A bare `Identifier` in type position must resolve to one of:

| Resolves to | Meaning |
| --- | --- |
| Enum (any context) | An `enum` value. |
| Value object (any context) | An embedded value object — copied by value into the wire shape. |
| Entity part of the *same* aggregate | An addressable child of this aggregate, by-reference at runtime (the engine has the loaded object). |
| Event / payload — **workflow `create` / `handle` parameter only** | The transport record that triggers the starter / command — `create(e: PaymentReceived) by …`, `handle settle(c: SettleOrder)`.  Offered as a type *only* in these two positions (see below). |

Cross-aggregate references must use **`X id`** — an explicit foreign
key.  The validator rejects a bare aggregate name in storage / wire
positions (aggregate fields, event fields, operation / function /
find / workflow parameters) with a fixit pointing at `'X id'`; it
also rejects an entity-part from a different aggregate the same way,
pointing at the owning aggregate's id.

**Events and payloads as parameter types.** An `event` or a `payload`
(`command` / `query` / `response` / `error`) may be named by a bare
identifier as the type of a workflow **`create`** or **`handle`**
parameter — the workflow command surface (`create(c: PlaceOrder)`,
`create(e: OrderPlaced) by e.order`, `handle settle(c: SettleOrder)`;
see [`workflow.md`](workflow.md)).  The bound parameter is a flat
transport record: `e.field` resolves to the field's declared type and
participates in the usual comparison / arithmetic / assignment checks.
These types are scoped **only** to those two positions — a stray event
name in an aggregate field, operation parameter, or UI position stays
an unresolved reference, and `Event id` is not a valid `X id` link.

The result is a legible three-keyword surface — `id` shows up exactly
when you cross an aggregate boundary; everything else is a bare name,
and the type system tells you what it means.

`T[]` denotes a collection; `T?` denotes an optional value.  Both
suffixes apply to the same `TypeRef`, in either order
(`Customer id?`, `Pokemon id[]`, `Address?`).

### Null narrowing

A `T?` is not usable where a `T` is required — `+` needs two `string`s, and a
scalar intrinsic needs a receiver that cannot be null (`loom.intrinsic-nullable-receiver`
rejects `path.trim()` on a `string?`, because every backend emits a bare
dereference).  The **ternary is the guard**: a direct null test on its own
condition narrows the branch the test proves safe.

```ddd
// dataKey: string?  — a root tenant has no parent path
dataKey := parent.dataKey != null ? parent.dataKey + "." + seg : seg
```

```typescript
// generated TS (Hono) — the emitted expression is unchanged by narrowing;
// the null test was always in the condition.
org.setPath(loaded.dataKey !== null ? loaded.dataKey + "." + nm : nm);
```

Both directions narrow: `x != null ? …` narrows the **then**-branch,
`x == null ? … : …` narrows the **else**-branch, and the `null` literal may sit
on either side of the comparison.

Deliberately **not** narrowed — each is conservative, never unsound:

- **Anything but a direct null comparison on that ternary's own condition.**
  `&&` chains, `!`-negated tests, `precondition x != null`, a `let` that copies
  the optional, and early-return guards do not narrow.  There is no flow
  analysis.
- **A test and a use spelled differently.** Narrowing matches a *simple path*
  syntactically, so `path != null ? this.path …` does not narrow — write the
  same spelling on both sides.  A call anywhere in the path (`f().x`) never
  narrows, since it names no stable location.
- **A branch containing a call that could mutate the field.** A ternary branch
  is an expression and cannot assign, but it *can* call a sibling `operation`,
  whose body assigns freely — so a branch carrying any call other than a scalar
  intrinsic or a collection op does not narrow.  (A block-form `function`
  is gated pure by the IR validator, but is still excluded for now.)

`slot` is a UI-only marker — valid **only** on a `component`'s parameter
list, where the caller injects a JSX expression that the component body
renders via a bare ref.  The validator rejects `slot` in any other
position (aggregate field, value-object field, operation param, etc.)
with `loom.slot-out-of-position`.  Member access on a slot ref is also
rejected (`loom.slot-member-access`) — slots are opaque values, not
records.  See [`page-metamodel.md`](page-metamodel.md) §5.2.

> Query results and projections are exempt — `find byEmail(e: string): Customer?`
> and `derived owner: Customer = ...` may legitimately reference an
> aggregate as a domain object.  The check only fires in storage /
> wire-data positions.

---

## Top-level helper functions

A pure, **expression-form** `function` may be declared at file root (or directly
inside a `system { }`), making it an ambient helper visible workspace-wide —
like a root `valueobject` / `enum`. It **inlines** at every call site during
lowering (no function is emitted), so it works uniformly on every backend and a
call inside a `find … where` stays queryable.

```ddd
function isBlank(s: string): bool = s.trim().length == 0
function withTax(amount: int, pct: int): int = amount + amount * pct / 100

context Sales {
  aggregate Invoice {
    customerName: string
    net: int
    invariant !isBlank(customerName)
    derived gross: int = withTax(net, 20)
  }
}
```

```csharp
// .NET — inlined, no helper function/class emitted
if (!(!(CustomerName.Trim().Length == 0))) throw new DomainInvariantException(...);
public int Gross => (Net + Net * 20 / 100);
```

Rules:

- **Expression-form only** (`= <expr>`). A block-form top-level function (`{ … }`)
  is rejected (`loom.function-toplevel-block`) — it has no emission home yet; make
  it an aggregate / value-object member instead (there it emits as a real method).
- **No recursion.** Because it inlines, a top-level function must not call itself
  directly or through a mutual cycle (`loom.function-recursive`). Recursion stays
  legal for member functions, which emit as real methods.
- **Shadowing.** A local member (`function` / field / operation / VO constructor)
  of the same name shadows the top-level one; a top-level function in turn shadows
  the stdlib builtins (a user `function days(...)` shadows `days()`).
- **Ambient scope.** The body sees only its parameters (and `currentUser` if
  present) — pass aggregate fields as arguments; a bare field name won't leak in.

The same `function` keyword declares **member** helpers inside an aggregate /
value object / workflow; those emit as real methods (`this.<fn>`) and may recurse.

### The standard prelude

A small set of top-level functions ships with the toolchain and is **ambient** —
callable in any `.ddd` with nothing imported, like a language builtin. They are
ordinary expression-form functions, so they inline at the call site and an
uncalled one emits nothing. A user-declared top-level function of the same name
**shadows** the prelude.

```ddd
// no import needed — isBlank / isPresent / truncate are ambient
aggregate Customer {
  name: string
  invariant isPresent(name)
  derived initial: string = truncate(name, 1)
}
```

Current prelude:

- **strings** — `isBlank(s)`, `isPresent(s)`, `truncate(s, n)`
- **math** — `clamp(n, lo, hi)`, `percentOf(part, whole)`, `roundTo(n, places)`
- **temporal** — `isOverdue(due)`, `isFuture(t)`, `isPast(t)`

The full library — the ambient prelude, the Layer-0 scalar intrinsics, and the
collection operations — is catalogued in [`stdlib.md`](stdlib.md) (generated from
the registries). The set grows over subsequent stdlib slices; see
`docs/old/plans/stdlib.md` → Phase C.

---

## Expression language

Pragmatic core, similar to a subset of TypeScript / C# expressions.

### Literals

| Kind | Examples |
| --- | --- |
| String | `"hello"` |
| Interpolated string | `` `Order #{quantity} for {customerName}` `` — see [String interpolation](#string-interpolation) |
| Integer | `0`, `42` |
| Decimal | `1.5`, `0.0` |
| Boolean | `true`, `false` |
| Null | `null` |
| Now | `now()` — current `datetime` |
| Money | `money("10.50")` — precise decimal; see [`money`](#money--precise-decimal-distinct-from-decimal) |
| Duration | `days(n)`, `hours(n)`, `minutes(n)` — an absolute span (`int` amount only — `loom.duration-arity` / `loom.duration-arg-type`; write `hours(36)`, not `days(1.5)`).  Ordinary free calls that lower to `duration` nodes unless a user `function` of that name shadows them.  See [Temporal arithmetic](#temporal-arithmetic). |
| List | `[3, 2, 1]` — bracketed list literal (page-DSL argument values such as `Grid { cols: [3, 2, 1] }`) |

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
| `cond ? a : b` | Ternary (`loom.ternary-condition` / `loom.ternary-branches`). A direct null test on `cond` narrows the proven branch — see [Null narrowing](#null-narrowing). |
| `match { cond => value, …, else => value }` | Predicate-arms expression — the first true arm wins; `else` is the fallthrough. |
| `match subject { Variant [b] => value, …, else => value }` | Variant match over an `A or B` / `T option` union scrutinee, optionally binding the narrowed variant.  The subject must be a simple ref / member read, not a call — except `match await <call> { … }` in a page `action`, which awaits a remote command and matches its Result ([`actions.md`](actions.md)). |
| `x => expr` / `(a, b) => expr` | Lambda (a collection-op argument or a page-DSL handler value). |
| `f(name: value, …)` | Named call arguments (page primitives, macro-style calls). |
| `PartName { field: expr, … }` | Construct a contained part; `id` and parent `parentId` are auto-injected. |
| `Money { amount, currency }` / `Money { amount: 1, currency: "USD" }` | Value-object constructor (positional or named). |
| `Repo.run(Criterion(args), page?)` / `Repo.run(retrieval { where: …, sort: […], loads: […] })` / `Repo.findAll(...) ignoring Cap` | Repository reads inside workflows / handlers — see [`criterion.md`](criterion.md) and [`capabilities.md`](capabilities.md) for `ignoring`. |

### String interpolation

A **backtick-delimited** template with `{expr}` holes. It lowers to plain string
concatenation of the literal segments and the `string()`-converted holes, so it is
exactly `"…" + string(hole) + …` written more legibly — it works anywhere a `string`
expression is valid (derived members, labels, function bodies).

```ddd
derived label: string = `Order #{quantity} for {customerName}`
```

```typescript
// generated TS (Hono) — concatenation through the existing String() path
get label(): string { return "Order #" + String(this._quantity) + " for " + this._customerName; }
```

- **Backtick, not `"…"`** — plain double-quoted strings are never interpolated, so a
  literal `{`/`}` inside `"…"` stays literal.
- **Holes are full expressions** — arithmetic, calls, ternaries, member chains, even a
  nested `` `…` `` template. The one exception: a hole may **not** contain a literal
  `{ }` block (an object / `match` / builder-call literal); factor that into a `derived`
  and interpolate the derived.
- **Hole type** — a hole must be `string` or implicitly stringifiable (`int` / `long` /
  `decimal` / `money` / `bool` / an enum / an `X id` / an aggregate with a
  `derived display: string`). A `datetime`, `duration`, collection, or plain aggregate
  hole is rejected (`loom.interp-hole-type`) — format it first.
- **Format specs** — a hole may carry an ICU format suffix after a comma at
  hole-depth 0: `{total, number, ::currency/USD}`, `{n, number, ::percent}`,
  `{at, date}` / `{at, time}`, `{n, plural, one {# item} other {# items}}`,
  `{n, selectordinal, …}`, `{kind, select, a {…} other {…}}`.  An unknown
  format is `loom.interp-format-unknown`; a format that doesn't fit the hole's
  type (a `date` on a non-`datetime`, a `number` on a non-numeric, a `select`
  on a non-string/enum) is `loom.interp-hole-type`.  These drive the i18n
  string catalog — see [`new-plan/T1-ui-frontend.md`](new-plan/T1-ui-frontend.md) § M-T1.11.
- **Escaping** — a literal brace or backtick in the text is `\{` / `\}` / `` \` ``;
  `\n` / `\t` / `\\` behave as in a string literal.
- **Not queryable** — an interpolated string desugars to `+`/`convert`, so (like any
  concatenation) it cannot appear in a `find` `where:` clause.
- **Prefer it over `+` in user-visible slots** — a `"Order " + order.id`
  concatenation in a page title / label / message slot warns
  (`loom.user-visible-concat`) because it won't translate; the template form
  extracts as one catalog entry.

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
| `xs.contains(x)` | `bool` | Membership.  Renders to `Array.includes` (TS) / `Enumerable.Contains` (.NET).  Also admitted in repository `where` clauses when `xs` is a `this`-rooted `X id[]` reference collection — see [Repositories](#repositories). |
| `xs.map(x => expr)` | `U[]` | Projection. |
| `xs.sortBy(x => expr, desc?)` | `T[]` | Ordering. |
| `xs.distinct` | `T[]` | De-duplication (scalar elements — `loom.distinct-non-scalar`). |
| `xs.take(n)` / `xs.skip(n)` | `T[]` | Slicing. |
| `xs.join(sep)` | `string` | Concatenate string elements (`loom.join-non-string`). |
| `xs.min(x => expr)` / `xs.max(x => expr)` | `T?` | Reductions over comparable elements (`loom.reduction-non-comparable`); `null` on empty. |
| `xs.avg(x => expr)` | `decimal?` | Mean (`loom.avg-non-numeric`); `null` on empty. |

A reduction spelled without its lambda (`xs.sum`, `xs.any`) is rejected
(`loom.bare-collection-accessor`).  The full catalogue with per-backend
queryability lives in [`stdlib.md`](stdlib.md) → "Collection operations";
the scalar intrinsics (`s.trim()`, `n.abs()`, `d.round(2)`, `t.startOfDay()`,
…) are in the same document — an unknown intrinsic, a wrong arity /
argument type, or a call on a nullable receiver is rejected
(`loom.intrinsic-unknown` / `-arity` / `-arg-type` / `-nullable-receiver`).

### Numeric widening

Within arithmetic, `int < long < decimal`.  An `int` is assignable to
`long` or `decimal`; a `long` to `decimal`.

**Division always yields a fractional result.**  Unlike `+`, `-`, `*`, `%`
(which preserve the widened integer type), **`/` on two integers widens to
`decimal`**: `int / int`, `int / long`, and `long / long` all type as
`decimal`, so `5 / 2` is `2.5` on every backend rather than truncating
differently per host.  A consequence: `derived half: int = a / b` is a
**type error** (`decimal` is not assignable to `int`) — declare the field
`decimal`, or use the truncating-division intrinsic **`a.divTrunc(b)`**
(`int × int → int`, truncating toward zero, e.g. `(-5).divTrunc(2) == -2`) when
you deliberately want integer division (page counts, bucketing, …).  Money and
`decimal` operands are unaffected (`money / int → money`, `decimal / int →
decimal`).

### Temporal arithmetic

`datetime` and `duration` form a closed algebra, the temporal twin of the
`money` rules below.  A `duration` is an **absolute** span (fixed millisecond
width per unit — no calendar-relative `months` / `years`):

- `datetime ± duration → datetime`, `duration + datetime → datetime`
- `datetime - datetime → duration`
- `duration ± duration → duration`, `duration × int → duration`
- everything else (`duration ÷ x`, `datetime × …`, mixing with a
  non-`int` numeric) is rejected.

```ddd
aggregate Invoice {
  issuedAt: datetime
  derived dueAt: datetime = issuedAt + days(30)
  derived overdue: bool = now() > dueAt
}
```

```typescript
// generated TS (Hono)
get dueAt(): Date { return new Date((this._issuedAt).getTime() + (((30) * 86400000))); }
get overdue(): boolean { return new Date() > this.dueAt; }
```

There is no `duration` field type on the wire — it lives only in
expressions (and as the `every:` cadence of a `timerSource`).

### `money` — precise decimal, distinct from `decimal`

`money` is a primitive type for precise-decimal values that must
survive the JSON wire round-trip without precision loss.  Distinct
from `decimal` (which serialises as a JSON number and is lossy
for high-magnitude / high-precision values).

| Aspect | `decimal` | `money` |
|---|---|---|
| JSON wire | `number` (lossy) | `string` with `format: decimal` |
| TS host type | `number` | `decimal.js` `Decimal` |
| .NET host type | `System.Decimal` (lossy through JSON-number boundary) | `System.Decimal` (precise, string-on-wire) |
| Phoenix host type | Elixir `Decimal` (lossy through Jason float) | Elixir `Decimal` (precise — Jason's default) |
| Python host type | `float` (lossy through JSON-number boundary) | `Decimal` (precise, string-on-wire) |
| Java host type | `double` (lossy through JSON-number boundary) | `BigDecimal` (precise, string-on-wire) |
| OpenAPI | `{ type: number }` | `{ type: string, format: decimal }` (PayPal/Coinbase/ISO 20022 convention) |
| Source-level literal | `10.50` | `money("10.50")` |
| Arithmetic | participates in `int < long < decimal` widening | **closed**: see below |

**Closed arithmetic.**  `money` does NOT participate in the
`int → long → decimal` widening chain.  Permitted:
* `money ± money → money`
* `money × {int|long|decimal} → money` (commutative)
* `money ÷ {int|long|decimal} → money`

Everything else involving `money` (e.g. `money + decimal`, `money ×
money`, `decimal ÷ money`) is **rejected** at the type-system layer.
The only bridge between `decimal` and `money` is the `money("…")`
constructor — which accepts a precise-decimal source string.

**Invariants and preconditions** on money are enforced
server-side only (the aggregate's `_assertInvariants` runs the
`.gte()` / `.lte()` / `.eq()` checks at the precise-decimal type);
they're NOT propagated into the wire-layer Zod / FluentValidation
schemas, because client-side JS can't faithfully compare `Decimal`
instances using host operators.

**Best practice.**  Use `money` for fields where precision matters
(prices, balances, tax amounts).  Use `decimal` for rates,
percentages, and other multiplicands where JS-number precision is
acceptable.  The two types compose naturally in scaling: `taxAmount:
money = subtotal * taxRate` where `subtotal: money`, `taxRate:
decimal`.

---

## Statements (in operation bodies)

| Form | Purpose |
| --- | --- |
| `precondition Expression [message "…"]` | Runtime check; failure throws a domain error (HTTP 422 — RS-15).  The optional `message` is the user-facing text. |
| `requires Expression` | Authorization gate (HTTP 403) — `currentUser` / `permissions.<x>` predicate; distinct from `precondition` (validity) and the header `when` (state, 409).  Also a header clause on `operation` / `create` / `handle` / `find` / `projection`.  See [`auth.md`](auth.md). |
| `lhs := Expression` | Assignment to a property reachable from `this`.  Derived properties are not assignable; under `persistedAs: eventLog` assignments live only in `apply` bodies. |
| `coll += value` | Append to a contained collection (or an `X id[]` reference collection). |
| `coll -= value` | Remove from a contained collection. |
| `emit EventName { field: expr, … }` | Raise a domain event; drained by the repository on `save`. |
| `let name = Expression` | Local binding for the rest of the body. |
| `helperName(args)` / `this.op(args)` | Call a helper `function` or `private operation` of the same aggregate (`loom.call-arg-count` / `loom.call-arg-type`). |
| `return Expression` | The designed-in outcome of an operation / handler declared with an `or`-union return type — an `error` variant maps to a ProblemDetails status, a success variant to 200.  See [`payloads.md`](payloads.md). |
| `match subject { Variant [b] => { … }, else => { … } }` | Statement-form variant match — arms run statements (state writes, `navigate(...)`) rather than yield a value.  In a page `action`, `match await Agg.op(...) { Ok r => …, Err e => … }` is how a remote command is awaited and its Result handled — a remote mutating call *without* the marker is `loom.missing-effect-marker`; `loom.match-await*` gates the awaited call's shape ([`actions.md`](actions.md)). |
| `for x in Repo.run(R(args)) { … }` | **Workflow / handler bodies only** — iterate an aggregate array, saving each element's mutations per iteration ([`workflow.md`](workflow.md)). |
| `if let x = Repo.find(C(args)) { … } else { … }` | **Workflow / handler bodies only** — bind an optional repository result and branch on presence. |

---

## Tests

Each aggregate may declare zero or more `test` blocks at the root level
(a value object or `domainService` may nest them too, and a test may be
hoisted beside its subject — or into a `tests/*.ddd` file — as
`test "…" for <Subject> { … }`, where the subject is an aggregate, value
object, domain service, or a bounded context for the in-process
integration rung):

```ddd
test "money literal builds" {
    let m = Money { 10.5, "USD" }
    expect(m.amount).toBe(10.5)
    expect(m.currency).toBe("USD")
}

test "negative money rejected" {
    expect(Money { -1.0, "USD" }).toThrow()
}
```

Assertions are **method-based**: every `expect` carries a matcher — a bare
`expect <bool>` is a validation error.  The matcher set is a closed,
compiler-known catalogue (`toBe` / `toBeGreaterThan(OrEqual)` /
`toBeLessThan(OrEqual)` / `toBeSameInstant` / `toHaveText` / `toHaveCount` /
`toBeVisible` / `toThrow`); they are not methods on a domain type but intrinsic
assertions the compiler type-checks and lowers per backend.  Two are context-
restricted (validator-enforced): `toThrow(<status>)` and `toBeSameInstant` are
only valid in a `test e2e` body — the first pins an HTTP status, the second
compares two ISO-8601 timestamps as *instants* (so a backend that serializes a
datetime as `…00.0000000Z` still equals the canonical `…00Z` on the wire, while
a real difference in time still fails).  Inside a test body the standard
operation statements are allowed plus:

| Form | Lowers to |
| --- | --- |
| `expect(<actual>).<matcher>(…)` | vitest `expect(<actual>).<matcher>(…)` / xUnit `Assert.*` / Playwright matcher. |
| `expect(<call>).toThrow()` | vitest `expect(() => <call>).toThrow()` / xUnit `Assert.Throws<DomainException>(() => <call>)`. |
| `expect(<api-call>).toThrow(<status>)` | e2e only — `.rejects.toThrow(/→ <status>\b/)` (pins the rejected HTTP status). |

Test blocks emit one file per subject on every backend:
- TS: `domain/<aggregate>.test.ts` (vitest).
- .NET: `Tests/<Ns>.Tests/<Plural>/<Aggregate>Tests.cs` (xUnit; value objects under `ValueObjects/`, services under `Services/`).
- Python: `tests/test_<aggregate>.py` (pytest).
- Java: `<Aggregate>Tests.java` in the subject's test package (JUnit).
- Elixir: `test/<context>/<aggregate>_test.exs` (ExUnit).

---

## End-to-end tests against a deployable

Inside a `system`, declare `test e2e` blocks that exercise a running
deployable through HTTP:

```ddd
test e2e "create then confirm an order" against api {
    let cust = api.customers.create({ name: "Ada", email: "ada@example.com" })
    let prod = api.products.create({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } })
    let ord = api.orders.create({ number: "A-1", customerId: cust.id, status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
    api.orders.addLine(ord, { productId: prod.id, qty: 3, price: { amount: 5.0, currency: "USD" } })
    api.orders.confirm(ord)
    let read = api.orders.getById(ord)
    expect(read.status).toBe("Confirmed")
    expect(read.lines.length).toBe(1)
}
```

(The domain is the [complete example](#a-complete-example) at the end of
this document.)  An optional `verifies <TestCase>` after the target links
the test to a traceability `testCase` ([`traceability.md`](traceability.md)).

The magic identifier `api` resolves to the named deployable's HTTP
surface.  Member-access chains describe the call shape:

| Form | Lowers to |
| --- | --- |
| `api.<aggregate>.create({ … })` | `POST /<plural>` with the body. |
| `api.<aggregate>.getById(idExpr)` | `GET /<plural>/{id}`. |
| `api.<aggregate>.destroy(idExpr)` | `DELETE /<plural>/{id}` — the canonical destroy, asserted to answer `204` with an empty body. Available only on an aggregate that declares one (an unnamed `destroy { }`, e.g. via `crudish`). |
| `api.<aggregate>.all(args?)` | `GET /<plural>` — the auto-`findAll` at the **bare collection root**, not `/<plural>/all`. Args ride as the query string (`page`, `pageSize`, `sort`, `dir`). |
| `api.<aggregate>.<operation>(idExpr, body?)` | `POST /<plural>/{id}/<op_snake>` with the body (or `{}` if absent). |
| `api.<aggregate>.<find>(args)` | `GET /<plural>/<find_snake>?…` with args as query string. |
| `api.<projection>.byKey(keyExpr)` | `GET /projections/<proj_snake>/{key}` — one folded read-model row by its correlation key. |
| `api.<projection>.list()` | `GET /projections/<proj_snake>` — every folded read-model row. |

`all` returns whatever the aggregate's `all` find returns, unwrapped by
nobody: the paged envelope (`{ items, page, pageSize, total, totalPages }`)
for a relational aggregate, a bare JSON array where `all` is typed `T[]`
— exactly like a declared collection find, so `expect(xs.items.length)`
reads the same as it does for `find … paged`.

The projection verbs read a folded `projection`'s read model (see
[`projection.md`](old/proposals/projection.md)), so a `test e2e` can
assert the state an operation's events fold into (drive an operation,
then `byKey` the row and `expect` its columns).

An e2e body speaks **wire, not domain**: it sends JSON and reads JSON
back, and it resolves no context-scoped names (one body may drive several
contexts, so there is no single scope to resolve against).  The only
names it binds are its own `let` bindings and the magic receivers
`api`/`ui`.  So an enum value goes in as the string the backend
serializes — `{ status: "Placed" }`, not `{ status: Placed }`.  The bare
form is rejected with `loom.e2e-unresolved-ref`; before that check
existed it lowered to an unresolved reference and emitted an undefined
identifier into the generated test.

When an argument is a previously bound `let` name (typically the result
of a `create` call), `.id` is appended automatically — `api.x.getById(p)`
becomes `GET /x/{p.id}`.

Bare object literals `{ a: 1, b: "x" }` are allowed inside test bodies
(elsewhere in the DSL only `new <PartName> { … }` is permitted).  They
serialize to JSON as the request body.

#### Negative-path assertions — `expect(<call>).toThrow(<status>)`

`expect(<api-call>).toThrow()` asserts the call rejects (any non-2xx). To pin
the *exact* HTTP status — turning a one-backend test into a cross-backend
status **parity** assertion — pass the status to `toThrow`:

```ddd
test e2e "creating a project with an empty name is rejected" against api {
    expect(api.projects.create({ name: "" })).toThrow(422)
}
test e2e "reading a non-existent project is 404" against api {
    expect(api.projects.getById("…")).toThrow(404)
}
```

The lowering recognises `toThrow` and rewrites the `expect` into a throw
assertion, lowering to `.rejects.toThrow(/→ N\b/)` — matching the status the
generated fetch helper surfaces in the thrown error message.  The status
argument is **e2e-only** (an in-process `test` has no wire status — the
validator rejects it there) and must be an integer literal.  The status
contract is identical across every backend: an `invariant` / `check` violation
rejects with **422** (DomainError — RS-15; 400 stays for a malformed body), a missing aggregate with **404**.  Because
every `test e2e` block replays against each backend serving the referenced
module, `toThrow(N)` asserts they all reject with the same status — the
behavioral complement to the static OpenAPI `errorResponseDiffs` parity gate.

The generated vitest file lives at `<system>/e2e/<SystemName>.e2e.test.ts`
in the output directory.  Endpoints default to the docker-compose ports;
override per environment via `E2E_<DEPLOYABLE>_BASE` env vars.

### UI e2e tests against a frontend deployable

The same `test e2e` syntax targets a frontend deployable as long as
the body uses the `ui` identifier instead of `api`:

```ddd
test e2e "create then confirm an order via UI" against webApp {
    let cust = ui.customers.create({ name: "Ada", email: "ada@example.com" })
    let prod = ui.products.create({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } })
    let ord = ui.orders.create({ number: "A-1", customerId: cust.id, status: "Draft", placedAt: "2024-01-01T00:00" })
    ui.orders.addLine(ord, { productId: prod.id, qty: 3, price: { amount: 5.0, currency: "USD" } })
    ui.orders.confirm(ord)
    let read = ui.orders.getById(ord)
    expect(read.status).toBe("Confirmed")
    expect(read.lines.length).toBe(1)
}
```

The test kind is implied by the target deployable's platform —
any frontend deployable (react, vue, svelte, angular, feliz, flutter)
gets a Playwright spec routed through the auto-generated page objects
(`<frontend-deployable>/e2e/pages/<aggregate>.ts`); backend deployables get
the vitest+fetch path described above.  The locator matchers
(`toHaveText` / `toHaveCount` / `toBeVisible`) are the frontend-only half
of the matcher catalogue.

The DSL surface is identical to api e2e (`ui.<aggregate>.<verb>(...)`);
only the lowering differs:

| Form | Lowers to |
| --- | --- |
| `ui.<aggregate>.create({ … })` | `<Agg>ListPage.goto() → create() → fill({…}) → submit()`; returns `{ id }` like the api version. |
| `ui.<aggregate>.getById(idExpr)` | `<Agg>DetailPage.goto(idExpr.id)` plus eager `field("…")` reads of every primitive / enum / VO field, plus `<containment>.length` accessors per contained collection.  The result behaves like the api JSON: `read.status` is a string, `read.lines.length` is a number. |
| `ui.<aggregate>.<operation>(idExpr, body?)` | `<Agg>DetailPage.goto(idExpr.id) → <opName>(body ?? {})` — opens the operation modal, fills it, submits. |

The generated Playwright spec lives at
`<frontend-deployable>/e2e/<SystemName>.ui.spec.ts`.  Run via the existing
Playwright config in that directory (`npx playwright test` from
`<frontend-deployable>/e2e/`).

## Repositories

```ddd
repository Orders for Order {
    // unique-key reconstitution: parameter names match aggregate properties.
    find byNumber(number: string): Order?

    // explicit predicate; `this` refers to the aggregate root.
    find activeForCustomer(forCustomer: Customer id): Order[]
        where this.customerId == forCustomer && this.status == Draft
}
```

The full form is `find name(params): T | T? | T[] | T paged [requires Expr]
[where Expr] [ignoring Cap, … | ignoring *]` — `requires` is the read-side
authorization gate, `ignoring` bypasses a capability's contributed query
filter (e.g. `softDeletable`).  Each `find` declaration becomes a method
on the generated repository plus a Mediator query in the .NET backend.

> **List finds warn.**  A `find` returning a collection (`T[]` / `T paged`)
> is flagged `loom.repository-find-deprecated`: the list read-path is
> `Repo.run(<Criterion>(args))` / a named `retrieval` (composable, page-able,
> SQL-inlined — see [`criterion.md`](criterion.md)), so a bespoke list finder
> on the repository is discouraged.  A unique-key find returning `T` / `T?`
> is the intended shape.  (The `activeForCustomer` find above still generates;
> it just carries the warning.)

- **TypeScript**: when no `where` is given, parameters are equality-
  matched against aggregate columns and lowered to a Drizzle
  `where(eq(...))`.  When `where` is given, the IR expression is
  lowered to Drizzle operators (`eq`/`ne`/`lt`/`lte`/`gt`/`gte`/
  `and`/`or`/`not`/`inArray`) over `this.<col>` and
  `this.<vo>.<sub>` references, including the membership form
  `this.<refColl>.contains(param)` against an `X id[]` join table.
  The queryable-subset validator rejects shapes that don't fit (e.g.
  `.count`, `.any`, lambdas) with a clear diagnostic.
- **.NET**: both forms lower to a LINQ `.Where(x => …)` predicate and
  pass through EF Core to SQL.

A repository `where` clause may use `this.<refColl>.contains(param)` to
query membership over an `X id[]` reference collection — for example,
`find holdingInParty(pokemon: Pokemon id): Trainer[] where
this.party.contains(pokemon)`.  The TypeScript backend lowers this to
an `inArray(...subquery...)` against the field's join table; other
collection operations (`.count`, `.any`, `.where`, …) remain rejected
by the queryable-subset validator.

`findById` and `getById` are auto-generated for every aggregate
(no need to declare them in the repository).  An auto-included
`find all(): T[]` is also added to every aggregate's repository, so
all five backends always expose `GET /<plural>` and every frontend
(react, vue, svelte, angular, feliz, flutter) always has a list page to
render.  Declaring your own `find all(...)` in the DSL overrides the
implicit one.

---

## Validation rules

The validator runs after parsing and reports errors for:

- `precondition` and `invariant` expressions whose type is not `bool`.
- A blank `message "..."` clause — empty or whitespace-only — on an
  `invariant`, property `check`, or `precondition` (`loom.blank-message`). A
  blank message renders an empty user-facing error string (and degenerates the
  content-hashed wire `code` derived from it), so it's almost always a typo.
- Field / parameter / call / member-access type mismatches.
- Access to a member that doesn't exist on a fully-resolved record
  receiver — `order.totl`, `paid.amont`, `this.noField` (`loom.unknown-member`).
  Covers aggregates (including fields inherited via `extends`), entity
  parts, value objects, events / payloads, and `X id` references; it does
  not fire on collection ops (`lines.first`), string members (`s.length`),
  or receivers whose type couldn't be resolved.
- Assignment to a derived property.
- `emit` payloads that don't match the event's declared shape.
- **Record construction** (`X { field: value }` for a value object, entity part,
  or `error` / `payload` / … record) is checked on three axes at every
  construction site (operation / create / destroy bodies, property defaults,
  `derived` / `invariant` / `function` bodies): an entry naming a field the
  record doesn't declare (`loom.unknown-construction-field`), an entry whose
  value type isn't assignable to the declared field (`loom.construction-field-type`),
  and a construction that omits a **required** field — a declared `Property` that
  is non-optional, has no `= default`, and isn't `provenanced`
  (`loom.construction-missing-field`; `contains` members auto-default to empty,
  so they're never required).
- **Call arguments** — an operation / function call with the wrong number of
  arguments (`loom.call-arg-count`) or a wrong-typed argument
  (`loom.call-arg-type`), at both statement position (`bump(a)`, `o.bump(a)`) and
  expression position (free calls `fee(a)` and member calls `price.scaled(a)` in
  `derived` / `let` / `precondition` / …). Criterion / policy-function calls keep
  their own arity gate (`loom.criterion-arity`) and share the argument **type**
  check. Bare-name arguments that don't resolve, and ergonomic numeric-literal
  promotions (`bump(5)` into a `money` / `decimal` param), are admitted exactly
  as elsewhere.
- Unknown / out-of-scope `X id` targets (`loom.bare-aggregate-in-type` for
  a bare aggregate name in a storage / wire position).
- `contains` referencing a part that belongs to a different aggregate.
- `operation` / `create` / `destroy` declared outside an aggregate root; a
  `test` outside its subject without a `for <Subject>` head
  (`loom.test-needs-target`), or with a redundant one (`loom.test-redundant-for`).
- A frontend deployable (`react`, `vue`, `svelte`, `angular`, `feliz`,
  `flutter`) without a `targets:` field, or pointing `targets:` at another
  frontend deployable, or without a `ui:` binding.
- A non-frontend deployable using `targets:` (only valid on frontends).

The list above is the classic core.  The catalogue today carries ~460
`loom.*` codes (`src/diagnostics/messages.ts` is the single source of the
wording; `test/system/diagnostic-catalog.test.ts` pins that every code a
validator raises is in it).  By family, with the doc that explains each:

| Family (prefix) | What it gates | Reference |
|---|---|---|
| `loom.projection-*` (~35) | Projection sources / `select` / `group by` / `keyed` / folds / paging / per-backend support | [`language-reference/10-repositories-and-queries.md`](language-reference/10-repositories-and-queries.md) |
| `loom.workflow-*` (~30), `loom.applier-*`, `loom.lifecycle-*` | Workflow bodies, reactors, `create`/`handle`, appliers, event-sourced lifecycle | [`workflow.md`](workflow.md) |
| `loom.policy-*`, `loom.permission-*`, `loom.field-mask-*`, `loom.auth-*`, `loom.*-gate-not-current-user`, `loom.guard-principal-without-auth` | Policy ladder / deny carve-outs / named policy functions, `implies`, `mask unless`, OIDC config, `requires` gates | [`auth.md`](auth.md) |
| `loom.tenancy-*`, `loom.tenant-*`, `loom.cross-tenant-without-tenancy`, `loom.orgpath-without-tenancy` | The explicit-stance rule, registry / claim wiring, `crossTenant` | [`tenancy.md`](tenancy.md) |
| `loom.migration-*`, `loom.rename-*`, `loom.backfill-*`, `loom.unique-*` | `migration { … }` ledger steps, destructive / rebaseline gating, `unique (…)` | [`migrations.md`](migrations.md) |
| `loom.handler-*`, `loom.command-handler-*`, `loom.query-handler-*`, `loom.route-handler-unresolved`, `loom.extern-*` | `commandHandler` / `queryHandler` contracts, `api` routes, extern pairing | [`extern.md`](extern.md), [`architecture.md`](architecture.md) |
| `loom.criterion-*`, `loom.retrieval-*`, `loom.find-*`, `loom.findall-*`, `loom.repository-find-deprecated` | Criteria purity / arity / aliasing, retrievals, the queryable subset | [`criterion.md`](criterion.md) |
| `loom.union-*`, `loom.payload-*`, `loom.generic-*`, `loom.match-*` | `A or B` unions, payload records, `paged` / `envelope` / `option` carriers, `match` exhaustiveness and subjects | [`payloads.md`](payloads.md) |
| `loom.channel*`, `loom.reactor-*`, `loom.relay-*`, `loom.timer-*` | Channels, channelSources, reactors, timers | [`channels.md`](channels.md) |
| `loom.resource-*`, `loom.datasource-*`, `loom.file-*`, `loom.config-*`, `loom.index-suggestion` | Resource bindings, storage kinds, `File` fields, vendor config, index advice | [`resources.md`](resources.md) |
| `loom.seed-*` | Seed rows vs abstract / event-sourced / tenant-owned aggregates, `raw` columns | [`language-reference/23-domain-services-and-seeds.md`](language-reference/23-domain-services-and-seeds.md) |
| `loom.macro-*`, `loom.unknown-macro`, `loom.scaffold-*`, `loom.softdelete-*`, `loom.capability-*`, `loom.stamp-*`, `loom.filter-*`, `loom.ignoring-clause-placement` | Macro args / targets, scaffold params, capability hosts, filters / stamps, `ignoring` placement | [`scaffold-macros.md`](scaffold-macros.md), [`capabilities.md`](capabilities.md) |
| `loom.abstract-*`, `loom.extends-*`, `loom.tph-*`, `loom.polymorphic-*` | Inheritance, TPH / TPC layout | [`inheritance.md`](inheritance.md) |
| `loom.intrinsic-*`, `loom.duration-*`, `loom.interp-*`, `loom.ternary-*`, `loom.call-arg-*`, `loom.construction-*`, `loom.unknown-*`, `loom.bare-collection-accessor`, `loom.user-visible-concat` | Expression typing — intrinsics, durations, interpolation formats, ternaries, calls, record construction, names / members | this document, [`stdlib.md`](stdlib.md) |
| `loom.function-*`, `loom.when-unsupported`, `loom.blank-message`, `loom.entity-field-*`, `loom.duplicate-*` | Functions, `when` gates, messages, entity-typed fields, duplicate names / ports / tables | this document |
| `loom.ui-*`, `loom.page-primitive*`, `loom.store-*`, `loom.datagrid-*`, `loom.chart-*`, `loom.table-*`, `loom.a11y-*`, `loom.slot-*`, `loom.component-*`, `loom.action-*`, `loom.missing-effect-marker`, `loom.match-await*`, `loom.feliz-*`, `loom.flutter-*`, `loom.heex-*`, `loom.frontend-*` | Page metamodel, primitive arity / args, stores and lifetimes, grids / charts, accessibility, slots, actions and effect markers, per-frontend support gaps | [`page-metamodel.md`](page-metamodel.md), [`actions.md`](actions.md) |
| `loom.e2e-*`, `loom.test-*`, `loom.context-test-unsupported` | e2e bodies, test placement | this document, [`testing.md`](testing.md) |
| `loom.domain-service-*` | Domain-service purity / read rules | [`domain-services.md`](domain-services.md) |
| `loom.provenanced-*`, `loom.audit-*`, `loom.correlation-*` | Provenance, audit trails, correlation keys | [`provenance.md`](provenance.md), [`observability.md`](observability.md) |
| `loom.platform-*`, `loom.java-*`, `loom.vanilla-*`, `loom.*-unsupported-backend`, `loom.*-unsupported` | Honest per-backend / per-adapter gaps — the feature parses but the selected target cannot emit it | [`generators.md`](generators.md), [`platforms.md`](platforms.md) |

Warnings (non-fatal):

- Self-recursive operation calls (often unintentional).
- `emit` payloads missing optional fields.
- A workflow `on(e: Event)` reactor or event-triggered `create(e: Event) by`
  starter whose event no `channel` carries (`loom.reactor-event-uncarried`):
  in-process dispatch is channel-routed, so the consumer would never fire —
  declare a `channel { carries: … }` for the event.
- A `projection` `on(e: Event)` fold whose event no `channel` carries
  (`loom.projection-event-uncarried`): the projection twin of the reactor rule —
  the fold never runs and the read-model row is never written, so declare a
  `channel { carries: … }` for the folded event.
- A reactor / event-create whose event is carried by **more than one** channel
  in its context (`loom.reactor-channel-ambiguous`): in-process dispatch records
  the first channel by declaration order, so the binding is ambiguous — carry
  the event on a single channel to keep routing explicit.
- A frequently-filtered column with no covering index (`loom.index-suggestion`,
  D-INDEX-SUGGEST): advisory only — add a manual `resource index: [...]` if the
  access pattern warrants it. See [`resources.md`](resources.md).

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

    event OrderConfirmed { order: Order id, at: datetime }

    aggregate Customer {
        name: string
        email: string
        derived display: string = name
    }
    aggregate Product {
        sku: string
        price: Money
        derived display: string = sku
    }

    aggregate Order {
        number: string
        customerId: Customer id
        status: OrderStatus
        placedAt: datetime
        contains lines: OrderLine[]

        derived total: Money =
            Money { lines.sum(l => l.subtotal.amount), "USD" }

        invariant lines.count > 0 when status == Confirmed

        function isMutable(): bool = status == Draft

        operation addLine(productId: Product id, qty: int, price: Money) {
            precondition isMutable()
            precondition qty > 0
            lines += OrderLine {
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
            productId: Product id
            quantity: int
            unitPrice: Money
            derived subtotal: Money =
                Money { unitPrice.amount * quantity, unitPrice.currency }
            invariant quantity > 0
        }

        test "money literal builds" {
            let m = Money { 10.5, "USD" }
            expect(m.amount).toBe(10.5)
            expect(m.currency).toBe("USD")
        }
    }

    repository Orders for Order {
        find byNumber(number: string): Order?
    }
}
```
