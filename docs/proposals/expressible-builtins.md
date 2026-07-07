# Expressible built-ins — general primitives over framework magic

**Status:** PROPOSED
**Related:** [`capabilities.md`](../capabilities.md),
[`criterion.md`](../criterion.md), the exception-less error→status mapper
(`httpStatus`, `enrichments.ts:173-192`).

## The problem — two kinds of "the framework does it for you"

A Loom built-in like `versioned` or `tenantOwned` is implemented in **two
layers**: a capability body (fields + `filter` + `stamp` — ordinary,
in-language) *plus* framework behavior keyed on the capability's **name**
(`agg.capabilities.includes("versioned")`, `versioned-capability.ts:29`).
That second layer is invisible at the call site: two aggregates that both
say `implements versioned` look identical, but one carries hidden
compare-and-swap machinery because the framework recognizes the string.

An audit of every marker-keyed emitter seam (capability-name gates, field
flags, header flags, declaration-derived infra) shows the "magic" is not
one amorphous blob — it splits into two very different piles:

- **Name-keyed behavior** — the framework recognizes a *name* and injects
  behavior a user couldn't write. This is the real surprise, and most of
  it is expressible with a small number of general primitives.
- **Declarative-shape-triggered infrastructure** — a real DB object (a
  unique index, an append-only table, a JSONB column, an FK) that no
  expression can replace. This is fine — it's triggered by a *visible*
  declaration (`unique(...)`, `persistedAs(eventLog)`), not a hidden name.

**The goal is not to remove framework behavior. It is to remove
name-keyed magic** — so that every behavior is either (a) expressed in
ordinary language, or (b) triggered by a declarative shape the reader can
see. Nothing should hinge on the compiler recognizing a blessed string.

## What the audit found (classified)

Classification: **(a)** `onWrite precondition` + `old` · **(b)**
materialized `derived` · **(c)** error→status mapper (`httpStatus`) ·
**(d)** field-role (already right) · **(e)** `stamp`/`filter`
(already body-expressible) · **(f)** irreducible infrastructure.

| Built-in behavior | Keyed on | Class | Verdict |
|---|---|---|---|
| `versioned` — version column | field | (d)/field | already fine |
| `versioned` — guarded CAS write + increment | **capability name** | **(a)** | → `onWrite precondition version == old.version` |
| `versioned` — atomic zero-rows detection | (infra) | (f) | stays, generic |
| `versioned` / `unique` / `when` / FK / event-store — **409** | hardcoded | **(c)** | → route through `httpStatus` mapper |
| `tenantOwned` — `tenantId`/`dataKey` filter + stamp | (prelude body) | (e) | already fine — `dataKey` value is a `stamp onCreate` off ambient `currentUser.orgPath` |
| `tenantOwned` — `deep`/`global` scope reads | **capability name** | **(e)** | → `filter` + a **prefix-match operator** (`startsWith`) |
| `tenantOwned` — `dataKey` prefix index | (infra) | (f) | stays — shape-triggered (field in prefix-filters → btree index) |
| `auditable` — fields + createdBy/updatedBy | (prelude body) | (e) | **reference case — no magic** |
| `softDeletable` + `softDelete` — fields/filter + destroy rewrite | (prelude body + macro) | (e) | **reference case — no magic** |
| `access: token/secret/internal/managed/immutable` | field role | (d) | already the right abstraction |
| `provenanced` — lineage history table | field flag | (f) | stays (append-only history, not recomputable) |
| `sensitive(tags)` — redaction | field tag | (d) | already the right abstraction |
| `unique(...)` — DB unique index | declaration | (f) | stays, generic |
| `persistedAs(eventLog)` — event_store table | header flag | (f) | stays, generic |
| `shape(document/embedded)` — JSONB storage | header flag | (f) | stays, generic |
| `inheritanceUsing` / `isAbstract` — table topology | header flag | (f) | stays, generic |

Two built-ins — **`auditable`** (`prelude.ts:58-75`) and
**`softDeletable`+`softDelete`** (`prelude.ts:81-87` +
`softDelete.macro.ts:27-40`) — are **already fully body-expressible**:
pure `field`/`filter`/`stamp` + a macro emitting real statement bodies.
They are the proof the model works and the target every other built-in
should reach.

## The three primitives

### 1. Atomic write-guards — `onWrite precondition` + `old`

A capability body has `filter` (a *read* predicate) and `stamp` (field
*assignments*), but nothing that conditions the **write** on the persisted
state. Add:

