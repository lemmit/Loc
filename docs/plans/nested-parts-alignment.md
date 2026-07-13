# Nested parts — storage alignment (the real DEBT-15)

> **Status:** PLAN (not started). Supersedes the backlog framing of DEBT-15
> ("Java single part-containment, M, mirror the collection path") — the
> investigation showed that framing is wrong: the path it says to mirror is
> itself silently broken, and the fix is a cross-backend storage alignment, not
> a Java-only emitter tweak.

## The shape we're talking about

A part can contain another part — an arbitrarily deep tree inside one aggregate:

```ddd
aggregate Order {
  code: string
  contains shipment: Shipment            // single
  entity Shipment {
    carrier: string
    contains labels: Label[]             // collection — a part inside a part
  }
  entity Label { zpl: string }
}
```

```
Order ── Shipment ── Label[]
```

The **wire shape** already nests correctly on every backend (the DTO is built
from the in-memory object graph). The problem is purely **storage**: which
column links a child row back to its owner.

## The bug

To record "which `Label` belongs to which `Shipment`", the `labels` table needs
a foreign key pointing *up*. There are two conventions in the tree:

- **point to the root** — `labels.order_id`. What the shared migration emits
  today (`src/system/migrations-builder.ts` `tableForPart`: every part FKs to
  `tableOwnerName(agg)` = the root).
- **point to your direct parent** — `labels.shipment_id`. What a normalized
  relational hierarchy wants, and what Java's JPA mapping already expects.

`order_id` is **lossy**: it records "this label is somewhere in this order" but
not *which shipment* owns it. It only works because a **single** containment is
1-to-1 (one shipment ⇒ no ambiguity). The moment an intermediate level is a
**collection** — an order with two shipments, each with labels — `labels.order_id`
**cannot** say which shipment a label belongs to. The hierarchy is lost.

This is already live, two ways:

- **Java single** part→part containment is **gated** (`loom.java-single-containment-unsupported`,
  `src/ir/validate/checks/system-checks.ts`).
- **Java collection** part→part containment is **not** gated but is **boot-broken**:
  the JPA mapping references `shipment_id` (`@OneToMany @JoinColumn(name = "shipment_id")`)
  while the migration only emits `order_id` — compiles under `gradle bootJar`,
  fails when the app starts / the relationship is used.

## How each platform reconstructs the tree TODAY

| Platform | Mechanism | Link column | How nesting is reassembled |
|---|---|---|---|
| **node** (Drizzle) | child table per part, **hand-written assembly** | `parentId` → **root** (`order_id`) | only the ROOT's direct `contains` are loaded, keyed off `root.id`; **nested parts are never loaded** |
| **python** (SQLAlchemy) | child table per part, **hand-written assembly** | `parent_id` → **root** | same — only `where ShipmentRow.parent_id == aggregate.id`, one level deep |
| **.NET** (EF Core) | EF **owned types** (`OwnsOne` / `OwnsMany`) | EF shadow FK → **root** today | EF auto-loads + materializes the owned graph; no hand-written assembly |
| **Java** (JPA / Hibernate) | JPA relations (`@OneToOne` / `@OneToMany`, `mappedBy = "_parent"`) | **direct parent** (`shipment_id`) ✅ Phase 1 | Hibernate navigates the relationship |
| **elixir** | relational nesting **gated** (DEBT-32); `shape(embedded)` → **jsonb** | n/a | the whole part subtree is one inline `jsonb` column — no FK, no assembly |

The conflict in one line: **the shared migration now speaks "point-to-direct-
parent" (Phase 1) and Java's ORM agrees; but node/python/.NET still emit their OWN
ORM schema pointing "to-root", and never reassemble the nested level at all.**

### ⚠️ What Phase-2 scoping actually found (the framing above was too optimistic)

The original plan assumed node/python merely need their existing child-assembly
**re-keyed** from root-id to direct-parent-id. Generating the
`Order → Shipment → {Label, Sticker[]}` fixture on each backend showed the gap is
much larger — part-in-part containment is **substantially unimplemented**, not
just mis-keyed:

- **node** — `save()` persists **only the root row**. A *single* containment is
  dropped entirely on write (`saveTxBody`: `if (!c.collection) return []`), so even
  one-level single containment never reaches the DB. `findById` *reads* a
  root-level containment but never recurses, so nested parts are never loaded —
  `Shipment._create({…})` is emitted without `label`/`stickers` while `toWire`
  dereferences `root.shipment!.label!`. It wouldn't typecheck if any example
  exercised it.
