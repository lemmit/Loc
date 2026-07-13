# Proposal: Storage and Platform Config Redesign

**Status:** Draft. Output of a design conversation. Partially superseded — see decision note below.
**Scope:** Make the data layer explicit in deployable composition; introduce per-aggregate persistence strategy; expose generator/architecture choices on the deployable's platform config; preserve backward compatibility.

> **Pinned decisions affecting this proposal** (see [`docs/decisions.md`](../../decisions.md)):
>
> - **D-STORAGE-SPLIT** — the keyword `storage` covers physical
>   instances only. The logical (aggregate-to-physical) form
>   described in §3.2 is renamed to `dataSource` and binds at
>   `(context, kind)` granularity; references to "logical storage"
>   below should read as `dataSource`. The deployable's binding
>   clause is `dataSources:`.
> - **D-GRANULARITY** — bindings are per-context, not per-aggregate.
>   The per-aggregate `for: <Aggregate>` syntax in §3.2/§3.3 does
>   not land in v1; it is deferred to a v2 override mechanism.
>   §2.1 invariant 4 ("BC = semantic boundary only … no storage
>   homogeneity") is superseded — read v1 as "storage homogeneity
>   per context is the default."
> - **D-ENV-SWAP** — the §3.8 `overrides` block is deferred out of
>   the F1 micro-plan; per-environment swap in v1 uses alternate
>   `dataSource` decls picked by the test deployable.
> - **D-REALIZATION-AXES** — the deployable platform-config axis
>   *names* in §3.x are renamed: `style:` → **`application:`**
>   (values `flat | serviceLayer | cqrs`) and `layout:` →
>   **`directoryLayout:`**; `persistence:` keeps its name but carries
>   the data-access library only (the domain/app-framework axis moves
>   to the new **`foundation:`** keyword, default `vanilla`). The
>   adapter *kinds* in `src/generator/_adapters/` stay `style`/`layout`
>   internally; the DSL spelling differs (`application`↔`style`,
>   `directoryLayout`↔`layout`). The §8.2/§882 **`platform: node` →
>   `platform: node { framework: hono }`** rename is **not adopted** —
>   `hono` remains the platform name; `node` does not exist. The full
>   axis vocabulary, gating matrix, and examples live in
>   [`platform-realization-axes.md`](./platform-realization-axes.md).
>
> - **D-ASH-REMOVED (2026)** — the `foundation:` knob from
>   D-REALIZATION-AXES survives, but the Ash foundation was removed:
>   `platform: elixir` now generates Phoenix LiveView on plain
>   Ecto/Phoenix only. `foundation:` resolves to `vanilla` (the
>   default and only valid value) on elixir; `foundation: ash` is now
>   a **validation error**. Wherever §4/§9/§10 list `ash` as a
>   `style:` value or `ashPostgres`/`ashCommanded` as `persistence:`
>   adapters for `phoenix`, read those as removed historical options —
>   the only elixir foundation is vanilla.
>
> The §1 motivation, §2.1 invariants 1–3 and 5, §3.1 physical
> storage grammar, and most of §3.4–§3.7 (per-aggregate persistence
> strategy, event publish markers, deployable platform config,
> `persistence:` shorthand) survive intact and inform F1 grammar.
>
> - **D-DOCUMENT-AXIS** — the per-aggregate `persistenceStrategy:
>   eventSourced | stateBased` clause (body) described in §3.4 is
>   renamed to the **header** modifier `persistedAs(eventLog | state)`
>   (values aligned to the `dataSource` `kind` set, so the
>   strategy→kind mapping is an identity; hard cutover, no parallel
>   acceptance). A second orthogonal header axis `normalised(true |
>   false)` selects document vs relational saving. Read §3.4's
>   `persistenceStrategy: eventSourced` as `persistedAs(eventLog)`.

---

## 1. Background and Motivation

In current Loom the data layer is expressed implicitly through deployable composition:

```ddd
storage primarySql { type: postgres }

deployable api {
  platform: dotnet
  modules: Sales { primary: primarySql, cache: redis }
}
```

Two structural problems:

1. **`storage` decls carry almost no information.** Just `{ type: <kind> }`. The data layer's shape — schema, connection, migration ownership, outbox semantics — has no DSL surface and is filled in by generator convention.
2. **Module-storage binding is expressed as flat role-keyed slots on the deployable.** Five hard-coded roles (`primary`, `cache`, `search`, `events`, `bi`). Per-aggregate granularity is not expressible. Per-aggregate persistence strategy (event-sourcing vs state-based) does not exist.

Separately, **generator choices are platform-internal hardcoded decisions**. `platform: dotnet` bundles EF Core + MediatR + minimal API + xUnit with no exposed knobs. Swapping to Dapper, picking a different mediator, or changing architectural style (cqrs vs layered) requires forking the platform's generator.

This proposal redesigns three things together because they share the same architectural seams:

1. The **storage layer** as the explicit composition node with per-aggregate granularity and configurable infrastructure.
2. The **aggregate's persistence strategy** as a first-class domain modeling decision (`stateBased` vs `eventSourced`).
3. The **platform config** as a small set of explicit knobs (`style`, `layout`, `persistence`) with sane defaults, allowing per-deployable architectural choices without forking the generator.

---

## 2. Conceptual Model

### 2.1 Core invariants

These are non-negotiable; the DSL is shaped so that violating them is either impossible or caught by the validator.

1. **The aggregate is the transaction boundary.** Each aggregate has exactly one authoritative store. Two aggregates in the same bounded context may live in different stores; they coexist semantically, not transactionally.
2. **Storage is infrastructure; persistence strategy is domain modeling.** Whether an aggregate is event-sourced or state-based changes the aggregate's API (`apply()` vs `save()`) and therefore is a modeling decision declared on the aggregate. Which physical storage backend hosts it is an infrastructure decision declared on a `storage` block.
3. **Events are first-class, but the outbox is not a parallel store.** Integration events are written to an outbox table in the same transaction as the business write. The outbox lives in the same physical store as the aggregate's primary write (state store for state-based aggregates; event log store for event-sourced ones).
4. **Bounded context = semantic boundary only.** It imposes no storage homogeneity. Mixed ES and state-based aggregates may share a context and even share a physical postgres instance.
5. **Storage is swappable per deployable.** Module/aggregate domain code never references storage names. A `deployable apiTest { overrides { storage pg { type: inMemory } } }` block changes the engine without touching the logical bindings.

### 2.2 Layers

```
[ physical storage ]      type, connection, instance grouping, outbox config
       ↑  use:
[ logical storage ]       use: <physical>, for: <Aggregate>, schema, kind, ttl, …
       ↑  for:
[ aggregates ]            persistenceStrategy: stateBased | eventSourced; events with publish: marker
       ↑
[ modules ]               groupings; no storage opinion of their own
       ↑
[ deployables ]           compose modules + apis + uis; carry platform config; can override storages
```

Casual users see one form: `storage db { type: postgres, for: Sales }`. The two-layer split (physical vs logical) only appears when sharing or per-deployable override is needed.

---

## 3. Grammar

The single keyword `storage` has two forms, distinguished by the presence of `for:`. The DSL parses both via one rule; the validator decides which form was meant.

### 3.1 Physical storage

Declares a server / managed instance.

```
storage <name> '{'
  'type'       ':' <StorageType>
  ('instance'  ':' <ident> ',')?
  ('connection':' <ConnectionSource> ',')?
  ('outbox'    ':' <OutboxConfig> ',')?
  ('follows'   ':' <storageRef> ',')?         # replica relationship (validated but limited in v1)
'}'
```

Examples:

```ddd
storage pg        { type: postgres }
storage cache     { type: redis }
storage events    { type: kafka }
storage memTest   { type: inMemory }
storage pgReplica { type: postgres, instance: appDb.replica, follows: pg }
```

**`StorageType` values:**
- SQL: `postgres`, `mysql`, `sqlite`
- KV / cache: `redis`, `inMemory`
- Search: `elastic`, `meilisearch`
- Stream / event: `kafka`
- Analytical: `clickhouse`, `bigquery`

**`instance:`** is a physical topology key. Multiple physical `storage` decls with the same `(type, instance)` collapse to one compose service. Absent `instance:` means "give me my own resource". The default v1 system orchestrator generates one compose service per `(type, instance)` group.

**`connection:`** declares where the connection URL comes from at boot:
- `service(<name>)` — wire to the compose service named `<name>` (default; auto-derived)
- `env("<ENV_VAR>")` — read from environment at boot
- `secret(<refName>)` — pull from a secret manager (k8s, Vault, AWS SM)
- `literal("postgres://…")` — for examples only; validator emits a warning

**`outbox:`** describes the outbox layout for any aggregate using this store that publishes integration events:
- `auto` (default) — one shared outbox table per schema, materialized only if at least one aggregate has `event { publish: integration | both }`
- `disabled` — no outbox; validator errors if an aggregate in this store has integration events
- Block form: `{ layout: shared | perAggregate, table: <stringLit>?, publisher: polling | listenNotify | logicalDecoding, interval: <duration>? }`

Note: both `shared` (one outbox table per DB / schema, polymorphic payload) and `perAggregate` (one table per aggregate) are legitimate patterns. `shared` is the default because it minimizes operational surface.

### 3.2 Logical storage

Binds an aggregate to a physical store with persistence configuration.

```
storage <name> '{'
  'use' ':' <physicalStorageRef>
  'for' ':' <AggregateRef>
  ('kind'          ':' LogicalStorageKind ',')?
  ('schema'        ':' <stringLit> ',')?
  ('every'         ':' <int> ',')?                 # snapshot kind only — snapshot every N events
  ('retain'        ':' <int> ',')?                 # snapshot kind only — snapshots to keep
  ('tablePrefix'   ':' <stringLit> ',')?           # SQL family
  ('searchPath'    ':' <stringLit> ',')?           # postgres
  ('isolationLevel':' <IsolationLevel> ',')?       # SQL family
  ('keyPrefix'     ':' <stringLit> ',')?           # redis
  ('ttl'           ':' <duration> ',')?            # redis
  ('topicPrefix'   ':' <stringLit> ',')?           # kafka
  ('retention'     ':' <duration> ',')?            # kafka
  ('consumerGroup' ':' <stringLit> ',')?           # kafka
  ('indexPrefix'   ':' <stringLit> ',')?           # search engines
  ('refreshOnWrite':' 'immediate' | 'async' ',')?  # search engines
  ('dataset'       ':' <stringLit> ',')?           # bigquery
  ('partitionBy'   ':' <stringLit> ',')?           # analytical
  ('readonly'      ':' <bool> ',')?
  ('migrations'    ':' 'auto' | 'manual' | 'none' ',')?
'}'
```

The presence of `for:` is what makes a decl logical. All non-`use`/`for`/`kind` keys are validated per-`(type, kind)` of the resolved physical storage and per the logical kind.

**`LogicalStorageKind` taxonomy (v1):**

| `kind:` | Meaning | Applies to | Count per aggregate |
|---|---|---|---|
| `state` (default for state-based) | Primary state store | state-based aggregates | Exactly 1 |
| `eventLog` | Primary event log | event-sourced aggregates | Exactly 1 |
| `snapshot` | Derived snapshot store | event-sourced aggregates | At most 1 |
| `cache` | Derived cache | any aggregate | At most 1 |
| `replica` | Read-only replica binding | any aggregate | At most 1 |

All five are **separate top-level `storage` decls**. There are no inline sub-blocks — each derived store (snapshot, cache, replica) is its own logical storage decl pointing at its own physical store via `use:`. This keeps the validator and emitter logic uniform across all kinds and lets each derived store live in a completely different physical engine when needed (e.g., events in postgres, snapshots in redis, replica in a follower postgres).

The relationship between an event log and its snapshot store is **implicit by `for:`** — both reference the same aggregate; the validator pairs them automatically. No explicit `linkedTo:` field.

Future kinds (`projection`, `searchIndex`, `archive`) will plug in by extending the enum when channels and read models are designed; no grammar change required at that time.

Examples:

```ddd
storage salesDb { use: pg, for: Sales.Order, schema: "sales" }
# kind defaults to `state` for a state-based aggregate.

storage orderEvents {
  use: pg
  for: Sales.Order
  kind: eventLog
  schema: "sales"
}

storage orderSnapshots {
  use: cache                    # snapshots in redis, different from event store
  for: Sales.Order
  kind: snapshot
  every: 100
  retain: 5
}

storage orderCache { use: cache, for: Sales.Order, kind: cache, keyPrefix: "order:", ttl: 60 }
storage orderReplica { use: pgReplica, for: Sales.Order, kind: replica, readonly: true }
```

### 3.3 `for:` reference syntax

For v1, `for:` accepts an aggregate-qualified name: `for: Sales.Order` resolves to the aggregate `Order` in module `Sales`. The scope provider walks `module → aggregate`.

Globs (`for: Sales.*`) and finer granularity (`for: Sales.Order.events`) are deferred.

### 3.4 `aggregate` — persistence strategy marker

```
aggregate <name> '{'
  ('strategy' ':' 'stateBased' | 'eventSourced' ',')?
  ...existing aggregate body...
'}'
```

Default is `stateBased`. Setting `persistenceStrategy: eventSourced` changes:
- The aggregate's generated API (the aggregate emits events; rebuild is via `apply()`).
- The repository emitter — must use an event-sourcing-capable persistence adapter.
- The validator — requires exactly one matching `kind: eventLog` logical storage.

### 3.5 `event` — publish marker

```
event <name> '{'
  ('publish' ':' 'internal' | 'integration' | 'both' ',')?
  ...existing event body...
'}'
```

Default is `internal`. `integration` and `both` cause the event to be drained via the outbox to (in v1) a per-module default channel; `both` also keeps in-process dispatch for domain logic.

Adding any `publish: integration | both` to an event whose aggregate's physical store doesn't support transactional outbox (`redis`, `kafka`, `inMemory` non-transactional variants) is a validator error.

### 3.6 Deployable platform config

```
deployable <name> '{'
  'platform' ':' <PlatformName> ('{' platformConfigEntry+ '}')?
  ...existing deployable body...
'}'
```

The `platformConfigEntry` set is platform-specific. Common entries:

| Entry | Type | Notes |
|---|---|---|
| `style:` | `<ident>` | platform-defined menu — see platform tables below |
| `layout:` | `byLayer` \| `byFeature` | file organization |
| `persistence:` | `<ident>` (shorthand) or block (full) | see §3.7 |
| `framework:` | `<ident>` | HTTP framework choice (where applicable) |

### 3.7 `persistence` — shorthand and block form

Two equivalent forms following Loom's `ModuleBinding` precedent (`Sales` vs `Sales { primary: pg }`):

```ddd
platform: dotnet { persistence: efcore }                              # shorthand
platform: dotnet { persistence { use: efcore, abstraction: none } }   # full form
```

```
PersistenceConfig:
    <ident>                                              # shorthand: just the adapter name
  | '{' persistenceEntry (',' persistenceEntry)* '}'     # block form

persistenceEntry:
    'use'         ':' <ident>                            # adapter name
  | 'use'         ':' '{' perStrategy '}'                # per-strategy adapter selection
  | 'abstraction' ':' 'repositoryPerAggregate' | 'none'  # RESERVED — v1 emitter warns and ignores

perStrategy:
  ('stateBased'    ':' <ident> ',')?
  ('eventSourced'  ':' <ident> ',')?
```

`abstraction:` is grammar-reserved in v1 but **not implemented**. The v1 emitter accepts the key, emits a warning ("`abstraction:` reserved for future use"), and proceeds with the default `repositoryPerAggregate` behavior. This locks in the syntactic slot so v2 can ship without a breaking change.

### 3.8 Per-deployable `overrides`

```
deployable <name> '{'
  ...
  ('overrides' '{' storageOverride+ '}')?
'}'

storageOverride:
  'storage' <existingName> '{' storageBody '}'   # re-declares an existing storage by name
```

An override targets an existing **physical** storage by name. Only `type`, `connection`, `instance`, `outbox` may be overridden. Logical storages are not overridable directly — to swap their backend, override the physical store they `use:`.

Example:

```ddd
deployable apiTest {
  ...
  overrides {
    storage pg     { type: inMemory }
    storage events { type: inMemory }
  }
}
```

### 3.9 Module bindings — bare form

With logical storage carrying `for:` aggregate refs, the deployable's `modules:` clause no longer needs explicit role-slot maps. The new canonical form is bare:

```ddd
modules: Sales, Catalog
```

The existing role-slot form (`modules: Sales { primary: pg }`) parses unchanged and desugars to anonymous logical storage decls during lowering. Both forms coexist; new code is expected to use the explicit logical storage form.

---

## 4. Platform Menus (v1)

Each platform's registry declares which `style:`, `layout:`, `persistence.use:`, and `framework:` values it accepts. The validator rejects out-of-menu values with a clear error.

| Platform | `style:` values | `layout:` values | `persistence.use:` values | `framework:` values |
|---|---|---|---|---|
| `dotnet` | `cqrs` (default), `layered` | `byLayer` (default), `byFeature` | `efcore` (default; state), `dapper` (state), `marten` (state + ES) | `minimalApi` (default) |
| `node` (renamed from `hono`) | `cqrs` (default), `layered` | `byLayer` (default), `byFeature` | TBD; current emitter is the default; one ES-capable adapter required | `hono` (default, only v1 value) |
| `phoenix` | `ash` (default), `contexts` | `byLayer` only | `ashPostgres` (default), `ashCommanded` (ES) | `liveview` (default) |
| `react` | n/a — frontend only | n/a | n/a | n/a |

**`layout: byFeature` × `style: layered`** is a validator error or warning — layered style produces one controller/service/repository per aggregate, not multiple per-feature artifacts; the layout is meaningless.

**`style: layered` × any `aggregate { persistenceStrategy: eventSourced }`** is a validator error. The layered style has no command/event flow that maps naturally onto event sourcing.

### 4.1 Note on `platform:` keyword evolution

The current `platform: node` keyword conflates runtime (Node) with HTTP framework (Hono). The proposed direction (out of v1 scope) is:

```
platform: node   { framework: hono | fastify | express | nestjs | elysia, ... }   # backend-only
platform: nextjs { router, rendering, persistence, ... }                          # fullstack meta-framework
platform: remix  { ... }                                                          # fullstack meta-framework
platform: phoenix { style: ash | contexts, framework: liveview | restApi, ... }   # already fullstack
```

For v1, rename `platform: node` to `platform: node { framework: hono }` (with `hono` as the sole v1 framework value), preserving backward compatibility via desugar of the old keyword.

Meta-frameworks (Next.js, Remix, SvelteKit) get their own top-level `platform:` entries because they own the entire stack (routing, rendering, server, deployment). They are not `framework:` options inside `platform: node`. Their concrete grammar shape is deferred.

---

## 5. Examples

### 5.1 Casual — one storage, one module, one deployable

```ddd
storage pg { type: postgres }
storage salesDb { use: pg, for: Sales.Order }

aggregate Sales.Order { ... }

deployable api {
  platform: dotnet
  modules: Sales
  serves: SalesApi
  port: 8080
}
```

Emits: postgres compose service named `pg`, EF Core repository for `Sales.Order`, MediatR-based cqrs handlers, `byLayer` file organization. Identical to current Loom defaults.

### 5.2 Standard — multiple aggregates, shared postgres, cache

```ddd
storage pg    { type: postgres }
storage cache { type: redis }

storage orderDb  { use: pg,    for: Sales.Order,  schema: "sales" }
storage quoteDb  { use: pg,    for: Sales.Quote,  schema: "sales" }
storage catDb    { use: pg,    for: Catalog.Item, schema: "catalog" }
storage orderHot { use: cache, for: Sales.Order,  keyPrefix: "order:", ttl: 60 }

aggregate Sales.Order { ... }
aggregate Sales.Quote { ... }
aggregate Catalog.Item { ... }

deployable api {
  platform: dotnet
  modules: Sales, Catalog
  serves: SalesApi, CatalogApi
  port: 8080
}

deployable apiTest {
  platform: dotnet
  modules: Sales, Catalog
  serves: SalesApi, CatalogApi
  overrides {
    storage pg    { type: inMemory }
    storage cache { type: inMemory }
  }
}
```

`api` gets a real postgres + redis stack via compose. `apiTest` swaps both engines for in-memory without rewriting any logical storage.

### 5.3 Event-sourced aggregate alongside state-based

```ddd
storage pg { type: postgres }

aggregate Sales.Order { persistenceStrategy: eventSourced
  event OrderPlaced  { publish: integration, ...fields }
  event OrderShipped { publish: both,        ...fields }
  ...
}
aggregate Sales.Quote { persistenceStrategy: stateBased
  event QuoteSubmitted { publish: integration, ...fields }
  ...
}

storage orderEvents {
  use: pg
  for: Sales.Order
  kind: eventLog
  schema: "sales"
}

storage orderSnapshots {
  use: pg                       # could equally be a different physical store
  for: Sales.Order
  kind: snapshot
  every: 100
}

storage quoteDb {
  use: pg
  for: Sales.Quote
  schema: "sales"
}

deployable api {
  platform: dotnet {
    style: cqrs
    persistence: marten        # adapter handles both state and ES on postgres
  }
  modules: Sales
  serves: SalesApi
  port: 8080
}
```

Both aggregates live in the same postgres. Marten manages the `Order` event log and snapshots; `Quote` is a normal Marten-document or backed by a separate adapter (see §5.4). One outbox table in `pg`, populated by both aggregates' integration events in their respective transactions.

### 5.4 Per-strategy adapter selection

When a deployable mixes strategies and a single adapter doesn't fit both well:

```ddd
deployable api {
  platform: dotnet {
    style: cqrs
    persistence {
      use: { stateBased: efcore, eventSourced: marten }
    }
  }
  modules: Sales
  serves: SalesApi
}
```

The platform's persistence dispatcher picks `efcore` for `Sales.Quote` and `marten` for `Sales.Order`.

### 5.5 Maximal — full control

```ddd
# === Physical layer ===
storage pg        { type: postgres, instance: appDb }
storage pgReplica { type: postgres, instance: appDb.replica, follows: pg }
storage cache     { type: redis,    instance: hotCache }
storage events    { type: kafka,    instance: streams }

# === Logical layer ===
storage orderEvents    { use: pg,        for: Sales.Order, kind: eventLog, schema: "sales" }
storage orderSnapshots { use: cache,     for: Sales.Order, kind: snapshot, every: 100, retain: 5 }
storage orderCache     { use: cache,     for: Sales.Order, kind: cache,    keyPrefix: "order:", ttl: 60 }
storage quoteDb        { use: pg,        for: Sales.Quote, schema: "sales" }
storage quoteReadOnly  { use: pgReplica, for: Sales.Quote, kind: replica,  readonly: true }
storage catDb          { use: pg,        for: Catalog.Item, schema: "catalog" }

# === Aggregates ===
aggregate Sales.Order { persistenceStrategy: eventSourced
  event OrderPlaced  { publish: integration, ... }
  event OrderShipped { publish: both,        ... }
}
aggregate Sales.Quote { persistenceStrategy: stateBased
  event QuoteSubmitted { publish: integration, ... }
}
aggregate Catalog.Item { persistenceStrategy: stateBased, ... }

# === Composition ===
deployable api {
  platform: dotnet {
    style:  cqrs
    layout: byFeature
    persistence {
      use: { stateBased: efcore, eventSourced: marten }
    }
  }
  modules: Sales, Catalog
  serves: SalesApi, CatalogApi
  port: 8080
}

deployable apiTest {
  platform: dotnet {
    style: cqrs
    persistence: efcore
  }
  modules: Sales, Catalog
  serves: SalesApi, CatalogApi
  overrides {
    storage pg     { type: inMemory }
    storage cache  { type: inMemory }
    storage events { type: inMemory }
  }
}
```

---

## 6. Validation Rules

### 6.1 Storage

- Physical and logical `storage` decls share one name namespace; names are unique within a system.
- A logical storage's `use:` must resolve to a physical storage in the same system (overrides considered).
- A logical storage's `for:` must resolve to a declared aggregate (qualified `module.aggregate` name).
- **Per aggregate, exactly one primary logical storage** must exist (`kind: state` for state-based aggregates; `kind: eventLog` for event-sourced).
- Per aggregate, **at most one** logical storage of each derived kind (`snapshot`, `cache`, `replica`) is allowed in v1.
- `kind: snapshot` is only valid for event-sourced aggregates. Validator errors if `kind: snapshot` is declared for a state-based aggregate.
- `kind: eventLog` requires its aggregate's `persistenceStrategy: eventSourced`; `kind: state` (or absent kind on a state-based aggregate) requires `persistenceStrategy: stateBased`. Mismatch is an error.
- Snapshot policy keys (`every:`, `retain:`) are only valid on `kind: snapshot`. Other kinds reject them.
- Storage type × kind compatibility: e.g., `kafka` cannot be the `use:` of any primary logical storage; `redis` cannot be `kind: eventLog`. The full per-kind compatibility list lives on each `PersistenceAdapter`'s `supportedStorageTypes` (see §7).
- `instance:` grouping: all physical storages sharing `(type, instance)` are coalesced to one compose service. Differing config on coalesced decls is an error.
- `follows:` must resolve to another physical storage of the same type; cycles are an error.

### 6.2 Aggregate

- `persistenceStrategy: eventSourced` requires the deployable's platform persistence config to expose an ES-capable adapter (either `persistence: <esAdapter>` where the adapter `supportedStrategies` includes `eventSourced`, or `persistence { use: { eventSourced: <esAdapter> } }`).
- An ES aggregate must have exactly one logical storage with `kind: eventLog`.

### 6.3 Events

- `publish: integration | both` requires the aggregate's primary physical store to be of a type that supports transactional outbox (`postgres`, `mysql`, `sqlite`, or `inMemory` with the test adapter). Otherwise: error.

### 6.4 Platform config

- `style:` must be in the platform's declared menu.
- `layout: byFeature` × `style: layered` → warning or error (platform decides; default warning, treated as `byLayer`).
- `persistence.use:` must be in the platform's adapter menu; the adapter must support all strategies present in the modules the deployable contains.
- `framework:` must be in the platform's framework menu.
- `style: layered` × any contained aggregate with `persistenceStrategy: eventSourced` → error.

### 6.5 Overrides

- Override target must reference an existing physical storage name.
- Override may modify `type`, `connection`, `instance`, `outbox`. Other keys are warnings or errors (v1: error).
- Cannot rename, delete, or create new storages via overrides.
- Per-deployable override resolution: physical storages effective in deployable `D` = (system-wide physical storages) ⊕ (D's `overrides {}`).

### 6.6 Storage Capability Matrix

Each `StorageType` is statically declared to support a subset of `LogicalStorageKind` values. This matrix expresses **platform-independent physical truth** (kafka is log-structured and can never host an in-place-updated `state`; redis has no transactions and can never be an authoritative `state`). It is the *first* of two validation layers; the second is per-adapter capability (§7.2).

| StorageType | `state` | `eventLog` | `snapshot` | `cache` | `replica` | Transactional (outbox-capable) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `postgres`     | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `mysql`        | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sqlite`       | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `inMemory`     | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `redis`        | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ |
| `kafka`        | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `elastic`      | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ |
| `meilisearch`  | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ |
| `clickhouse`   | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ |
| `bigquery`     | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ |

**Justifications for non-obvious entries:**
- `elastic` / `meilisearch` × `state`: not transactional, eventually consistent; allowed because document-shaped aggregates where the EC window is acceptable do use these as state stores in practice.
- `elastic` × `eventLog`: rejected — no per-stream ordering guarantees suitable for an event store.
- `clickhouse` / `bigquery` × `snapshot`: legitimate use as cold-storage snapshots.
- `clickhouse` / `bigquery` × `state`: rejected — no in-place updates.
- `redis` × `snapshot`: allowed for hot snapshots; the loss-on-restart risk is acceptable since snapshots are derivable from the event log.

**Transactional column** (rightmost) drives outbox compatibility: an aggregate publishing integration events (`event { publish: integration | both }`) requires its primary store to be transactional. Non-transactional primaries are a validator error.

**Validation flow:**
1. **Physical capability check** — for every `dataSource X { use: P, kind: K }`, verify `STORAGE_CAPABILITIES[P.type].has(K)`. Error otherwise (with the supported-kinds list in the message).
2. **Outbox transactional check** — for every aggregate with integration events, verify its primary physical store is in `TRANSACTIONAL_TYPES`.
3. **Per-adapter capability check** — for every aggregate × deployable, verify the chosen `PersistenceAdapter.supports(physical.type, ds.kind, agg.persistenceStrategy)` returns true.

Errors at any layer halt the build with a descriptive message.

**Deferred storage kinds** (`archive`, `projection`, `searchIndex`) will reshape this matrix when channels/read-models land. ClickHouse, BigQuery, and Elastic will gain richer entries then. The v1 matrix is conservative on purpose: it covers the kinds Loom can actually emit code for today.

---

## 7. Internal Architecture Changes

### 7.1 Per-platform persistence adapter seam

Each platform generator gains a `persistence/` subtree with one folder per adapter, plus a shared contract:

```
src/generator/dotnet/
  index.ts                        # platform orchestrator; selects adapters per config
  surface.ts                      # PlatformSurface impl (unchanged shape)
  emit/                           # adapter-agnostic emitters (DTOs, value objects, events, controllers)
  styles/
    surface.ts                    # StyleAdapter contract
    cqrs/
      handler.ts
      command.ts
      mediator-wire.ts
    layered/
      controller.ts
      service.ts
      di.ts
  persistence/
    surface.ts                    # PersistenceAdapter contract
    efcore/
      dbcontext.ts
      repository.ts
      migrations.ts
      di.ts
    dapper/
      connection.ts
      repository.ts
      migrations.ts               # FluentMigrator or DbUp
      di.ts
    marten/
      session.ts
      repository.ts
      di.ts
  layouts/
    surface.ts                    # LayoutAdapter contract
    by-layer.ts
    by-feature.ts
  render-expr.ts                  # adapter-agnostic
  render-stmt.ts                  # adapter-agnostic
```

### 7.2 Contracts (sketches)

```typescript
// src/ir/storage-capabilities.ts (new file)
import type { StorageType, LogicalStorageKind } from "./loom-ir.js";

export const STORAGE_CAPABILITIES: Record<StorageType, Set<LogicalStorageKind>> = {
  // Universal transactional SQL
  postgres:    new Set(["state", "eventLog", "snapshot", "cache", "replica"]),
  mysql:       new Set(["state", "eventLog", "snapshot", "cache", "replica"]),
  sqlite:      new Set(["state", "eventLog", "snapshot", "cache", "replica"]),
  inMemory:    new Set(["state", "eventLog", "snapshot", "cache", "replica"]),

  // KV / cache
  redis:       new Set(["cache", "snapshot"]),

  // Log-structured streaming
  kafka:       new Set(["eventLog"]),

  // Search-flavored document stores
  elastic:     new Set(["state", "snapshot", "replica"]),
  meilisearch: new Set(["state", "snapshot", "replica"]),

  // Columnar / OLAP — limited fit within v1 kinds; richer use awaits archive/projection kinds
  clickhouse:  new Set(["snapshot", "replica"]),
  bigquery:    new Set(["snapshot", "replica"]),
};

export const TRANSACTIONAL_TYPES: Set<StorageType> = new Set([
  "postgres", "mysql", "sqlite", "inMemory",
]);

export function supportsKind(type: StorageType, kind: LogicalStorageKind): boolean {
  return STORAGE_CAPABILITIES[type].has(kind);
}

export function isTransactional(type: StorageType): boolean {
  return TRANSACTIONAL_TYPES.has(type);
}

// src/generator/<platform>/persistence/surface.ts
export interface PersistenceAdapter {
  name: string;
  supportedStrategies: PersistenceStrategy[];

  // Per-(type, kind, strategy) capability. Validator consults after STORAGE_CAPABILITIES passes.
  supports(
    type: StorageType,
    kind: LogicalStorageKind,
    persistenceStrategy: PersistenceStrategy
  ): boolean;

  emitProjectDeps(ctx: EmitCtx): Lines;
  emitConnectionSetup(physicalStores: PhysicalStorageIR[], ctx: EmitCtx): Lines;
  emitRepository(agg: AggregateIR, logical: LogicalStorageIR, ctx: EmitCtx): Lines;
  emitMigrations(aggs: AggregateIR[], physicalStores: PhysicalStorageIR[], ctx: EmitCtx): Lines | null;
}

// src/generator/<platform>/styles/surface.ts
export interface StyleAdapter {
  name: string;
  supportedStrategies: PersistenceStrategy[];
  emitEndpoint(op: AggregateOpIR, ctx: EmitCtx): Lines;
  emitHandlerOrService(op: AggregateOpIR, ctx: EmitCtx): EmittedArtifact[];
  emitDi(ctx: EmitCtx): Lines;
}

// src/generator/<platform>/layouts/surface.ts
export interface LayoutAdapter {
  name: string;
  pathFor(artifact: EmittedArtifact, ctx: EmitCtx): string;
}
```

**Per-adapter capability declarations (v1):**

| Adapter | `supports(type, kind, strategy)` returns true for |
|---|---|
| `efcore` | `(postgres\|mysql\|sqlite\|inMemory, state, stateBased)`; `(postgres\|mysql\|sqlite\|inMemory, eventLog, eventSourced)` — emits a generic events table; `(postgres\|mysql\|sqlite\|inMemory, snapshot, _)`; `(postgres\|mysql\|sqlite, replica, _)`. |
| `dapper` | `(postgres\|mysql\|sqlite\|inMemory, state, stateBased)`; `(postgres\|mysql\|sqlite\|inMemory, snapshot, _)`; `(postgres\|mysql\|sqlite, replica, _)`. No `eventLog` in v1 — the hand-rolled query layer is too much without a library. |
| `marten` | `(postgres, state\|eventLog\|snapshot\|replica, stateBased\|eventSourced)`. Postgres-only; built-in event store and document state. |
| `ashPostgres` (phoenix) | `(postgres, state\|snapshot\|replica, stateBased)`. |
| `ashCommanded` (phoenix) | `(postgres, eventLog\|snapshot\|replica, eventSourced)`. |

Adapter emitters are otherwise **plain TS functions building strings via `lines(...)` from `src/util/code-builder.ts`**, matching the existing Loom convention (no Handlebars in backend emitters).

### 7.3 IR additions

```typescript
// src/ir/loom-ir.ts additions

export type PersistenceStrategy = "stateBased" | "eventSourced";
export type EventPublishMode = "internal" | "integration" | "both";
export type LogicalStorageKind = "state" | "eventLog" | "snapshot" | "cache" | "replica";

export interface AggregateIR {
  // existing fields...
  persistenceStrategy: PersistenceStrategy;             // default: "stateBased"
}

export interface EventIR {
  // existing fields...
  publish: EventPublishMode;                 // default: "internal"
}

export interface PhysicalStorageIR {
  name: string;
  type: StorageType;
  instance?: string;
  connection?: ConnectionSourceIR;
  outbox?: OutboxConfigIR;
  follows?: string;                          // ref to another physical storage
}

export interface LogicalStorageIR {
  name: string;
  use: string;                               // ref to physical storage
  for: AggregateRefIR;                       // module.aggregate
  kind: LogicalStorageKind;                  // inferred from aggregate.persistenceStrategy if absent (defaults to "state" or "eventLog")
  schema?: string;
  // snapshot-only:
  every?: number;
  retain?: number;
  // type/kind-specific:
  tablePrefix?: string;
  searchPath?: string;
  isolationLevel?: IsolationLevel;
  keyPrefix?: string;
  ttl?: number;
  topicPrefix?: string;
  retention?: number;
  consumerGroup?: string;
  indexPrefix?: string;
  refreshOnWrite?: "immediate" | "async";
  dataset?: string;
  partitionBy?: string;
  readonly?: boolean;
  migrations?: "auto" | "manual" | "none";
}

export interface DeployableIR {
  // existing fields...
  platformConfig: PlatformConfigIR;
  storageOverrides: PhysicalStorageOverrideIR[];
}

export interface PlatformConfigIR {
  platform: string;                          // ident from grammar
  style?: string;
  layout?: "byLayer" | "byFeature";
  persistence?: PersistenceConfigIR;
  framework?: string;
}

export interface PersistenceConfigIR {
  use?: string;                              // single-adapter shorthand
  usePerStrategy?: Partial<Record<PersistenceStrategy, string>>;
  abstraction?: "repositoryPerAggregate" | "none";   // RESERVED; v1 emitter warns
}

export interface OutboxConfigIR {
  mode: "auto" | "disabled" | "explicit";
  layout?: "shared" | "perAggregate";        // default: "shared"
  table?: string;
  publisher?: "polling" | "listenNotify" | "logicalDecoding";
  interval?: number;
}
```

### 7.4 Lowering changes

`src/ir/lower.ts` gains:
- Physical/logical detection on `storage` nodes (presence of `for:`).
- Lowering for `aggregate.persistenceStrategy:` and `event.publish:` markers.
- Lowering for `deployable.platform { ... }` config block (the bare `platform: dotnet` form fills in defaults from the platform registry).
- Lowering for `overrides { }` blocks.

`src/ir/enrichments.ts` adds one pass per concern, kept pure:
- **Storage resolution**: for each aggregate, identify the primary logical storage and the resolved physical storage. Materialize the per-deployable effective storage set (system storages ⊕ overrides).
- **Outbox materialization plan**: for each physical store, determine if outbox is needed (any contained aggregate publishes integration events) and emit the materialization plan (table name(s), publisher process).
- **Adapter selection**: for each aggregate × deployable, choose the persistence adapter.

The existing `wireShape`, auto-`findAll`, and React `targets:` inheritance passes remain unchanged.

### 7.5 Validator additions

In `src/language/ddd-validator.ts`:
- Storage uniqueness, physical/logical XOR detection.
- Strategy × kind consistency.
- Style × strategy compatibility (`layered` rejects ES).
- Adapter × storage-type compatibility (per `supportedStorageTypes`).
- Override target existence and allowed-key set.
- Integration event × store-type transactional compatibility.
- Cycle check on `follows:` graph.

### 7.6 System orchestrator changes

In `src/system/`:
- Compose service generation: one service per `(type, instance)` physical group.
- Outbox publisher: one publisher process per physical store with `outbox: auto | explicit` and at least one integration-event-publishing aggregate. Implementation language depends on the deployable's platform; the publisher may live inside the platform's deployable or as a sidecar.
- Migrations owner enrichment is unchanged in shape but reads from the resolved logical/physical storage map.

---

## 8. Backward Compatibility

| Existing form | After this proposal |
|---|---|
| `storage pg { type: postgres }` | Parses as physical storage. Identical behavior. |
| `modules: Sales { primary: pg, cache: redis }` | Parses unchanged; lowering desugars to anonymous logical `storage` decls (one per role-slot). Identical generated output. |
| `aggregate Order { ... }` (no `persistenceStrategy:`) | Defaults to `stateBased`. Identical behavior. |
| `event Placed { ... }` (no `publish:`) | Defaults to `internal`. Identical behavior. |
| `platform: dotnet` (bare) | Defaults to `{ style: cqrs, layout: byLayer, persistence: efcore, framework: minimalApi }`. Identical generated output. |
| `platform: node` | Desugars to `platform: node { framework: hono }`. Identical generated output. |

Existing `.ddd` files require no edits. All new features are strictly opt-in.

---

## 9. Scope: v1 vs Deferred

### 9.1 v1 — In scope

**DSL:**
- `storage` keyword in physical and logical forms.
- `instance:`, `connection:`, basic `outbox:` (`auto` / `disabled` / shared-layout block) on physical.
- `use:`, `for:`, `schema:`, `kind:`, and the type-specific config keys listed in §3.2 on logical.
- `aggregate { persistenceStrategy: stateBased | eventSourced }`.
- `event { publish: internal | integration | both }`.
- `deployable platform: <name> { style:, layout:, persistence:, framework: }` config.
- `deployable overrides { storage X { ... } }`.
- Module binding bare form (`modules: Sales, Catalog`); existing role-slot form preserved as desugar.

**Persistence adapters:**
- `dotnet`: `efcore` (state, current default), `dapper` (state, alternative), `marten` (state + ES).
- `node`: existing default emitter wrapped as one adapter; one ES-capable adapter (TBD: hand-rolled event store, or candidate library).
- `phoenix`: `ashPostgres` (state, current default), `ashCommanded` (ES).

**Style adapters:**
- `dotnet`: `cqrs` (current), `layered` (new).
- `node`: `cqrs`, `layered`.
- `phoenix`: `ash` (current), `contexts` (new).

**Layouts:**
- `byLayer` (current default).
- `byFeature` (new).

**Platform rename:**
- `platform: node` → `platform: node { framework: hono }` (with desugar for backward compatibility).

### 9.2 Deferred (grammar slot reserved; emitter v1 may warn and ignore)

- **`persistence.abstraction: none`** — drop per-aggregate repository emission. Grammar accepts the key; v1 emitter warns. Implementation lands in v2.
- **Read models / projections** as first-class nouns (`readModel` or `projection` keyword) consuming channels.
- **Channels** as a first-class noun for cross-aggregate event transport. v1 outbox materializes a per-module default channel implicitly.
- **`for:` globs and finer granularity** (`for: Sales.*`, `for: Sales.Order.events`).
- **Per-module style/layout/persistence override** inside a deployable.
- **Sharding** (`shards:`, `shardKey:`) and richer replica policies.
- **Validator/mediator/API-framework as separate knobs** inside `platform { ... }`.

### 9.3 Future — no grammar slot reserved

- **Platform tier split** for backend-only frameworks: `platform: node { framework: hono | fastify | express | nestjs | elysia }`.
- **Fullstack meta-framework platforms**: `platform: nextjs`, `platform: remix`, `platform: sveltekit`, `platform: rails`.
- **Fullstack deployables** as a distinct deployable class (Phoenix-LiveView is already this; formalize).
- **Analytical store tuning** beyond `dataset:` / `partitionBy:`.
- **Sagas / process managers** as DSL concepts.

### 9.4 Not in scope (will not be added to DSL)

- Logging library, JSON serializer, HTTP server runtime — these are runtime swaps with no code-shape change. They belong in env / config files, not the DSL.
- Connection pool tuning (`pool.min/max`, `timeout`) — same reasoning.

---

## 10. Resolved Decisions

The questions raised during the design conversation are resolved as follows. Each resolution can be revisited if implementation surfaces a concrete reason — recorded here so the next agent doesn't re-litigate.

| # | Decision |
|---|---|
| **R1** | **Per-strategy default bundles.** Each platform's registry declares `defaultBundle: { stateBased: <adapter>, eventSourced: <adapter> }`. Bare `platform: dotnet` resolves to the bundle. Bare `persistence: efcore` overrides only the matching slot, leaving the other at the platform default. Defaults: dotnet → `{ stateBased: efcore, eventSourced: marten }`; phoenix → `{ stateBased: ashPostgres, eventSourced: ashCommanded }`; node → `{ stateBased: <existing emitter wrapped>, eventSourced: TBD in Phase 6 }`. |
| **R2** | **`for:` granularity.** v1 accepts only `for: <module>.<aggregate>`. Globs (`for: Sales.*`) and per-stream refs (`for: Sales.Order.events`) are deferred to a separate mini-RFC. |
| **R3** | **`outbox: perAggregate` layout.** Deferred from v1. Grammar accepts the key (so v2 ships without breaking change); v1 validator rejects `layout: perAggregate` with "not yet supported". Default `shared` is the only v1 emission. |
| **R4** | **Phoenix `contexts` style.** Dropped from v1 unless a Phoenix-using maintainer signs up to implement and own it. v1 ships Phoenix with `style: ash` as the sole menu value. The `style:` axis still exists in grammar; the menu is single-valued for Phoenix until contributed. |
| **R5** | **Logical storage namespace.** System scope. Matches physical storage. Cross-module reuse is easier; overrides target by global name. Module-private logical storages can be added later via a `private:` flag if needed; no namespace model change required. |
| **R6** | **Overrides for logical storages.** Forbidden in v1. All realistic swap scenarios (engine swap, connection swap, schema swap) are physical-store concerns. Logical storage identity is the binding; to change the binding, declare a different deployable's worth of logical storages. |
| **R7** | **Outbox publisher topology.** In-process for v1. Auto-emit the publisher inside whichever deployable's `migrationsOwner` already owns the physical store. Single replica per deployment; document the horizontal-scaling caveat ("polling mode with row-level locking is safe across replicas; switch to sidecar in v2 for `listenNotify` / `logicalDecoding` modes"). |
| **R8** | **`framework:` slot in v1.** Grammar-reserved, default registered per platform, **omitted from documentation examples**. Each platform has one v1 value (`hono` for node, `minimalApi` for dotnet, `liveview` for phoenix). It is not bullet-pointed as a v1 feature; its purpose is purely forward-compat. |
| **R9** | **Snapshots and other derived stores are separate top-level logical storages, not inline sub-blocks.** The `LogicalStorageKind` taxonomy is `state | eventLog | snapshot | cache | replica`. All five are uniform `storage X { use:, for:, kind:, ...config }` decls. Each derived store can live in a completely different physical engine (events in postgres, snapshots in redis, replica in pgReplica). The relationship between an event log and its snapshot store is implicit by `for:` — both target the same aggregate; the validator pairs them automatically. No `linkedTo:` or other explicit linking field. |

---

## 11. Implementation Plan (Suggested Phasing)

Each phase is shippable in isolation; later phases depend on the seams introduced earlier.

### Phase 1 — Grammar + IR scaffolding (no behavior change)

- Add grammar rules for physical/logical `storage`, `aggregate.persistenceStrategy:`, `event.publish:`, `platform { ... }` block, `overrides { }`.
- Regenerate Langium artifacts.
- Add IR types listed in §7.3.
- Add structural validator checks (uniqueness, XOR, reference resolution).
- **Acceptance gate**: existing fixture suite generates byte-identical output; new keywords parse and lower without affecting emission.

### Phase 2 — Persistence adapter seam in `.NET`

- Refactor `src/generator/dotnet/` to extract current EF-Core-specific code into `persistence/efcore/`.
- Define `PersistenceAdapter` contract in `persistence/surface.ts`.
- Platform `index.ts` routes through the adapter.
- **Acceptance gate**: byte-identical fixture output to current emission.

### Phase 3 — Dapper adapter on `.NET`

- Implement `persistence/dapper/`.
- Wire `platform: dotnet { persistence: dapper }` config.
- Add tests under `LOOM_DOTNET_BUILD=1` covering Dapper emission for several example `.ddd` files.

### Phase 4 — Event-sourcing on `.NET` (Marten)

- Implement `persistence/marten/`.
- Wire `aggregate.persistenceStrategy: eventSourced` through adapter selection.
- Implement outbox materialization (shared layout) in postgres.
- Implement integration event publisher process emission.
- Add E2E test confirming transactional outbox semantics.

### Phase 5 — Style + layout adapters on `.NET`

- Extract current cqrs-flavored emitter into `styles/cqrs/`.
- Implement `styles/layered/`.
- Implement `layouts/by-layer.ts` (current) and `layouts/by-feature.ts`.
- Validator: enforce style × strategy and style × layout matrix.

### Phase 6 — Same arc on `node`

- Rename `platform: node` to `platform: node { framework: hono }`; add desugar.
- Apply phases 2–5 to the Node platform.
- Identify and implement one alternative persistence adapter and one ES-capable adapter.

### Phase 7 — Same arc on `phoenix`

- Wrap current Ash emitter as `persistence/ashPostgres/` + `styles/ash/`.
- Implement `styles/contexts/` (vanilla Phoenix Contexts + Ecto) if maintainer confirms scope.
- Implement `persistence/ashCommanded/` for ES.

### Phase 8 — Per-deployable overrides materialization

- System orchestrator: apply override resolution per deployable.
- Generated docker-compose reflects effective physical storages per deployable.
- Test gate: a single system with `api` (postgres) and `apiTest` (inMemory) generates correct two-service / one-service compose stacks.

### Phase 9 — Outbox publisher hardening

- Cross-platform: confirm transactional consistency under load (separate test gates per platform).
- Add `LOOM_OUTBOX_E2E=1` test suite (analogous to existing `LOOM_OBS_E2E*` suites).

Phases 1–4 deliver the headline outcomes (explicit storage layer + ES support). Phases 5–7 round out the platform-config menu. Phases 8–9 mature the operational surface.

---

## 12. Cross-references

- `docs/architecture.md` — system-level composition (api/storage/ui/deployable layers). This proposal extends section on storage.
- `docs/language.md` — formal language reference. New grammar rules to be appended.
- `docs/generators.md` — per-platform feature matrix. New `style:`, `layout:`, `persistence:` columns to be added.
- `docs/migrations-design.md` — migrations ownership. The new logical storage layer is the source of truth for primary-storage-per-aggregate; the migrations enrichment must read from it.
- `docs/old/proposals/observability.md` and related — orthogonal to this proposal; no interaction expected.

### Relationship to the type-system family (PR #549 et al.)

This proposal **sits alongside** the type-system family proposals (`type-system-overview.md`, `aggregate-inheritance.md`, `payload-transport-layer.md`, `exception-less.md`, `criterion.md`, `partial-update.md`, `load-specifications.md`, `implementation-plan.md`). They share no required ordering but have coordination points worth pinning before either lands:

**Coordination 1 — the word `storage` is overloaded between the two proposals.**

This proposal uses `storage` as a **top-level declaration keyword** (`storage pg { type: postgres }` introduces a physical storage instance; `storage salesDb { use: pg, for: Sales.Order }` introduces a logical binding).

`aggregate-inheritance.md` uses `storage:` as an **aggregate-property key** for table layout (`abstract aggregate Party storage: shared` selects TPH; `storage: own` selects TPC).

The two concepts are genuinely different (top-level resource vs aggregate-property table-layout choice), but the same word in two roles forces readers to context-switch. **Recommendation: rename inheritance's `storage: shared | own` to `inheritanceStrategy: shareTable | ownTable`** (or `tableInheritanceStrategy:` if maximal explicitness is preferred). The two then read distinctly:

```ddd
storage pg { type: postgres }                                 # top-level: a physical storage instance
storage orderDb { use: pg, for: Sales.Order }                 # top-level: a logical binding

abstract aggregate Party {
  inheritanceStrategy: shareTable                              # aggregate property: TPH table layout
}

aggregate Customer extends Party {
  persistenceStrategy: stateBased                              # aggregate property: persistence model
}

aggregate AuditLog {
  persistenceStrategy: eventSourced
}
```

Per Loom convention, the `inheritanceStrategy:` key lives **inside** the `aggregate { ... }` block, not floating between the name and the block — same convention as `persistenceStrategy:` and every other aggregate attribute. Only modifiers (like `abstract`) appear before the keyword. This is also a small clean-up versus #549's draft, which placed `storage:` between name and block.

This rename leaves four cleanly distinct words for cleanly distinct concerns:
- `storage` (top-level) — physical instance or logical binding declaration.
- `persistenceStrategy:` — aggregate's persistence model (state vs events).
- `inheritanceStrategy:` — aggregate's inheritance table layout (TPH vs TPC).
- Loom doesn't shorten obvious words; the trade for readability is a few extra characters.

**Note on aspect orthogonality.** Aside from the word overloading, the underlying *concepts* are orthogonal:

- `persistenceStrategy: stateBased | eventSourced` — persistence model. Relevant on every aggregate.
- `inheritanceStrategy: shareTable | ownTable` (renamed) — inheritance table layout. Relevant only on abstract aggregates with subtypes.

They coexist on the same `aggregate { ... }` block without further conflict.

**One intersection corner case worth flagging** — an event-sourced concrete subtype of a TPH inheritance hierarchy raises a real semantic question: does the shared parent table hold rows for the ES subtype? If yes, those rows are derived state (a projection from events) inside the inheritance table; if no, polymorphic `Party id` references break. Three reasonable resolutions:

1. Validator rejects the combination entirely (`persistenceStrategy: eventSourced` × extending an aggregate with `inheritanceStrategy: shareTable` → error).
2. Allow it with explicit projection-into-base semantics (each event application also upserts the parent-table row).
3. Force ES subtypes to use `inheritanceStrategy: ownTable` (TPC), so each subtype owns its event log and any derived state separately.

Recommendation when both proposals are stable: option (3) — simplest, no projection-into-parent magic. To be decided jointly with the #549 author at the intersection point; not blocking either proposal's foundation phase.

**Coordination 2 — adapter contract interaction with exception-less A4.**
- This proposal's `PersistenceAdapter.emitRepository(agg, logical, ctx): Lines` contract signature is **stable** under `exception-less.md` Phase A4 (find-variant re-shape: `Repo.getById → T or NotFound`).
- What changes under A4 is the *emitted code body inside each adapter's emitRepository*. The seam introduced by this proposal makes A4's per-backend update become per-adapter update — strictly cleaner.
- Sequencing-wise: this proposal landing **before** A4 makes A4 easier. Landing after A4 means A4 modifies monolithic emitters that this proposal would then refactor — wasted work.

**Coordination 3 — outbox + payload generics.**
- This proposal's outbox emission writes integration events as JSON blobs (event_type + payload columns) in v1. After `payload-transport-layer.md` Phases P3-P4 land, outbox emission *could* be retrofitted to use generic `envelope<T>` payloads. Forward-looking note; not a v1 requirement.

**Coordination 4 — `criterion.md`'s `Repo.findAll(criterion, sort?, page?, loads?)`.**
- This is purely additive to the persistence adapter contract — adds an `emitFindAll(criterion, ...)` method. Existing emit methods are unaffected. Lands after this proposal's foundation, slots into each persistence adapter cleanly.

**Decision pins from #549 that affect this proposal** (none of these change my design):
- D1 (`carrier` bound name) — affects only outbox-event-as-payload future work, not v1.
- D14 (ML-postfix syntax) — affects only how outbox-event payload generics would be written in the future.
- D17 (`error` as sugar keyword) — orthogonal; my outbox doesn't emit errors.
- D22 (preconditions throw) — orthogonal; storage adapters don't see preconditions.

### Position in the overall roadmap

Given the analysis above, this proposal's foundation phases land **before** the bulk of the type-system family work, in parallel with `aggregate-inheritance.md`'s I-track. See [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md) §"Sequencing relative to PR #549" for the detailed week-by-week placement.

---

## 13. Summary of decisions taken in design

The following design decisions were made during the conversation that produced this proposal. They are recorded here so reviewers can challenge any specific decision:

1. **One noun for the data layer, not two.** `storage` collapses physical-server and logical-binding concerns into one keyword with two forms. Rationale: a two-noun split (`storage` + `dataSource`) added boilerplate without separating concerns the user perceives as separate.
2. **`for:` lives on logical storage, not on aggregate.** Storage points at its aggregate; the aggregate doesn't point at its storage. Rationale: aggregate domain code stays storage-agnostic; per-deployable swap works by re-pointing storages, not by re-pointing aggregates.
3. **One primary storage per aggregate, period.** Multiple "roles" (cache, replica, events) on an aggregate are not parallel transaction boundaries. The outbox is a property of the primary store, not a separate storage.
4. **`persistenceStrategy:` lives on aggregate, not on storage.** Event-sourcing changes the aggregate's API (apply vs save), which makes it a domain modeling concern, not pure infrastructure. The matching storage `kind: eventLog` is constrained by it.
5. **Block syntax (`storage X { ... }`), not function-call syntax (`postgres(...)`)**. Matches Loom's existing tone; every wiring construct in the DSL today is `Name { key: value }`.
6. **`persistence:` block uses `use:` as the inner key.** Consistent with logical storage's `use: <physical>` — same word, same meaning ("pick this named thing").
7. **`abstraction: repositoryPerAggregate | none` deferred from v1 emission but grammar slot reserved.** Avoids a future breaking change; v1 ships smaller.
8. **`layout:` is orthogonal to `style:`.** `byFeature` is a directory-organization choice on top of `cqrs`; it is not the same thing as VSA. Pure VSA (no shared repository abstractions) is what `abstraction: none` would later unlock.
9. **`outbox: shared` (one table per DB / schema) is the v1 default.** `outbox: perAggregate` is a legitimate alternative and is mentioned in the grammar sketch, but does not ship in v1.
10. **`platform: node` becomes `platform: node { framework: hono }`** as the first step toward separating runtime, HTTP framework, and meta-framework tiers. Meta-frameworks (Next.js, Remix, SvelteKit) will get their own `platform:` slots when added; they are not framework values inside `platform: node`.
11. **Verbose, self-explanatory names over abbreviated ones.** Loom doesn't shorten obvious words elsewhere (`view`, `aggregate`, `workflow` are all full); the convention extends here. `persistenceStrategy:` over `strategy:`; recommended `inheritanceStrategy:` over `storage:`; values `shareTable | ownTable` over `shared | own`. A few extra characters per declaration buy self-explanatory reading without context.
12. **Both `persistenceStrategy:` and (recommended) `inheritanceStrategy:` are domain-modeling concerns, not pure infrastructure.** Each choice changes capabilities the user can see: persistence model affects the aggregate's API and event semantics; inheritance layout affects whether `Party id` refs are legal, whether `find all Party` is single-scan vs UNION ALL, how views project. Surface these as visible, named attributes inside the aggregate block — not as quiet annotations.
13. **All aggregate attributes live inside the `{ ... }` block.** Only modifiers (like `abstract`) appear before the keyword. The recommended fix to #549's `abstract aggregate Party storage: shared { ... }` shape moves `inheritanceStrategy:` inside the block — matching the convention `persistenceStrategy:` already follows.
14. **The recommendation to #549 is to rename `storage:` → `inheritanceStrategy: shareTable | ownTable`** (and move it inside the block). The original conflict was the word `storage` being overloaded between this proposal's top-level keyword and `aggregate-inheritance.md`'s aggregate-property key — same word, different syntactic roles. The aspects are orthogonal; only the lexical overlap needed fixing. Decision pending #549 author's response; this proposal carries the recommendation without unilateral edits to their PR.
15. **Storage capability matrix is enforced at two layers.** Static `(StorageType × LogicalStorageKind)` matrix in `src/ir/storage-capabilities.ts` expresses platform-independent physical truth (kafka can never be a `state` store; redis can never be transactional). Per-adapter `supports(type, kind, strategy)` expresses each adapter's implementation coverage. Both checks must pass. This split is what lets EF Core declare `eventLog` capability (via a generic events table emitter) without conflating "physically possible" with "this adapter chooses to emit".
16. **`AdapterNotImplementedError` does not reference internal plan phases or stream names in user-facing messages.** Users have no visibility into our roadmap. Errors carry adapter kind, adapter name, platform name, and the list of *available* sibling adapters — that's enough for the user to act on. Internal tracking lives in code comments at the stub registration site only.
17. **This proposal's foundation lands BEFORE most of PR #549's type-system family work** — specifically before exception-less A4, in parallel with the aggregate-inheritance I-track. The `PersistenceAdapter.emitRepository(...)` contract introduced here is stable under A4; the seam landing first reduces A4's per-backend monolithic edits to per-adapter file edits. Landing after A4 would force me to refactor whatever A4 produces — wasted work. See `storage-and-platform-config-micro-plan.md` §"Sequencing relative to PR #549" for the week-by-week placement.
