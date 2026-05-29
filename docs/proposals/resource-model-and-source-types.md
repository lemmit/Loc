# Proposal: Resource Model & Source Types (response to the data-source RFC)

**Status:** Draft. Response to an external RFC ("Resource Model for Data Sources").
**Scope:** Decide whether and how Loom should conform to the RFC's three-noun model
(`dataSource` / `sourceType` / `resource`) plus its `kind` / `capability` / `interface`
dimensions. Proposes a phased adoption that renames the shipped `dataSource` →
`resource`, formalizes a data-driven `sourceType` registry, and sequences the new
semantic kinds (`queue`, `objectStore`, `api`) and the abstract need-node as a
follow-up.

> **Relationship to prior decisions.** This builds directly on
> **D-STORAGE-SPLIT** ([`docs/decisions.md`](../decisions.md)) and the
> [`storage-and-platform-config*.md`](./storage-and-platform-config.md) proposal
> trio. The RFC is, in effect, a "v2" of that same data-layer axis: where
> D-STORAGE-SPLIT separated the *physical instance* (`storage`) from the *logical
> binding* (`dataSource`), the RFC separates the *logical need* from the
> *binding*, and promotes the *technology enum* into a *registry*.

---

## 1. The RFC in brief

The RFC defines a stricter data-layer vocabulary, motivated by the observation
that broad low-code "data source" buckets (NocoBase, ToolJet) are semantically
weak. It proposes:

- **`dataSource`** — a *logical application need*. Describes *what* the app
  requires (a relational store, an object store, a queue…), not *which*
  technology provides it. Carries `kind` + `requires: [capability…]`.
- **`sourceType`** — a *built-in, platform-defined* descriptor of a technology
  family (`postgres`, `awsS3`, `rabbitmq`, `redis`, `restApi`…). Not
  user-authored. Declares, *per kind*, the supported `capabilities` and valid
  `interfaces`.
- **`resource`** — the *configured binding* of a `dataSource` to a `sourceType`,
  choosing one `kind`, deriving/selecting one `interface`, and holding
  connection config. Closest precedent is Retool's `resource`.
- **`kind`** — the *semantic role*: `database | queue | eventLog | cache |
  objectStore | api`.
- **`capability`** — a finer-grained behavior within a kind (`crud`, `query`,
  `transactions`, `publish`, `ack`, `append`, `replay`, `blob`, `signedUrl`,
  `ttl`…).
- **`interface`** — the *access mode* selected per context: `sql | rest |
  graphql | webSocket | amqp | sdk`.

Core rules (RFC §10): a resource is valid iff `resource.kind == dataSource.kind`,
the kind is supported by the sourceType, `dataSource.requires ⊆
sourceType.supports[kind].capabilities`, and the consuming operation selects an
interface from `sourceType.supports[kind].interfaces`.

---

## 2. Mapping the RFC onto Loom today

| RFC noun | Loom today | Match quality |
|---|---|---|
| `resource` (need→tech binding + config) | **`dataSource`** — `ddd.langium:170`, `DataSourceIR` `loom-ir.ts:1216`. `{ for: Ctx, kind, use: storage, schema, ttl… }` | **Strong.** Our `dataSource` *is* the RFC's `resource`. |
| `sourceType` (built-in tech descriptor; per-kind capabilities + interfaces) | **`StorageType`** enum (`ddd.langium:307`, `StorageKind` `loom-ir.ts:871`) + **`PersistenceAdapter.supports(storageType, kind, strategy)`** (`persistence-surface.ts:29`) + hardcoded vendor pins across generators | **Partial / scattered.** The knowledge exists, but as a closed enum + adapter code, not a first-class registry. |
| `dataSource` (logical need: kind + requires) | **Nothing standalone.** Implied by aggregate `persistedAs(…)` (`loom-ir.ts:336`) and the `(context, kind)` pair. | **Absent.** |
| `kind` (semantic role) | **`DataSourceKind`** = `state \| eventLog \| snapshot \| cache \| replica` (`loom-ir.ts:1241`) | **Different axis** (see §4). |
| `capability` | **`implementsCapabilities: string[]`** on aggregates (`loom-ir.ts:315`) — but that is *domain* capabilities, not *storage* capabilities | **Name collision; no real counterpart.** |
| `interface` (sql/rest/amqp/sdk) | *(none — implicitly fixed by the backend platform)* | **Absent.** |

### 2.1 `storage` vs the RFC

Loom's `storage { type: postgres, instance, connection }` (`ddd.langium:300`) is
the *physical instance* layer. The RFC has no separate first-class physical node
("§4.5 connection is implicit for now" — folded into `resource`). So under any
conformance, Loom's `storage` stays as-is; the `type:` enum is what gets
promoted into `sourceType`.

---

## 3. The naming inversion (the crux)

The single most important risk: **RFC `dataSource` is nearly the *opposite* of
Loom `dataSource`.**

