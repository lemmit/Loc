# Uniqueness & indexes — a domain `unique` invariant, an infra index

> Status: **PROPOSED** — not yet adopted. No grammar, IR, or emitter
> changes have landed. This doc scopes a Loomish, DDD-clean way to express
> database-level **uniqueness** and **indexes**, and is explicit about how
> each is *enforced* (the DB), *scoped* (tenancy), and *derived* (the
> compiler), so the design survives contact with multi-tenancy,
> soft-delete, and concurrency.
>
> **What already exists** (the machinery is mostly built — only the surface
> and the plumbing are missing):
> - `IndexShape` in `src/ir/types/migrations-ir.ts` already carries
>   `unique: boolean`.
> - `src/generator/sql-pg.ts` already renders `CREATE UNIQUE INDEX`.
> - `src/system/migrations-builder.ts` already *derives* a non-unique index
>   for **every FK column** (and the inverse FK on join tables) — so Loom
>   already emits indexes; it just has no way to ask for a *unique* one or
>   an extra performance one.
> - Tenancy is already a domain `filter` (`filter this.tenantId ==
>   currentUser.tenantId`) that every backend *reifies* into its storage
>   layer (EF `HasQueryFilter`, Drizzle AND-ed predicate, Ecto
>   `where`-clause helper, JPA `@SQLRestriction`). **Uniqueness follows the exact
>   same seam** — declared high, enforced low, derived in between.

## TL;DR

Two concerns get lumped together and must be split:

1. **Uniqueness is a domain invariant** — "no two customers share an
   email", "a SKU identifies one product". These are *natural-key /
   identity* rules, squarely DDD domain concepts. They are declared on the
   aggregate as a first-class `unique (...)` statement (a sibling of
   `invariant`, **not** an infra-flavored `@unique` field annotation). The
   compiler *derives* the enforcement from it.

2. **A plain (non-unique) index is pure infrastructure** — query
   performance only, zero domain meaning. It does **not** belong on the
   aggregate. It is **auto-derived** from `find ... where` finders (the
   same path FK indexes already use), with an optional escape hatch on the
   `resource` (where storage binding already lives).

Enforcement of uniqueness is **always at the DB** (a unique index, possibly
*partial*). The application layer only *translates* the constraint
violation into a domain `409 Conflict`. An app-level pre-read is **cosmetic**
— a friendlier error in the non-racing case — never the contract.

Strictly additive: a model with no `unique` and no manual `index:` emits
byte-identically.

---

## 1. Problem

Loom can describe an aggregate's fields, access, sensitivity, provenance,
defaults, and per-instance `invariant`s — but it has **no way to say a
field (or tuple of fields) must be unique**, and no way to ask for a
performance index. Every generated schema gets a primary key, FK indexes,
and nothing else. There is no proposal covering this today; the big storage
RFC (`storage-and-platform-config.md`) stops at aggregate→storage binding.

The naive fix — an `@unique` annotation on a column — is wrong for three
reasons this proposal is built to avoid:

- It reads as infrastructure metadata leaking onto the domain model.
- It is **silently incorrect under tenancy**: a per-column unique is global,
  so it both blocks legitimate cross-tenant duplicates *and*, if the scope
  is forgotten, is a data-isolation latent bug. The annotator can't see the
  tenancy model; the compiler can.
- It is **silently incorrect under soft-delete**: a full unique index
  blocks re-creating a row whose predecessor was soft-deleted. The correct
  DDL is a *partial* index, which only the compiler — which knows
  `softDeletable` is applied — can derive.

The throughline: **declare intent in the domain, derive enforcement in the
compiler.** (`docs/decisions.md` "Derive, don't stamp".)

---

## 2. Why uniqueness can't be enforced in the domain floor

Loom's `invariant <expr>` runs in `AssertInvariants()` with only `this` in
scope — pure, no I/O (`src/language/ddd.langium`, the `Invariant` rule).
Uniqueness is a **set-level** invariant: "no *other* row has this value". It
structurally cannot run there. That's the architectural reason it (a) needs
its own keyword rather than being crammed into `invariant`, and (b) must be
delegated to storage.

There are also two enforcement realities:

- **TOCTOU race.** A "SELECT then INSERT" is not atomic, even inside one
  transaction at READ COMMITTED. Two concurrent creates both see "no clash"
  and both insert. Only a DB unique constraint (or a serializable
  lock/reservation) closes the window.
