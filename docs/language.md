# Loom — Language Reference

Loom is a high-descriptive DSL for **Domain-Driven Design**.  A `.ddd`
source describes one or more bounded contexts, each containing the
familiar DDD primitives — aggregates, value objects, enums, events,
repositories — with strongly-typed invariants, operations, and a small
expression language.

This document defines the language formally.  For the architectural
view (AST → IR → templates) see [`technical.md`](technical.md); for CLI
and tooling see [`tools.md`](tools.md).

---

## Lexical structure

- **Comments**: `// line` and `/* block */`.
- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`.  Case-sensitive.
- **String literals**: double-quoted, standard backslash escapes.
- **Number literals**: `INT` (`/[0-9]+/`) and `DECIMAL` (`/[0-9]+\.[0-9]+/`).
- **Whitespace** and comments are ignored between tokens.

Reserved keywords:

```
context  enum  valueobject  aggregate  entity  contains  ids
event  repository  for  find  where
derived  invariant  when  function  operation  private
precondition  emit  let  expect  test  new
true  false  null  this  id
int  long  decimal  money  string  bool  datetime  guid  json
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
- **`valueobject`, `enum`, and `component` may appear at the model root.**
  They form an implicit shared kernel — visible workspace-wide from every
  importing file.  Value objects and enums resolve into every context's
  type space; top-level `component` declarations resolve from every page
  body in every ui in every system (ui-scope components shadow on name
  collision).  See [`page-metamodel.md`](page-metamodel.md) §5.1.
- Aggregates, events, repositories, workflows, and views stay inside
  a context, as before.
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
| `deployable name { platform: dotnet\|node\|elixir\|python\|java\|phoenixLiveView, contexts: [A, B], dataSources: [X, Y], port: N, auth: required? }` | A concrete artefact: one project, one HTTP server, one DbContext, listening on `port`.  `contexts:` names which bounded contexts this deployable hosts; `dataSources:` lists the system-scope `resource` decls that route those contexts' persistence (every hosted aggregate must have a matching binding — see the `resource` row below; the clause keyword stays `dataSources:` for compatibility).  Optional `auth: required` enables JWT-decode middleware on this deployable; see [`auth.md`](auth.md). |
| `deployable name { platform: react, targets: <other-deployable>, port: N }` | A frontend deployable: a Vite-built React + RQ + Zod + Mantine SPA whose API base URL is wired to `targets`'s port.  Hosted contexts are inherited from the target. |
| `deployable name { platform: svelte, targets: <other-deployable>, port: N }` | The Svelte frontend deployable: a Svelte 5 / SvelteKit static SPA (adapter-static, ssr off) + svelte-query + Zod, rendered against a svelte design pack (`shadcnSvelte` default, or `flowbite`).  Same contract as `react` — `targets:` a backend, inherits its contexts. |
| `deployable name { platform: vue, targets: <other-deployable>, port: N }` | A Vue 3 frontend deployable: a Vite-built vue-router + vue-query + Zod SPA (design packs `vuetify` / `shadcnVue`), same `targets:` contract as `react`. |
| `deployable name { platform: angular, targets: <other-deployable>, port: N }` | An Angular SPA frontend deployable (angularMaterial design pack), same `targets:` contract as `react`. |
| `context Name { … }` | Allowed directly inside a system; treated as if it were in an implicit `_default` subdomain. |
| `test e2e "name" against <deployable> { … }` | End-to-end test that runs against the named deployable's HTTP API; lowers to a vitest file at the system output root. |
| `user { id: string, role: string, … }` | System-wide JWT-claim shape decoded by the verifier hook.  At most one per system; required when any deployable opts in via `auth: required`.  The `currentUser` magic identifier in operation / workflow / view-bind expressions is typed against this shape.  See [`auth.md`](auth.md). |
| `theme { primary: "#…", radius: "md", … }` | System-wide visual identity — design tokens consumed by every frontend (react, vue, svelte, angular) and Phoenix LiveView deployable in this system.  At most one per system.  Colour properties (`primary`, `secondary`, `accent`, `success`, `warning`, `error`, `neutral`) accept CSS hex values (`#RGB` / `#RRGGBB` / `#RRGGBBAA`).  `radius` is one of `none / sm / md / lg / xl`.  `fontFamily` and `fontFamilyMono` are free-form strings.  `colorScheme` is `light / dark / auto`.  Unknown property names and invalid values are validator errors. |
| `api Name from <Subdomain>` | First-class API contract derived from a subdomain's domain (aggregates expose `all / byId / create / update / delete`, repositories expose their finds, workflows expose mutations, views expose queries).  Backend deployables `serves:` an api; UIs reference one via `api X: <ApiName>` parameters.  See [`architecture.md`](architecture.md). |
| `storage Name { type: postgres\|redis\|kafka\|s3\|rabbitmq\|restApi\|… }` | Typed physical store / service reusable across deployables.  `type:` names the built-in **sourceType** that realizes it.  v0 fully supports `postgres`; object-store / queue / external-api types (`s3`, `rabbitmq`, `restApi`) activate dev-compose sidecars + client emission; the rest parse but don't activate generator output.  Optional `config { k: v }` map for vendor parameters (region, bucket, vhost, …).  See [`resources.md`](resources.md). |
| `resource Name { for: <Ctx>, kind: <k>, use: <storage>, … }` | The configured binding (renamed from `dataSource`) from a bounded context's data of kind `state` / `eventLog` / `snapshot` / `cache` / `replica` / `objectStore` / `queue` / `api` to a physical `storage`.  Optional knobs: `schema`, `tablePrefix`, `keyPrefix`, `ttl`, `every`, `retain`, `isolationLevel`, `readonly`, `shape`, `config { … }`.  Every backend deployable hosting an aggregate must list a matching `resource` under its `dataSources:` field.  See [`resources.md`](resources.md) for the full model (sourceTypes, kinds, capabilities, interfaces) and workflow-level consumption. |
| `ui Name { … }` | Block of pages, components, menu, and api parameters that a deployable binds via `ui:`.  See [`page-metamodel.md`](page-metamodel.md). |

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
used in operation / workflow expression bodies.  The
`permissions.<name>` magic identifier lowers to the runtime string
`<lowercase-subdomain>.<name>`; see [`auth.md`](auth.md).

