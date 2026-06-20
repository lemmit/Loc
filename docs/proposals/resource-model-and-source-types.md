# RFC: Resource Model & Source Types

**Status:** Draft / Proposed.

> **[2026-06-20 status audit]** PARTIAL (no longer Draft/Proposed) — `Resource`/`sourceType`/`kind` in grammar (`ddd.langium`), `src/ir/resource-verbs.ts` + per-backend `adapters/resource-clients.ts` ship objectStore/queue/api clients across backends, with tests. Some sourceTypes/interfaces remain.

**Scope:** Define Loom's data-layer model as a clean separation of *logical need*,
*configured binding*, and *built-in technology descriptor*, with explicit
semantic `kind`, refining `capability`, and context-selected `interface`. The
model generalizes the current data layer so that relational stores, event logs,
caches, **object stores, queues, and external APIs** are all first-class, and
prepares the toolchain to add new technologies without grammar changes.

---

## 1. Summary

Loom's data layer is modeled as four layers plus three cross-cutting dimensions:

```
storage     physical instance — a server / managed service / endpoint
  ↑ use:
resource    the configured binding of a need to a sourceType + storage; holds config
  ↑ (implicit)
need        what the application requires (kind + capabilities), derived from usage

sourceType  built-in, platform-defined descriptor of a technology family;
            for each kind it declares the capabilities and interfaces it offers

kind        semantic role:    database | eventLog | cache | objectStore | queue | api
capability  refines a kind:    crud, query, transactions, append, replay, ack, blob, signedUrl, …
interface   access mode:        sql | rest | graphql | webSocket | amqp | sdk
```

- **`storage`** and **`resource`** are user-authored (`.ddd`).
- **`sourceType`** is **platform-internal** — a registry in the toolchain, never
  written by users.
- **`need`** is **implicit** — derived from how aggregates and contexts use data
  and threaded through the IR as a first-class node, not written by users.
- **`kind`**, **`capability`**, and **`interface`** are properties owned by the
  registry and the IR; only `kind` appears at the user surface (on `resource`),
  reusing the existing clause key.

This keeps the user surface small while making the architecture explicit and
extensible.

---

## 2. Motivation

A single broad "data source" bucket is convenient but semantically weak: a
relational database is not an object store, an object store is not a queue, and an
external API is none of those. Conflating them blocks precise validation and
makes adding a new technology a generator fork rather than a registry entry.

Concretely, Loom needs to model — now —

- **object stores** (e.g. S3-class blob storage with `blob` / `list` /
  `signedUrl` semantics),
- **queues** (e.g. RabbitMQ-class messaging with `enqueue` / `dequeue` / `ack`),
- **external APIs** (REST/GraphQL endpoints consumed as integration points),

alongside the existing relational stores, event logs, and caches — and to do so
without re-deriving name resolution or forking a backend per vendor.

The model below achieves that by separating **what the app needs** from **what a
technology offers** and binding the two through a **resource**, with the
technology knowledge living in a **platform-internal registry**.

---

## 3. Model

### 3.1 `storage` — physical instance

A `storage` declares a physical store, managed service, or endpoint. Unchanged
shape; the `type:` value names the **sourceType** that realizes it, and
vendor-specific parameters flow through `connection:` and a generic `config` map.

```ddd
storage primarySql { type: postgres, connection: service(db) }
storage fileStore  { type: s3,    connection: env("S3_URL"),  config: { region: "eu-central-1", bucket: "app-files" } }
storage jobBus     { type: rabbitmq, connection: env("MQ_URL"),  config: { vhost: "/" } }
storage payments   { type: restApi,  connection: env("PAY_URL") }
```

`type:` is a value-position enumeration; new technologies are added as new
literals (see §4) — no new keywords.

### 3.2 `resource` — configured binding

A `resource` binds a bounded context's data of a given `kind` to a `storage`,
carrying the per-binding configuration. It is the configured realization of a
logical need.

```ddd
resource ordersDb    { for: Orders, kind: state,       use: primarySql, schema: "orders" }
resource ordersFiles { for: Orders, kind: objectStore, use: fileStore }
resource orderJobs   { for: Orders, kind: queue,       use: jobBus }
resource payApi      { for: Orders, kind: api,         use: payments }
```

`resource` reuses every clause key the data-layer binding already understands
(`for`, `kind`, `use`, `schema`, `tablePrefix`, `keyPrefix`, `ttl`, `every`,
`retain`, `isolationLevel`, `readonly`). New per-kind parameters (bucket prefix,
queue routing, etc.) are expressed through the generic `config` map rather than
new typed keys, so no new clause keywords are introduced.

