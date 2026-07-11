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

Classification: **(a)** default-on aggregate infrastructure (no surface) ·
**(b)** prefix-match filter operator · **(c)** error→status mapper
(`httpStatus`) · **(d)** field-role (already right) · **(e)** `stamp`/`filter`
(already body-expressible) · **(f)** irreducible infrastructure.

| Built-in behavior | Keyed on | Class | Verdict |
|---|---|---|---|
| `versioned` — the whole feature (version column + guarded CAS + increment + 409) | **capability name** | **(a)** | → **make it default for every aggregate** (like `id`); delete the `versioned` capability entirely. See §1. |
| `unique` / `when` / FK / event-store — **409** | hardcoded | **(c)** | → route through `httpStatus` mapper |
| `tenantOwned` — `tenantId`/`dataKey` filter + stamp | (prelude body) | (e) | already fine — regular `dataKey` is a `stamp onCreate` off `currentUser.orgPath`; registry/cross-scope `dataKey` (`parent.dataKey + "." + id`) is a hand-written create factory (`prelude.ts:150-156`) |
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

## The moves

### 1. Versioning is default-on infrastructure — no surface at all

The cleanest de-magic: don't express `versioned`, **remove the opt-in.**
Optimistic concurrency is an aggregate-level system property that is cheap
and safe — so make **every aggregate versioned by default**, exactly the way
every aggregate has a system `id`. There is then no capability name to key
off, no field to declare, no guard to write — it is simply how a Loom
aggregate persists.

```ddd
aggregate Order { total: money }   // already optimistically-versioned — nothing to add
```

Why this is the right endpoint (not a header modifier, not a field role, not
a capability):

- **Safe by default** — you cannot *forget* to version and ship a
  lost-update bug; correctness is the default, not a missable opt-in.
- **Symmetric with `id`** — every aggregate gets a system `id` (identity) and
  a system version (consistency); both generated, both invisible in the
  domain surface.
- **Free on every target** — a version column + guarded `UPDATE` is native
  everywhere (`@Version` / `optimistic_lock` / `IsConcurrencyToken` /
  `version_id_col`). Cost is one int column + one `WHERE` clause.
- **Event-sourced aggregates are already versioned** (stream `(stream_id,
  version)`), so it is consistent, not a special case.
- **"Multiple versioned fields" cannot happen** — it is an aggregate
  property that mints exactly one system version, like `id`, not a field a
  user can duplicate.

The version lives at the **HTTP layer as an `ETag` / `If-Match`** — *not* a
body field, so it never touches the DTO wire shape. Read returns an ETag;
an update sends `If-Match`.

**Two things to pin:**

1. **Wire strictness.** *Graceful* (default) — no `If-Match` ⇒ fall back to a
   write-time CAS on the loaded version (still no lost update; what the code
   does today); naive clients keep working. *Strict* (opt-in per api) —
   updates **require** `If-Match`, else `428 Precondition Required`, forcing
   clients to acknowledge concurrency.
2. **The rare opt-out.** Deliberate last-write-wins / high-contention
   aggregates use a single `unversioned` header modifier — the exception,
   mirroring how `crossTenant` is the exception to tenant-scoping. Most
   aggregates never write it.

**Result:** the `versioned` capability is **deleted** from the prelude; the
whole write-guard / `old` / concurrency-token thread is struck. Versioning
joins the "always-on infrastructure" bucket next to `id` generation. The
only surface in this area is the `unversioned` opt-out and the strict/graceful
api toggle.

### 2. A prefix-match filter operator (NOT a materialized `derived`)

The audit first framed `tenantOwned`'s `dataKey` as needing a *materialized
`derived`* primitive (a computed column recomputed on write). Closer
tracing shows it does **not** — and neither does any other built-in, so
that primitive has **no current consumer** and drops off the critical path
(kept only as a speculative general computed-column feature).

`dataKey` has **two distinct computations** (both already in-language —
neither is framework name-magic, neither needs a materialized-`derived`):

1. **Regular tenant-owned aggregate** — the record sits *at* its owner-org's
   node, so `dataKey == the caller's org path`. A pure claim-copy **stamp**
   off the ambient `currentUser.orgPath` accessor (`prelude.ts:126`,
   `tenant-stance.ts:126`) — no cross-row read, no `"." + id`:
   ```ddd
   stamp onCreate { tenantId := currentUser.tenantId
                    dataKey  := currentUser.orgPath }
   ```
2. **The registry tree** (`tenantRegistry`) / any **cross-scope write
   anchored to a non-caller org** — `dataKey = <parent org's dataKey>
   + "." + id`, i.e. based on *another* org's path. This genuinely needs a
   **repo read of the parent row**, so a capability (a pure mixin) *cannot*
   express it — the author writes a **create factory** that reads the
   parent and concatenates (`prelude.ts:150-156`; the `signUp` `repo-let`
   mechanism already exists). The capability only carries the fields.