#### Deployable platforms

| `platform:` | Stack |
| --- | --- |
| `dotnet` | ASP.NET Core + EF Core + Mediator (martinothamar) + Swashbuckle.  Default port 8080. |
| `node`   | Hono + Drizzle ORM + Zod with `@hono/zod-openapi`.  Default port 3000. |
| `elixir` / `phoenixLiveView` | Phoenix + Ecto (plain Ecto/Phoenix — the Ash foundation and the `foundation:` axis were removed).  `phoenixLiveView` additionally mounts a HEEx UI (fullstack). |
| `python` | FastAPI + SQLAlchemy + Pydantic. |
| `java`   | Spring Boot + JPA + Hibernate. |
| `react`  | Vite + React Router + React Query + Zod + Mantine + Playwright page objects.  Default port 3001. |
| `vue`    | Vite + vue-router + vue-query + Zod (design packs `vuetify` / `shadcnVue`). |
| `svelte` | Svelte 5 / SvelteKit static SPA + svelte-query + Zod (`shadcnSvelte` / `flowbite`). |
| `angular` | Angular SPA (angularMaterial pack). |

Backend deployables (`dotnet`, `node`, `elixir`, `python`, `java`,
`phoenixLiveView`) declare
`contexts: [...]` (which bounded contexts they host) and
`dataSources: [...]` (the system-scope `resource` decls that route
those contexts' persistence).  React deployables declare
`targets: <other-deployable>` instead — the frontend's API base URL
is wired to the target's port and its hosted contexts are inherited
from the target so pages exactly cover the API surface.  See
[`resources.md`](resources.md) for the storage/resource model
and [`generators.md`](generators.md) for what each platform emits per
aggregate.

### Inside a context

Inside a context, the following kinds of declarations may appear, in any
order:

| Form | Purpose |
| --- | --- |
| `enum Name { A, B, C }` | Closed enumeration; values are referenced bare. |
| `valueobject Name { … }` | Immutable record with optional invariants and derived members. |
| `aggregate Name [ids guid] [persistedAs(eventLog\|state)] [shape(relational\|embedded\|document)] { … }` | Aggregate root with implicit `Name id` field (always a `guid`; `ids guid` is an optional explicit spelling — `ids int\|long\|string` were removed, see the identity note below).  Header modifiers (D-DOCUMENT-AXIS): `persistedAs(…)` picks the primary truth kind (default `state`); `shape(…)` picks the saving shape (default `relational`) — how the hierarchy is laid out physically: **`relational`** = table-per-entity; **`embedded`** = queryable root row + contained parts folded into one JSONB column (EF owned `.ToJson()` / Drizzle jsonb / Ecto embedded schemas); **`document`** = the whole aggregate as one opaque JSONB blob (`id, data, version`).  Emitted on all backends for `relational`/`embedded`; `document` on all five backends — `dotnet`, `node`, `python`, `java`, and `elixir` (Route A — plain Phoenix persists the aggregate as a typed `embeds_one` embed) (a `shape(…)` a backend can't emit is a validation error — see `supportedShapes`). |
| `event Name { field: Type, … }` | Flat record raised via `emit`. |
| `repository Name for Aggregate { find … }` | Repository declaration with optional find queries. |
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

The underlying value type is always `guid`. `ids guid` may be written
explicitly (a no-op spelling of the default); `ids int|long|string` were
removed — no backend implemented id generation for a non-guid primary key, so
declaring one produced an app that collided on the second insert. See
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
`contains lines: OrderLine[]` declares entity parts that live and die
with the parent — a child table joined on `parent_id`.  `X id[]` is a
list of references to a *different* aggregate that outlives any one
owner — persisted as a separate join table when the backend supports
it (see [`docs/generators.md`](generators.md)).

### Aggregate inheritance

An aggregate may extend a shared base so subtypes carry a common field set and
can be queried polymorphically:

| Form | Notes |
| --- | --- |
| `abstract aggregate <Name> { … }` | A base that is never instantiated: no table / repository / routes of its own. May declare fields and `derived` getters; may **not** declare `create` / `operation` behaviour or a `repository`. |
| `aggregate <X> extends <Base> { … }` | A concrete subtype. `<Base>` must be an `abstract aggregate` in the same context. Inherits the base's fields (merged into the wire shape ahead of its own; an own field shadows a like-named base field). |
| `inheritanceUsing(sharedTable \| ownTable)` | Header modifier (on the base, optionally per concrete) choosing the table-mapping strategy. Default `sharedTable` (TPH). `ownTable` (TPC) emits a standalone table per concrete. |

`find all <Base>` returns the polymorphic union of all subtypes via a per-backend
reader. TPC (`ownTable`) is emitted on every backend; TPH (`sharedTable`) is
emitted on all five backends. See
[`inheritance.md`](inheritance.md) for the per-backend emission, the validation
rules, and the deferred patterns.

### Aggregate / entity-part members

Inside an aggregate or an `entity` part:

| Form | Notes |
| --- | --- |
| `name: TypeRef [provenanced] [sensitive(tags)] [access] [check Expr]` | Property, with optional modifiers (in this order). `provenanced` records assignment lineage (below); `sensitive(...)` tags the field for log-redaction / inspect; `access` is one of `immutable / managed / token / internal / secret` (default: `editable` — see [Field access modifiers](#field-access-modifiers) below); `check Expr` is a per-field validation predicate. |
| `contains name: PartName[]` | Containment of a part declared within the same aggregate; collection. |
| `contains name: PartName` | Containment, single (required). |
| `contains name: PartName?` | Containment, single (optional) — the part may be absent at runtime; serialised as a nullable wire field.  `[]?` is rejected: an empty collection already encodes absence. |
| `derived name: TypeRef = Expression` | Computed read-only property. |
| `derived display: string = Expression` | **Reserved** — declares the aggregate's user-facing label.  When present, `string(aggregate)` and implicit `"x " + aggregate` compile to a member access on this derived; React Select pickers use it for option text.  Without it, those expressions are compile errors. |
| `derived inspect: string = Expression` | **Reserved** — declares the aggregate's developer-facing debug form.  Auto-generated when omitted (structural form, sensitive fields shown as `<redacted>`).  Backends emit it as `ToString()` / `[util.inspect.custom]` / `Inspect` so debugger watches, exceptions, and logger output get a useful representation. |
| `invariant Expression [when Expression]` | `bool` predicate; checked after every mutation. Optional `when` is a guard. |
| `function name(params): TypeRef = Expression` | Pure helper (expression form); callable from any expression in the same aggregate. Stays SQL-inlinable like a `criterion`. |
| `function name(params): TypeRef { … }` | Pure helper (block form); `let` + branch (ternary/`match`) + bug-regime `precondition`/`requires`, ending in `return`. Still **pure** — no mutation, no `emit`, no repository / operation / domain-service / extern call. **Not queryable** (a block-form call is rejected in a `where` / `criterion` / view filter). |
| `operation name(params) { … }` | Public mutating method (root only). |
| `private operation name(params) { … }` | Mutating method, only callable from within the same aggregate root. |
| `operation name(params) extern { precondition … }` | Public op whose business decision lives in user code; body must contain only `precondition` statements. See `extern.md`. |
| `operation name(params) when <pred> { … }` | **canCommand state gate** (criterion.md, use site 2): `<pred>` is a pure bool predicate over the aggregate's own state (op params are out of scope — `loom.when-references-op-param`), evaluated against the loaded instance before the body. False → 409 "Disallowed" ProblemDetails; a side-effect-free `GET /{id}/can_<op>` companion returns `{ allowed }` for UI enablement. Named criteria / aggregate functions inline like any bool position. Supported on all five backends (node, dotnet, python, elixir, java). Distinct from `requires` (auth, 403) and `precondition` (argument validation, 400). |
| `apply(e: <Event>) { … }` | **Event-sourcing fold** (only on a `persistedAs(eventLog)` aggregate).  Folds one emitted event type into state — a pure transition: assignments / collection mutations / `let` only, no `emit`, no side-effecting calls, no guards.  One `apply` per event type.  See the event-sourcing note below. |
| `view name = Aggregate where filter` | Shorthand: saved query, source's wire shape.  Exposed at `GET /views/<snake>`. |
| `view name { fields ... from Aggregate where? bind ... }` | Full form: declared output shape with bind-expression projections.  See `views.md`. |
| `entity Name { … }` | Nested part declaration (inside an aggregate). |
| `test "name" { … }` | Test block; lowers to vitest / xUnit (root only). |

Entity parts may declare any of the above except `operation` and `test`
(those live on the root).

#### Event sourcing — `persistedAs(eventLog)` + `apply(...)`

An aggregate marked `persistedAs(eventLog)` in its header is **event-sourced**:
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

aggregate Account ids guid persistedAs(eventLog) {
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
aggregate Order ids guid {
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
traced back to the snapshot that produced it at runtime. Provenance trace code
is emitted on the TypeScript/Hono, .NET, and elixir-vanilla backends; the
remaining backends parse the keyword but emit no trace code. See `examples/provenance.ddd` for a runnable backend example and the
`Provenance System` playground example for the same domain as a Hono + React
system.

### Field access modifiers

Every property gets an **access modifier** that governs how it
participates in input DTOs, the update wire shape, and view / API
read exposure.  The grammar form is

```
name: TypeRef [provenanced] [sensitive(...)] [immutable|managed|token|internal|secret]
```

The default — no keyword — is `editable`.  The five keywords (and
the implicit `editable`) form this matrix:

| Modifier | Client read | In `create(...)` input | In `update(...)` input | In view payloads |
|---|---|---|---|---|
| `editable` *(default)* | ✓ | ✓ | ✓ | ✓ |
| `immutable` | ✓ | ✓ | ✗ (server rejects) | ✓ |
| `managed` | ✓ | ✗ (server owns it) | ✗ | ✓ |
| `token` | ✓ | ✗ | ✓ (echoed unchanged, like `id`/`version`) | ✓ |
| `internal` | ✗ (never exposed via API) | ✗ | ✗ | ✓ (views may project it) |
| `secret` | ✗ (never disclosed) | ✓ | ✓ (write-only) | ✗ |

Examples:

```ddd
aggregate User {
  email: string                            // editable (default)
  createdAt: datetime managed              // server stamps it
  passwordHash: string secret              // accepted on create + update; never sent back
  version: int token                       // round-tripped for optimistic concurrency
  isDeleted: bool internal                 // hidden from clients; views may read
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
TypeRef       = BaseType ('[]')? ('?')?
BaseType      = PrimitiveType | SlotType | IdType | NamedType
IdType        = Identifier 'id'                // cross-aggregate FK
NamedType     = Identifier                     // bare name
PrimitiveType = 'int' | 'long' | 'decimal' | 'money' | 'string' | 'bool' | 'datetime' | 'guid' | 'json'
SlotType      = 'slot'                         // element-shaped param marker — UI-only
MoneyLit      = 'money' '(' STRING ')'         // precise-decimal literal
```

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
| `cond ? a : b` | Ternary. |
| `x => expr` | Lambda (only valid as a collection-op argument). |
| `PartName { field: expr, … }` | Construct a contained part; `id` and parent `parentId` are auto-injected. |
| `Money { amount, currency }` | Value-object constructor. |

### String interpolation

A **backtick-delimited** template with `{expr}` holes. It lowers to plain string
concatenation of the literal segments and the `string()`-converted holes, so it is
exactly `"…" + string(hole) + …` written more legibly — it works anywhere a `string`
expression is valid (derived members, labels, view binds, function bodies).

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
- **Escaping** — a literal brace or backtick in the text is `\{` / `\}` / `` \` ``;
  `\n` / `\t` / `\\` behave as in a string literal.
- **Not queryable** — an interpolated string desugars to `+`/`convert`, so (like any
  concatenation) it cannot appear in a `find` / `view` `where:` clause.

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

### Numeric widening

Within arithmetic, `int < long < decimal`.  An `int` is assignable to
`long` or `decimal`; a `long` to `decimal`.

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
| `precondition Expression` | Runtime check; failure throws a domain error (HTTP 400). |
| `lhs := Expression` | Assignment to a property reachable from `this`.  Derived properties are not assignable. |
| `coll += value` | Append to a contained collection. |
| `coll -= value` | Remove from a contained collection. |
| `emit EventName { field: expr, … }` | Raise a domain event; drained by the repository on `save`. |
| `let name = Expression` | Local binding for the rest of the operation body. |
| `helperName(args)` | Call a helper `function` or `private operation` of the same aggregate. |

---

## Tests

Each aggregate may declare zero or more `test` blocks at the root level:

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
`toBeLessThan(OrEqual)` / `toHaveText` / `toHaveCount` / `toBeVisible` /
`toThrow`); they are not methods on a domain type but intrinsic assertions the
compiler type-checks and lowers per backend.  Inside a test body the standard
operation statements are allowed plus:

| Form | Lowers to |
| --- | --- |
| `expect(<actual>).<matcher>(…)` | vitest `expect(<actual>).<matcher>(…)` / xUnit `Assert.*` / Playwright matcher. |
| `expect(<call>).toThrow()` | vitest `expect(() => <call>).toThrow()` / xUnit `Assert.Throws<DomainException>(() => <call>)`. |
| `expect(<api-call>).toThrow(<status>)` | e2e only — `.rejects.toThrow(/→ <status>\b/)` (pins the rejected HTTP status). |

Test blocks emit one file per aggregate:
- TS: `domain/<aggregate>.test.ts` (vitest).
- .NET: `Tests/<Plural>/<Aggregate>Tests.cs` (xUnit).

---

## End-to-end tests against a deployable

Inside a `system`, declare `test e2e` blocks that exercise a running
deployable through HTTP:

```ddd
test e2e "create then confirm an order" against api {
    let prod = api.products.create({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } })
    let ord = api.orders.create({ customerId: "cust-001", status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
    api.orders.addLine(ord, { productId: prod.id, qty: 3 })
    api.orders.confirm(ord)
    let read = api.orders.getById(ord)
    expect read.status == "Confirmed"
    expect read.lines.length == 1
}
```

The magic identifier `api` resolves to the named deployable's HTTP
surface.  Member-access chains describe the call shape:

| Form | Lowers to |
| --- | --- |
| `api.<aggregate>.create({ … })` | `POST /<plural>` with the body. |
| `api.<aggregate>.getById(idExpr)` | `GET /<plural>/{id}`. |
| `api.<aggregate>.<operation>(idExpr, body?)` | `POST /<plural>/{id}/<op_snake>` with the body (or `{}` if absent). |
| `api.<aggregate>.<find>(args)` | `GET /<plural>/<find_snake>?…` with args as query string. |

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
    expect(api.projects.create({ name: "" })).toThrow(400)
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
rejects with **400** (DomainError), a missing aggregate with **404**.  Because
every `test e2e` block replays against each backend serving the referenced
module, `toThrow(N)` asserts they all reject with the same status — the
behavioral complement to the static OpenAPI `errorResponseDiffs` parity gate.

The generated vitest file lives at `<system>/e2e/<SystemName>.e2e.test.ts`
in the output directory.  Endpoints default to the docker-compose ports;
override per environment via `E2E_<DEPLOYABLE>_BASE` env vars.

### UI e2e tests against a react deployable

The same `test e2e` syntax targets a frontend deployable as long as
the body uses the `ui` identifier instead of `api`:

```ddd
test e2e "create then confirm an order via UI" against webApp {
    let prod = ui.products.create({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } })
    let ord = ui.orders.create({ customerId: "cust-001", status: "Draft", placedAt: "2024-01-01T00:00" })
    ui.orders.addLine(ord, { productId: prod.id, qty: 3 })
    ui.orders.confirm(ord)
    let read = ui.orders.getById(ord)
    expect read.status == "Confirmed"
    expect read.lines.length == 1
}
```

The test kind is implied by the target deployable's platform —
any frontend deployable (react, vue, svelte, angular) gets a Playwright
spec routed through the auto-generated page objects
(`<frontend-deployable>/e2e/pages/<aggregate>.ts`); backend deployables get
the vitest+fetch path described above.

The DSL surface is identical to api e2e (`ui.<aggregate>.<verb>(...)`);
only the lowering differs:

| Form | Lowers to |
| --- | --- |
| `ui.<aggregate>.create({ … })` | `<Agg>ListPage.goto() → create() → fill({…}) → submit()`; returns `{ id }` like the api version. |
| `ui.<aggregate>.getById(idExpr)` | `<Agg>DetailPage.goto(idExpr.id)` plus eager `field("…")` reads of every primitive / enum / VO field, plus `<containment>.length` accessors per contained collection.  The result behaves like the api JSON: `read.status` is a string, `read.lines.length` is a number. |
| `ui.<aggregate>.<operation>(idExpr, body?)` | `<Agg>DetailPage.goto(idExpr.id) → <opName>(body ?? {})` — opens the operation modal, fills it, submits. |

The generated Playwright spec lives at
`<react-deployable>/e2e/<SystemName>.ui.spec.ts`.  Run via the existing
Playwright config in that directory (`npx playwright test` from
`<react-deployable>/e2e/`).

## Repositories

```ddd
repository Orders for Order {
    // convention-based: parameter names match aggregate properties.
    find byCustomer(customerId: Customer id): Order[]

    // explicit predicate; `this` refers to the aggregate root.
    find activeForCustomer(forCustomer: Customer id): Order[]
        where this.customerId == forCustomer && this.status == Draft
}
```

Each `find` declaration becomes a method on the generated repository
plus a Mediator query in the .NET backend.

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
(react, vue, svelte, angular) always has a list page to render.  Declaring your own `find all(...)`
in the DSL overrides the implicit one.

---

## Validation rules

The validator runs after parsing and reports errors for:

- `precondition` and `invariant` expressions whose type is not `bool`.
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
- Unknown / out-of-scope `X id` targets.
- `contains` referencing a part that belongs to a different aggregate.
- Operations or `test` blocks declared outside an aggregate root.
- A frontend deployable (`react`, `vue`, `svelte`, `angular`) without a
  `targets:` field, or pointing `targets:` at another frontend deployable.
- A non-frontend deployable using `targets:` (only valid on frontends).

Warnings (non-fatal):

- Self-recursive operation calls (often unintentional).
- `emit` payloads missing optional fields.
- A workflow `on(e: Event)` reactor or event-triggered `create(e: Event) by`
  starter whose event no `channel` carries (`loom.reactor-event-uncarried`):
  in-process dispatch is channel-routed, so the consumer would never fire —
  declare a `channel { carries: … }` for the event.
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

    aggregate Customer { name: string, email: string }
    aggregate Product  { sku: string, price: Money }

    aggregate Order {
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
            expect m.amount == 10.5
            expect m.currency == "USD"
        }
    }

    repository Orders for Order {
        find byCustomer(customerId: Customer id): Order[]
    }
}
```