A deployable lists the resources it wires under its existing `dataSources:`
binding clause (the clause name is retained for compatibility; it references
`resource` declarations).

### 3.3 `need` — logical requirement (implicit, threaded)

A *need* is what the application requires of a data layer: a `kind` plus the
`capabilities` implied by how the domain uses it. Needs are **not authored** —
they are derived during lowering/enrichment from aggregate persistence and
context usage, and represented as a first-class IR node (`NeedIR`) that each
`resource` satisfies. Threading the need explicitly through the IR gives:

- a single place to validate `need.capabilities ⊆ sourceType.supports[kind].capabilities`,
- a stable contract a `resource` is checked against (rather than ad-hoc matrices),
- a seam for future explicit `requires:` authoring without re-plumbing — but no
  user-facing syntax, and therefore no new keywords, ship in this RFC.

### 3.4 `sourceType` — built-in technology descriptor

A `sourceType` is platform-internal knowledge about a technology family. It lives
in a toolchain registry, not in `.ddd`. For each `kind` it supports, it declares
the `capabilities` it offers and the `interfaces` through which that kind is
reached, plus the vendor realization (compose image, client library, migration
dialect, connection wiring).

```ts
// platform-internal registry (illustrative)
sourceType postgres
  supports:
    database: { capabilities: [crud, query, transactions, state, snapshot, replica], interfaces: [sql] }
    eventLog: { capabilities: [append, read, replay],                                interfaces: [sql] }
    cache:    { capabilities: [get, set, ttl],                                       interfaces: [sql] }

sourceType s3
  supports:
    objectStore: { capabilities: [blob, list, signedUrl, versioning], interfaces: [rest, sdk] }

sourceType rabbitmq
  supports:
    queue: { capabilities: [enqueue, dequeue, ack, publish, consume], interfaces: [amqp] }

sourceType restApi
  supports:
    api: { capabilities: [request], interfaces: [rest] }
```

The registry consolidates knowledge that is otherwise scattered (type
enumerations, per-adapter `supports()` predicates, hardcoded vendor pins,
relational-type sets) into one data-driven table that every backend and validator
reads.

**Registry home.** The registry splits by altitude, respecting the
one-directional layering (`language → ir → generator → system`):

- **Platform-neutral descriptor** (`src/util/source-types.ts`) — the single source
  of truth for `sourceType → supported kinds → { capabilities, interfaces }` and
  the canonical kind/capability sets. Read by IR lowering/enrich (need
  derivation), IR validation (capability/kind matching), and system composition.
  Because `language/` cannot import from `ir/`, the semantic kind↔type
  compatibility check moves from the AST validator into IR validation
  (`src/ir/validate/validate.ts`), where kind-coverage checks already live; the
  AST validator keeps only structural checks. This consolidates the duplicated
  relational-type sets.
- **Vendor realization** stays distributed across the platform adapters, keyed by
  sourceType name — compose image pins, client-library versions, migration
  dialect, connection-setup code are inherently platform-specific and belong where
  the layering already places them. Each adapter's `supports()` becomes a thin
  lookup against the neutral descriptor instead of an inline table.

The grammar's `type:` / `kind:` literal lists stay hand-maintained (the parser is
generated at build time and cannot read the TS registry), so adding a sourceType
touches two places — the grammar literal and the registry entry. This adds no soft
keywords.

### 3.5 `kind`, `capability`, `interface`

- **`kind`** is the semantic role and the primary contract between a need and a
  provider: `database | eventLog | cache | objectStore | queue | api`. It is the
  one dimension surfaced to users (on `resource`). **Surface note:** the
  user-facing `kind:` keyword keeps the fine-grained persistence values
  (`state | eventLog | snapshot | cache | replica`) and *adds* the new infra roles
  (`objectStore | queue | api`); the registry reasons in the coarse infra kinds and
  maps `state`/`snapshot`/`replica` onto `database` + a refining capability. This
  keeps `kind:` as the `(context, kind)` routing discriminator while the
  capability reframe stays internal.
- **`capability`** refines a kind. The persistence roles Loom already
  distinguishes — `state`, `snapshot`, `replica` — are capabilities under
  `database`; `eventLog` and `cache` are kinds in their own right with their own
  capabilities (`append`/`read`/`replay`, `get`/`set`/`ttl`). New kinds bring new
  capabilities (`blob`/`list`/`signedUrl` for `objectStore`,
  `enqueue`/`dequeue`/`ack` for `queue`). Capabilities live in the registry and
  the derived need; they are not authored.