So `currentUser.orgPath` covers the common case but is **not universal** —
hierarchy-building and cross-tenant-scoped writes derive the path from the
*target* org's `dataKey`, via a hand-written factory. That's the honest
escape hatch, and it's already how the code works.

**Cross-scope creates — two framings, the second is preferred.**

*Framing A (workflow + explicit stamp).* Because a cross-scope create
*reads another aggregate* (the target org) to compute the path, it is
orchestration — a **workflow**, by Loom's single-aggregate-vs-workflow
layering — that explicitly stamps `dataKey`/`tenantId` to the target,
overriding the capability's self-scope default. Works, but needs the
override rule (open question 4) and a repo-let per create.

*Framing B (ambient `organizationContext`) — PREFERRED.* Split
`currentUser.orgPath`'s conflation of *principal* and *operating tenant
scope* into `currentUser` (principal) + `organizationContext` (operating
scope). Then every dataKey is the *same* unconditional stamp
(`dataKey := organizationContext.orgPath`, `+ "." + id` for sub-orgs),
the context varying rather than the stamp — which **eliminates the
repo-let**, **removes the cross-scope workflow** for path purposes, and
**dissolves open question 4** (no override; switching context is how you go
cross-scope). Its cost moves to an authorization-gated,
once-per-request context establishment. Full design (semantics, the
security gate, the two-flat-accessors-vs-unified-`context` shape decision,
open questions) is its own proposal:
[`organization-context.md`](./organization-context.md).

Either way, the framework never needs to know about cross-scope writes —
they are ordinary in-language stamps + an ambient context frame. No new
magic.

The remaining `deep`/`global` **subtree reads** are ordinary `filter`s
*if* the filter language gains a **prefix-match operator** (`startsWith` /
`LIKE 'prefix.%'`). Today this is the `__loomDeepScope__` sentinel; the
current SQL is literally `R.dataKey = P.orgPath OR R.dataKey LIKE
P.orgPath || '.%'` (`tenant-stance.ts:159-160`).

So the only genuinely-new language surface for tenancy is the
**prefix-match operator** — far smaller than a materialized-`derived`
primitive (which no built-in needs). The lone framework residue is the
**prefix btree index** for the subtree scans (class (f)), now
*shape-triggered* — a field used in prefix-match filters gets a btree
index, exactly like `unique(...)` → a unique index — not keyed on the
capability's name.

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

## Simulation — default versioning is atomic on every storage shape

Making versioning default-on is only safe if the per-aggregate version CAS
lowers atomically on **all four** storage shapes. It does — because
`versioned` already works on each today; default-on just makes it universal.
Traced against the real write paths:

| Shape | Write path today | Version CAS | Atomic? |
|---|---|---|---|
| **relational state** | `UPDATE … SET … WHERE id=?` (`repository-save-builder.ts`) | `AND version=$expected`, `version=version+1`; 0 rows ⇒ conflict | ✅ (how `versioned` works today) |
| **embedded** | root columns + parts JSONB; `UPDATE … WHERE id=?` | `version` is a root column → `AND version=?` | ✅ |
| **document** | table `(id, data jsonb, **version**)` (`repository-document-builder.ts:103-110`) | `version` is a **top-level column** → `AND version=?` | ✅ (post-hydrate raciness is a read-filter concern, not writes) |
| **event-sourced** | append at `version=max+1` vs `unique(stream_id,version)` (`repository-eventsourced-builder.ts:100-110`) | intrinsic stream version — a concurrent append hits 23505 ⇒ conflict | ✅ native ES append CAS |

**Verdict: no shape needs gating.** Every shape already has an atomic
version mechanism, and the version is a **top-level column** (or the ES
stream version) on all of them — never JSONB-nested — so default-on
versioning is a trivial, uniform `WHERE version=?` (or the ES append) with
no new lowering to invent. The 409 on a zero-row CAS routes through the
error→status mapper (move 3), which must also re-check existence to
distinguish `409 conflict` from `404 not-found`.

### `dataKey` (move 2) — no materialized-`derived` needed

