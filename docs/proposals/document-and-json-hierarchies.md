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

### 2.2 Candidate invariants (to ratify under D-DOCUMENT-AXIS)

1. **A document boundary is a single value.** Whatever is mapped as a document is written and read as one unit and concurrency-checked as one unit (matches Marten / Mongo embedding). No partial-row updates inside a document tree.
2. **Embedding is acyclic and ownership-only.** Only *containment* (parts / value objects) may be embedded. A cross-aggregate `X id` reference is never embedded — it stays a reference (matches "reference what is shared/independent"). This keeps aggregate boundaries intact.
3. **Open-shape JSON is opaque to the wire spec.** A `json` field contributes a single `json`-typed entry to `wireShape`; it is never expanded, diffed structurally, or validated field-by-field. Contract diffing (`wire-spec.json`) treats it as a leaf.
4. **Document mapping does not change the domain API.** `save`/`find`/`apply` semantics are identical whether an aggregate is normalised or document-mapped; only the emitted persistence code differs. (This is invariant #2 of `storage-and-platform-config.md` applied here: *storage is infrastructure; the aggregate's API is domain modelling*.)

---

## 3. The Option Space

Five options, arranged from smallest to largest surface. They are **not mutually exclusive** — the recommendation in §7 combines two of them.

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

### Option 3 — Per-containment storage hint (`as document` / `as table`) *(addresses need B at the use site)*

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

### Option 4 — Aggregate-level document persistence strategy (`persistenceStrategy: documentBased`) *(addresses need B, Marten-style, whole-aggregate)*

Treat the entire aggregate tree as one document, selected by extending the existing `PersistenceStrategy` enum.

```ddd
aggregate ShoppingCart persistenceStrategy: documentBased {
  id     guid
  items  CartItem[]          // whole tree → one JSONB document, Marten-style
}
```

- **Grammar:** `PersistenceStrategy: 'stateBased' | 'eventSourced' | 'documentBased'` (`ddd.langium:619`).
- **IR:** already threaded — `persistenceStrategy` rides on `AggregateIR` (`loom-ir.ts:327`) and through `resolve-datasource.ts`. A `documentBased` aggregate maps to `dataSource kind`… (needs a `document` kind, see Option 5).
- **Per-backend:** This is the natural **Marten** target. The `PersistenceAdapter` contract already gates on strategy (`efcore-persistence.ts:43` declares `supportedStrategies: ["stateBased"]`); a `martenPersistenceAdapter` would declare `supportedStrategies: ["documentBased", "eventSourced"]`. EF Core can serve it too via root-level `.ToJson()`.
- **Trade-offs:** Honours invariant "persistence strategy is a domain decision declared on the aggregate." Whole-aggregate granularity (no per-field control) — matches how Marten/Mongo actually work. Pairs with Option 5 for the storage binding.

### Option 5 — Document as a `dataSource kind` *(storage-layer wiring for Option 4)*

Under **D-STORAGE-SPLIT**, extend the `kind` set with `document`:

```ddd
storage pg { type: postgres }
dataSource cartStore { for: Shopping, kind: document, use: pg }   // Marten-style doc store on pg
```

- This is the binding half of Option 4: it says *where* document-based aggregates in a context live and which engine serves them (Postgres+Marten, or a real document DB if `StorageType` gains `mongo`/`documentdb`).
- **Trade-offs:** Pure infrastructure, no domain surface. Per-context granularity per D-GRANULARITY; per-aggregate override deferred to v2. On its own it does nothing — it is the plumbing Option 4 needs.

### Option 6 (rejected) — `document` as a top-level aggregate peer

A first-class `document Order { … }` declaration *alongside* `aggregate`, with its own repository and lifecycle but no normalised storage.

- **Why rejected:** It duplicates `aggregate` almost entirely (identity, repository, events, find specs, traceability) purely to change physical storage — violating invariant §2.2#4 ("document mapping does not change the domain API"). Marten/EF/Mongo all model this as *the same aggregate, stored differently*, not a separate object kind. Two near-identical declaration kinds would fork every downstream phase (scope, validate, lower, enrich, all four generators). The thing people actually want — "this aggregate is a document" — is Option 4 + 5, at a fraction of the surface. Recorded here to close the question explicitly.

---

## 4. Cross-Framework Mapping (what each option emits)

| Option | Marten | EF Core | Mongo-shaped | Postgres DDL |
|---|---|---|---|---|
| 1 `json` field | doc property | `[Column(TypeName="jsonb")]` `JsonDocument` | embedded sub-field | `JSONB` |
| 2 `document` type | embedded sub-doc | `.OwnsOne/.OwnsMany(...).ToJson()` | embedded array/object | `JSONB` |
| 3 `as document/table` | per-edge embed/ref | `.ToJson()` vs child-table owned | embed vs `$ref` | `JSONB` col vs child table |
| 4 `documentBased` agg | **native doc/event store** | root `.ToJson()` | one document per aggregate | doc table `(id, data jsonb, version)` |
| 5 `kind: document` | `IDocumentStore` session | `DbContext` w/ JSON config | collection | schema/table placement |

---

## 5. Disambiguation: when modellers pick which nested kind

If Options 2 + 3 both land, three nested-structure kinds coexist. The teaching rule:

| Need | Reach for | Stored as |
|---|---|---|
| Immutable, no identity, scalar-only (Money, DateRange) | `valueobject` | inline JSONB (unchanged) |
| Typed, may hold collections, always embedded as one tree | `document` (Opt 2) | one JSONB column |
| Has identity / is queried independently / referenced | `entity` + `contains` | child table (or `as document`, Opt 3) |
| Shape unknown / externally defined | `json` field (Opt 1) | opaque JSONB |
| Whole aggregate stored as a document | `persistenceStrategy: documentBased` (Opt 4) | doc table |

A validator nudge (`loom.json-field-known-shape`) can suggest promoting a `json` field to a `document`/`valueobject` once its shape is known, keeping Option 1 from becoming an escape hatch.

---

## 6. Implementation touch-points (per option, by pipeline phase)

| Phase / file | Opt 1 | Opt 2 | Opt 3 | Opt 4 | Opt 5 |
|---|---|---|---|---|---|
| Grammar `ddd.langium` | +`json` primitive | +`Document` decl, +`NamedDecl` | +`as` on `Containment` | +`documentBased` | (none) |
| `type-system.ts` | resolve `json` | resolve `Document` | — | — | — |
| `loom-ir.ts` `TypeIR`/`ContainmentIR`/`AggregateIR` | +`json` | +`document` | +`embedding` | already present | `DataSourceIR.kind` |
| `lower/` | leaf | wireShape like VO | carry hint | already | — |
| `enrich/enrichments.ts` | leaf in wireShape | wireShape, no assoc | branch table-vs-assoc | migrationsOwner | — |
| `migrations-builder.ts` / `sql-pg.ts` | already `json`→JSONB | keep arrays JSON | branch `tableForPart` | doc table shape | placement |
| backends (TS/.NET/Phoenix/React) | unknown/JsonElement/:map | DTO from wireShape | repo read/write path | **new Marten adapter** opt-in | session wiring |
| validators | known-shape nudge | embed-acyclic (§2.2#2) | no-id-in-document | strategy×storage compat | kind compat |
| docs | `language.md` | `language.md` | `language.md` | `migrations-design.md` | `architecture.md` |

Phases follow the one-directional pipeline in `CLAUDE.md`; nothing here crosses a layer boundary.

---

## 7. Recommendation (D-DOCUMENT-AXIS — OPEN)

**Document is *both* a small field type and a storage axis — and is *not* an aggregate peer.** Concretely, adopt in this order:

1. **Option 1 (`json` primitive) first.** Smallest, orthogonal, mostly already plumbed (`json` column kind + `JSONB` renderer exist). Ships need (A) on its own and is a prerequisite-free win.
2. **Option 3 (`as document` / `as table` containment hint) next.** Makes today's implicit VO-inline / entity-table asymmetry explicit and chooseable, which is the most-requested capability and the most EF-Core-faithful. Prefer Option 3 over Option 2 because it adds *no* new declaration kind — it reuses `entity`, avoiding the three-way `valueobject`/`document`/`entity` teaching cost in §5. Revisit Option 2 only if a "typed-collection-that-is-never-a-table" type proves to need its own name.
3. **Options 4 + 5 together, later, as the Marten story.** A `documentBased` strategy bound through a `dataSource kind: document`, served by a new `martenPersistenceAdapter` plugged into the existing `PersistenceAdapter` seam. This is the largest piece and should wait until a concrete Marten/Postgres-document target is committed.
4. **Reject Option 6.** "This aggregate is a document" is expressed by 4 + 5, not by a parallel declaration kind.

This keeps the domain model honest (the aggregate API is unchanged regardless of mapping), gives an immediate escape hatch for genuinely open data, and reserves the heavyweight document-store work for when a document backend actually lands.

---

## 8. Open questions

1. Does `json` need an optional *shape hint* (`json<SomeType>`) for the common case where the blob *is* a known DTO from an `extern` boundary, without full structural validation?
2. For Option 3, should `as document` be **forbidden** when the contained `entity` carries find-specs / is referenced elsewhere (it can't be queried independently once embedded)? Likely yes — a validator rule.
3. For Option 4, is `documentBased` *orthogonal* to `eventSourced` (Marten supports event-sourced aggregates with document snapshots), i.e. should the enum become two axes (`stateBased|eventSourced` × `normalised|document`) rather than three mutually-exclusive values?
4. Does a real document DB (`StorageType += mongo`) ever justify itself, or is Postgres-JSONB-everywhere (Marten's own bet) sufficient for Loom's target users?

---

## 9. Sources

- Marten — [Introduction](https://martendb.io/introduction), [as Event Store](https://martendb.io/events/), [JasperFx/marten](https://github.com/JasperFx/marten)
- EF Core — [Owned Entity Types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities), [EF7 JSON Columns](https://devblogs.microsoft.com/dotnet/announcing-ef7-release-candidate-2/), [EF Core 8 what's new](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew)
- MongoDB / DDD — [Embedded vs Referenced (GeeksforGeeks)](https://www.geeksforgeeks.org/mongodb/embedded-vs-referenced-documents-in-mongodb/), [Embedding vs Referencing (OneUptime)](https://oneuptime.com/blog/post/2025-12-15-how-to-choose-between-embedding-and-referencing-in-mongodb/view), [Fowler — DDD_Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html), [InfoQ — Storing Aggregates](https://www.infoq.com/news/2014/12/aggregates-ddd/)
