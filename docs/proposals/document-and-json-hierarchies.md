# Proposal: Documents and JSON-Based Hierarchies

**Status:** Draft. Output of a design conversation. Options-gathering — no decision pinned yet.
**Scope:** Survey how Loom should let a modeller persist a hierarchy as a *document* (a single JSON tree) instead of a normalised set of tables, and whether "document" deserves to be a declaration kind next to `aggregate`/`entity`, a field type, a persistence strategy, or some combination. Compares against Marten, EF Core, and MongoDB-style modelling. Ends with a recommendation.

> **Pinned decisions affecting this proposal** (see [`docs/decisions.md`](../decisions.md)):
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
> A new decision tag **D-DOCUMENT-AXIS** is *requested* by this
> proposal: settle whether "document" is a domain-modelling axis, a
> storage axis, or both. §7 records the recommended answer; it is
> **OPEN** until ratified.
>
> **Direction taken in this revision** (from the design conversation,
> not yet a pinned D-tag): two **orthogonal and different-in-kind**
> per-aggregate axes — they are not both "persistence":
>
> 1. **Body structure** (domain, *behavioral*): `eventSourced` vs
>    `stateBased` describes **how the aggregate body is written and
>    mutates** (emits events, rebuilt via appliers) and is **what the
>    validator checks against the body** — *not* how it is saved. It is
>    a bare marker (`eventSourced`), not a `persistenceStrategy:` value.
>    *(The current grammar spells it `persistenceStrategy: eventSourced`
>    at `ddd.langium:612/619`; this proposal treats that keyword as a
>    misnomer to reconcile — see §2.3.)*
> 2. **Saving** (infra): `storeAs: normalised | document` — **how the
>    materialised state/snapshot is laid out**. The only genuine
>    storage axis.
>
> The combination explicitly required is **`eventSourced` + `storeAs:
> document`** (Marten's sweet spot: an append-only event stream with
> the aggregate snapshot/projection persisted as a single JSON
> document). Consequently **Option 3 is dropped** and **Option 4 is
> reframed** as the `storeAs:` axis (not a third body-structure value).
> See §2.3 and §7.

---

## 1. Background and Motivation

Loom already models internal hierarchies inside an aggregate, but it splits them across **two storage shapes today, and the split is implicit**:

| Source construct | Grammar | Where it lands physically |
|---|---|---|
| Value object | `valueobject Money { … }` (`ddd.langium:602`) | **Inline JSONB column** — `mapTypeToColumn` returns `{ kind: "json" }` for `valueobject`/`entity` types (`src/system/migrations-builder.ts:370`), rendered `JSONB` by `renderPgType` (`src/system/sql-pg.ts`). |
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

- **Axis 1 — body structure** (`eventSourced` | `stateBased`): a **behavioral/structural** trait of the aggregate. It governs *how the body is written and how the aggregate mutates* — `eventSourced` bodies emit events and are rebuilt by appliers; `stateBased` bodies mutate state directly. This is **checked by validating the body** (do the appliers cover the events? does mutation go through the right surface?). It is **domain modelling, not saving.** It surfaces as a **bare marker** on the aggregate.
  > **Naming reconciliation.** Today this is spelled `persistenceStrategy: eventSourced` (`ddd.langium:612`, `:619`, threaded to `loom-ir.ts:327`). That keyword frames a *body-structure* decision as a *persistence* one — a misnomer. This proposal uses the bare `eventSourced` / `stateBased` form and recommends renaming the grammar clause accordingly (or dropping the `persistenceStrategy:` prefix), tracked under D-DOCUMENT-AXIS.

- **Axis 2 — saving** (`storeAs: normalised | document`): *how the materialised state/snapshot is physically laid out.* New, per-aggregate, default `normalised` (full backward compatibility). The **only** genuine storage axis.

Because they are different in kind, every combination is meaningful:

| | **`storeAs: normalised`** (default) | **`storeAs: document`** (new) |
|---|---|---|
| **`stateBased`** | EF Core normalised tables; VOs inline JSONB (today). | Whole current-state tree → one JSON document (Marten doc store / EF root `.ToJson()`). |
| **`eventSourced`** | Event log + projections to tables. | **The required combination.** Append-only event stream (JSON-event rows) + aggregate snapshot/projection persisted as **one JSON document**; rehydrate from snapshot, replay the tail. |