- **`interface`** is the access mode used in a given context (`sql`, `rest`,
  `amqp`, `sdk`, …). A `sourceType` exposes interfaces **per kind**, not as one
  flat set, so the same technology used in different roles exposes different valid
  interfaces. Interface is selected by the consuming operation from
  `sourceType.supports[kind].interfaces`; it is not authored.

---

## 4. Extensibility without grammar churn

Adding a technology or a role must not expand the keyword surface:

- **New technology** → a new `sourceType` registry entry **plus** a new literal in
  the value-position `type:` enumeration. Value-position literals are not global
  identifiers, so no soft keyword is introduced.
- **New role** → a new literal in the value-position `kind:` enumeration, plus the
  registry entries that support it.
- **New capability / interface** → registry data only; no grammar.
- **Vendor-specific parameters** → the generic `config` map on `storage` /
  `resource`; no new typed clause keys.
- **`sourceType`, `capability`, `interface`, `need`, `requires`** → never appear
  in `.ddd`; they are internal/registry/IR concepts. No keywords, no soft
  keywords.

The only user-surface change is the declaration keyword `resource` (replacing the
binding declaration) and the optional `config` map; the existing binding clause
keys are reused as-is.

---

## 5. Matching & invariants

For a `resource` binding a need to a `sourceType`:

1. `resource.kind` is supported by `resource`'s `sourceType` (via `use:` →
   `storage.type`).
2. `need.kind == resource.kind` for the served context.
3. `need.capabilities ⊆ sourceType.supports[kind].capabilities`.
4. the consuming operation selects an `interface` from
   `sourceType.supports[kind].interfaces`.

Invariants:

- A `need` declares exactly one primary `kind`.
- A `sourceType` may support multiple kinds; it must declare interfaces **per
  kind**, not only globally.
- A `resource` binds exactly one context's need to exactly one `storage`/
  `sourceType` and chooses exactly one active `kind`.
- A `resource` may omit an explicit interface when it is derivable from kind +
  operation.
- Per `(context, kind)` bindings are unique within a deployable.
- Users cannot author `sourceType` semantics; the registry is platform-owned
  (custom-sourceType plugins are an explicit future seam, §7).

---

## 6. Examples

### 6.1 Relational database

```ddd
storage primarySql { type: postgres }
resource ordersDb  { for: Orders, kind: state, use: primarySql, schema: "orders" }
```
Reached through `sql`; the surface `kind:` stays fine-grained (`state` / `snapshot`
/ `replica`), which the registry models as capabilities under `database` and
derives into the need.

### 6.2 Postgres-backed event log

```ddd
resource ordersEvents { for: Orders, kind: eventLog, use: primarySql, every: 100, retain: 5 }
```
`append` / `read` / `replay` over `sql`.

### 6.3 Object store (S3)

```ddd
storage fileStore   { type: s3, config: { region: "eu-central-1", bucket: "app-files" } }
resource ordersFiles { for: Orders, kind: objectStore, use: fileStore }
```
`blob` / `list` / `signedUrl`; browser flows prefer `rest`, backend batch flows
prefer `sdk`.

### 6.4 Queue (RabbitMQ)

```ddd
storage jobBus    { type: rabbitmq, config: { vhost: "/" } }
resource orderJobs { for: Orders, kind: queue, use: jobBus }
```
`enqueue` / `dequeue` / `ack` over `amqp`.

### 6.5 External API

```ddd
storage payments { type: restApi, connection: env("PAY_URL") }
resource payApi   { for: Orders, kind: api, use: payments }
```
`request` over `rest`.

---

## 7. Phased delivery

The target is the full model above; it is delivered in phases, each independently
mergeable and CI-green, with `test/fixtures/**` byte-identical where features are
unused.

**Phase 1 — Resource model + sourceType registry (foundation).**
- Introduce the `resource` declaration as the data-layer binding; retain the
  `dataSources:` deployable clause referencing it. **Hard cutover** — the prior
  binding keyword is removed (no transitional alias); all `.ddd` sources,
  examples, and fixtures migrate in one step via codemod, since all Loom sources
  live in this repository.
- Stand up the platform-internal `sourceType` registry and back the existing
  per-adapter `supports()` checks and validator compatibility matrix with it;
  consolidate the duplicated relational-type sets.
- Reframe `kind` as the infrastructure role and `state`/`snapshot`/`replica` as
  `database` capabilities in the registry/IR (existing `kind: eventLog|cache`
  remain valid kinds).
- Thread the derived `NeedIR` through lowering/enrichment; wire the
  `need.capabilities ⊆ sourceType.capabilities` check.