- **The DB is therefore the source of truth.** The app layer's job is to
  *map* the violation back to a domain-meaningful conflict (which field
  collided → `409`), not to be the check.

---

## 3. Surface

### 3.1 Uniqueness — a domain statement on the aggregate

A first-class `unique` member, supporting single-column and composite
(scoped) keys:

```ddd
aggregate Customer with softDeletable {
  tenantId: string
  email:    string
  name:     string

  unique (tenantId, email)      // email unique *per tenant*
  unique (tenantId, name)
}
```

It lives with the other domain rules, reads as a natural-key declaration,
and supports composite keys (which a field modifier cannot). It is declared
in the domain because **only the domain knows what is a natural key and
what its scope is.**

> **Composite is the common case, not the exception.** Under tenancy,
> almost every `unique` should include the tenant discriminator. See §5.

### 3.2 Indexes — infrastructure, auto-derived or on `resource`

Default: **auto-derive** a non-unique index for every `find ... where` /
`find byX` filter column, exactly as FK indexes are derived in
`migrations-builder.ts` today. Zero DSL, no domain pollution.

Manual escape hatch for the rare case (lives on the infra binding):

```ddd
resource customersState { for: Customers, kind: state, use: primarySql, index: [status, lastName] }
```

---

## 4. Enforcement & derived output

From the single `unique (...)` declaration the compiler derives **two**
artifacts, kept consistent because they come from one source:

### 4.1 The DB unique index (the contract)

```sql
-- Customer with softDeletable + unique (tenantId, email)
CREATE UNIQUE INDEX customer_tenant_id_email_uq
  ON customer (tenant_id, email)
  WHERE is_deleted = false;          -- partial, because softDeletable is applied
```

`IndexShape.unique` already exists; the new work is deriving the
`IndexShape` (with the optional partial predicate) in the migrations
builder and giving it a **deterministic name** (`<table>_<cols>_uq`) so the
violation can be mapped back to a field.

### 4.2 The violation → domain-conflict mapping (per backend)

Every backend surfaces a Postgres unique violation (SQLSTATE `23505`)
differently; the generated repository needs a `constraintName → field` map
derived from the same IR:

| Backend | Conflict strategy |
|---|---|
| Hono/Drizzle, Python/SQLAlchemy, Phoenix/Ecto | `INSERT … ON CONFLICT (cols) WHERE … DO NOTHING RETURNING` — atomic, no race, no pre-read needed (Ecto: `on_conflict:`) |
| .NET/EF Core | insert + catch `DbUpdateException` → `PostgresException.SqlState == "23505"` → map by constraint name |
| Java/Spring JPA | insert + catch `DataIntegrityViolationException` → map by constraint name |

Phoenix/Ecto gets this most idiomatically via `unique_constraint/3`, which maps
the constraint name to a changeset field automatically.

```ts
// Hono/Drizzle — the better, race-free path (no separate pre-read)
const ins = await db.insert(customer)
  .values(row)
  .onConflictDoNothing({ target: [customer.tenantId, customer.email] })
  .returning({ id: customer.id });
if (ins.length === 0) throw new ConflictError("email", "Customer email already exists");
```

```csharp
// .NET/EF — catch-and-map, because EF doesn't surface ON CONFLICT cleanly
try { await _db.SaveChangesAsync(); }
catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: "23505" } pg) {
    throw ConflictFor(pg.ConstraintName);   // customer_tenant_id_email_uq → "email"
}
```

---

## 5. Tenancy — the scope *is* part of the key

Tenancy in Loom today is a domain `filter` reified per backend (see
`docs/capabilities.md` → "Backend emission"; fixture
`test/fixtures/corpus/tenancy-filter.ddd`). Uniqueness is the **same shape**
— a domain declaration reified as a DB constraint — so it inherits the same
mental model.

Concretely:

- The scope discriminator (`tenantId`) **must be in the key**:
  `unique (tenantId, email)` → `UNIQUE (tenant_id, email)`. A global
  `unique email` under tenancy is a bug.
- Because the compiler knows the tenancy capability is applied, it can
  **validate** the scope and warn:
  *"`unique email` on a tenant-scoped aggregate — did you mean
  `unique (tenantId, email)`?"* (proposed code `loom.unique-missing-tenant-scope`).
  A raw `@unique` column annotation could never offer this.

This is the single strongest argument for *declare-in-domain, derive-
enforcement* over a per-column annotation.

---

## 6. The app-level pre-read is cosmetic