Note what `eventSourced` *does* and *does not* imply for saving: being event-sourced means there **is** an event log (events are the record of what happened — intrinsic to the body being event-emitting), but it says nothing about the *shape* of the read model. The event log is always serialised JSON-event rows; **`storeAs:` governs only the snapshot/projection.** D-STORAGE-SPLIT's `kind` set already carries both `eventLog` and `snapshot`, so the ES + document case wires as an `eventLog` binding plus a document-shaped `snapshot` binding; no new `kind` is required.

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

> **Decision (this revision): dropped.** Option 3 tunes the embedding of a *normalised* aggregate per containment edge — a relational-world refinement. Once the chosen direction is whole-aggregate `storeAs: document` (Option 4, §2.3), the per-edge knob answers a question we've opted out of. Its only residual value (embedding one sub-tree in an otherwise-relational row) is already largely served by value objects, which embed as JSONB today. Recorded for completeness; not pursued.

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

### Option 4 — Aggregate-level `storeAs: document` axis *(chosen — addresses need B, Marten-style, whole-aggregate)*

Treat the entire aggregate tree as one document, selected by a **new `storeAs` axis** that is orthogonal to — and a different *kind* of concern from — the body-structure marker (see §2.3). This is what makes `eventSourced` + `storeAs: document` expressible.

```ddd
aggregate ShoppingCart
  eventSourced                          // axis 1 (body structure): emits events, rebuilt via appliers
  storeAs: document                     // axis 2 (saving): snapshot/projection = one JSON doc
{
  id     guid
  items  CartItem[]                     // whole tree → one JSONB snapshot, Marten-style
}
```

A `stateBased` aggregate with `storeAs: document` is equally valid (whole current state as one document, no event log).