Tracing `dataKey` (see §2 above for the detail): the **regular**
tenant-owned case is a plain claim-copy `stamp onCreate` off the ambient
`currentUser.orgPath`; the **registry / cross-scope** case (`dataKey =
parent.dataKey + "." + id`, based on *another* org's path) needs a repo
read of the parent and so is a **hand-written create factory** — already
in-language today (`prelude.ts:150-156`), not framework magic. `parent` is
immutable, so neither case recomputes on write. So no
materialized-`derived`-with-cascade primitive is needed (it has **no
built-in consumer**), and the only genuinely-new surface is the
**prefix-match operator** for the `deep`/`global` scope `filter`.

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
3. **default versioning** → the per-aggregate version column + the *atomic*
   zero-rows CAS (now universal, like `id` — no longer name-gated).
4. `persistedAs(eventLog)` → `event_store(stream_id, version)` append-only
   table.
5. `shape(document/embedded)` → JSONB `data` column + `ON CONFLICT` upsert.
6. `inheritanceUsing` / `isAbstract` → table topology (TPH/TPC).
7. cross-aggregate `X id` → FK `ON DELETE RESTRICT`.
8. `tenantOwned` → `dataKey` prefix index for subtree scans.

The distinction that matters: after this proposal, **a reader predicts
every behavior from declarative shape on screen** — a `unique(...)`, a
`persistedAs(eventLog)`, a `crossTenant` — or from a *universal* default
they never have to think about (versioning, like `id`). No behavior hinges
on the compiler recognizing a blessed capability string.

## Cross-proposal seams

**The `deep`/`global` read anchor** — this proposal and
[`organization-context.md`](./organization-context.md) must **jointly**
decide one security-relevant question: does the `deep`/`global` subtree-read
filter anchor on the **principal** (`currentUser`'s reachability, as today —
`tenant-stance.ts:160-190`) or on the **operating context**
(`organizationContext`)? Operating-context-anchored `deep` could let a
switched context reach a subtree the principal cannot, so the two proposals
cannot specify this independently. Recommended default: **anchor reads on
the principal**, and treat a context switch as an *explicit,
separately-authorized widening* — see `organization-context` open question 4.

**⚠️ Conflicts with `authorization.md`'s `DataKey` type.** `authorization.md`
(§2/§10) proposes `dataKey` as a **first-class built-in type** with six magic
member ops (`isAncestorOf` / `isDescendantOf` / `sameParent` / `isRoot` /
`rootTenant` / `depth`) and a special off-`wireShape` ambient column. This
proposal argues the same capability reduces to an **ordinary `string` field +
one `startsWith` / `LIKE 'prefix.%'` filter operator** — far less surface,
and it matches the `__loomDeepScope__` SQL already in `tenant-stance.ts`.
**These cannot both land.** Recommendation: pin the reduction here and drop
the `DataKey`-type + 6-op surface from `authorization.md`. (Owner decision —
this proposal cannot edit `authorization.md`; flagged for reconciliation.)

## Reserved-name cleanup (falls out of the above)

Today `versioned` / `tenantOwned` / `tenantRegistry` are **magic capability
names** — a user-defined `capability versioned {}` would collide with or
shadow the built-in, and nothing in the surface signals these names are
special. After the moves above, **`versioned` is deleted entirely** (it's a
universal default, not a capability), and `tenantOwned`'s name-gate shrinks
to the residual index trigger. Any remaining reserved names should get an
explicit validator guard (or move fully to shape-triggering) so no name
silently carries framework meaning.

## Phasing (each ships independently)

1. **Unify conflict statuses (3)** — additive, no new surface, immediate
   consistency win; makes the structural 409s overridable and closes the
   OpenAPI/runtime drift.
2. **Versioning default-on (1)** — every aggregate versioned by default
   (ETag/If-Match, graceful mode), the `versioned` capability deleted, an
   `unversioned` opt-out added. The version CAS already ships on every
   shape, so this is mostly *removing* the opt-in and generalizing it.
3. **Prefix-match filter operator (2)** — `startsWith` / `LIKE 'prefix.%'`
   in the filter language. Turns `tenantOwned`'s `deep`/`global` scope into
   an ordinary `filter` (retiring the `__loomDeepScope__` sentinel) and
   reduces `dataKey` to a `stamp onCreate`. The materialized-`derived`
   primitive is dropped — no built-in needs it.
4. **Reserved-name guard** — after 1–3, lock down the residual magic names.

## Open questions

1. **Versioning wire strictness** — is *graceful* (no `If-Match` ⇒ write-time
   CAS fallback) the fixed default with *strict* (require `If-Match`, else
   `428`) an opt-in per api, or should some contexts default to strict?
2. **`unversioned` opt-out** — a header modifier (mirroring `crossTenant`),
   and does it apply to ES aggregates (which are intrinsically versioned via
   the stream) as a no-op, or is it a validation error there?
3. **Built-in error payloads** — are `ConcurrencyConflict` /
   `UniquenessConflict` / `Disallowed` / `ReferencedInUse` first-class
   `error` decls in a prelude, or a fixed internal set the `httpStatus`
   mapper is taught to accept?
4. **`organizationContext` (preferred cross-scope resolution)** — split
   `currentUser` (principal) from `organizationContext` (operating tenant
   scope). Makes every dataKey a single unconditional stamp off
   `organizationContext.orgPath` and dissolves the cross-scope "stamp
   override" problem. Full design + the security gate in
   [`organization-context.md`](./organization-context.md).

**Resolved:** no storage shape needs gating (all four carry the version as a
top-level column / stream version, so default versioning is a uniform atomic
CAS); the `writeGuard`/`old` operator is **struck** (versioning-by-default
removed its only consumer); materialized `derived` is dropped (no consumer).