- **`old`** — a reference to the persisted pre-image in a write-time
  predicate. (`this` is the being-written state — a mutable cursor that
  is already "new" by write time — so it cannot name the pre-image;
  `this.x >= this.x` is a tautology.)
- **`onWrite precondition <expr>`** — a guard evaluated against the stored
  row *at the write*, lowered **atomically** (predicate pushed into the
  `UPDATE … WHERE` clause, or a `SELECT … FOR UPDATE` fallback). A
  zero-row result ⇒ the guard's declared conflict error.

`versioned` becomes an ordinary capability — no name-gate:

```ddd
capability versioned {
  version: int token                              // client echoes last-seen value
  onWrite precondition version == old.version     // guard: expected == persisted
  stamp onUpdate { version := old.version + 1 }   // increment off the pre-image
}
```

The framework loses its `versioned` branch entirely; it keeps only a
**generic** rule — *"lower an `old`-referencing write-guard into an atomic
guarded write; zero rows ⇒ the declared error."* Versioning is then the
simplest instance. The same primitive unlocks user write-invariants that
are impossible today. **A guard is only an `onWrite precondition` when it
references `old`** — a predicate over `new`/`this` alone is a plain
`invariant` (checkable before the write, no pre-image needed) and should
stay one. The write-guards are the ones that compare against persisted
state:

```ddd
onWrite precondition amount <= old.balance           // can't overdraw the *persisted* balance
onWrite precondition new.total >= old.total          // monotonic / append-only
onWrite precondition old.status.canGoTo(new.status)  // legal state transition
```