- **Grammar:** add the `storeAs` clause on `Aggregate` (`ddd.langium:610–614`), e.g. `('storeAs' ':' storeAs=StoreShape ','?)?` with `StoreShape returns string: 'normalised' | 'document'`. Separately, reconcile the body-structure marker per §2.3 (bare `eventSourced` / `stateBased` rather than `persistenceStrategy: …`).
- **IR:** `AggregateIR` (`loom-ir.ts:327`) gains `storeAs?: "normalised" | "document"` alongside the existing body-structure field; `resolve-datasource.ts` already maps `eventSourced → eventLog` and would additionally request a document-shaped `snapshot` binding when `storeAs === "document"`.
- **Per-backend:** the natural **Marten** target. The `PersistenceAdapter` contract gates on strategy today (`efcore-persistence.ts:43` declares `supportedStrategies: ["stateBased"]`); a `martenPersistenceAdapter` would declare `supportedStrategies: ["stateBased", "eventSourced"]` **and** advertise the `document` shape, while the EF adapter advertises `normalised` (plus root `.ToJson()` for `stateBased` + `document`). The adapter contract may need a `supportedShapes` companion to `supportedStrategies` so the orchestrator can pick the right adapter from the (strategy × storeAs) pair.
- **Trade-offs:** Whole-aggregate granularity (no per-field control) — matches how Marten/Mongo actually work, and is exactly what dropping Option 3 commits to. Keeps the aggregate API unchanged (invariant §2.2#4). Pairs with Option 5 for the storage binding.

### Option 5 — Storage-layer wiring for the `storeAs` axis *(infra half of Option 4)*

Because the `storeAs` axis (§2.3) governs *layout* and the existing `kind` set already has `eventLog` and `snapshot`, the ES + document case needs **no new `kind`** — it binds the stream and a document-shaped snapshot. The binding echoes the same `storeAs:` vocabulary as the aggregate, so there is one word for the concept at both layers:

```ddd
storage pg { type: postgres }                                   // Marten on Postgres

dataSource cartEvents   { for: Shopping, kind: eventLog, use: pg }                   // append-only stream
dataSource cartSnapshot { for: Shopping, kind: snapshot, use: pg, storeAs: document } // inline projection as one JSON doc
```

For a `stateBased` + `document` aggregate the document shape rides the `state` binding instead (`kind: state, storeAs: document`).

- **Grammar:** add an optional `('storeAs' ':' storeAs=('normalised'|'document'))?` to the `dataSource` rule's per-`kind` config (the `state`/`snapshot` kinds). Defaults to `normalised`.
- **Open alternative:** a real document DB target (`StorageType += mongo`) would let `storeAs: document` resolve to a true document store rather than Postgres-JSONB. Deferred — Marten's own bet is JSONB-on-Postgres (see §8 Q4).
- **Trade-offs:** Pure infrastructure, no new domain surface beyond Option 4's `storeAs:`. Per-context granularity per D-GRANULARITY (the aggregate-level `storeAs:` from Option 4 is what supplies per-aggregate intent; the validator pairs the two). On its own it is just plumbing — it realises what Option 4 declares.

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
| 4 `storeAs: document` | **native doc/event store** | root `.ToJson()` | one document per aggregate | doc table `(id, data jsonb, version)` |
| 4 + ES (`eventSourced`+`document`) | **stream + inline projection doc** | events table + `.ToJson()` projection | event coll. + snapshot doc | `mt_events`-style log + snapshot `jsonb` |
| 5 `storeAs: document` binding | `IDocumentStore` session | `DbContext` w/ JSON config | collection | schema/table placement |

---

## 5. Disambiguation: when modellers pick which nested kind

If Options 2 + 3 both land, three nested-structure kinds coexist. The teaching rule:

| Need | Reach for | Stored as |
|---|---|---|
| Immutable, no identity, scalar-only (Money, DateRange) | `valueobject` | inline JSONB (unchanged) |
| Typed, may hold collections, always embedded as one tree | `document` (Opt 2) | one JSONB column |
| Has identity / is queried independently / referenced | `entity` + `contains` | child table (or `as document`, Opt 3) |
| Shape unknown / externally defined | `json` field (Opt 1) | opaque JSONB |
| Whole aggregate stored as a document | `storeAs: document` (Opt 4) | doc table (snapshot for ES) |

A validator nudge (`loom.json-field-known-shape`) can suggest promoting a `json` field to a `document`/`valueobject` once its shape is known, keeping Option 1 from becoming an escape hatch.

---

## 6. Implementation touch-points (per option, by pipeline phase)

| Phase / file | Opt 1 | Opt 2 | Opt 3 | Opt 4 | Opt 5 |
|---|---|---|---|---|---|
| Grammar `ddd.langium` | +`json` primitive | +`Document` decl, +`NamedDecl` | ~~+`as`~~ dropped | +`storeAs:` axis | +`storeAs:` on binding |
| `type-system.ts` | resolve `json` | resolve `Document` | — | — | — |
| `loom-ir.ts` `TypeIR`/`AggregateIR`/`DataSourceIR` | +`json` | +`document` | — | +`storeAs?` | +`storeAs?` |
| `lower/` | leaf | wireShape like VO | — | thread axis | — |
| `enrich/enrichments.ts` | leaf in wireShape | wireShape, no assoc | — | migrationsOwner / snapshot owner | — |
| `migrations-builder.ts` / `sql-pg.ts` | already `json`→JSONB | keep arrays JSON | — | doc/snapshot table shape | placement |
| backends (TS/.NET/Phoenix/React) | unknown/JsonElement/:map | DTO from wireShape | — | **new Marten adapter** + `supportedShapes` | session wiring |
| validators | known-shape nudge | embed-acyclic (§2.2#2) | — | strategy×storeAs×storage compat | storeAs×kind compat |
| docs | `language.md` | `language.md` | — | `migrations-design.md` | `architecture.md` |

Phases follow the one-directional pipeline in `CLAUDE.md`; nothing here crosses a layer boundary.

---

## 7. Recommendation (D-DOCUMENT-AXIS — OPEN)

**Document is *both* a small field type and a per-aggregate `storeAs` axis — and is *not* an aggregate peer.** The driving requirement is **`eventSourced` + `document`**, which is only expressible once storage shape is its own axis (§2.3). Concretely, adopt:

1. **Options 4 + 5 — the core, as a `storeAs` axis.** Add per-aggregate `storeAs: normalised | document` (Option 4) orthogonal to the existing `persistenceStrategy`, wired through `storeAs: document` on the `snapshot` (ES) or `state` (state-based) `dataSource` binding (Option 5). Served by a new `martenPersistenceAdapter` advertising `supportedStrategies: ["stateBased","eventSourced"]` + the `document` shape, plugged into the existing `PersistenceAdapter` seam (`efcore-persistence.ts:41`). The headline combination — append-only event stream + document snapshot/projection — is the deliverable.
2. **Option 1 (`json` primitive) — ship alongside or first.** Smallest, fully orthogonal (covers need A, which Option 4 does *not* touch), and mostly already plumbed (`json` column kind + `JSONB` renderer exist). A prerequisite-free win that is independent of the document-store work.
3. **Drop Option 3.** Decided: once whole-aggregate `storeAs: document` is the model, the per-edge embedding knob refines a relational layout we've opted out of; its residual case is already served by value objects.
4. **Defer Option 2.** Revisit a dedicated `document` *type* only if a "typed-collection-that-is-never-a-table" sub-structure proves to need its own name independent of the aggregate-level axis.
5. **Reject Option 6.** "This aggregate is a document" is expressed by `storeAs: document`, not by a parallel declaration kind.

This keeps the domain model honest (the aggregate API is unchanged regardless of storage shape — invariant §2.2#4), makes the required ES + document combination first-class, and still gives an immediate escape hatch for genuinely open data via `json`.

> **Naming note.** This axis was provisionally called `representation:`; it is renamed **`storeAs:`** here — `layout:`/`style:` collide with the deployable platform-config knobs, `shape:` collides with the internal `wireShape`/loadedness vocabulary, and `persistAs:` crowds the `persistence*` family. `storeAs:` reads as intent, echoes EF Core's "store as JSON" (`.ToJson()`), and is reused unchanged at the `dataSource` binding so there is one word at both layers.

---

## 8. Open questions

1. Does `json` need an optional *shape hint* (`json<SomeType>`) for the common case where the blob *is* a known DTO from an `extern` boundary, without full structural validation?
2. **(Resolved — see §2.3.)** Is storage shape orthogonal to `eventSourced`? **Yes — and they are different *in kind*.** `eventSourced`/`stateBased` is a *body-structure/behavioral* trait checked against the aggregate body; `storeAs: normalised|document` is a *saving* trait. Two axes, not one enum, not nested. The required combination is `eventSourced` + `storeAs: document`. *Follow-on:* the existing `persistenceStrategy:` keyword misframes the body-structure axis as persistence and should be reconciled to a bare marker (§2.3).
3. For ES + document, what is the snapshot/projection cadence — every event (inline projection, Marten's default), every N events, or on-demand? Does this belong on the aggregate (`storeAs: document(every: …)`), on the `snapshot` `dataSource` (`every:` already exists in D-STORAGE-SPLIT's per-kind config), or both? Leaning: reuse the `snapshot` binding's `every:`.
4. Does a real document DB (`StorageType += mongo`) ever justify itself, or is Postgres-JSONB-everywhere (Marten's own bet) sufficient for Loom's target users? If JSONB-on-Postgres suffices, `storeAs: document` never needs a non-Postgres engine.
5. For `eventSourced` aggregates, can the shape legitimately be `normalised` (projections to tables) and `document` (projection to one JSON doc) *per projection*, or is it one shape per aggregate? v1: one per aggregate (per D-GRANULARITY spirit); per-projection deferred.

---

## 9. Sources

- Marten — [Introduction](https://martendb.io/introduction), [as Event Store](https://martendb.io/events/), [JasperFx/marten](https://github.com/JasperFx/marten)
- EF Core — [Owned Entity Types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities), [EF7 JSON Columns](https://devblogs.microsoft.com/dotnet/announcing-ef7-release-candidate-2/), [EF Core 8 what's new](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew)
- MongoDB / DDD — [Embedded vs Referenced (GeeksforGeeks)](https://www.geeksforgeeks.org/mongodb/embedded-vs-referenced-documents-in-mongodb/), [Embedding vs Referencing (OneUptime)](https://oneuptime.com/blog/post/2025-12-15-how-to-choose-between-embedding-and-referencing-in-mongodb/view), [Fowler — DDD_Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html), [InfoQ — Storing Aggregates](https://www.infoq.com/news/2014/12/aggregates-ddd/)
