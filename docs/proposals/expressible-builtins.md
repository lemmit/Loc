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
| `tenantOwned` — `tenantId` filter + stamp | (prelude body) | (e) | already fine |
| `tenantOwned` — `dataKey` materialized path | **capability name** | **(b)** | → materialized `derived` field |
| `tenantOwned` — `dataKey` prefix index | (infra) | (f) | stays, generic |
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
are impossible today:

```ddd
onWrite precondition new.balance >= 0                // race-free non-negative
onWrite precondition new.total   >= old.total        // monotonic / append-only
onWrite precondition old.status.canGoTo(new.status)  // legal state transition
```

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

### 2. Materialized / persisted `derived`

Loom's `derived` is compute-on-read only. Add a **persisted** variant — a
`derived` value that is *stored as a column and recomputed on write*.

This retires `tenantOwned`'s remaining name-magic: the `dataKey`
hierarchical path (`root.child.leaf`) is exactly a stored computed value.
`tenantOwned`'s `filter` and `stamp` halves are *already* prelude bodies
(class (e)); with a materialized `derived` the `dataKey` join the
in-language half:

```ddd
capability tenantOwned {
  tenantId: Organization id internal
  derived persisted dataKey: string = parent.dataKey + "." + id   // materialized path
  filter this.tenantId == currentUser.tenantId
  stamp onCreate { tenantId := currentUser.tenantId }
}
```

The prefix index for subtree (`deep`/`global`) scans stays infrastructure
(class (f)), but it's triggered by the *shape* (a materialized path
column that gets `LIKE 'prefix.%'` reads), not the capability's name. The
primitive is general — any denormalized/computed column wants it.

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
3. **Materialized `derived` (2)** — retires `tenantOwned`'s `dataKey`
   name-gate; general computed-column primitive.
4. **Reserved-name guard** — after 1–2, lock down the residual magic names.

## Open questions

1. **`onWrite precondition` non-pushable predicates** — ship the
   pessimistic `SELECT … FOR UPDATE` lowering, or restrict to pushable
   forever?
2. **Materialized `derived` recompute triggers** — recompute on any write,
   or only when a dependency field changes (dependency tracking)?
3. **Built-in error payloads** — are `ConcurrencyConflict` /
   `UniquenessConflict` / `Disallowed` / `ReferencedInUse` first-class
   `error` decls in a prelude, or a fixed internal set the `httpStatus`
   mapper is taught to accept?
4. **`old` in `stamp`** — the increment `version := old.version + 1` needs
   `old` inside a `stamp onUpdate`; confirm the pre-image scope extends to
   stamp bodies, not just `onWrite precondition`.
