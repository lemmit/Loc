# M-T9.2 — persistence-emit seam: divergence audit + seam design

*Phase 1 (divergence audit) + Phase 2 (seam contract + slicing plan). This is the **design-first deliverable for maintainer sign-off**, per [`M-T9.2-persistence-seam-brief.md`](./M-T9.2-persistence-seam-brief.md) and [`../RUNBOOK.md`](../RUNBOOK.md) step 3. **No extraction code lands until this is signed off.***

> **STATUS: IMPLEMENTED + CONCLUDED.** Audit complete (all 5 backends). **Seed spine extracted (#1876, byte-identical, merged).** Then, on byte-level scoping, every other candidate fragment declined (§0.4 events/ids/enum; §0.6 wire; **§0.7 QueryTarget** — the flagship). **Net conclusion in §0.7:** the persistence surface's *byte-identical-realizable* shared content is the seed spine + the already-shared substrate; "regular-shaped" (parallel decision tree) turned out to be a weaker property than "byte-identical-extractable" (shared *composition*), which almost nothing outside seed has. Go/no-go history in §0.5; open questions in §2.7.

---

## 0.7 Implementation finding #3 (the conclusion) — `QueryTarget` declines too; the realizable seam is seed + the already-shared substrate

*(Recorded after reading `lowerToDrizzle` and `lowerToSqlAlchemy` at the byte level to build the seam — the "recommended" slice 2.)*

`QueryTarget` was the mission's flagship: the audit called `lowerToDrizzle` ↔ `lowerToSqlAlchemy` "nearly line-for-line." At the **decision-tree** level that's true — both walk the same logical predicate (deny/deep/`&&`/`||`/compare/temporal/`refColl.contains`/intrinsic). But **byte-identical extraction needs shared *composition*, and the composition topology diverges**:

| | Drizzle (TS) | SQLAlchemy (Python) |
|---|---|---|
| comparison | `eq(col, val)` — **function combinator**; must *split* operands by role (`renderColumnRef` vs `renderValue` — different functions) | `(l op r)` — **native operator overload**; recurses *both* operands through the same `lower()` |
| logical | `and(l, r)` / `or(l, r)` | `and_(l, r)` / `or_(l, r)` |
| bare bool `filter this.isActive` | `eq(col, true)` — **extra normalization arm** | `Row.is_active` — a column *is* a boolean expr (no arm) |
| `!this.isDeleted` | `not(eq(col, true))` — **extra normalization arm** | `not_(Row.is_deleted)` — uniform |

A shared dispatcher cannot unify a **uniform-recurse** walk (Python) with a **split-by-role** walk (TS): Drizzle *must* identify which operand is the column to build `eq(col, val)`, so there is no uniform-recurse form, and TS carries two normalization arms (bare-bool, unary-bool) that Python doesn't need. This is the same class of divergence the audit flagged on Axis A (function-combinator vs native-operator), now confirmed at the arm level. And the genuinely **shared** part — the detection (`isDenyFilter`/`isDeepScopeFilter`) and the intrinsic classification (`intrinsicKey`/`intrinsicFor`) — **is already extracted** into `util/intrinsics.js` + the shared filter-shape helpers. What would remain for a `QueryTarget` is a ~15-line recursion skeleton whose arms mostly diverge, behind a ~10-method interface — **net-negative indirection**, the same verdict as wire/events/ids. **`QueryTarget` declines.**

### The mission's real conclusion

The brief framed this as "the last un-abstracted N" and expected a large multi-fragment seam. The byte-identical discipline revealed the opposite: **"regular-shaped" (conceptually parallel decision tree) is a strictly weaker property than "byte-identical-extractable" (shared composition API).** Almost every persistence fragment is regular-shaped, but each ORM composes through a *different API* — Drizzle combinators, SQLAlchemy operator overloads, EF fluent config, JPA annotations, Ecto changesets — so the *composition* (the actual emitted bytes) diverges even where the decision tree is parallel. The **one** fragment that was both parallel *and* composition-free was **seed** (pure structural grouping — `groupByDataset`, no ORM API touched), which is exactly the one that extracted cleanly.

So the realizable persistence seam is: **the seed spine (landed) + the substrate that was *already* shared** (`MigrationsIR`, `wireShape`, `sql-pg`, `ExprTarget`, `intrinsicKey`, deny/deep detection). The rest is deliberately per-backend, reason recorded — which is precisely the brief's stated success criterion ("every divergent one deliberately per-backend with the reason recorded"), not a failure. The remaining committed item that is **not** a byte-identical extraction — **slice 3, removing the orphaned adapter emit-layer (§2.5, closes M-T6.10)** — still stands; it's dead-code cleanup, unaffected by this finding.

**Consequence for T10:** the "unfreeze" is effectively complete *now* — a 6th backend inherits the entire already-shared substrate + the seed pattern, and its persistence composition was always going to be per-ORM (that's not debt the seam could have removed; it's the nature of ORMs). The brief's premise that a seam would let a 6th backend avoid "re-buying the whole surface" was partly mistaken: most of that surface is irreducibly per-ORM composition.

---

## 0. TL;DR — the three findings that reshape the brief

The brief's instinct ("abstract the last un-abstracted N, imitate `ExprTarget`/`WalkerTarget`") is right. The audit changes three specifics:

1. **The seam is not "5 backends × all fragments." It's a *relational-SQL cluster* plus deliberate declines.** TS/Hono and Python are built as explicit mirrors and share nearly every persistence decision tree; .NET/EF joins them on some (joins, wire) and declines on others (writes, injection); **Java and Elixir decline on almost every write-side and injection-side fragment** because each pushes that logic into framework-native machinery (JPA annotations + `@SQLRestriction` + Spring-Data method derivation; Ecto changesets + context-module `defdelegate`s + `with`-chains). This is the same outcome as HEEx declining `walkBody` and Elixir declining `WorkflowStmtTarget` — **expected, not a failure.**

2. **The brief's nominated slice 1 is inverted.** Repository-CRUD *write* verbs (`save`/`insert`/`update`/`delete`) are the **least** shareable fragment — only the TS↔Python pair share the tree; .NET (EF change-tracking unit-of-work), Java (`jpa.save` one-liner + Spring derivation), and Elixir (`insert`/`update` split, `{:ok,_}` tuples) each compose writes on a foreign topology. The genuinely high-feature-traffic *shared* logic lives on the **read/query path** — a new **`QueryTarget`** seam (find-`where` → query lowering) the brief didn't name, which is a direct `ExprTarget` analogue and absorbs custom-finds **and** capability-filter predicates at once.

3. **The adapter emit-layer is orphaned dead code.** `PersistenceAdapter.emitRepository`/`emitMigrations`/`emitConnectionSetup`/`emitOutbox` and `resolvePersistence()` are **never called on the real emit path** (`src/system/index.ts` → `emitProject` never touches them; only unit tests + `defaultsFor` in lowering do). The seam must live *inside* each backend's real `src/generator/<platform>/` emitters — **not** by resurrecting the adapter `emit*` methods. Recommendation for M-T6.10: **fold the orphan's removal into this design** (§Phase 2.5).

The net: the seam is worth building, but its shape is **a `src/generator/_persistence/` directory of several narrow per-fragment seams — each with its own in-scope backend set — not one monolithic `PersistenceTarget` interface.** That directly imitates how the repo already did `_expr` / `_walker` / `_stmt/leaves` / `_payload` / `_workflow` (separate seams, shared home), rather than one god-interface.

---

## 0.4 Implementation finding — the "cheap warm-up" slices are net-negative; skip them

*(Recorded during implementation, on close reading of the actual emitters — supersedes the events/ids/enum rows of the original slicing table.)*

The audit ranked events / ids / enum as the "cheapest" first slices (by *ease*). Reading the emitters line-by-line shows ease here means **there is almost nothing to share**: the shared decision tree is a **one-line walk**, and 90% of each emitter is *divergent* framing that must stay a per-backend leaf.

- **events** — the only shared logic is `fields.map(f → renderType(f) + name)`. Everything else diverges: file-per-event (.NET/Java) vs one module (TS/Python); positional record params (`record Name(T a)`) vs member block (`interface`/`@dataclass`) vs `defstruct`; the marker interface, the `DomainEvent` union, the dispatcher boundary, the import systems — all per-backend. A `EventTarget` interface would be *more* code than the duplication it removes.
- **ids** — shared logic is the 3-line name walk (`for a of aggregates: push a.name; for p of a.parts: push p.name`). The emission (`branded string + uuidv7` / `NewType + uuid7` / `record struct` / `@Embeddable record`) is entirely divergent leaf.
- **enum** — a name-list → language enum; the DSL casing is the wire contract, so there is no decision to share, just a trivial spelling.

**Decision:** **drop events / ids / enum as `Target` seams** — extracting a 5-method dispatch interface to wrap a one-line loop is exactly the *speculative-generality debt* the repo warns against (retro §"no stub adapters"). The pattern-establishment value the brief wanted from a cheap first slice is better bought by the **smallest slice with a genuinely shared *tree*** — `groupByDataset` (byte-identical across TS/.NET/Python), which is what Slice 3 (seed) actually lands first. A `Target` seam earns its interface only when the shared decision tree is substantial (query lowering, seed spine, wire projection); a fragment whose shared part is one line stays inlined per-backend. This refines, not contradicts, §0.5: the committed set narrows to **slice 0 + seed + wire + QueryTarget**; the value is still real, just concentrated in fewer, meatier slices.

## 0.5 Go/no-go — is the alignment worth it? (considerations + decision)

The audit forces the go/no-go question the brief assumed away ("the seam is worth building" — but *how much* of it?). Two distinct readings of "align the persistence layer," with opposite answers:

### Reading A — align the *emitters* onto shared seams (the extraction). Verdict: **SCOPED GO.**

The ROI is real but **very uneven** across the matrix — most rows either share nothing new (already `▣`) or decline (`○`). Blindly "aligning everything" would mean forcing divergent topologies into a shared core: the exact anti-pattern the decline criterion exists to stop. So the decision is **not** "build the whole seam" and **not** "skip it" — it is **build the high-ROI subset, defer the low-ROI subset, never force the declines.**

**Cost/benefit, honestly:**

- **Cost:** every extraction slice is *pure refactoring* — byte-identical, zero feature payoff **at the time it lands**. The payoff is amortised over *future* storage features. So each slice must clear the bar "the recurring re-landing cost this removes > the one-time extraction + review + byte-gate cost."
- **Benefit is concentrated, not spread:** much of the raw file-count duplication the brief counts is *already-shared substrate* (`MigrationsIR`, `wireShape`, `sql-pg`, `ExprTarget`) — so the true per-feature re-landing cost is smaller than "elixir 70 / dotnet 61 / …" suggests. The genuine, recurring, not-yet-shared cost lives in a **handful** of rows.

**The decision, per tier:**

| Tier | Slices | Verdict | Why |
|---|---|---|---|
| **Pure win** | Slice 0 — delete orphaned adapter emit-layer + `resolvePersistence` | **DO** | No emit change, deletes dead code + dead tests, closes M-T6.10. Zero risk, positive today. |
| **High ROI** | `QueryTarget` (slice 6) | **DO** | The single best slice: the **read/query path is the recurring pain** (every custom find + every capability-filter predicate), it spans **3 backends** (TS/Py/Java), and it is a proven-pattern `ExprTarget` analogue. This is where "36 files" actually recurs on the query side. |
| **Cheap + unfreezes T10** | events (1), wire DTO (5), ids (2), enum/VO (4), seed (3) | **DO** | Flat walks, tiny leaves, near-all-5. Low cost, and they establish the `_persistence/` **pattern a 6th backend follows** — this is what "unfreezes T10" concretely (see below). |
| **Low ROI (2-backend)** | `ColumnTarget` (7), `renderRepositoryWith` writes (9) | **DEFER** | Net only the TS↔Python pair. Real duplication, but do them **when a concrete storage feature would touch them**, not speculatively ("consolidate the present, don't design for the future"). `JoinRowTarget` (8, 3-backend) is the borderline — defer unless association traffic justifies. |
| **Declines** | writes on .NET/Java/Elixir, stamp injection, embedded mapping, criterion emission, filter-injection on .NET/Java, routes, DI | **DO NOT TOUCH** | Framework-native composition; sharing trips the decline criterion. Keeping them per-backend *is* the correct outcome (the HEEx/`walkBody` and Elixir/`WorkflowStmtTarget` precedent). |

### Reading B — align the *backends themselves* (converge topologies so the seam captures all 5). Verdict: **NO.**

Tempting after the audit: ".NET/Java/Elixir decline only because they're framework-native — rewrite them to the TS/Python relational-SQL procedure so the seam captures 5/5." **Reject this outright.** It would (a) throw away idiomatic EF change-tracking / Spring-Data derivation / Ecto changesets — the per-ecosystem drift is a stated *feature* (CLAUDE.md §Conventions; `src/platform/surface.ts` header: *"That drift is a feature… reads idiomatically for each ecosystem"*); (b) be a massive **non-byte-identical** behaviour change riding a refactor, violating hard-constraint #2; and (c) fight each stack's grain for the sake of a metric. The declines are correct; they stay.

### On the T10 freeze

The brief says *"T10 target growth stays frozen until this exists."* The scoped seam unfreezes T10 **as far as it can be** — not "a 6th backend writes zero persistence code," but "a 6th backend does not **re-buy the shareable surface**": it reuses `QueryTarget` + wire + events + the `▣` substrate, and hand-writes only its framework-native write/injection path (which *every* backend does, and which a 6th backend would have to write regardless). "Seam exists" = the pattern + the shared read/value/query core are in place — **that** is the unfreeze condition, achieved by the "high-ROI + cheap" tiers above; the deferred 2-backend slices are **not** on the T10 critical path.

### Net decision

**Proceed with the scoped subset — slice 0 + the high-ROI + cheap/unfreeze tiers (slices 1–6) — defer the 2-backend slices (7–9) until feature traffic justifies them, and do not converge backend topologies.** This captures the recurring cost where it actually recurs (read/query path, value types, wire), lifts the T10 freeze, and honours the decline criterion instead of fighting it. *(Recommendation pending maintainer confirmation of the §2.7 open questions — those are the finer sign-offs within this GO.)*

---

# Phase 1 — Divergence audit

Backends: **TS/Hono** (Drizzle), **.NET** (EF Core), **Java** (Spring Data JPA/Hibernate), **Python** (SQLAlchemy), **Elixir** (plain Ecto/Phoenix, the `vanilla/` subtree). Method: four parallel deep-reads of the parallel emitter files, each classifying every fragment cell as **already-shared** / **regular-shaped** (seam candidate) / **shape-divergent** (decline), with the pre-registered decline criterion applied: *if sharing the fragment requires the shared core to know per-backend composition order or grouping, it is divergent.*

## 1.1 The already-shared substrate (the baseline the seam sits on)

These are computed **once** and consumed by every backend — the seam does **not** re-touch them:

| Shared artifact | Home | What it owns |
|---|---|---|
| **`MigrationsIR`** | `src/system/migrations-builder.ts` (`schemaFromModule`, `:72`) | The physical table/column truth: `ColumnShape[]` with physical `ColumnType`, join tables (`tableForAssociation`, `:1230`), document table `(id, data jsonb, version)` (`:479`), embedded root+jsonb table (`:434`). Header: *"Backends never derive their own table list."* |
| **`sql-pg.renderPgType`** | `src/generator/sql-pg.ts:138` | `ColumnType → SQL`. Consumed by every backend's `migrations` + `seed` emitter (verified: dotnet/java/python/elixir migrations + seed all import it). Phoenix stays in Ecto DSL for schema but uses it for raw seed SQL. |
| **`agg.wireShape`** | `src/ir/enrich/enrichments.ts:1239` (`wireShapeFor`, `:148`) | The ordered wire-field list. Every DTO emitter walks `forApiRead(wireShapeFor(ent))` (see 1.4 wire). |
| **`agg.associations`** | `enrichments.ts:1462` | One `AssociationIR` per `X id[]` field (joinTable, ownerFk, targetFk). |
| **`ExprTarget`** | `src/generator/_expr/target.ts:184` (`renderExprWith`) | The 17-arm `ExprIR` dispatch — every *domain-logic* expression body already renders through it (all 5 backends). |
| **IR capability model** | `loom-ir.ts` — `contextFilters` (`:555`), `contextStamps` (`:596`/`:708`), `FindIR.filter` (`:817`), `FilterBypass` (`bypassAll`/`bypassCaps`) | Filter/stamp values + bypass origins fully resolved on the IR; **no backend re-derives them.** The `isFilterBypassed`/`bypassDrops` helper is reimplemented near-identically in all 5 (TS `repository-find-predicate.ts:469`, Python `find-predicate.ts:389`, Elixir `capability-filter.ts:52`, Java `capability-filter.ts:59`, .NET `efcore.ts:668`) — *already-shared at the IR level, regular-shaped at the emitter level.* |

## 1.2 The fragment × backend matrix

Legend: **▣ already-shared** · **● regular-shaped (seam candidate)** · **○ shape-divergent (decline)** · **—** not emitted.

| Fragment family | TS/Hono | .NET | Java | Python | Elixir | Seam verdict |
|---|:--:|:--:|:--:|:--:|:--:|---|
| **events** (field-bag record) | ● | ● | ● | ● | ● | **all 5** — cheapest |
| **ids** (branded wrapper + factory) | ● | ● | ● | ● | ○ | **4/5** (Elixir: no branded id) |
| **enum** (name-list → enum decl) | ● | ● | ● | ● | ○ | **4/5** (Elixir: folds into changeset) |
| **VO** (fields+invariants+derived) | ● | ● | ● | ● | ○ | **4/5** (bodies already via `ExprTarget`; Elixir: Ecto embedded-schema+changeset) |
| **wire DTO** (framing over `wireShape`) | ▣● | ▣● | ▣● | ▣● | ▣● | **all 5** — core shared, framing regular |
| **seed** (dataset group + row insert) | ● | ● | (chk) | ● | (chk) | **≥3** (`renderSeedRowInsert` already shared; D-SEED-* pins tree) |
| **find `where` → query** | ● | ▣ | ● | ● | ▣ | **all 5** via a **`QueryTarget`** (.NET/Elixir already on `ExprTarget`) |
| **criterion — eligibility test** | ● | ● | ● | — | — | shareable predicate |
| **criterion — emission** | ○ | ○ | ○ | — | — | decline (Spec-class OO vs fn vs inline) |
| **capability filter — bypass model** | ▣ | ▣ | ▣ | ▣ | ▣ | already IR-shared |
| **capability filter — injection** | ● | ○ | ○ | ● | ● | **3/5** (TS/Py/Elixir "AND-per-read"); .NET/Java decline |
| **entity/schema — column mapping** | ● | ○ | ○ | ● | ○ | **2/5** (Drizzle↔SQLAlchemy vs `ColumnShape`); EF/JPA emit no col-type, Ecto VO→jsonb |
| **association — standalone join-row** | ● | ● | ○ | ● | ○ | **3/5** (Drizzle/EF/SQLAlchemy row-table); Java `@ElementCollection`/Ecto `many_to_many` decline |
| **repository — `getById` (load+throw)** | ● | ○ | ● | ● | ○ | **3/5** (TS/Py/Java `orElseThrow`); .NET nullable, Elixir tuple+context-bang |
| **repository — `save`/`insert`** | ● | ○ | ○ | ● | ○ | **2/5** (TS↔Python only) |
| **repository — `findById` (hydrate)** | ● | ○ | ○ | ● | ○ | **2/5** (TS↔Python explicit select+hydrate) |
| **repository — `delete`** | ○ | ○ | ○ | ○ | ○ | decline (arg convention splits id vs aggregate) |
| **repository — `update`** | — | — | — | — | ○ | N/A (distinct verb only on Elixir) |
| **stamp injection** (write hook) | ○ | ○ | ○ | ○ | ○ | decline all 5 (per-ORM write hook) |
| **document/embedded — mapping** | ○ | ○ | ○ | ○ | ○ | decline all 5 (physical layout ▣; mapping maximally divergent) |
| **routes/controllers** | ○ | ○ | ○ | ○ | ○ | decline + **defer** (M-T5.10 reshaping) |
| **DI/bootstrap** | ○ | ○ | ○ | ○ | ○ | decline all 5 (container vs scan vs Depends vs OTP) |

## 1.3 The two structural axes the matrix reveals

Reading the matrix down the columns, the declines cluster along two axes — worth naming because they predict where a **sixth** backend (T10) will fall:

**Axis A — relational-SQL vs framework-native.** TS/Hono and Python treat persistence as *explicit SQL-shaped procedures* (build a row, `insert … on conflict`, AND a predicate into every `where`, diff-sync children in a transaction). They are near-isomorphic — Python's `py-columns.ts:4` says outright *"Mirrors the Drizzle column rules."* .NET/Java/Elixir instead *delegate to a framework* (EF change-tracking + `HasQueryFilter` + `SaveChangesInterceptor`; Hibernate `@Entity`/`@SQLRestriction`/`AuditingEntityListener`; Ecto changesets + `Repo`). The framework owns composition — so a shared core that emits the composition trips the decline criterion.

**Axis B — read-path vs write-path.** The **read/query path is broadly shareable** (find-`where`, filter conjunction, wire projection — the matrix's dense ● band). The **write path is where backends diverge** (save composition, stamp injection, embedded serialization). This inverts the brief's "CRUD verbs are slice 1" instinct: the write verbs are the *hardest* to share, the read/query lowering the *easiest and highest-traffic*.

## 1.4 Per-fragment evidence (citations)

**events — ● all 5.** Per event: `record/struct/interface` of `{renderType(field), name}` + marker/union + (Py/TS) dispatcher. `dotnet/emit/events.ts:19` `public sealed record …(…) : IDomainEvent;` · `java/emit/events.ts:14` `@DomainEvent public record …` · `python/emit/events.ts:59` `@dataclass(frozen=True)` + `ClassVar` tag · `ts/emit/events.ts:10` interface+tagged-union · `elixir/events-emit.ts:13` `defstruct`. An event is a field-bag with no invariants, so even Elixir's `defstruct` is parallel here. Marker/union/dispatcher is a leaf-string.

**ids — ● 4/5.** Identical `for each aggregate+part name → {wrapper over valueType} + {factory}` walk; the only inputs are a 2-cell leaf table (`valueTypeForId`, `newIdValue`). Parallel: `dotnet/emit/ids.ts:7` (`record struct …Id(Value)`) · `java/emit/ids.ts:11` (`@Embeddable record …Id`) · `python/emit/ids.ts:23` (`NewType` + `new_…_id()`) · `ts/emit/ids.ts:22` (branded string + `uuidv7`). **Elixir declines** — no branded id; ids lower to a shared `<App>.Types.id()` typespec (`events-emit.ts:18`). Pre-recorded decline: the BEAM has no nominal wrappers.

**VO/enum — ● 4/5.** Enum ≈ trivial name-list→enum. VO: same `fields→props, invariants→guard, derived→accessor, functions→method` order, and every *body* already renders through `ExprTarget` (`renderCsExpr`/`renderJavaExpr`/`renderPyExpr`). Parallel: `dotnet/emit/enums-vos.ts:26` · `java/emit/enums-vos.ts:31` · `python/emit/value-objects.ts:95`. **Elixir declines** — VOs are Ecto embedded-schema + changeset validators (`vanilla/valueobject-emit.ts`, `changeset-emit.ts`): validation is changeset-pipeline-shaped, not constructor-invariant-shaped (composition-order → decline).

**wire DTO — ▣ core + ● framing, all 5.** Verified every backend consumes `forApiRead(wireShapeFor(ent))` directly, no re-derivation: `dotnet/dto-mapping.ts:418` · `java/emit/dto.ts:251` · `ts/repository-wire-builder.ts:38` · `elixir/vanilla/wire-serialize.ts`. Python honors it for aggregate DTOs via `routes-builder.ts` (its `http-models.ts` only frames nested VO models). The residual per-backend piece is a 3-arm switch over `wf.source` (`id`/`containment`/`property`) + a primitive→wire value-map (`money→string`, `datetime→ISO`, `id→bare`, `enum→name`) whose *semantics* are byte-identical across `dotnet/dto-mapping.ts:45`, `java/wire.ts:22`, `python/http-models.ts:34` — only record-vs-object framing differs.

**seed — ● (≥3 verified).** `dotnet/emit/seed.ts` and `python/emit/seed.ts` (and `ts/emit/seed.ts`) are near-mechanical translations, keyed to the same pinned decisions (D-SEED-PATH/-IDEMPOTENCY/-XREF, cited identically in both headers): `groupByDataset` byte-identical (`dotnet:82` ≡ `python:145`), `renderDatasetFn` same shape (enabled-guard → already-seeded-guard → repo decls → per-row `create`/raw-INSERT via **shared** `renderSeedRowInsert` → mark-seeded). Grouping is *already shared logic*, so it does **not** trip the decline criterion.

**find `where` → query — the `QueryTarget` finding.** Two families: **(A) reuse `ExprTarget`** — .NET (`find-emit.ts:167` `.Where(x => renderCsExpr(find.filter, {efQuery:true}))` → `CS_TARGET_EF` leaf, `render-expr.ts:314`) and Elixir (Ecto `where:` fragments *are* Elixir exprs, rendered via `renderExpr`). **(B) a dedicated query-lowerer** — TS `lowerToDrizzle` (`repository-find-predicate.ts:110`, a *separate oracle* from the domain `renderExprWith`, though it borrows `TS_INTRINSIC_RENDERERS`), Python `lowerToSqlAlchemy` (`find-predicate.ts:85`), Java `renderJpqlWhere` (`render-jpql.ts:82`). **Decisive:** the three Family-B lowerers share an *identical* decision tree — `COMPARE_OP` map, `&&`/`||`→and/or, bare-boolean column, VO sub-column flatten (`<field>_<sub>`), null checks, `refColl.contains(x)`→join subquery, `isDenyFilter`/`isDeepScopeFilter` sentinels, A5 `datetime ± duration` arithmetic — diverging only in leaf spelling. The tell: four parallel per-op intrinsic tables with the *same keys*, different output strings — `DRIZZLE_INTRINSIC_SQL` (`repository-find-predicate.ts:46`) ↔ `SQLALCHEMY_INTRINSIC_SQL` (`find-predicate.ts:55`) ↔ `JPQL_INTRINSIC_SQL` (`render-jpql.ts:52`). `ts/repository-find-predicate.ts` ↔ `python/find-predicate.ts` are nearly line-for-line.

**capability filter injection — ● 3/5.** TS/Python/Elixir all "AND into every read site" (`contextFilterPredicate` TS `:541` / Py `:419`; `vanillaCapabilityFilter` Elixir `capability-filter.ts:70`), conjoined via `combinePredicate`/`combineWhere` — regular-shaped among themselves (same bypass check, origin-indexed drop, principal-accessor swap). **.NET declines** — EF global `HasQueryFilter` install in `OnModelCreating` (`efcore.ts:254`,`:502`), 1 site, bypass via `.IgnoreQueryFilters([...])`. **Java declines** — a 3-mechanism triage: static `@SQLRestriction`, promoted `@Filter(autoEnabled)` + `session.disableFilter`, and per-query JPQL for principal filters (`java/capability-filter.ts`, `render-sql-restriction.ts`). The *inner predicate render* reuses the `QueryTarget` seam even where the injection wrapper doesn't.

**entity/schema column mapping — ● 2/5.** `migrations-builder.columnsForField` already owns the physical `ColumnShape.type` once. But each backend re-walks `TypeIR` for its ORM binding. Near-isomorphic: Drizzle `drizzleColumnLines` (`ts/emit/schema.ts:812`) ↔ SQLAlchemy `columnsFor` (`python/py-columns.ts:120`) — same arms (`money→numeric(19,4)`, `guid→uuid`, `id[]→skip`, `enum→text`, VO **flattened**). **EF/JPA decline** — `fieldConfigLines` (`efcore.ts:771`) / `jpaFieldAnnotations` (`jpa-annotations.ts:135`) emit *no column type* (CLR/Hibernate inference) — they emit `HasConversion`/`OwnsOne` / `@Column`/`@Embedded` keyed off the CLR/Java type, so a "column-type core" gives them little. **Ecto declines** — VO stored as `:map` jsonb, *not* flattened (`schema-emit.ts:449`).

**association standalone join-row — ● 3/5.** Join table itself ▣ (`AssociationIR` + `tableForAssociation`). Topology A (standalone row table the repo writes): Drizzle `emitJoinTable` (`ts/emit/schema.ts:352`) ↔ EF `renderJoinEntity` (`dotnet/emit/join-entities.ts:43`, header: *"mirroring how the TS/Hono generator persists the join table"*) ↔ SQLAlchemy `renderJoinModel` (`python/emit/schema.ts:595`). **Java/Elixir decline** — Topology B, owner-side ORM collection (`@ElementCollection`+`@CollectionTable` / `many_to_many join_through:`).

**repository CRUD — the decline detail (Axis B).** `save`: TS↔Python isomorphic (row projection → `insert … onConflict` → diff-sync containments/joins/value-collections → dispatch, in a tx — `ts/repository-save-builder.ts:30` ↔ `python/repository-builder.ts:1042`). **.NET** = EF change-tracking unit-of-work (`_db.Entry`; `Add` if detached; `SaveChangesAsync`; `repository.ts:409`). **Java** = `jpa.save(aggregate)` one-liner (Spring derives INSERT/UPDATE; `repository.ts:622`). **Elixir** = `insert/2` + distinct `update/3` returning `{:ok,_}|{:error,_}`, `put_assoc`/`cast_assoc` children (`vanilla/repository-emit.ts:370`), re-exposed through context-module `defdelegate`s (`context-emit.ts:321`) with `with`-chain guard ordering (`:594`). `getById` shares "load-then-throw" on TS/Py/Java (`orElseThrow`); **.NET** returns nullable (404 in the handler), **Elixir** hoists a throwing `get_<agg>!` bang into the context module.

**decline-all fragments.** **stamp injection** — per-ORM write hook everywhere: EF `SaveChangesInterceptor` (`auditable-interceptor.tpl.ts:7`), JPA `AuditingEntityListener` + `@PrePersist`/`@PreUpdate` (`entity.ts:808`), Ecto `put_change` pipe (`stamp-emit.ts:104`), Python `_stamp_on_*` instance methods (`aggregate.ts:92`), TS save-middleware (`emit/audit-stamp.ts`). **document/embedded mapping** — physical layout ▣ (`migrations-builder.ts:426` header names all four as one physical layout), but the mapping hangs on a different ORM primitive per backend (EF `.ToJson()`/owned-types, JPA `@JdbcTypeCode(JSON)`, Ecto `embeds_one`/`embeds_many`, raw-jsonb+manual-serialize) — the clearest decline-criterion instance. **routes** — regular *inputs* (route-slug + `errorStatuses` already shared vocabularies) but divergent router topology (Mediator controllers / Spring `@RestController` / FastAPI `APIRouter` / Hono chain / Phoenix Router-splice with CRUD-verb suppression), **and** `RouteIR`/`CommandHandlerIR` are landed-but-unread (`loom-ir.ts:2326`) — M-T5.10 is mid-flight reshaping this surface; extracting now collides. **DI/bootstrap** — imperative container (`.NET program.ts:136`) vs component-scan (Java) vs `Depends` (Python) vs manual (Hono) vs OTP supervision (Elixir).

## 1.5 The benchmark, re-measured honestly

The brief cites part-in-part containment (**#1835**) as "**36 files across 4 backends**." Verified: 36 files = **23 src / 11 test / 2 docs**, and the 4 backends are **TS/dotnet/java/python — Elixir was not touched at all.** Part-in-part is a *containment/embedded-shape* feature, and per the matrix, embedded mapping **declines on all 5** while the relational containment path shares only on TS↔Python (save diff-sync) + the ▣ migrations substrate. So the seam's benefit on *this specific benchmark* is **asymmetric**: large for the shared substrate + the TS/Python pair, modest for .NET/Java (which keep divergent embedded leaves). See Phase 2.6.1 for the restated, per-backend acceptance target — the "≤1 leaf per backend for all backends" phrasing in the brief overstates what an embedded-shape feature can achieve; it holds for *relational* storage features, not embedded ones.

---

# Phase 2 — Seam design (contract sketch + slicing plan)

## 2.1 The shape: a `_persistence/` directory of narrow seams, not one interface

The brief's name "`PersistenceTarget`" implies one interface. The audit says otherwise: persistence is **many independent decision trees** (query lowering, wire framing, column mapping, seed spine, value-type framing), each with a **different in-scope backend set**. Forcing them into one interface would (a) put decline-backends on the interface for fragments they can't implement, and (b) break the "one seam = one decision tree" discipline every existing seam follows (`ExprTarget` = expr dispatch; `WalkerTarget` = body walk; `WorkflowStmtTarget` = stmt spine — each *one* tree).

**Decision:** build `src/generator/_persistence/` as the shared *home* (sibling of `_expr`/`_walker`/`_payload`/`_workflow`), containing **one small module per fragment seam**, each exporting a `render<Fragment>With(node, target, ctx)` dispatcher + a `<Fragment>Target` leaf interface. A backend opts into a seam by supplying that leaf table; a decline-backend simply doesn't import it and keeps its bespoke emitter. This is the `_stmt/leaves.ts` / `_payload/` precedent exactly.

## 2.2 Home + layering (D-BACKEND-PKG / D-ADAPTER-HOME compliant)

`src/generator/_persistence/`. This satisfies all four hard constraints:
- **No new IR** — every seam dispatches over existing `LoomModel`/`EnrichedAggregateIR` + `MigrationsIR`; no target-backend IR.
- **D-BACKEND-PKG** — under `src/generator/` (`@loom/core`), so `packages/backend-hono-v5/` can import it; it must **never** import from `src/platform/<family>/<vN>/` (guarded by `backend-packages-layering.test.ts`). Consumers (each `src/generator/<platform>/` emitter + the hono package) all live at or below the generator layer → `pipeline-layering.test.ts` holds.
- **D-ADAPTER-HOME** — orthogonal. Adapters are the *per-library menu* on the surface; this seam is the *per-fragment emit dispatch* inside a backend. They compose: an adapter's (future, live) `emitRepository` would *call* `renderRepositoryWith(agg, TS_PERSISTENCE)` rather than reimplement it. See 2.5.
- Reuse existing shared maps as leaf inputs where they exist: `sql-pg` `ColumnType`, `migrations-builder` `ColumnShape`, `wireShape`, the `ExprTarget` intrinsic tables.

## 2.3 Contract sketches

### 2.3.1 `QueryTarget` — the flagship (find-`where` + capability-filter predicate lowering)

The highest-value seam: one dispatcher that lowers a filter `ExprIR` (from `FindIR.filter` **or** `contextFilters`) to a backend's query representation, mirroring `renderExprWith`. Absorbs the three Family-B lowerers directly; .NET/Elixir already sit on `ExprTarget` for it (they'd supply a `QueryTarget` that delegates to their `renderExpr`, or stay as-is and the seam just unifies TS/Py/Java — an open question, 2.7-Q3).

```ts
// src/generator/_persistence/query-target.ts   (sketch — not final)
export interface QueryTarget<Q> {                 // Q = backend query node: Drizzle op | SQLAlchemy expr | JPQL string
  compare(op: CompareOp, col: ColumnRef, value: string): Q;   // COMPARE_OP leaf
  and(parts: Q[]): Q;  or(parts: Q[]): Q;  not(inner: Q): Q;
  boolColumn(col: ColumnRef): Q;                  // bare-boolean predicate
  isNull(col: ColumnRef, negated: boolean): Q;
  collectionContains(assoc: AssociationIR, value: string): Q;  // refColl.contains → join subquery
  intrinsic(key: IntrinsicKey, args: string[]): Q;             // the *_INTRINSIC_SQL tables, one leaf table per backend
  temporalArith(col: ColumnRef, op: "+" | "-", duration: string): Q;  // A5
  // value-side falls back to the backend's existing render-expr for literals/refs
}
// Shared dispatcher owns: the queryable-subset walk, COMPARE_OP structure, VO sub-column
// flatten, deny/deep sentinels, null handling, refColl.contains topology, temporal arithmetic.
export function lowerFilterWith<Q>(e: ExprIR, t: QueryTarget<Q>, ctx: QueryCtx): Q | null; // null = non-queryable
```
Leaf tables: `TS_QUERY` (Drizzle) / `PY_QUERY` (SQLAlchemy) / `JAVA_QUERY` (JPQL). Java needs *three* instantiations (JPQL / Criteria / SQLRestriction) over the same dispatcher — the framework-imposed multiplicity is a Java-only leaf concern, not a dispatcher concern (2.7-Q4).

### 2.3.2 `WireTarget` — DTO framing over `wireShape`

Core is already shared (`forApiRead(wireShapeFor(ent))`). The seam captures the 3-arm `wf.source` walk + primitive→wire value-map, leaving only record-vs-object framing per backend.
```ts
export interface WireTarget {
  openDto(name: string, fields: WireField[]): Lines;   // record header vs object-literal open
  field(wf: WireField, projected: string): string;     // one wf.source arm's line
  wireValue(wf: WireField): string;                    // money→string, datetime→ISO, id→bare, enum→name
  closeDto(): Lines;
}
export function renderWireDtoWith(agg, t: WireTarget): Lines;   // walks forApiRead(wireShapeFor(agg))
```
In-scope: all 5 (each already consumes `wireShape`).

### 2.3.3 `ColumnTarget` — `ColumnShape` → ORM column (relational trio)

Re-expose `migrations-builder`'s per-field `ColumnShape` (kind + nullable + flatten) as the shared decision, so Drizzle + SQLAlchemy stop re-switching on `TypeIR`.
```ts
export interface ColumnTarget {
  column(shape: ColumnShape): Lines;    // pgTable line vs mapped_column line
  idColumn(shape: ColumnShape): Lines;
  flattenedVo(prefix: string, subs: ColumnShape[]): Lines;
}
export function renderColumnsWith(agg, migrations: MigrationsIR, t: ColumnTarget): Lines;
```
In-scope: TS/Hono + Python. **Decline:** EF/JPA (no column type — CLR inference), Elixir (VO→jsonb). *Do not* extend to them.

### 2.3.4 Value-type seams — ~~`IdTarget`, `EventTarget`, `EnumTarget`, `VoTarget`~~ **DROPPED (§0.4)**

**Cut during implementation.** On close reading the shared decision tree for id/event/enum is a *one-line walk*; the emission framing is entirely divergent leaf, so a `Target` interface would add more indirection than it removes. See §0.4. These fragments stay inlined per-backend.

### 2.3.5 `SeedSpine` — dataset grouping + `renderDatasetFn` **(first landed slice)**

`groupByDataset` + `usedAggregates` + the `Entry`/`Dataset` model are **byte-identical across TS/.NET/Python** — verified and **extracted to `src/generator/_persistence/seed-datasets.ts` (landed; byte-identical gate green)**. The guard/decl/row/mark skeleton (`renderDatasetFn`) is pinned by D-SEED-* and the row SQL is already shared (`renderSeedRowInsert`); the remaining `renderDatasetFn` framing (`save`-call shape, import collection, datetime coercion) stays the per-backend leaf. This is the slice that *establishes the `_persistence/` home + the byte-identical gate* — deliberately chosen over the dropped value-type warm-ups because it has a genuinely shared tree. Java/Elixir seed spot-checked as decline (own framing).

### 2.3.6 Repository CRUD — a **TS↔Python-pair-only** seam (not the brief's slice 1)

Because only TS↔Python share the write tree, a `renderRepositoryWith` seam here is a **2-backend** shared core (save projection + `insert…onConflict` + child diff-sync + inline filter conjunction + hydrate). Worth doing *for that pair* (it's real, high-traffic duplication — `repository-save-builder.ts` ↔ `repository-builder.ts`), but it is **not** the cross-backend win the brief imagined. `.NET`/`Java`/`Elixir` keep their bespoke write emitters. `getById`'s load-then-throw is separately shareable across TS/Py/Java.

## 2.4 What stays per-backend (the recorded declines)

Per the decline criterion, and to be honest about the ceiling: **stamp injection** (all 5 — per-ORM write hook), **document/embedded mapping** (all 5 — different ORM primitive each), **criterion emission** (Spec-class vs fn vs inline), **capability-filter injection on .NET/Java** (global-filter install / 3-way triage), **repository writes on .NET/Java/Elixir** (change-tracking / Spring derivation / tuple+context+`with`-chain), **routes** (framework router topology + M-T5.10 in flight), **DI/bootstrap** (all 5). Each decline is a framework-native composition the shared core would have to encode order/grouping for — exactly the pre-registered stop condition, and exactly why HEEx/`walkBody` and Elixir/`WorkflowStmtTarget` declined before.

## 2.5 `resolvePersistence()` / the adapter emit-layer (M-T6.10) disposition

**Finding:** the adapter *emit* surface is orphaned. `PersistenceAdapter.emitRepository`/`emitMigrations`/`emitConnectionSetup`/`emitOutbox` have implementations on every backend's adapter but **no production caller** — `src/system/index.ts`'s `emitProject` path never invokes them; only `test/adapters/*` unit tests and `resolvePersistence()` (itself uninvoked outside tests) reach them. The live half is the *capability/menu*: `adapterDefaults()` (read by `lower-deployment.ts:139` to normalize the `persistence:` default) and `supports()`/`supportedShapes` (read by the validator).

**Recommendation (fold removal into this design):** the adapter emit-layer is a **half-built abstraction at the wrong granularity** — it models "one library emits its whole repository," when the audit shows the real sharing is *sub-fragment* and *crosses* libraries (TS-drizzle and Python-SQLAlchemy share `save`; they are different adapters). The `_persistence/` seams are the correct replacement. So:
- **Remove** the dead `emit*` methods from `PersistenceAdapter` + the per-backend adapter `emit*` bodies + `resolvePersistence()` + the resolve-side tests that only exercise the orphan. (This closes **M-T6.10** as "removed, not wired.")
- **Keep** the live capability half (`adapterDefaults`, `supports`, `supportedShapes`, `PlatformAdapters` menu) — the validator/lowering depend on it and D-ADAPTER-HOME/D-REALIZATION-AXES pin it.
- This is a **separate, non-byte-identical cleanup slice** (it deletes dead code + tests), sequenced *before* the extraction slices so the seam lands in a clean field. Flagged for explicit sign-off (2.7-Q1) since it deletes a pinned-adjacent surface.

## 2.6 Slicing plan (easiest-first, byte-identical, one fragment × one backend at a time)

Every slice follows the PRs #607–#627 / #843 protocol: **the generated corpus must be byte-identical before and after** (`git diff` the generated output over `examples/` + `web/src/examples/` × the relevant targets is empty), gated by the existing generator/fixture tests + a spot `LOOM_TS_BUILD`/`LOOM_*_BUILD` compile. No behavior change ever rides an extraction slice. Elixir last on any seam it's in-scope for, decline option open at each step.

*(Revised during implementation — §0.4 dropped the value-type warm-ups; seed is now the machinery-proving first slice.)*

| # | Slice | Backends | Status | Gate |
|---|---|---|---|---|
| **1** | `seed-datasets` spine (`groupByDataset` + `usedAggregates` + model) | TS/.NET/Python | ✅ **LANDED (#1876)** — establishes `_persistence/`, byte-identical green | byte-identical ✓ + 31 seed tests ✓ + layering ✓ |
| **2** | Remove orphaned `resolvePersistence()` **+ the four dead `emit*` methods** (§2.5/§2.7-Q1) | — | ✅ **DONE** — **fully closes M-T6.10**; interface + 6 adapter impls + dead helpers + 6 test files cleaned; 494 tests green; byte-identical (emitters stay live via the orchestrator) | `npm test` ✓ |
| — | ~~`QueryTarget`~~ | — | **DECLINED (§0.7)** — combinator-vs-operator tree topology diverges; detection already shared; net-negative | — |
| — | ~~`WireTarget`~~ | — | **DROPPED (§0.6)** — composition diverges (.NET flag-flatten vs recurse); thin shared skeleton | — |
| — | ~~events / ids / enum warm-ups~~ | — | **DROPPED (§0.4)** — one-line shared core, net-negative indirection | — |
| — | `ColumnTarget` / `JoinRowTarget` / `renderRepositoryWith` | — | **DEFER→likely-decline (§0.5+§0.7)** — same combinator-vs-operator composition divergence expected; revisit only under real feature traffic | — |
| — | routes | — | **Deferred** — coordinate with M-T5.10 (`RouteIR` landed-but-unread) | — |

**Committed set (final):** the seed spine (**landed, #1876**) + the adapter-emit dead-code removal (slice 2 above, closes M-T6.10). Every `Target`-style extraction candidate **declined at the byte level** (§0.4/§0.6/§0.7) — "regular-shaped" ≠ "byte-identical-extractable" once each ORM's composition API differs. This is the brief's stated success criterion (divergent fragments per-backend, reason recorded), not a shortfall.

## 0.6 Implementation finding #2 — `WireTarget` is thin too; `QueryTarget` is the *only* substantial seam left

*(Recorded while scoping slice 2, from reading the actual wire + query emitters.)*

Reading the three wire type-spelling mappers (`python/emit/http-models.ts:wireFieldType`, `dotnet/dto-mapping.ts:wireType`, `java/emit/wire.ts:wireJavaType`) shows the **composition diverges structurally**, not just in spelling:

- **.NET** flattens `array`/`optional` into `isCollection`/`isNullable` **flags** (via `wireTypeInfo`) and applies them as `IReadOnlyList<>`/`?` suffixes — a **non-recursive** traversal.
- **Python** recurses: `list[…]` for array, `… | None` for optional.
- **Java** recurses too but differently: `List<boxed element>` for array, and optional just **unwraps to the boxed inner** (no marker).

The only byte-parallel arms are `enum → t.name` and `entity → ${name}Response`; every other arm is per-language spelling *and* the array/optional composition is three different shapes. A uniform recursive `WireTarget` dispatcher cannot reproduce .NET's flag-flatten byte-identically, and Python/Java diverge from each other on both `array` and `optional`. So `WireTarget` is the **events/ids situation one level up**: a thin `switch(t.kind)` skeleton whose every arm is a leaf → net-negative indirection. **Dropped.**

**The consolidated conclusion.** After the already-shared substrate (`MigrationsIR`, `wireShape`, `sql-pg`, `ExprTarget`, **`intrinsicKey`/`intrinsicFor` in `util/intrinsics.js`**, and the **`isDenyFilter`/`isDeepScopeFilter` detection** — all already imported cross-backend) **plus the now-extracted seed spine**, the persistence-emit surface has far less *substantial* extractable-shared content than the raw file-counts implied. The value-shaped fragments (ids, events, enum, wire types/DTOs) are all thin-skeleton/divergent-leaf. **The one remaining seam with a genuinely substantial shared decision tree is `QueryTarget`** — the find-`where`/capability-filter predicate lowering (`lowerToDrizzle` ↔ `lowerToSqlAlchemy`, ~600/508 near-parallel lines: deny/deep/`&&`/`||`/COMPARE_OP/temporal/column-value-split/bare-boolean/`refColl.contains`). Its substrate is already shared; the work is the ~10-method dispatch seam + a per-backend leaf table (`sql\`…\`` for Drizzle, `func.*`/operator for SQLAlchemy, JPQL string for Java — the intrinsic tables stay legit per-backend leaves). This also means the **T10 unfreeze is largely already banked**: a 6th backend inherits the whole shared substrate + the seed pattern, and `QueryTarget` (once landed) covers its highest-traffic read surface.

Ordering rationale: the seed spine (landed) proved the `_persistence/` home + byte-identical gate cheaply. `QueryTarget` is the one structurally-interesting, high-value slice — done next, TS↔Python first (near-line-for-line), Java after (its JPQL string form is more divergent). This is a deliberate inversion of the brief's "CRUD first."

### 2.6.1 Restated acceptance benchmark (honest, per-backend)

The brief's epic acceptance ("re-run part-in-part → shared-tree edits + ≤1 leaf per backend + tests") is **correct for a *relational* storage feature** and **overstated for an *embedded* one**. Restated: after the seam, a comparable **relational** storage feature (a new stamped/filtered column, a new find, a new association) lands as **shared-tree edits + the ▣ substrate (free) + 1 leaf edit each on the in-scope backends (TS/Py, sometimes +.NET) + a bespoke edit on each decline-backend** — versus today's *N hand-written copies*. For an **embedded** feature (like #1835), the embedded-mapping declines stand, so the win is the shared substrate + the TS/Py pair only. The measurable epic target: **the in-scope-backend edit count for a relational feature drops from N to 1 leaf each; the decline-backend count is unchanged (and that's the recorded, deliberate ceiling).**

## 2.7 Open questions for sign-off

1. **Adapter-emit removal — DONE (fully).** ✅ **`resolvePersistence()` removed** (the precise M-T6.10 orphan — 0 production callers; the 6 test files that used it as an accessor were rewired to the live `adaptersFor(...).persistence[name]` menu). ✅ **The four heavy emit methods removed too** (`emitConnectionSetup`/`emitRepository`/`emitMigrations`/`emitOutbox` — 0 production callers) from the `PersistenceAdapter` interface + all 6 backend adapter impls, plus the now-dead private helpers each impl carried (`findRepoFor`/`contextOf`/`nsOf`/…) and the `contract-shape`/`stub-throws`/`dotnet-efcore`/`hono-drizzle` test assertions on them. **Correction to §2.5:** the emit-layer was **not** entirely dead — `PersistenceAdapter.emitProjectDeps` **has a live caller** (`hono/v4/emit.ts:808`), so it + the capability half (`name`/`supportedStrategies`/`supportedShapes`/`supports`) + the menu/defaults **stay**; each removed method's underlying emitter (`renderRepositoryImpl`, `emitDotnetMigrations`, `DRIZZLE_CONNECTION_SETUP`, …) is still consumed by the real orchestrator, so nothing on the emit path changed (494 adapter+platform+migration tests green, byte-identical output). The wrappers were scaffolding for the abandoned "route the orchestrator through the adapter registry" rewire (superseded by §0.7). **M-T6.10 fully closed.**
2. **Seam granularity.** Confirm the `_persistence/` **directory of per-fragment seams** over a single `PersistenceTarget` god-interface. (Recommend the directory — matches `_expr`/`_walker`/`_payload` precedent and lets decline-backends abstain per-fragment.)
3. **`QueryTarget` scope for .NET/Elixir.** They already lower queries through `ExprTarget`. Options: (a) leave them as-is, `QueryTarget` unifies only TS/Py/Java; (b) give them thin `QueryTarget` leaves that delegate to their `renderExpr`, so all 5 share one dispatcher. **Recommend (a)** for slice 6 (smaller, byte-safe), revisit (b) only if a later feature needs it — "consolidate the present."
4. **Java's 3× query multiplicity.** Accept that Java instantiates `QueryTarget` three times (JPQL/Criteria/SQLRestriction) over the shared dispatcher — a Java-only leaf concern, not a dispatcher concern? (Recommend: yes; it's framework-imposed, and the dispatcher stays single.)
5. **Repository slice value.** Given repository *writes* share only TS↔Python, is slice 9 worth its risk, or should the pair-level duplication be left alone and the seam stop at slice 8? (Recommend: do it — the pair duplication is large and high-traffic — but it's the one slice a reviewer might cut without losing the epic's value.)

## 2.8 Non-goals (unchanged from brief)

No new features during extraction; no forcing HEEx/Elixir/JPA topology into a shared core; no touching the design-pack (`.hbs`) axis; no output-tree changes. Every slice is byte-identical or (slice 0) pure dead-code deletion.

---

## Appendix — audit method

Phase 1 was produced by four parallel read-only deep-reads over the parallel emitter files (repository CRUD; finds/criteria/capability injection; entity/schema/associations/embedded; ids/VO/enum/events/wire/routes/seed/bootstrap), each classifying every cell with `file:line` evidence and applying the pre-registered decline criterion. Load-bearing claims (adapter-emit orphan status; .NET/Java filter-out-of-body; MigrationsIR/`sql-pg` cross-backend sharing; the #1835 36-file/4-backend/no-Elixir spread; TS query-path ≠ domain `ExprTarget`) were independently re-verified by direct grep before inclusion. Corrections folded in: the Elixir repository seam is `vanilla/repository-emit.ts` + `vanilla/context-emit.ts` (not `store-emit.ts`, which emits UI stores).