(`new.balance >= 0` is NOT a write-guard — it's an ordinary invariant.)

**Atomicity is the contract.** The primitive MUST lower atomically —
never load-check-then-write, which silently reintroduces a TOCTOU race
while looking correct. Two generic lowerings:

- **pushable** (column comparison — versioning, `balance >= 0`) →
  optimistic `WHERE`-push, no lock;
- **non-pushable** (a method call SQL can't express) → pessimistic
  `SELECT … FOR UPDATE` + check.

A sane v1 restricts `onWrite precondition` to *pushable* predicates
(covers versioning + most numeric/equality invariants) and defers the
pessimistic path.

### 2. A prefix-match filter operator (NOT a materialized `derived`)

The audit first framed `tenantOwned`'s `dataKey` as needing a *materialized
`derived`* primitive (a computed column recomputed on write). Closer
tracing shows it does **not** — and neither does any other built-in, so
that primitive has **no current consumer** and drops off the critical path
(kept only as a speculative general computed-column feature).

`dataKey` decomposes entirely into things that already exist plus one
small operator:

- the **field** (`dataKey: string internal`) — a field-role;
- the **value** — a `stamp onCreate`, because `parent` is *immutable* and
  the caller's path is already the ambient `currentUser.orgPath` accessor
  (`tenant-stance.ts:126`), so no cross-aggregate read and no cascade;
- the **`deep`/`global` subtree reads** — ordinary `filter`s, *if* the
  filter language gains a **prefix-match operator** (`startsWith` /
  `LIKE 'prefix.%'`). Today this is the `__loomDeepScope__` sentinel; the
  current SQL is literally `R.dataKey = P.orgPath OR R.dataKey LIKE
  P.orgPath || '.%'` (`tenant-stance.ts:159-160`).

```ddd
capability tenantOwned {
  tenantId: Organization id internal
  dataKey:  string internal
  stamp onCreate { tenantId := currentUser.tenantId
                   dataKey  := currentUser.orgPath + "." + id }   // create-time, immutable
  filter this.tenantId == currentUser.tenantId                    // local
  // deep/global scope (a filter rewrite) once prefix-match exists:
  //   this.dataKey == currentUser.orgPath || this.dataKey startsWith currentUser.orgPath + "."
}
```

So the real new language surface for tenancy is **just the prefix-match
operator** — far smaller than a materialized-derived primitive. The only
framework residue is the **prefix btree index** for those subtree scans
(class (f)), and it becomes *shape-triggered* — a field used in
prefix-match filters gets a btree index, exactly like `unique(...)` → a
unique index — not keyed on the capability's name.

### 3. Unify structural conflicts through the error→status mapper

The audit's most broadly-valuable finding: the exception-less mapper
(`httpStatus <Error> <Code>` → `errorStatusOverrides`,
`enrichments.ts:173-192`) governs **only user-declared `error` payloads**.
Every *structural* 409 is **hardcoded at runtime** in each backend, and
only its *OpenAPI declaration* passes through the shared matrix
(`openapi-errors.ts:58`):

| Conflict | Runtime status | Via mapper? |
|---|---|---|
| `unique` 23505 violation | hardcoded 409 (`routes-builder.ts:772`) | **no** |
| `versioned` stale write | hardcoded 409 (`routes-builder.ts:791`) | **no** |
| `when`-gate `DisallowedError` | hardcoded 409 (`routes-builder.ts:745`) | **no** |
| FK-restrict destroy | hardcoded 409 (`routes-builder.ts:664`) | **no** |
| event-store append CAS | hardcoded 23505→409 | **no** |

Model each of these as a **built-in `error` payload** (`ConcurrencyConflict`,
`UniquenessConflict`, `Disallowed`, `ReferencedInUse`, …) with a stdlib
default status, routed through the *same* `errorStatusOverrides` path as
user errors. Result: **one status mechanism instead of six**, the
structural conflicts become **user-overridable** (`httpStatus
UniquenessConflict 422`), and the OpenAPI/runtime status can no longer
drift (today they're derived independently). No new surface — this reuses
a mechanism that already ships; it just extends its reach from user errors
to the built-in ones.

## Simulation — storage-shape lowering & atomicity

The one genuine risk in primitives 1 & 2 is that a write-guard lowers to a
*different* mechanism per storage shape, and one shape might not support it
atomically. Traced against the real write paths (`versioned == old.version`
plus an inequality guard), through all four shapes:

| Shape | Write path today | Guard lowering | Atomic? |
|---|---|---|---|
| **relational state** | `UPDATE … SET … WHERE id=?` (`repository-save-builder.ts`) | add `AND <guard>` to the WHERE; 0 rows ⇒ conflict | ✅ (this is how `versioned` works today) |
| **embedded** | root columns + parts JSONB; `UPDATE … WHERE id=?` | root/`version` fields → column WHERE; part fields → `data->>` WHERE | ✅ pushable |
| **document** | table `(id, data jsonb, **version**)`; `UPDATE … set(data,version) WHERE id=?` (`repository-document-builder.ts:103-110`) | `version` is a **top-level column** → `AND version=?` trivially; domain fields → `(data->>'f')` WHERE | ✅ pushable — the post-hydrate raciness is a **read-filter** concern, not writes |
| **event-sourced** | append at `version=max+1` vs `unique(stream_id,version)` (`repository-eventsourced-builder.ts:100-110`) | fold stream → check guard → append at V+1; a concurrent append takes V+1 first → 23505 ⇒ conflict | ✅ the **native ES optimistic-append CAS** — serializable write-guards for free |

**Verdict: no shape needs to be gated out.** Every shape already has an
atomic write mechanism (that's how `versioned` works on each today), so the
primitive *reproduces existing infra*, it doesn't invent atomicity. Three
lowerings, all real:

1. relational / embedded / document → **`WHERE`-push** on the UPDATE
   (top-level column directly; JSONB field via `data->>`),
2. event-sourced → the **stream-version append CAS** (fold → check →
   append; the intrinsic `unique(stream_id, version)` rejects concurrent
   writers, making the fold-then-append serializable).

### Refinements the simulation forced

- **`onWrite precondition` requires an `old` reference** (else it's a plain
  `invariant`) — corrected above.
- **Pushable vs. pessimistic.** Equality/inequality over columns or
  JSONB-extractable fields → `WHERE`-push (all non-ES shapes). A
  method-call predicate SQL can't express (`old.status.canGoTo(…)`) →
  `SELECT … FOR UPDATE` on relational/document/embedded, or is *naturally*
  atomic on event-sourced (fold → check → append). **v1 = pushable
  predicates only**; the pessimistic path is a later slice.
- **Zero-rows disambiguation.** On the `WHERE`-push shapes, 0 affected rows
  means *either* the guard failed *or* the row was deleted — the lowering
  must re-check existence to return `409 conflict` vs `404 not-found`.

### `dataKey` (primitive 2) — the simulation dissolves it entirely

Tracing `dataKey`: `parent` is **immutable** (set once at create) *and* the
caller's path is already the ambient `currentUser.orgPath` accessor. So
`dataKey` is neither a recompute-on-write value nor a cross-aggregate read
— it's a plain `stamp onCreate` writing an `internal` field (see §2 above).
The only genuinely-new surface it needs is the **prefix-match operator** for
the `deep`/`global` scope `filter`. The materialized-`derived`-with-cascade
primitive the audit first proposed has **no built-in consumer** and leaves
the critical path.

## What is already right — do not touch

- **Field roles** (`token`/`secret`/`internal`/`managed`/`immutable`,
  `sensitive(tags)`, `provenanced`) — the flag *is* the abstraction, and
  the wire/redaction behavior is derived from it centrally
  (`wire-projection.ts`). This is the field-level analogue of exactly the
  "trigger on declarative shape" principle. Keep.
- **`stamp` / `filter` capability bodies** — `auditable`, `softDeletable`,
  `tenantOwned`'s scoping half are literal prelude `field`/`stamp`/`filter`
  nodes. Already in-language.

## The irreducible residue (stays — but shape-triggered, not name-keyed)

These are real database objects / atomic guarantees no expression can
replace. The proposal does **not** try to. It only ensures each is
triggered by a *visible declaration*, never a recognized name:

1. `provenanced` → append-only `provenance_records` table + per-field
   JSONB column (a write *history* — not a recomputable derivation).
2. `unique(...)` → DB UNIQUE index (partial under `softDeletable`).
3. `versioned` → the *atomicity* of the zero-rows CAS detection.
4. `persistedAs(eventLog)` → `event_store(stream_id, version)` append-only
   table.
5. `shape(document/embedded)` → JSONB `data` column + `ON CONFLICT` upsert.
6. `inheritanceUsing` / `isAbstract` → table topology (TPH/TPC).
7. cross-aggregate `X id` → FK `ON DELETE RESTRICT`.
8. `tenantOwned` → `dataKey` prefix index for subtree scans.

The distinction that matters: after this proposal, **a reader predicts
every behavior from declarative shape on screen** — a `derived persisted`,
an `onWrite precondition`, a `unique(...)`, a `persistedAs(eventLog)`. No
behavior hinges on the compiler recognizing a blessed capability string.

## Reserved-name cleanup (falls out of the above)

Today `versioned` / `tenantOwned` / `tenantRegistry` are **magic capability
names** — a user-defined `capability versioned {}` would collide with or
shadow the built-in, and nothing in the surface signals these four names
are special. Once (1) and (2) land, `versioned` is an ordinary capability
using `onWrite precondition` (no name-gate at all) and `tenantOwned`'s
name-gate shrinks to the residual index trigger. The remaining reserved
names should get an explicit validator guard (or move fully to
shape-triggering) so no name silently carries framework meaning.

## Phasing (each ships independently)

1. **Unify conflict statuses (3)** — additive, no new surface, immediate
   consistency win; makes structural 409s overridable.
2. **`onWrite precondition` + `old` (1)** — pushable predicates only;
   retires the `versioned` name-gate and unlocks write-invariants.
3. **Prefix-match filter operator (2)** — `startsWith` / `LIKE 'prefix.%'`
   in the filter language. Turns `tenantOwned`'s `deep`/`global` scope into
   an ordinary `filter` (retiring the `__loomDeepScope__` sentinel) and
   reduces `dataKey` to a `stamp onCreate`. The materialized-`derived`
   primitive is dropped — no built-in needs it.
4. **Reserved-name guard** — after 1–3, lock down the residual magic names.

## Open questions

1. **`onWrite precondition` non-pushable predicates** — the simulation
   sequences these to a later slice (v1 is pushable-only). Ship the
   pessimistic `SELECT … FOR UPDATE` lowering then, or restrict forever?
2. **Built-in error payloads** — are `ConcurrencyConflict` /
   `UniquenessConflict` / `Disallowed` / `ReferencedInUse` first-class
   `error` decls in a prelude, or a fixed internal set the `httpStatus`
   mapper is taught to accept?
3. **`old` in `stamp`** — the increment `version := old.version + 1` needs
   `old` inside a `stamp onUpdate`; confirm the pre-image scope extends to
   stamp bodies, not just `onWrite precondition`. (The simulation confirms
   it's *needed*; the question is the scope-plumbing.)

**Resolved by the simulation:** no storage shape needs gating out (all four
have an atomic write mechanism today); write-guards require an `old`
reference (else they're plain invariants); materialized `derived` splits
into a cheap create-time form (covers tenancy) and a deferred cascade form.