- RFC `dataSource` = the *abstract need* (no technology).
- Loom `dataSource` = the *concrete binding* (technology + config) = **RFC
  `resource`**.

So conforming is **not a rename in place** — it is a re-layering:

1. Loom `dataSource` → **`resource`** (clean; matches Retool and the RFC).
2. The freed-up word `dataSource` becomes available for the *need* node (a new,
   different meaning).

During any transition, both specs use the word `dataSource` for different things.
Mitigation: keep `dataSource` as a **deprecated soft-keyword alias for `resource`**
through Phase 1, and only re-introduce `dataSource`-as-need in the phase that adds
the need node — never let both meanings be live simultaneously.

---

## 4. Axis mismatches to reconcile

### 4.1 `kind` taxonomies are not the same dimension

| Loom `DataSourceKind` | RFC `kind` |
|---|---|
| `state`, `snapshot`, `replica` | *(all sub-roles of)* `database` |
| `eventLog` | `eventLog` |
| `cache` | `cache` |
| *(none)* | `queue`, `objectStore`, `api` |

Ours is **DDD-persistence-shaped** (how an aggregate's truth is stored); the
RFC's is **infrastructure-shaped** (what kind of system this is). `state` /
`snapshot` / `replica` are really *capabilities or sub-roles within* the RFC's
`database` kind. Adopting RFC `kind` wholesale would reclassify our shipped enum —
a breaking change with no current payoff, since we don't yet emit queues or
object stores.

**Resolution path:** treat RFC `kind` as the *outer* axis (`database`, `queue`,
`objectStore`, …) and keep our `state/eventLog/snapshot/cache/replica` as the
*persistence sub-role* under `database`/`eventLog`/`cache`. This is additive, not
a reclassification, and only matters once non-database kinds land.

### 4.2 `capability` collides with an existing concept

We already have `implementsCapabilities` on aggregates (`loom-ir.ts:315`,
declared via `implements "…"`) meaning *domain* capabilities (audit, soft-delete,
etc.). The RFC's `capability` is a *storage* capability (`crud`, `transactions`,
`signedUrl`). These must not share a type or keyword. Proposed: name the storage
concept `sourceCapability` (registry-side) to avoid overloading.

---

## 5. Where "sourceType" knowledge lives today

The RFC's `sourceType` registry (per-kind capabilities + interfaces + vendor
realization) maps onto code that is currently **scattered and closed**:

| Concern | Location |
|---|---|
| Closed type enum (no extensibility seam) | `loom-ir.ts:871` (`StorageKind`), `ddd.langium:307` |
| Per-tech capability predicate (the natural registry home) | `persistence-surface.ts:29` — `PersistenceAdapter.supports(storageType, kind, strategy)` |
| Docker image pin | `system/index.ts:315` (`postgres:16-alpine`) |
| .NET provider | `efcore-persistence.ts:68,87` (`Npgsql…`, `UseNpgsql()`) |
| Hono/TS provider | `drizzle-persistence.ts:51,107` (`pg`, `pg.Pool()`) |
| Phoenix provider | `ash-postgres-persistence.ts:82,109` (`ash_postgres`, PG extensions) |
| Postgres-only SQL renderer | `sql-pg.ts:19` |
| Relational-type set (duplicated) | `system/datasources.ts:8`, `validators/datasource.ts` |

A `sourceType` registry would consolidate the duplicated relational-type sets and
the `supports()` matrix into one data-driven table. The RFC's `interface`
dimension has **no counterpart** today — the backend platform implicitly fixes
it. It only earns its keep once non-database kinds exist.

---

## 6. Options

### Option A — Cosmetic conformance (rename only)
Rename `dataSource` → `resource` (keep `dataSource` as a deprecated alias). Name
the `sourceType` registry as a mechanical extraction of the existing enum +
`supports()` knowledge. **No** need-node, capability, or interface.
*Aligns vocabulary; lowest risk; no new expressive power.*

### Option B — Full RFC adoption
All three nouns + `kind` / `capability` / `interface`. Reconcile the kind
taxonomy (§4.1), add `queue` / `objectStore` / `api` kinds with real adapters,
add the `interface` selection axis and the abstract `dataSource` need-node with
`requires ⊆ supports` validation. *Maximum expressiveness; ~the
65-implementer-day class of change from the existing storage plan; reclassifies
the shipped enum.*

### Option C — Registry + capabilities now, need-node + new kinds later **(recommended)**
A strict prefix of B:
1. Rename `dataSource` → `resource` (+ deprecated alias).
2. Formalize a **data-driven `sourceType` registry** on top of the existing
   `PersistenceAdapter.supports()` seam, carrying per-kind `sourceCapabilities`
   and `interfaces` as descriptor data; collapse the duplicated
   `RELATIONAL_STORAGE_TYPES` / validator tables into it.
3. Keep our `kind` axis; make the kind↔sourceType↔capability matrix data-driven.
4. **Defer** the standalone `dataSource` need-node, the `queue`/`objectStore`/`api`
   kinds, and the user-facing `interface` selection to Phase 2.