A pre-read = a scoped `EXISTS` run through the aggregate's **existing
filtered read path** just before insert, so tenancy + soft-delete scoping
come for free and match the index predicate:

```ts
// optional, cosmetic — gives a friendly 409 before hitting the DB
const clash = await db.select({ one: sql`1` }).from(customer)
  .where(and(
    eq(customer.tenantId, user.tenantId),
    eq(customer.email, input.email),
    eq(customer.isDeleted, false),        // matches the partial index predicate
  ))
  .limit(1);
if (clash.length) throw new ConflictError("email", "Customer email already exists");
// … then INSERT, AND STILL handle the violation — the pre-read is racy.
```

Caveats that make it cosmetic, not load-bearing:

- **It is racy.** Read-then-insert is not atomic; concurrent creates slip
  through. The DB constraint is what actually holds.
- **Self-exclusion on update.** When an update touches a unique column the
  pre-read must add `AND id <> :id` (the DB index handles this for free; the
  pre-read does not).
- **Redundant on the `ON CONFLICT` backends** (§4.2), which already get an
  atomic, race-free conflict signal.

Recommendation: make the pre-read **opt-in** (or skip it entirely). Treat
the constraint + violation-mapping as the contract. The proposal is explicit
that the DB is what's load-bearing.

---

## 7. Interactions the compiler must handle (the payoff of deriving)

| Case | Derived behaviour |
|---|---|
| `with softDeletable` | **Partial** unique index: `… WHERE is_deleted = false` — so re-create after delete is allowed. |
| Optional unique field | Postgres treats NULLs as distinct (multiple NULLs allowed) — usually wanted; `NULLS NOT DISTINCT` (PG15) when not. |
| Tenant-scoped aggregate | Scope discriminator must be in the key; validator warns when omitted (§5). |
| Event-sourced / non-relational storage | No single table to constrain → needs a reservation table or projection-side constraint. **Gated/deferred**, like the existing capability-filter "deferred cases". |

---

## 8. Pipeline placement (one-directional, no new IR)

1. **Grammar** (`src/language/ddd.langium`) — a `Unique` member rule on the
   aggregate (and `index:` on `Resource`). Re-run `npm run langium:generate`.
2. **IR** (`src/ir/types/loom-ir.ts`) — a `UniqueKeyIR` (columns + optional
   scope) on `AggregateIR`; the manual `index:` list on the resource IR.
3. **Lower** — collect the unique keys in the relevant `lower-*` leaf.
4. **Derive** (`src/system/migrations-builder.ts`, phase ⑨) — emit
   `IndexShape{ unique: true, predicate? }` from each `UniqueKeyIR`, mirror
   the soft-delete predicate, and emit auto/manual non-unique indexes.
   *No new top-level IR* — this rides `MigrationsIR`, exactly like FK indexes.
5. **Backends** — each repository's create/update path gains the conflict
   strategy from §4.2 (driven by the deterministic constraint name).
6. **Validators** — `loom.unique-unknown-field`,
   `loom.unique-missing-tenant-scope`, `loom.unique-on-event-sourced` (gate).
7. **Tests** — parsing, negative validator, one migrations-builder test, and
   one generator test per backend; plus a `LOOM_*_BUILD` compile run.

`sql-pg.ts` and `IndexShape` need **no change** for the unique DDL itself —
that is already there.

---

## 9. Decisions to pin (proposed)

- **D-UNIQUE-DOMAIN** — uniqueness is declared as a domain `unique (...)`
  statement on the aggregate, never as an infra column annotation. The DB
  index and the conflict mapping are *derived*.
- **D-UNIQUE-DB-AUTHORITATIVE** — the DB unique index is the enforcement
  contract; the app pre-read is cosmetic and opt-in.
- **D-UNIQUE-SCOPE** — under tenancy the scope discriminator must be part of
  the key; the compiler validates it.
- **D-INDEX-INFRA** — non-unique indexes are infrastructure: auto-derived
  from finders, with a manual `resource index:` escape hatch. They never
  appear on the aggregate.

---

## 10. Slices

1. **`unique` invariant** — grammar + IR + derived unique index (all
   backends' DDL, with partial-index + tenancy-scope handling) + the
   per-backend conflict→409 mapping. The bulk of the value.
2. **Auto-derived finder indexes** + optional `resource index:` hatch —
   small, isolated, pure infra; independent of slice 1.

Event-sourced/non-relational uniqueness is explicitly out of scope for v1
(gated by validator).
