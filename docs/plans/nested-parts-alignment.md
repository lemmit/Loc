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
| **node** (Drizzle) | child table per part, **hand-written assembly** | `parentId` → **root** (`order_id`) | repo loads children `where parentId = <rootId>`, builds the object graph in code (`shipmentByParent.get(root.id)`) |
| **python** (SQLAlchemy) | child table per part, **hand-written assembly** | `parent_id` → **root** | same — `where ShipmentRow.parent_id == aggregate.id` |
| **.NET** (EF Core) | EF **owned types** (`OwnsOne` / `OwnsMany`) | EF shadow FK → **root** today | EF auto-loads + materializes the owned graph; no hand-written assembly |
| **Java** (JPA / Hibernate) | JPA relations (`@OneToOne` / `@OneToMany`, `mappedBy = "_parent"`) | wants **direct parent** (`shipment_id`) | Hibernate navigates the relationship |
| **elixir** | relational nesting **gated** (DEBT-32); `shape(embedded)` → **jsonb** | n/a | the whole part subtree is one inline `jsonb` column — no FK, no assembly |

The conflict in one line: **the shared migration speaks "point-to-root"; Java's
ORM speaks "point-to-direct-parent"; and "point-to-root" silently loses the
hierarchy for any collection nested below the root.**

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

### Phases 2–4 — node, .NET, python (one PR each, independent)
For each backend, in any order:
- switch the **read assembly** to group children by their **direct-parent** id
  (node/python: the `where parentId = …` + `*ByParent` maps in the repository
  builders; .NET: nest the `OwnsOne`/`OwnsMany` config so the shadow FK is the
  direct parent);
- switch the **write path** to populate the direct-parent FK;
- gate: that backend's build gate **+ a real boot + two-level-nesting round-trip**
  (compile gates are blind to FK/constraint mismatches).

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