- **python** — better than node (it diff-syncs + loads a *single* root-level
  containment), but `_hydrate_shipment` **hard-codes** `label=None, stickers=[]`;
  the generated `_hydrate_label` / `_hydrate_sticker` helpers are **dead code**,
  nested parts are never saved, and `parent_id` is mis-branded to the **root** id
  type for nested rows (`OrderId`, should be `ShipmentId`).
- **both** — their hand-rolled ORM schema still FKs nested parts to `order_id`,
  while the shared `MigrationsIR` SQL (Phase 1) now emits `shipment_id`. The two
  **disagree**, but only for the part-in-part shape, which **zero examples use**,
  so no real generated project is broken today.

So "full alignment" on node/python is really **"build single + nested part-
containment persistence from near-scratch"** per backend — domain `_create`
threading, own-schema FK to direct parent, recursive read assembly, save diff-sync
of the nested level, and a boot round-trip — a large feature for a shape nothing
generates.

**Decision (2026-06-28):** the merged Java Phase 1 (#1596) — which removed the real
validator gate (`loom.java-single-containment-unsupported`) and fixed the real
boot-break — is the DEBT-15 **deliverable**. Phases 2–5 below stay **deferred
follow-up**, re-scoped from "re-key the assembly" to "implement part-containment
persistence on node/python/.NET". Tracked, not abandoned; pick them up only when an
actual `.ddd` needs part-in-part nesting on a non-Java backend.

## Target design

One uniform rule for every part on every relational backend:

> **A part is a child table with a foreign key to its _direct parent_.
> A _single_ containment adds a `UNIQUE` constraint on that FK.**

```sql
-- collection: Shipment has many Labels
CREATE TABLE labels (
  id          UUID PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments,
  zpl         TEXT
);

-- single: Shipment has at most one Label — identical, plus UNIQUE
CREATE TABLE labels (
  id          UUID PRIMARY KEY,
  shipment_id UUID NOT NULL UNIQUE REFERENCES shipments,   -- UNIQUE = "at most one"
  zpl         TEXT
);
```

Single vs. collection is **one constraint**, not two different mechanisms. We
explicitly do **not** flatten a single containment's columns into the parent row
(EF `OwnsOne` style): that splits single and collection into incompatible
storage models and can't tell "absent" from "all-null".

Consequences:

- **Java falls in for free** — its mapping already wants `shipment_id`; deleting
  the gate is most of the Java work.
- **node / python** switch their hand-written assembly to group children by their
  **direct-parent** id instead of the root id.
- **.NET** nests its owned-type config so EF's shadow FK targets the direct
  parent (and matches the DDL).
- The **silent collection-nesting bug is fixed on every backend**, not just Java —
  a two-level collection nest now stores and reads back correctly.
- **No grammar / IR / wire change.** Nesting already parses, lowers, and serialises
  correctly; this is storage + read-assembly only. Conformance/parity (which diffs
  the wire) should stay byte-identical.

## Sequencing — additive first, one backend per PR, green on `main` throughout

The migration emits **one shared schema** every backend consumes, so the FK
can't be flipped per-backend in isolation. The schema change goes in
**additively** first, then each backend migrates, then the redundant column is
dropped.

### Phase 0 — foundation (small PR, no behaviour change)
- Add `directParentOf(agg, partName)` in `src/ir/util/` → the declaring entity
  (root or sibling part) + single-vs-collection, resolved from the containment
  graph (`agg.contains` + each `part.contains`; `agg.parts` is a flat list).
- Pure + unit-tested. Confirm **elixir is unaffected** (relational nesting gated;
  embedded is jsonb) so the shared-migration change below never reaches it.

### Phase 1 — Java + direct-parent migration ✅ DONE
> Landed: nested parts (single **and** collection) FK to their direct parent on
> java; gate removed; boot-verified on Postgres (Flyway migrate → SQL-insert a
> two-level graph → GET nests correctly). Because **no existing `.ddd` uses
> part-in-part nesting**, the shared `tableForPart` change is inert for all
> current output (root-level parts resolve to the root, byte-identical) — so the
> additive-nullable dance below was unnecessary; the change went in directly.
> `single → UNIQUE` was deferred to a follow-up (it's a constraint refinement,
> not the structural fix). Original plan text kept below for the record.

- `src/system/migrations-builder.ts` `tableForPart`: also emit the **direct-parent
  FK** (`labels.shipment_id`) **in addition to** the existing root FK, with a
  `UNIQUE` when the containment is single. Additive ⇒ node/python/.NET ignore the
  new column and keep working.
- `src/generator/java/{index.ts, emit/entity.ts, render-expr.ts}`: point Java's
  `_parent` / `parentId` / `@JoinColumn` + the `_create` factory + the `new <Part>`
  arm at the **direct parent** (most of this already wants `shipment_id`).
- **Delete** the gate (`system-checks.ts`); flip the xfail in
  `test/generator/java/generator-java-single-containment.test.ts`.
- **Verify by BOOT, not compile** (the whole design hinges on this): generate
  `Order → Shipment[] → Label[]` (the genuinely-ambiguous two-level *collection*
  nest), `gradle bootJar` + a real Postgres — Flyway migrate, create a nested
  graph, read it back, assert the right labels land under the right shipment.

### Phase 2 — python ✅ DONE
> Landed: part-in-part containment persistence on the python backend. A nested
> part FKs to (and brands its `parent_id` from) its DIRECT parent
> (`labels.shipment_id`, `Label.parent_id: ShipmentId`), matching the shared
> migration DDL; `save` recurses to diff-sync each nested level keyed by its
> direct-parent id; `_hydrate_<part>` is `async` when the part has children and
> loads them (calling the previously-dead `_hydrate_<nested>` helpers). Parts are
> emitted **children-first** (`partsChildrenFirst`, `ir/util/containment-parent.ts`)
> so a `<Part>` / `<Part>Response` never forward-references a not-yet-defined
> sibling; `new <Part>`'s `_create` factory defaults a part's own containments
> (safe `None`-coercion, never a shared-mutable `[]`). Single-level output is
> byte-identical. **Boot-verified on real Postgres** (create order + shipment via
> API → SQL-insert a label under the shipment → GET nests it under the right
> shipment → addShipment re-save preserves the nested label). `ruff` +
> `mypy --strict` clean; fixture `test/e2e/fixtures/python-build/nested-parts.ddd`.
> Construction-bearing nested ops (`new Label` inside an inline `new Shipment`)
> stay a follow-up — the nested-`new` arm doesn't thread the parent-part instance
> yet (the risk noted below).

### Phase 3 — node ✅ DONE
> Landed: part-in-part containment persistence on the node/Hono backend. The
> Drizzle schema FKs a nested part to (and `references()`) its DIRECT parent
> (`labels.shipment_id → shipments`); the domain `parentId` brands to the
> direct-parent id type; `save` recurses (single containments now persist too —
> they were dropped entirely before — and each nested level diff-syncs keyed by
> its direct-parent id); the read paths (`findById`, `findManyByIds`, custom
> finds) recursively bulk-load the nested level into per-direct-parent maps and
> assemble it into the graph. Wire response DTOs (`z.object`) + the frontend api
> module emit parts children-first so `z.array(LabelResponse)` never
> forward-references; `_create` defaults a part's own containments. Single-level
> output is byte-identical (680 node generator/platform tests green). **Boot-
> verified on real Postgres** (same create → SQL-insert label → GET-nests →
> re-save-preserves round-trip as python). `tsc --noEmit` + `tsup` clean; fixture
> `test/e2e/fixtures/ts-build/nested-parts.ddd`.

### Phase 4 — .NET ✅ DONE
> Landed: part-in-part containment persistence on the .NET/EF Core backend. The
> owned-type config now NESTS — a part's own containments emit as a nested
> `OwnsMany`/`OwnsOne` inside its parent's owned-nav builder (`o.OwnsMany<Label>(
> "_labels", o1 => …)`), with the shadow `ParentId` column named for the DIRECT
> parent (`o1.Property("ParentId").HasColumnName("shipment_id")`) — matching the
> migration DDL. The domain `ParentId` brands to the direct-parent id type
> (`Label.ParentId: ShipmentId`) via a new `parentName` param on `renderEntity`
> (distinct from `rootName`, which still names the shared aggregate namespace).
> **No repository changes** — EF materialises + persists the owned graph itself.
> Single-level output byte-identical (418 .NET generator tests green).
> `dotnet build /warnaserror` clean and **boot-verified on real Postgres** (same
> create → SQL-insert label → GET-nests → re-save-preserves round-trip as
> python/node). Fixture `test/e2e/fixtures/dotnet-build/nested-parts.ddd`.

**All four relational backends now persist + read part-in-part nesting** (java
Phase 1, python Phase 2, node Phase 3, .NET Phase 4). DEBT-15 is fully drained.

### Construction follow-up — ✅ DONE (tree-position parentId)
Inline nested construction — a `new <Part> { … }` that supplies the part's OWN
containment (`Shipment { carrier: c, labels: [Label { … }] }`) — now works on all
four relational backends. The original problem: a nested child's parent id is
minted inside the enclosing part's `_create`, so it isn't available at the child
construction site; the old code stamped the ambient `this` (the aggregate root),
mis-typing the child's `parentId` (`OrderId` where a `ShipmentId` is required).

The fix reframes **parentId as a tree-derived value, not a construction input**:
- **Lowering** flags a `new` whose part is nested (contained by a sibling) —
  `NewExpr.nested` (`lower-expr.ts`, matching `directParentOf(...).nested`).
- **`renderNew`** omits the construction-time parentId for a nested part on every
  backend (node/python/.NET/java); a root-level part still passes the ambient
  parent (byte-identical).
- **Domain** — a nested part's parentId is optional at construction and defaulted
  (node/python mint a placeholder in the ctor; .NET State slot is `= default!`;
  java's FK column is already `insertable=false`). node/python/.NET/java `_create`
  factories also gained the containment-children slots so the parent can carry
  them (`Shipment._create(…, labels)`).
- **Save** stamps the child FK from **tree position** — the enclosing parent's id
  in the recursive save loop (node/python), or the ORM relationship (EF owned-type
  graph position / JPA `@OneToMany @JoinColumn`) on .NET/java — never the child's
  construction-time parentId.
- **Hydrate** sets parentId from the DB row (correct, from the FK column).

parentId is not on a part's wire shape, so a freshly-constructed (unsaved) part's
placeholder parentId is never observed. **Boot-verified** on node/python/.NET
(create-with-nested-child via one API call → the inline label lands under the
right shipment); java build-verified (same JPA-cascade mechanism as its
boot-verified storage). The `loom.nested-part-construction-unsupported` gate that
briefly guarded this is removed. Fixtures exercise it via an `addFull` op
(`{python,ts,dotnet}-build/nested-parts.ddd`) + a single-containment `setup`
(`java-build/nested-parts.ddd`).

For each backend, in any order:
- **node** — make `saveTxBody` persist single containments (not just collections),
  recurse into each part's own `contains`, and load the nested level into per-
  direct-parent maps the hydrate consumes; brand nested `parentId` to the direct
  parent's id type;
- **python** — call the already-emitted `_hydrate_label`/`_hydrate_sticker` from
  `_hydrate_shipment` (load by `parent_id == shipment.id`), save the nested level,
  fix the `OrderId`→`ShipmentId` mis-brand;
- **.NET** — nest the `OwnsOne`/`OwnsMany` config so the shadow FK is the direct
  parent;
- all: switch the **own ORM schema** FK + **write path** to the direct parent
  (via `directParentOf`), so it matches the Phase-1 `MigrationsIR` SQL;
- gate: that backend's build gate **+ a real boot + two-level-nesting round-trip**
  (compile gates are blind to FK/constraint mismatches *and* to the never-loaded
  nested level).

### Phase 5 — cleanup (small PR)
- Drop the now-redundant root FK from non-root part tables (a root-level part's
  direct parent *is* the root, so it keeps `order_id`); make `directParentOf` the
  single source of truth.
- Conformance/parity diff confirms the wire shape never moved.

## Verification strategy (why compile gates aren't enough)

Every wrong answer here — a mismatched FK column, a missing `UNIQUE`, a child
grouped under the wrong parent — **compiles clean** and only fails at migrate- or
query-time. So each phase's gate is a **real boot + deep-nesting round-trip**
(`generated-stack-verifier` locally; the `k8s-e2e` / per-backend obs-e2e tier in
CI), using a **two-level collection nest** (`Order → Shipment[] → Label[]`) as
the canonical fixture — the shape the old root-FK model silently mishandles.

## Risks / unknowns

- **.NET owned-type nesting.** EF `OwnsOne`/`OwnsMany` manage the FK themselves;
  confirm the nested owned config and the emitted DDL agree on the direct-parent
  column (today both point at root; the change must move both together).
- **Existing data / migration ordering.** New project generation only — Loom emits
  greenfield migrations, so there's no in-place data migration to worry about, but
  the additive→drop sequence keeps any already-generated project buildable across
  phases.
- **TPH concretes.** A contained part of a TPH concrete already FKs to the shared
  base table (`tableOwnerName`); `directParentOf` must compose with that (a part's
  direct parent that is itself a TPH concrete resolves to the base table).
- **Single-containment construction path.** `new <Part>` for a deeply-nested part
  needs the *parent instance* in scope; confirm the `_create` factory + the
  `render-expr` `new` arm thread the direct parent (not the root) before un-gating
  construction-bearing ops.

## Effort

~6 PRs, each green on `main`. M–L total. The payoff: the storage model becomes
*correct* (deep collection nesting stops silently losing the hierarchy on all four
relational backends) and the Java single/collection part-containment gaps close as
a side effect.
