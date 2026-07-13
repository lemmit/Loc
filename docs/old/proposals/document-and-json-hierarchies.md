# Proposal: Documents and JSON-Based Hierarchies

**Status:** Decisions sealed — **all §8 sub-questions resolved**. Core direction **PINNED** as [D-DOCUMENT-AXIS](../../decisions.md). **The saving-shape axis is a 3-point spectrum, not a boolean:** `shape(relational | embedded | document)` (reworked from the boolean `normalised(true|false)` once that became clear — see §9 row C′). Slices A (`json`, #703), B (`persistedAs`, #711), C (shape surface, #713 + #724 rework) are merged/landed. Emission: the shared migration emits the right table per shape; **.NET and TS/Hono emit all three shapes** (relational; `embedded` — owned-`.ToJson()` on EF, root row + jsonb containment columns on Drizzle via `repository-embedded-builder.ts`; `document` blob), and **Phoenix/elixir emits `relational` + `embedded`** (on plain Ecto — embedded schemas). The per-backend `supportedShapes` gate is live (`validateSavingShapeSupport` over `PLATFORM_SAVING_SHAPES` in `src/util/platform-axes.ts` — `loom.saving-shape-unsupported`). Remaining: `shape(document)` on Phoenix/elixir. Full breakdown in §9.

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** References below to "Ash embedded resources" / "Ash `:map`" describe the former Ash-foundation emission — on the current vanilla foundation the same shapes are Ecto `embedded_schema` / `:map` columns.
**Scope:** Survey how Loom should let a modeller persist a hierarchy as a *document* (a single JSON tree) instead of a normalised set of tables, and whether "document" deserves to be a declaration kind next to `aggregate`/`entity`, a field type, a persistence strategy, or some combination. Compares against Marten, EF Core, and MongoDB-style modelling. Ends with a recommendation.

> **Pinned decisions affecting this proposal** (see [`docs/decisions.md`](../../decisions.md)):
>
> - **D-STORAGE-SPLIT** — `storage` is a physical instance; `dataSource`
>   is the logical `(context, kind)` → storage binding, where
>   `kind ∈ { state | eventLog | snapshot | cache | replica }`. A
>   document-store mapping, if it lands as a storage concern, extends
>   this `kind` set rather than inventing a parallel keyword.
> - **D-GRANULARITY** — `dataSource` bindings are per-context, not
>   per-aggregate, in v1. Any per-aggregate document override is a v2
>   concern and must be flagged as such.
>
> **D-DOCUMENT-AXIS** is now **PINNED** in [`docs/decisions.md`](../../decisions.md)
> (core axes, header syntax, the event-sourcing validation contract,
> `json` field type, document-is-not-a-peer). Sub-questions 3–5 there
> remain OPEN. This proposal is its decision record.
>
> **Direction (now pinned as D-DOCUMENT-AXIS):** two **orthogonal and
> different-in-kind**
> per-aggregate axes — both speak the `dataSource` vocabulary but
> capture different things:
>
> 1. **`persistedAs(eventLog | state)`** (the **primary truth** kind):
>    *what is the record of truth* — an append-only event log, or
>    current state. Renamed from the shipped body `persistenceStrategy:
>    eventSourced | stateBased`; the values now match the `dataSource`
>    `kind` set (`eventLog`/`state`), so the aggregate names its own
>    primary store kind. `persistedAs(eventLog)` foregrounds the
>    storing-as-a-log facet; the **body-discipline** contract
>    (operations emit events and never mutate state directly; an `apply`
>    must exist — the *validated* part) is the consequence the validator
>    enforces against the body. Default `persistedAs(state)`, usually
>    omitted. *(This truth-kind is a different storing concern from axis
>    2 — the log is always JSON-event rows; axis 2 governs only the
>    derived read model. Grammar reconciliation in §2.3.)*
> 2. **`shape(relational | embedded | document)`** (saving, new): **how the
>    materialised read model / snapshot is laid out** — a 3-point
>    spectrum (table-per-entity → queryable root + embedded-children
>    jsonb → one opaque jsonb blob). The axis that is genuinely new here.
>    *(Originally drafted as the boolean `normalised(true|false)`;
>    reworked to the enum once the spectrum was clear — §9 row C′.)*
>
> The combination explicitly required is **`persistedAs(eventLog)` +
> `shape(document)`** (Marten's sweet spot: an append-only event
> stream with the aggregate snapshot/projection persisted as a single
> JSON document). Consequently **Option 3 is dropped** and **Option 4
> is reframed** as the `shape` axis (not a third truth-kind value).
> See §2.3 and §7.

---

## 1. Background and Motivation

Loom already models internal hierarchies inside an aggregate, but it splits them across **two storage shapes today, and the split is implicit**:

| Source construct | Grammar | Where it lands physically |
|---|---|---|
| Value object | `valueobject Money { … }` (`ddd.langium:602`) | **Inline JSONB column** — `mapTypeToColumn` returns `{ kind: "json" }` for `valueobject`/`entity` types (`src/system/migrations-builder.ts:370`), rendered `JSONB` by `renderPgType` (`src/generator/sql-pg.ts`). |
| Entity part + containment | `entity Line { … }` + `contains lines: Line[]` (`ddd.langium:724`, `:853`) | **Separate relational table** — `tableForPart` emits one table per part; `schemaFromModule` walks `agg.parts` (`src/system/migrations-builder.ts:46`). |
| Reference collection | `Order id[]` | **Join table** — `tableForAssociation`, metadata derived in enrichment (`src/ir/enrich/enrichments.ts:409`). |

So a value object embedded in an aggregate is *already* a JSON document column, while a contained entity part is *already* a child table. The modeller does not choose this — it falls out of which keyword they reached for. There is **no `json` primitive and no `document` declaration** today (`PrimitiveType` is `int|long|decimal|money|string|bool|datetime|guid`, `ddd.langium:940`; `TypeIR` has no `json`/`document` variant, `loom-ir.ts:79`).

Three gaps follow:

1. **Schemaless / open-shape data has no home.** A `payload`, a `metadata` bag, an externally-defined JSON blob, a partially-typed integration message — there is no way to say "this field is JSON, and I'm not going to enumerate its shape."
2. **The relational-vs-document choice is not expressible.** A deeply nested aggregate (an `Order` with `Line[]` each with `Adjustment[]`) is forced into a star of join tables even when the team wants Marten-style "store the whole tree as one JSONB document and load it as a unit." Conversely there is no way to flatten a value object out of JSON into columns.
3. **Document-database backends can't be targeted faithfully.** The `.NET` backend is EF Core today (`src/platform/dotnet.ts`); a Marten target (Postgres-as-document-store + event store) has nowhere to attach, even though the `PersistenceAdapter` contract (`src/generator/dotnet/adapters/efcore-persistence.ts:41`) is exactly the seam a `martenPersistenceAdapter` would slot into via `supportedStrategies` / `supports(storageType, kind, persistenceStrategy)`.

### 1.1 How other ecosystems frame it

- **Marten (.NET / Postgres).** A document DB *and* an event store on one Postgres instance. The aggregate is stored as a JSONB document; you get hierarchical storage with relational-grade consistency, FKs between documents for referential integrity, and aggregate snapshots for event-sourced rehydration. Marten's thesis is explicitly that document storage beats RDBMS+ORM for *complex, hierarchical* objects. ([introduction](https://martendb.io/introduction), [events](https://martendb.io/events/))
- **EF Core 7+.** Offers *both* mappings for an owned/aggregate type: split into extra columns (or a child table for collections), **or** `.ToJson()` to collapse the whole owned tree into a single JSON column — "retaining the overall relational structure of the data" while embedding the document. This is the closest analogue to what Loom should expose: same domain type, two physical mappings, chosen per type. ([owned-entities](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities), [EF7 JSON columns](https://devblogs.microsoft.com/dotnet/announcing-ef7-release-candidate-2/))
- **MongoDB-style DDD.** "Embed what is read together; reference what is large, shared, or independent." Persisting an entire aggregate as one document gives optimistic-concurrency-by-value. ([embedded vs referenced](https://www.geeksforgeeks.org/mongodb/embedded-vs-referenced-documents-in-mongodb/), [Fowler, DDD_Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html))

The consistent lesson across all three: **document-vs-relational is mostly a *storage/embedding* decision applied to a hierarchy, not a separate kind of domain object** — with one exception, the genuinely open-shape JSON blob, which *is* a distinct field type.

---

## 2. Conceptual Model

### 2.1 Two different needs, often conflated

There are **two** distinct features hiding under "documents," and the proposal keeps them separate:

- **(A) Open-shape JSON** — a field whose interior Loom does not model. No wire shape to enumerate, no validation of the interior, no migrations beyond "this column is JSONB". This is a **field type**.
- **(B) Document-mapped hierarchy** — a fully-typed Loom hierarchy (aggregate + parts/value objects) that the modeller wants stored as *one embedded JSON tree* rather than normalised tables. The domain model is unchanged; only the **physical mapping** changes. This is a **storage/embedding** decision.

Conflating them is the trap: (A) wants *less* typing, (B) wants the *same* typing with a different physical layout.

### 2.3 Two orthogonal axes — and they are different *in kind*

The decisive realisation from the design conversation: **document-vs-relational is not a variant of event-sourcing — it is a second axis that is a different *kind* of concern altogether.** The two must not be conflated, and crucially **neither is a sub-case of the other**:

- **Axis 1 — `persistedAs(eventLog | state)`**: the aggregate's **primary truth kind** — a **modelling** decision that bundles **two coupled facets**:
  1. **Body discipline** (behavioral, *validated*): for `persistedAs(eventLog)`, operations **emit events and never mutate state directly**; an `apply` (applier) must exist for every event, and the aggregate is rebuilt by folding them. The validator checks this against the body — the "is `apply` always there / do operations avoid mutating state directly" contract.
  2. **Storing as a log** (persistence): the append-only event stream is the durable record of truth.

  These are inseparable — that *is* what event-sourcing is. The keyword foregrounds facet 2 (the keyword *is* the truth kind); facet 1 rides along as the validated consequence. Crucially, this truth-kind is a *different* storing concern from Axis 2 below: the log is always a stream of JSON events; Axis 2 governs only the **derived read model / snapshot**. Default is `persistedAs(state)`, usually omitted.
  > **Naming reconciliation.** Today this is the shipped body clause `persistenceStrategy: stateBased | eventSourced` (`ddd.langium:612`, `:619`, threaded to `loom-ir.ts:327`). This proposal renames it to the header modifier `persistedAs(eventLog | state)`: (a) it moves to the header (no config in the body, §4); (b) it adopts the paren modifier form, parallel to `normalised(…)` / `inheritanceUsing(…)`; (c) its **values change to `eventLog` / `state`** to match the `dataSource` `kind` vocabulary — so `resolve-datasource.ts`'s current `eventSourced → eventLog` / `stateBased → state` translation becomes an identity. The English concept names stay "event-sourced" / "state-based"; the *keyword values* are `eventLog` / `state`. Breaking change — **hard cutover**: `persistenceStrategy:` is removed, sources migrate in one step via codemod (D-DOCUMENT-AXIS).

- **Axis 2 — saving** (`normalised(true | false)`): *how the materialised state/snapshot is physically laid out.* New, per-aggregate, default `normalised` (full backward compatibility).

Because they are different in kind, every combination is meaningful:

| | **`normalised(true)`** (default) | **`normalised(false)`** (new) |
|---|---|---|
| **`persistedAs(state)`** | EF Core normalised tables; VOs inline JSONB (today). | Whole current-state tree → one JSON document (Marten doc store / EF root `.ToJson()`). |
| **`persistedAs(eventLog)`** | Event log + projections to tables. | **The required combination.** Append-only event stream (JSON-event rows) + aggregate snapshot/projection persisted as **one JSON document**; rehydrate from snapshot, replay the tail. |

Note what `eventSourced` *does* and *does not* imply for saving: being event-sourced means there **is** an event log (events are the record of what happened — intrinsic to the body being event-emitting), but it says nothing about the *shape* of the read model. The event log is always serialised JSON-event rows; **`normalised` governs only the snapshot/projection.** D-STORAGE-SPLIT's `kind` set already carries both `eventLog` and `snapshot`, so the ES + document case wires as an `eventLog` binding plus a document-shaped `snapshot` binding; no new `kind` is required.

### 2.2 Candidate invariants (to ratify under D-DOCUMENT-AXIS)

1. **A document boundary is a single value.** Whatever is mapped as a document is written and read as one unit and concurrency-checked as one unit (matches Marten / Mongo embedding). No partial-row updates inside a document tree.
2. **Embedding is acyclic and ownership-only.** Only *containment* (parts / value objects) may be embedded. A cross-aggregate `X id` reference is never embedded — it stays a reference (matches "reference what is shared/independent"). This keeps aggregate boundaries intact.
3. **Open-shape JSON is opaque to the wire spec.** A `json` field contributes a single `json`-typed entry to `wireShape`; it is never expanded, diffed structurally, or validated field-by-field. Contract diffing (`wire-spec.json`) treats it as a leaf.
4. **Document mapping does not change the domain API.** `save`/`find`/`apply` semantics are identical whether an aggregate is normalised or document-mapped; only the emitted persistence code differs. (This is invariant #2 of `storage-and-platform-config.md` applied here: *storage is infrastructure; the aggregate's API is domain modelling*.)

---

## 3. The Option Space

Six options, arranged from smallest to largest surface (one dropped, one rejected). They are **not mutually exclusive** — the recommendation in §7 combines Options 1 + 4 + 5.

### Option 1 — `json` primitive field type *(addresses need A only)*

Add `json` to `PrimitiveType`. A `json` field is an opaque blob.

```ddd
aggregate Webhook {
  id          guid
  receivedAt  datetime
  payload     json          // opaque; stored as JSONB / jsonb / nvarchar(max)/ Map
  headers     json?
}
```

- **Grammar:** `PrimitiveType: name=(… | 'json');` (`ddd.langium:940`).
- **IR:** `TypeIR` gains `{ kind: "json" }` (`loom-ir.ts:79`). `wireShape` carries it as a leaf.
- **Per-backend:** TS `unknown`/`Record<string, unknown>` + `z.unknown()`; .NET `JsonDocument`/`JsonElement` (EF `[Column(TypeName="jsonb")]`); Phoenix `:map`; Postgres `JSONB`. Already half-built: the column kind `"json"` and `renderPgType` → `JSONB` exist.
- **Trade-offs:** Tiny, orthogonal, immediately useful. Does nothing for typed hierarchies (need B). Risk: people reach for `json` to dodge modelling — mitigate with a lint nudging toward a value object when the shape is known.

### Option 2 — Typed inline document type (`document`/`embedded` value-object variant) *(addresses need B at the type level)*

A *typed* nested structure that always serialises to **one JSON column**, even for collections — i.e. the EF Core `.ToJson()` shape. Today value objects already do this for scalars; the gap is **typed collections of nested structures** that should stay embedded instead of becoming child tables.

```ddd
document Address {           // fully typed, but always embedded as JSON
  street  string
  city    string
  zip     string
}

aggregate Order {
  id        guid
  shipTo    Address          // one JSONB sub-object (like a value object today)
  lines     OrderLine[]      // embedded array-of-objects in ONE JSONB column,
}                            //   NOT a child table
```

- **Conceptually:** `document` ≈ "value object that may contain collections and is guaranteed embedded." It is a *field/containment type*, **not** an aggregate peer — it has no identity, no repository, no independent lifecycle.
- **Grammar:** new `Document` decl (mirrors `ValueObject`, `ddd.langium:602`) added to `NamedDecl` (`ddd.langium:958`).
- **IR:** `TypeIR` gains `{ kind: "document"; name }`; lowering produces a `wireShape` for it exactly like a value object, but `mapTypeToColumn` keeps it `json` *including its arrays* (today arrays-of-entity become tables).
- **Trade-offs:** Clean answer to "is document a field type?" — **yes, this option says document is a typed field type.** Distinguishes "embedded forever" from "entity part that becomes a table." Cost: a third nested-structure keyword next to `valueobject`/`entity`; modellers must learn when to use which. See §5 for the disambiguation.

### Option 3 — Per-containment storage hint (`as document` / `as table`) — **DROPPED**

> **Decision (this revision): dropped.** Option 3 tunes the embedding of a *normalised* aggregate per containment edge — a relational-world refinement. Once the chosen direction is whole-aggregate `normalised(false)` (Option 4, §2.3), the per-edge knob answers a question we've opted out of. Its only residual value (embedding one sub-tree in an otherwise-relational row) is already largely served by value objects, which embed as JSONB today. Recorded for completeness; not pursued.

Keep `entity`/`valueobject` as the only nested kinds, but let the **containment edge** choose its physical mapping. This makes today's *implicit* asymmetry explicit and overridable.

```ddd
aggregate Order {
  id     guid
  contains lines:       OrderLine[]  as document   // embed as JSONB array
  contains attachments: Attachment[] as table      // child table (today's default)
}
```

- **Grammar:** extend `Containment` (`ddd.langium:853`) with `('as' embedding=('document'|'table'))?`.
- **IR:** `ContainmentIR` (`loom-ir.ts:139`) gains `embedding: "document" | "table"`; `schemaFromModule` branches on it instead of unconditionally calling `tableForPart`.
- **Trade-offs:** Most faithful to EF Core's "same type, choose mapping per use." No new declaration kind. But the choice lives at the use site, so the *same* `entity` could be embedded in one aggregate and tabled in another — flexible, but harder to reason about wire/migration stability. Composes well with Option 1.

### Option 4 — Aggregate-level `normalised(false)` (document) saving axis *(chosen — addresses need B, Marten-style, whole-aggregate)*

Treat the entire aggregate tree as one document, selected by a **new `normalised` axis** that is orthogonal to — and a different *kind* of concern from — the truth-kind axis `persistedAs(…)` (see §2.3). This is what makes `persistedAs(eventLog)` + `normalised(false)` expressible.

```ddd
aggregate ShoppingCart
  persistedAs(eventLog)                 // axis 1 (truth kind): emits events, rebuilt via appliers
  normalised(false)                     // axis 2 (saving): snapshot/projection = one JSON doc
{
  id     guid
  items  CartItem[]                     // whole tree → one JSONB snapshot, Marten-style
}
```

A `persistedAs(state)` aggregate with `normalised(false)` is equally valid (whole current state as one document, no event log).

- **Grammar:** add a header `normalised` modifier on `Aggregate` (`ddd.langium:610–614`), e.g. `('normalised' '(' normalised=Bool ')')?` placed with `ids` / `withClause` before `{`, with `Bool returns string: 'true' | 'false'` (default `true`). Separately, reconcile the body-structure marker per §2.3 + §4: a header `('persistedAs' '(' persistedAs=TruthKind ')')?` with `TruthKind returns string: 'eventLog' | 'state'`, replacing the body `persistenceStrategy: …`.
- **IR:** `AggregateIR` (`loom-ir.ts:327`) gains `normalised?: boolean` (default `true`) alongside `persistedAs?: "eventLog" | "state"`; `resolve-datasource.ts`'s `eventSourced → eventLog` / `stateBased → state` mapping becomes an identity, and it additionally requests a document-shaped `snapshot` binding when `normalised === false`.
- **Per-backend — a document *mode* in the existing adapters, not a new backend.** "Store as a document" is *the aggregate read model in one JSONB column*, and every backend already has that primitive (each serialises value objects to JSONB today). So the `document` shape is added to the **existing** per-backend adapters via their ORM's native whole-object-to-JSON feature: .NET **EF Core `.ToJson()`** chained onto the `OwnsOne`/`OwnsMany` mapping it already emits (`efcore.ts`); TS **Drizzle `jsonb`** column; Phoenix **Ash embedded resource / `:map`**. The `PersistenceAdapter` contract gates on strategy today (`efcore-persistence.ts:43` declares `supportedStrategies: ["stateBased"]`); add a **`supportedShapes`** companion (`["normalised","document"]`) so the orchestrator routes a `normalised(false)` binding to the *same* adapter's document branch. **A dedicated `martenPersistenceAdapter` was considered and rejected** — its document half is exactly EF `.ToJson()`, and its event-store half (stream + document snapshot rehydration) needs appliers (`workflow-and-applier.md`), so it is gated on that feature regardless of the backend choice.
- **Trade-offs:** Whole-aggregate granularity (no per-field control) — matches how Marten/Mongo actually work, and is exactly what dropping Option 3 commits to. Keeps the aggregate API unchanged (invariant §2.2#4). Pairs with Option 5 for the storage binding.
- **Syntax — paren modifier in the header.** `normalised(false)`, placed on the aggregate *header* line (before `{`), next to `ids` / `with` / `extends`.

  **Placement.** The corpus is inconsistent about where aggregate config lives, and this proposal picks the header to fix it: today `ids` and `with X(...)` are on the header (`ddd.langium:611`) and the inheritance proposal's strategy is on the header (`abstract aggregate Party storage: shared {`), but `persistenceStrategy:` is the lone exception — it sits *inside* the braces (`ddd.langium:612`; storage proposal `aggregate Sales.Order { persistenceStrategy: eventSourced`), grouped with the `event { publish: }` markers it governs. That is simply misplaced: the body holds the aggregate's *members*, not its configuration. **All aggregate-level config belongs on the header — there are no config entries in the body** — so `persistenceStrategy:` moves to the header too (as `persistedAs(eventLog | state)`).

  **Shape.** Two header shapes, by argument-arity:
  - **Argument-less markers → bare:** `abstract`, shipped boolean `audited`.
  - **Value-bearing modifiers → `name(value)`:** `persistedAs(eventLog)`, `normalised(false)`, `inheritanceUsing(sharedTable)`. This matches the existing modifier-application family (`audited(actions)`, `with audit(...)`) and reads as "selector(choice)". Defaults — `persistedAs(state)`, `normalised(true)` — are rarely written.

  **Binding block keeps colon.** Inside a `dataSource { kind: snapshot, use: pg, normalised: false }` every entry is `key: value`, so `normalised:` stays a colon entry *there* — a paren would clash with its siblings. So `normalised` is a paren *modifier* on the aggregate header but a colon *entry* in the binding block; each context is internally consistent.

  **Two frictions (both touch settled artefacts) — tracked under D-DOCUMENT-AXIS:**
  1. **D-RENAME (was `inheritanceStrategy: shareTable | ownTable`) is amended** on three counts (D-DOCUMENT-AXIS, §8 Q6): **key** `inheritanceStrategy` → **`inheritanceUsing`** (reads as a phrase — "inheritance using sharedTable"); **syntax** colon → paren header modifier; **values** kept table-baked and respelled `shareTable` → **`sharedTable`** (reads as "shared table"). Medium-neutral `shared`/`own` was considered and **rejected**.
  2. **`persistenceStrategy:` is shipped** (colon, in body, values `stateBased | eventSourced`). Renaming it to a header `persistedAs(eventLog | state)` — header, paren, *and* value change to `eventLog`/`state` — is a breaking grammar change. Resolved (D-DOCUMENT-AXIS): **hard cutover** — `persistenceStrategy:` is removed (not accepted in parallel); sources migrate in one step via codemod.

#### 4a. Interaction with inheritance (`inheritanceUsing`, was `inheritanceStrategy` / D-RENAME; D-ES-TPH)

`normalised` and the inheritance toggle (pinned as `inheritanceStrategy: sharedTable | ownTable` by D-RENAME; renamed by this proposal to `inheritanceUsing(…)`) are **near-orthogonal — they answer different questions**:

- `normalised` chooses the **medium**: relational tables vs one JSON document.
- `inheritanceUsing` chooses the **partitioning** across a hierarchy: shared vs per-concrete.

Both questions are meaningful in both media, so they compose as a 2×2:

| | `normalised(true)` | `normalised(false)` |
|---|---|---|
| `sharedTable` | **TPH** — one table + discriminator | one document collection + `_type` discriminator (Mongo single-collection / Marten hierarchy) |
| `ownTable` | **TPC** — table per concrete | document collection per concrete |

Two consequences:

1. **The value names keep "table" by decision.** `normalised(false)` is evidence the layout axis is not strictly table-specific (in the document column `sharedTable` means "one document collection + discriminator"), and medium-neutral `shared`/`own` was considered. It was **rejected** (D-DOCUMENT-AXIS / §8 Q6): the values stay `sharedTable`/`ownTable`, with "table" read as vestigial under `normalised(false)`.
2. **D-ES-TPH generalises across the medium.** Its rule — *an `eventSourced` concrete subtype of a shared base is forced to `ownTable`* — is about **partitioning, not tables**: an event-sourced concrete needs its own stream, so it cannot live in a shared partition whether that partition is a discriminated table or a discriminated document collection. The constraint holds unchanged in the `document` column (forced own collection/stream).

### Option 5 — Storage-layer wiring for the `normalised` axis *(infra half of Option 4)*

Because the `normalised` axis (§2.3) governs *layout* and the existing `kind` set already has `eventLog` and `snapshot`, the ES + document case needs **no new `kind`** — it binds the stream and a document-shaped snapshot. The binding reuses the same `normalised` keyword as the aggregate (paren modifier on the header; colon entry inside the binding block — see §4), so the concept reads the same at both layers:

```ddd
storage pg { type: postgres }                                   // Marten on Postgres

dataSource cartEvents   { for: Shopping, kind: eventLog, use: pg }                   // append-only stream
dataSource cartSnapshot { for: Shopping, kind: snapshot, use: pg, normalised: false } // inline projection as one JSON doc
```

For a `persistedAs(state)` + `normalised(false)` aggregate the document shape rides the `state` binding instead (`kind: state, normalised: false`).

- **Grammar:** add an optional `('normalised' ':' normalised=Bool)?` to the `dataSource` rule's per-`kind` config (the `state`/`snapshot` kinds). Defaults to `true`.
- **Open alternative:** a real document DB target (`StorageType += mongo`) would let `normalised(false)` resolve to a true document store rather than Postgres-JSONB. Deferred — Marten's own bet is JSONB-on-Postgres (see §8 Q4).
- **Trade-offs:** Pure infrastructure, no new domain surface beyond Option 4's `normalised(…)`. Per-context granularity per D-GRANULARITY (the aggregate-level `normalised(…)` from Option 4 is what supplies per-aggregate intent; the validator pairs the two). On its own it is just plumbing — it realises what Option 4 declares.

### Option 6 (rejected) — `document` as a top-level aggregate peer

A first-class `document Order { … }` declaration *alongside* `aggregate`, with its own repository and lifecycle but no normalised storage.

- **Why rejected:** It duplicates `aggregate` almost entirely (identity, repository, events, find specs, traceability) purely to change physical storage — violating invariant §2.2#4 ("document mapping does not change the domain API"). Marten/EF/Mongo all model this as *the same aggregate, stored differently*, not a separate object kind. Two near-identical declaration kinds would fork every downstream phase (scope, validate, lower, enrich, all four generators). The thing people actually want — "this aggregate is a document" — is Option 4 + 5, at a fraction of the surface. Recorded here to close the question explicitly.

---

## 4. Cross-Framework Mapping (what each option emits)

| Option | Marten | EF Core | Mongo-shaped | Postgres DDL |
|---|---|---|---|---|
| 1 `json` field | doc property | `[Column(TypeName="jsonb")]` `JsonDocument` | embedded sub-field | `JSONB` |
| 2 `document` type | embedded sub-doc | `.OwnsOne/.OwnsMany(...).ToJson()` | embedded array/object | `JSONB` |
| 3 `as document/table` *(dropped)* | per-edge embed/ref | `.ToJson()` vs child-table owned | embed vs `$ref` | `JSONB` col vs child table |
| 4 `normalised(false)` | **native doc/event store** | root `.ToJson()` | one document per aggregate | doc table `(id, data jsonb, version)` |
| 4 + ES (`eventSourced`+`document`) | **stream + inline projection doc** | events table + `.ToJson()` projection | event coll. + snapshot doc | `mt_events`-style log + snapshot `jsonb` |
| 5 `normalised: false` binding | `IDocumentStore` session | `DbContext` w/ JSON config | collection | schema/table placement |

### 4b. Worked example — an aggregate exercising every config

Two aggregates that, between them, exercise every config discussed in this proposal and its neighbours. Inline comments tag each config with its concern and status (existing / this proposal / pinned decision / neighbouring proposal).

```ddd
// ── infrastructure (D-STORAGE-SPLIT) ──────────────────────────────────
storage pg { type: postgres }                        // physical instance — Marten on Postgres

dataSource cartEvents   { for: Shopping, kind: eventLog, use: pg }                    // append-only stream
dataSource cartSnapshot { for: Shopping, kind: snapshot, use: pg, normalised: false } // projection → one JSON doc
dataSource crmState     { for: Crm,      kind: state,    use: pg }                    // normalised (default)

// ── nested structures (existing) ──────────────────────────────────────
valueobject Money { amount decimal, currency string }   // → inline JSONB column (today)
entity CartLine   { sku string, qty int, price Money }  // entity part (containment edge below)

// ── an event-sourced, document-stored aggregate ───────────────────────
// All aggregate-level config is on the HEADER line: bare markers for
// argument-less ones (abstract/audited), name(value) for the rest.
aggregate ShoppingCart
  ids guid                       // idKind                                   (existing, header)
  persistedAs(eventLog)          // axis 1: truth kind = event log           (today: body persistenceStrategy: eventSourced)
  normalised(false)              // axis 2: snapshot/projection = one JSON doc  (this proposal; default normalised(true))
  with audit, softDelete         // stdlib macros                            (existing WithClause, header)
{
  total     Money                // value object → embedded in the snapshot doc
  metadata  json                 // open-shape blob                          (Option 1, this proposal)
  contains  lines: CartLine[]    // containment → embedded in the doc (whole tree, not a child table)

  operation addItem(sku string, qty int)   // emits event; rebuilt via `apply` (the eventSourced discipline)
}

// ── an inheritance hierarchy showing the layout axes ──────────────────
abstract aggregate Party              // abstract base                       (aggregate-inheritance, proposed)
  inheritanceUsing(sharedTable)     // TPH: one `parties` table + discriminator   (D-RENAME: renamed from inheritanceStrategy, colon→paren)
  audited                             // boolean capability                  (shipped, header)
{
  name  string
  email string
}

aggregate Customer extends Party persistedAs(state) {   // shares the `parties` table (sharedTable + normalised = TPH)
  creditLimit Money
}

aggregate Auditor extends Party
  persistedAs(eventLog)               // D-ES-TPH: an ES concrete of a sharedTable base …
  inheritanceUsing(ownTable)       // … is FORCED to ownTable — own stream/table, not the shared one
{
  clearanceLevel int
}
// NB: because `Auditor` is `ownTable`, polymorphic `Party id` refs become invalid
//     (FK target ambiguous) — the inheritance proposal's validator rule.
```

| Config | Axis / concern | Status |
|---|---|---|
| `ids guid` | id kind | existing grammar |
| `persistedAs(eventLog\|state)` | **truth kind** — event log vs current state (+ the validated apply-always/no-direct-mutation body contract) | renamed from shipped body `persistenceStrategy:` *(§2.3/§4 reconcile)* |
| `normalised(true\|false)` | **saving** — read-model/snapshot shape (`false` = document) | this proposal *(paren header modifier, §4 syntax note)* |
| `inheritanceUsing(sharedTable\|ownTable)` | inheritance **partitioning** | D-RENAME (pinned; renamed from `inheritanceStrategy`, colon→paren, §4) |
| `extends` / `abstract` | inheritance | aggregate-inheritance (proposed) |
| `with audit, softDelete` | macros | existing |
| `audited` | capability | shipped |
| `json` field | open-shape data | Option 1 (this proposal) |
| `valueobject` / `entity` + `contains` | internal hierarchy | existing |
| `dataSource … normalised: false` | infra wiring of the snapshot | Option 5 (this proposal) |

The two orthogonal axes — `persistedAs(eventLog)` (truth kind) and `normalised(false)` (snapshot shape) — sit on `ShoppingCart`; the inheritance layout axis and the `eventSourced`-forces-`ownTable` constraint (D-ES-TPH) show on the `Party` hierarchy.

---

## 5. Disambiguation: when modellers pick which nested kind

If Options 2 + 3 both land, three nested-structure kinds coexist. The teaching rule:

| Need | Reach for | Stored as |
|---|---|---|
| Immutable, no identity, scalar-only (Money, DateRange) | `valueobject` | inline JSONB (unchanged) |
| Typed, may hold collections, always embedded as one tree | `document` (Opt 2) | one JSONB column |
| Has identity / is queried independently / referenced | `entity` + `contains` | child table (or `as document`, Opt 3) |
| Shape unknown / externally defined | `json` field (Opt 1) | opaque JSONB |
| Whole aggregate stored as a document | `normalised(false)` (Opt 4) | doc table (snapshot for ES) |

A validator nudge (`loom.json-field-known-shape`) can suggest promoting a `json` field to a `document`/`valueobject` once its shape is known, keeping Option 1 from becoming an escape hatch.

---

## 6. Implementation touch-points (per option, by pipeline phase)

| Phase / file | Opt 1 | Opt 2 | Opt 3 | Opt 4 | Opt 5 |
|---|---|---|---|---|---|
| Grammar `ddd.langium` | +`json` primitive | +`Document` decl, +`NamedDecl` | ~~+`as`~~ dropped | +`normalised(…)` header modifier | +`normalised:` on binding |
| `type-system.ts` | resolve `json` | resolve `Document` | — | — | — |
| `loom-ir.ts` `TypeIR`/`AggregateIR`/`DataSourceIR` | +`json` | +`document` | — | +`normalised?` | +`normalised?` |
| `lower/` | leaf | wireShape like VO | — | thread axis | — |
| `enrich/enrichments.ts` | leaf in wireShape | wireShape, no assoc | — | migrationsOwner / snapshot owner | — |
| `migrations-builder.ts` / `sql-pg.ts` | already `json`→JSONB | keep arrays JSON | — | doc/snapshot table shape | placement |
| backends (TS/.NET/Phoenix/React) | unknown/JsonElement/:map | DTO from wireShape | — | **document mode in existing adapters** (EF `.ToJson()` / Drizzle `jsonb` / Ash embedded) + `supportedShapes` | session wiring |
| validators | known-shape nudge | embed-acyclic (§2.2#2) | — | strategy×normalised×storage compat | normalised×kind compat |
| docs | `language.md` | `language.md` | — | `migrations-design.md` | `architecture.md` |

Phases follow the one-directional pipeline in `CLAUDE.md`; nothing here crosses a layer boundary.

---

## 7. Recommendation (D-DOCUMENT-AXIS — OPEN)

**Document is *both* a small field type and a per-aggregate `normalised(false)` choice — and is *not* an aggregate peer.** The driving requirement is **`persistedAs(eventLog)` + `normalised(false)`**, only expressible once the saving shape is its own axis (§2.3). Concretely, adopt:

1. **Options 4 + 5 — the core, as the `normalised` axis.** Add per-aggregate `normalised(true | false)` (Option 4) orthogonal to the truth-kind axis `persistedAs(eventLog | state)`, wired through `normalised: false` on the `snapshot` (ES) or `state` (state-based) `dataSource` binding (Option 5). Served by a **document mode added to the existing per-backend adapters** (EF `.ToJson()` / Drizzle `jsonb` / Ash embedded), advertising a `document` shape via a new `supportedShapes` companion to `supportedStrategies` on the existing `PersistenceAdapter` seam (`efcore-persistence.ts:41`) — **no new backend**. The immediate deliverable is **`persistedAs(state)` + `normalised(false)`** (whole current state as one document), which each ORM's JSON-column feature delivers directly. The headline ES combination — append-only event stream + document snapshot/projection — stays deferred behind appliers (`workflow-and-applier.md`), which it needs whether or not a Marten adapter exists.
2. **Option 1 (`json` primitive) — ship alongside or first.** Smallest, fully orthogonal (covers need A, which Option 4 does *not* touch), and mostly already plumbed (`json` column kind + `JSONB` renderer exist). A prerequisite-free win that is independent of the document-store work.
3. **Drop Option 3.** Decided: once whole-aggregate `normalised(false)` is the model, the per-edge embedding knob refines a relational layout we've opted out of; its residual case is already served by value objects.
4. **Defer Option 2.** Revisit a dedicated `document` *type* only if a "typed-collection-that-is-never-a-table" sub-structure proves to need its own name independent of the aggregate-level axis.
5. **Reject Option 6.** "This aggregate is a document" is expressed by `normalised(false)`, not by a parallel declaration kind.

This keeps the domain model honest (the aggregate API is unchanged regardless of storage shape — invariant §2.2#4), makes the required ES + document combination first-class, and still gives an immediate escape hatch for genuinely open data via `json`.

> **Naming note.** The two axes were named through several iterations:
> - **Saving axis:** `representation:` → `storeAs(document)` → **`normalised(true | false)`** (a boolean; `false` = document, default `true`). Rejected along the way: `layout`/`style` (collide with the deployable platform-config knobs), `shape` (collides with the internal `wireShape`/loadedness vocabulary), and `storeAs`/`persistAs` (read as a *second* storage keyword sitting next to the truth axis).
> - **Truth axis:** `persistenceStrategy: eventSourced|stateBased` (shipped) → **`persistedAs(eventLog | state)`**, with values aligned to the `dataSource` `kind` set.
>
> Both surface as paren header modifiers; inside a `dataSource { … }` block `normalised:` is a colon entry (context-appropriate). One caveat for the maintainer: `normalised(false)` is a mild double-negative for "document" — it trades the positive word `document` for keeping the default (`normalised`) explicit, and being boolean it cannot grow a third saving shape without reverting to an enum.

---

## 8. Open questions

1. **(Resolved.)** Does `json` need a shape hint (`json<SomeType>`)? **No** — plain `json` only for v1; if the shape is known, use a `valueobject`. `json<T>` is out of scope.
2. **(Resolved — see §2.3.)** Is the saving shape orthogonal to the truth kind? **Yes.** `persistedAs(eventLog)` bundles a *body-discipline* contract (apply-always, no direct mutation — validated) and a *storing-as-a-log* facet; `normalised(true | false)` governs only the **derived read model / snapshot**. The log facet and the `normalised` facet are different storing concerns, so the required combination `persistedAs(eventLog)` + `normalised(false)` is well-formed. *Follow-on:* the shipped `persistenceStrategy:` keyword names only the storing half and hides the body-discipline half; renamed to header `persistedAs(…)` (§2.3).
3. **(Resolved.)** Snapshot/projection cadence for event-log + document: **reuse the `snapshot` `dataSource`'s `every:` knob** (already in D-STORAGE-SPLIT) — cadence is binding/infra config, not an aggregate-header arg.
4. **(Resolved.)** Can the shape vary per projection? **Yes — per-projection.** The per-binding `dataSource normalised:` knob (on the `state`/`snapshot`/`replica` binding) sets that projection's shape; the aggregate-header `normalised(…)` is the default. Stays within D-GRANULARITY (per `(context, kind)`); richer *named* read models are future scope.
5. **(Resolved.)** Real document DB? **Postgres-JSONB only in v1** (Marten's bet); `normalised(false)` resolves to JSONB / Marten docs on Postgres. `StorageType += mongo` deferred.
6. **(Resolved — D-RENAME amended.)** D-RENAME becomes `inheritanceUsing(sharedTable | ownTable)`: **key** `inheritanceStrategy` → `inheritanceUsing`; **syntax** colon → paren header modifier; **values** kept table-baked, respelled `shareTable` → `sharedTable`. Medium-neutral `shared`/`own` rejected.

---

## 9. Implementation status

Delivered in slices off `main` (each its own squash-merged PR). The
**surface and IR are complete**; the document-persistence **emission**
(Slice D) is **in progress** — a document *mode* in the existing
adapters, **no new Marten backend** (see below).

### Done

| Slice | Scope | Where | PR |
|---|---|---|---|
| **A — `json` primitive** | Opaque JSON field type. Per-backend leaf mapping: TS `unknown` / Zod `z.unknown()`, .NET `System.Text.Json.JsonElement`, Phoenix Ash `:map`, Postgres `JSONB` (Drizzle `jsonb`), OpenAPI freeform `object` (wire-spec leaf). Grammar + `PrimitiveName`/`WirePrimitive` + migrations. | `ddd.langium`, `loom-ir.ts`, all 4 generators, `migrations-builder.ts`, `wire-spec.ts`; `test/generator/json-primitive-emission.test.ts` | #703 |
| **B — `persistedAs(eventLog\|state)`** | Hard-cutover rename of the shipped body `persistenceStrategy: stateBased\|eventSourced` → header paren modifier. Values aligned to the `dataSource` `kind` set, so `resolve-datasource` is now an identity. Adapters / default-menus / `resolve-adapters` updated. **No body-discipline validator** (deferred — owned by the applier feature). | `ddd.langium`, `loom-ir.ts`, `lower.ts`, `resolve-datasource.ts`, `validate.ts`, `print-structural.ts`, all persistence/style adapters; parsing/IR/validation/adapter tests | #711 |
| **C — saving-shape surface** | Aggregate header modifier + `dataSource` knob, threaded through IR + printer, parsed/validated. **Originally shipped as the boolean `normalised(true\|false)` (#713); reworked to the 3-valued `shape(relational\|embedded\|document)` (#724)** once it was clear the axis is a spectrum, not a boolean. | `ddd.langium`, `loom-ir.ts`, `lower.ts`, `print-structural.ts`, `validate.ts`; `test/language/parsing/aggregate-shape.test.ts` | #713, #724 |
| **C′ — `shape` 3-value rework** | `normalised(bool)` → `shape(relational\|embedded\|document)`; `SavingShape` defined in the IR, `effectiveSavingShape(agg, resolved)` (binding wins → header → `relational`), `isDocumentShaped` kept as a thin derivation. Behaviour-preserving: `shape(document)` == the prior `normalised(false)` opaque blob. The inert-knob warning dropped (the knob is consumed; unsupported shape is a per-backend `supportedShapes` check). | `ddd.langium`, `loom-ir.ts`, `resolve-datasource.ts`, `print-structural.ts`, `validate.ts`, all 4 generators + adapters | #724 |
| **D.1 — backend-neutral document foundation** | `PersistenceAdapter.supportedShapes: SavingShape[]` (efcore advertises `["normalised","document"]`); `ResolvedDataSource.normalised` + `isDocumentShaped(agg, resolved)` per-projection resolver (binding wins, header is default); migrations `(id, data jsonb, version)` document table shape (parts fold into `data`, references ride as id arrays — no part/join tables), binding-aware in `buildMigrations`. Byte-identical for all non-document aggregates. | `_adapters/persistence-surface.ts`, `efcore-persistence.ts`, `ir/util/resolve-datasource.ts`, `system/migrations-builder.ts`; `resolve-datasource.test.ts` (+5), `migrations-builder.test.ts` (+3) | #724 |
| **D.2 — EF (.NET) document emission** | STJ + persistence-record, domain class untouched (incl. parts). `<Agg>Document` POCO `(Id, Data jsonb, Version)` + EF config; `<Agg>Snapshot`/`<Part>Snapshot` records mirror the entity's C# types (ID record-structs + VO records round-trip natively); `ToSnapshot()`/`FromSnapshot(...)` on the entity (reach private setters + `_<containment>` lists, `AssertInvariants` once over the full tree); document repository (de)serialises `Data`, bumps `Version`, finds eval client-side; DbContext routes to `DbSet<<Agg>Document>`, join tables skipped. **`dotnet-build /warnaserror` green.** | `dotnet/emit/document.ts`, `entity.ts`, `efcore.ts`, `repository.ts`, `dotnet/index.ts`; `examples/document.ddd`; `dotnet-document-emission.test.ts` (+7) | #724 |
| **D.3-TS — Drizzle (Hono) document emission** | Schema emits `(id, data jsonb, version)` (part/join tables skipped); structural repository (`repository-document-builder.ts`) serialises getters → plain object (`<entity>ToDoc`) and rebuilds via the same `_create({...})` factory (`<entity>FromDoc`); finds eval in-memory (`renderTsExpr` with `this`→`x`); `toWire` reused unchanged. Routed on `shape(document)`. **`tsc + tsup` gate green** (`examples/document.ddd` added). | `typescript/repository-document-builder.ts`, `typescript/emit/schema.ts`, `hono/v4/emit.ts`; `typescript-document-emission.test.ts` (+5) | #724 |
| **D.4-mig — embedded migration shape** | 3-way `schemaFromModule` (relational \| embedded \| document); `embeddedTableForAggregate` = queryable root columns + one JSONB column per containment + ref-collections as JSONB id-arrays, no part/join tables. `buildMigrations` binding-aware via `effectiveSavingShape`. One physical shape every backend maps to → no per-backend migration fork. | `system/migrations-builder.ts`; `migrations-builder.test.ts` (+1) | #724 |
| **D.5-net — EF (.NET) embedded emission** | `shape(embedded)` folds each containment into a JSONB column via owned-types `OwnsOne/OwnsMany(...).ToJson("<col>")` — no child table — while the **entity, repository and `DbSet<Agg>` stay the normal relational ones** (EF owned-JSON is transparent), so finds remain real indexed SQL on the root. 3-way orchestrator routing; join entities skipped for embedded. | `dotnet/emit/efcore.ts`, `dotnet/index.ts`; `examples/document.ddd` (Wishlist), `dotnet-document-emission.test.ts` (+2) | #724 |

Net: an aggregate header like
`aggregate ShoppingCart persistedAs(eventLog) shape(document) { … }`
parses, validates, prints, and threads end-to-end; a `json` field works
across every backend; the migrations layer emits the right table per
saving shape (relational / embedded / document); **.NET emits all three
shapes**, and TS/.NET emit `document`.

### Missing (not yet built)

- **`embedded` on Drizzle (TS) + Phoenix (Ash) — the remaining emitters.**
  The shape surface, IR, migration shape, and the .NET emitter all do
  `embedded`; the two other backends don't yet (they emit a
  `shape(embedded)` aggregate *relationally* for now — compiles, just not
  folded).
  - **Drizzle (TS):** a third repository builder — root hydrated/saved
    from columns (the relational path) + each containment (de)serialised
    from its jsonb column (the document-part path); finds stay real SQL on
    the root. Schema emits root columns + jsonb-per-containment (the
    `emitEmbeddedTable` shape, drafted then reverted pending the repo).
  - **Phoenix (Ash):** contained parts become `data_layer: :embedded`
    resources (`attribute :items, {:array, WishItem}`); root attributes
    stay columns. This now maps cleanly onto the **shared** embedded
    migration table (no fork — the migration shape is per-strategy, and
    `embeddedTableForAggregate` already emits root columns + jsonb-per-
    containment for every backend). Add a `phoenix-build` fixture.
- **`supportedShapes` — two-tier validator.** Capability (error: the
  backend has no emitter for that shape yet) vs idiomaticity (warning: it
  *can* emit it but it's a poor fit). Lets Ash eventually offer
  `document` as a single `:map` resource — **allowed but warned
  non-idiomatic** — rather than being permanently "unsupported". The
  validator is *not* what avoids the migration fork (the per-strategy
  shape is); it's purely UX.
- **`document` on Phoenix (Ash)** — a single `:map` attribute resource
  (the opaque blob). Implementable, **non-idiomatic** (loses Ash's
  attribute/calculation/relationship value); a later allowed-but-warned
  addition. Not scheduled.
- **`eventLog` + document/embedded** (event stream + snapshot
  rehydration, Marten's other half) needs the fold/apply logic from
  **appliers** (`workflow-and-applier.md`); deferred behind that feature.
- **Event-sourcing body-discipline validator** (emit/apply, no direct
  `:=` mutation). Owned by `workflow-and-applier.md`; gated on
  `persistedAs(eventLog)`.
- **Option 2 — dedicated `document` value-type** (deferred), and
  **Option 3 — per-containment `as document/table`** (dropped).
- **Open sub-questions** — all resolved (§8): cadence reuses the
  `snapshot` binding's `every:`; the shape is **per-projection** (per-
  binding `dataSource shape:`, aggregate header is the default);
  **Postgres-JSONB only** (no `mongo`); no `json<T>`.

---

## 10. Sources

- Marten — [Introduction](https://martendb.io/introduction), [as Event Store](https://martendb.io/events/), [JasperFx/marten](https://github.com/JasperFx/marten)
- EF Core — [Owned Entity Types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities), [EF7 JSON Columns](https://devblogs.microsoft.com/dotnet/announcing-ef7-release-candidate-2/), [EF Core 8 what's new](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew)
- MongoDB / DDD — [Embedded vs Referenced (GeeksforGeeks)](https://www.geeksforgeeks.org/mongodb/embedded-vs-referenced-documents-in-mongodb/), [Embedding vs Referencing (OneUptime)](https://oneuptime.com/blog/post/2025-12-15-how-to-choose-between-embedding-and-referencing-in-mongodb/view), [Fowler — DDD_Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html), [InfoQ — Storing Aggregates](https://www.infoq.com/news/2014/12/aggregates-ddd/)