- No behavior change in emitters for relational/eventLog/cache.

**Phase 2 — New kinds: object store, queue, external API.** *(model + compose
delivered; backend client emission deferred — see note.)*
- Add `s3`, `rabbitmq`, `restApi` (and siblings) to the `type:` enumeration and
  the registry; add `objectStore`, `queue`, `api` to the `kind:` enumeration; add
  their capabilities/interfaces to the registry. ✓
- Add the generic `config` map on `storage`/`resource` for vendor parameters,
  validated against the registry schema. ✓
- Compose integration: emit dev sidecars for the new-kind storages (minio for
  `s3`, `rabbitmq`), gated so existing models stay byte-identical. ✓
- Validation for the new kind↔sourceType↔capability combinations, driven by the
  registry. ✓
- **Deferred — backend client emission.** Emitting object-store / queue /
  external-API *clients* into a backend depends on a way for domain logic to
  *consume* a resource (e.g. put a blob, enqueue a job, call an API). That
  consumption surface is a **workflow-level** concern, designed separately (see
  Phase 4); emitting clients with no caller would be speculative scaffolding, so it
  waits on that design. The persistence-adapter emit seam is also not yet wired
  into real backend output (an in-progress refactor), which the consumption work
  would build on.

**Phase 3 — Interface selection & custom-sourceType plugins.**
- ✓ `interface` selection — `defaultInterfaceFor` resolves a per-resource default
  (native/operational preference order) onto `EnrichedSystemIR.resourceInterfaces`.
  The per-operation override hook awaits the consumption surface (Phase 4).
- ✓ Custom-sourceType plugins — a `packages/*` package declaring
  `loom: { kind: "sourceType", sourceType: {…} }` registers a declarative
  descriptor at boot (`bootSourceTypePlugins` → `registerSourceType`); the neutral
  descriptor ships as JSON, no plugin code is executed to register it.
- (`requires:` authoring is deferred — the need layer stays implicit.)

**Follow-ups completed alongside Phase 3:**
- ✓ The drizzle `PersistenceAdapter.emitConnectionSetup` seam is now wired into
  real backend output (shared `DRIZZLE_CONNECTION_SETUP` const; the server entry
  no longer hardcodes its own copy) — the prerequisite flagged for Phase 4.

**Phase 4 — Workflow-level resource consumption.** Designed in
[`workflow-resource-consumption.md`](./workflow-resource-consumption.md): a
`resource` becomes a capability-typed handle callable from a workflow through a
closed per-kind verb vocabulary (`files.put(…)`, `jobs.enqueue(…)`,
`rates.get(…)`). This is the caller of the Phase-2.4 clients; it activates the
`need ⊆ sourceType` check (needs derive from verbs used) and the per-resource
interface selection.

---

## 8. Resolved decisions

- **Rename = hard cutover.** The prior binding-declaration keyword is removed with
  no transitional alias; all sources migrate in one codemod step (all Loom code
  lives in this repository).
- **Registry home is split** (see §3.4): the platform-neutral descriptor lives in
  `src/util/source-types.ts`; vendor realization stays in the platform adapters
  keyed by sourceType name; the semantic kind↔type check moves into IR validation.
- **Config typing — generic syntax, registry-validated keys.** `config` stays a
  free-form key→value map at the grammar (no per-vendor clause keywords). The
  registry declares each sourceType's allowed/required config keys and their
  types; IR validation checks them: unknown keys warn (forward-compatible),
  missing-required / wrong-type error. The config schema lives in the same neutral
  descriptor.
- **Need granularity — per `(context, kind)`.** Matches the existing binding
  granularity pinned by D-GRANULARITY. A context's need for a kind carries the
  union of capabilities implied by that context's aggregates. Per-aggregate
  refinement is deferred to the same future override mechanism that owns
  per-aggregate bindings.
- **Custom sourceType plugins — seam now, loader later.** A sourceType is
  platform-owned code, never `.ddd`-authored, so plugins ride the existing
  out-of-tree package rail (`packages/` + `loom` manifest key, discovered by
  `src/platform/fs-discovery.ts`) and are trusted like an out-of-tree backend
  (full code trust). Because `ir/` cannot import `platform/`,
  `src/util/source-types.ts` exposes a **registration API** and the platform loader
  pushes both the neutral descriptor and the vendor realization into it at boot
  (the inversion `bootMacros()` already uses for macros). A plugin contributes a
  descriptor entry plus a realization adapter under one manifest entry
  (`kind: "sourceType"`). This RFC fixes the seam; the loader implementation lands
  in Phase 3.