---

## 7. What C defers relative to B

C is **forward-compatible** with B — it is the foundation B builds on, sequenced
rather than skipped. Until Phase 2 (B), the following are *not* available:

1. **The abstract need layer.** No `dataSource { kind, requires }` decoupled from
   tech; no language-level `requires ⊆ supports` capability matching. Validation
   stays the coarse kind↔type compat matrix.
2. **New semantic kinds** — `queue`, `objectStore`, `api`. So **S3 / RabbitMQ /
   external REST services cannot be modeled yet**. This is the main thing the
   "more things soon" goal wants, and it is the explicit Phase-2 payload.
3. **The `interface` dimension as a selectable axis** (e.g. `rest` vs `sdk` for
   S3, `amqp` for a queue). Under C, `interfaces` exist only as registry
   descriptor data; access mode stays implicitly fixed by the backend.
4. **Model-level portability** via the need↔resource split — swapping the
   realizing technology still happens at the `resource` / deployable-override
   level, not against a stable need contract.

**What C does *not* cost** (no rework for B): the vocabulary alignment, the
consolidated registry, and the migration path are all a strict prefix of B.

---

## 8. Recommended plan (Phase 1 = Option C)

**Goal:** vocabulary aligned with the RFC, vendor knowledge consolidated, no loss
of shipped behavior, paved road to B. Mirrors the F1 micro-plan discipline:
`test/fixtures/**` stays byte-identical where features are unused.

1. **Grammar** (`ddd.langium`): add `resource` rule (clone of `DataSource`);
   admit `dataSource` as a deprecated alias (validator warning). Add `resource`,
   `sourceType`, `sourceCapability`, `interface`, `requires` as **soft keywords**
   (we already do this for `kind`/`schema`/`every` — `ddd.langium:456,929,1287`)
   so user field names don't break. `npm run langium:generate`.
2. **IR** (`loom-ir.ts`): rename `DataSourceIR` → `ResourceIR` (keep a type alias
   for one cycle); add a `SourceTypeIR` registry type
   (`{ name, supports: Record<kind, { capabilities, interfaces }> }`).
3. **Registry**: introduce `src/ir/source-types.ts` (or `src/platform/`) as the
   single data-driven table; back `PersistenceAdapter.supports()` with it; fold in
   `RELATIONAL_STORAGE_TYPES` from `system/datasources.ts:8` and
   `validators/datasource.ts`.
4. **Lowering** (`lower.ts:517-548`): emit `ResourceIR`; keep `persistedAs`
   identity mapping (`resolve-datasource.ts:34`) unchanged.
5. **Validation** (`validators/datasource.ts`): drive the kind↔type compat checks
   from the registry instead of inline tables; emit the `dataSource`-deprecation
   warning.
6. **Printer / tooling**: `print-structural.ts`, VS Code TextMate grammar, Monaco
   playground tokens, web builder round-trip.
7. **Sources**: migrate `.ddd` examples + `test/fixtures/**` (codemod
   `dataSource`→`resource`); keep one fixture exercising the alias.

**Phase 2 (Option B, separate proposal/PR sequence):** abstract `dataSource`
need-node, RFC kind taxonomy as the outer axis, `queue`/`objectStore`/`api` kinds
with adapters, user-facing `interface` selection, and `requires ⊆ supports`
matching. Gated on a concrete new backend (S3 or RabbitMQ) to create real
pressure.

---

## 9. Migration surface (any option)

- **Soft-keyword churn:** `resource`, `sourceType`, `sourceCapability`,
  `interface`, `requires` added as soft keywords.
- **`persistedAs` identity mapping** (`resolve-datasource.ts:34`) is unchanged.
- **Blast radius:** `ddd.langium` + regenerate · `loom-ir.ts` · `lower.ts:517-548`
  · `validators/datasource.ts` + `deployable.ts` · `system/datasources.ts` /
  `system/index.ts` · `print-structural.ts` · **every `.ddd` example +
  `test/fixtures/**` byte snapshot** · VS Code TextMate grammar · Monaco
  playground tokens · web builder round-trip.

---

## 10. Open questions

1. **Alias lifetime.** One release cycle for `dataSource`-as-`resource`, or hard
   cutover with a codemod (consistent with D-DOCUMENT-AXIS's hard-cutover
   precedent)?
2. **Registry home.** `src/ir/source-types.ts` vs `src/platform/` — the latter is
   closer to where adapters already declare `supports()`.
3. **Custom source types.** RFC §11 forbids user-authored `sourceType` semantics
   "unless the platform explicitly supports custom sourceType plugins." Do we want
   that seam to align with the out-of-tree backend story (`packages/`,
   `fs-discovery.ts`)?
4. **Kind reconciliation timing.** Introduce the outer `database`/`queue`/… axis
   in Phase 1 (descriptor-only, unused) or hold it entirely for Phase 2?
