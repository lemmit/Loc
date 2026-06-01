# Database seeding — a Loomish `seed` declaration

> Status: **PROPOSED.** No code yet; grammar / IR / semantics specified.
> Graduates the `seed {}` sketch from
> [`quickstart-and-day-one-batteries.md` §5.4](./quickstart-and-day-one-batteries.md)
> into a full, platform-neutral design that mirrors the migrations
> pipeline.
>
> **Pinned decisions affecting this proposal**
> - The DB-owning deployable per module is already chosen by the
>   `migrationsOwner` enrichment
>   (`src/ir/enrich/enrichments.ts`). Seeding reuses that owner verbatim —
>   it does not introduce a second ownership rule.
> - Requests two new decision tags: **D-SEED-PATH** (seed through the
>   domain `create` vs. raw table insert) and **D-SEED-IDEMPOTENCY**
>   (v1 = ship-once applied-marker; per-row upsert-by-natural-key
>   deferred until reference data needs it).

## TL;DR

Loom already derives schema **migrations** as a platform-neutral
`MigrationsIR`, built once per system and translated to Drizzle SQL,
EF C#, and Ecto `.exs` by each backend. Loom has **no story for the
rows** — every generated app boots against an empty database and shows
an empty list.

This proposal adds a first-class `seed` declaration that follows the
*identical* shape as migrations: a declarative surface → a neutral
`SeedIR` → per-backend emitters → per-deployable distribution in phase
⑨ → a `.loom/` provenance artifact. Seeding is **declarative-first**
(typed records that lower through the aggregate's canonical `create`,
so invariants hold), with an **imperative escape hatch** (a
workflow-shaped body) for relational graphs. It is **idempotent**,
**dataset-scoped** (`dev` / `demo` / `test`), and **strictly
additive** — a model with no `seed` block emits byte-identically.

---

## 1. Problem

Migrations answer *"what tables does this module need?"* Nothing
answers *"what rows should exist on first boot?"* The gap shows up
three ways:

1. **The quick-start demo is empty.** `ddd new` → `docker compose up`
   yields a running stack whose every list is blank. The `saas`
   template in the quickstart proposal explicitly wants a `seed {}`
   block so the on-ramp app shows content immediately.
2. **Reference / lookup data has no home.** Country lists, plan
   catalogs, the `crossTenant unpaged` aggregates from
   `pagination-design-note.md` — these are *part of the model's
   meaning*, not test fixtures, yet there is nowhere to declare them.
3. **e2e and conformance tests hand-roll inserts.** The e2e suite
   boots a stack and pokes the API to create state. A declared seed
   set would give every backend the same starting rows for free, and
   make cross-backend parity checks (`conformance-parity.yml`)
   data-anchored rather than empty-state-only.

Every mature framework has this: Rails `db/seeds.rb`, EF Core
`HasData` / `IDbSeeder`, Ecto `priv/repo/seeds.exs`, Django fixtures,
Laravel seeders. Loom should have **one** declaration that compiles to
*all* of them.

### Why not "just write `seeds.exs` / `seed.ts` by hand"

Because that re-introduces the exact problem Loom exists to remove:
per-backend hand-authored code that drifts. A seed row written against
Drizzle and a seed row written against Ash must describe the *same*
domain fact, validated *once*, ordered *once*, and made idempotent
*once*. That is precisely the `MigrationsIR` value proposition applied
to data instead of schema.

---

## 2. Prior art (what each target framework wants as output)

| Framework | Idiomatic seed home | Idempotency mechanism | Through domain? |
|---|---|---|---|
| Drizzle / Hono | `db/seed.ts`, run via `npm run db:seed` | `onConflictDoNothing` / `onConflictDoUpdate` on a natural key | no — raw insert |
| EF Core / .NET | `HasData(...)` (migration-bound) **or** a runtime `ISeeder` | PK identity (HasData) / `AnyAsync()` guard (seeder) | optional |
| Ash / Phoenix | `priv/repo/seeds.exs`, run via `mix run` / `mix ecto.setup` | `Ash.Changeset.for_create` + `upsert?: true` on an identity | yes — Ash actions |

Two tensions fall out, and they become the two requested decisions:

- **D-SEED-PATH.** EF `HasData` and Drizzle inserts go *straight to
  tables*; Ash goes *through actions* (enforcing changesets). Loom must
  pick a default. **Recommendation: through the domain `create`** — the
  aggregate's `canonicalCreate` already encodes the invariants, and a
  seed that violates an invariant is a bug we want caught. A `seed raw`
  modifier opts into table-level inserts for bulk fixtures where the
  domain pass is too slow or deliberately bypassed.
- **D-SEED-IDEMPOTENCY.** Re-running a seed must not duplicate rows.
  **Recommendation for v1: ship-once via an applied-marker** — a
  `__loom_seed` table holding one row per applied dataset, the data
  twin of `__drizzle_migrations`. On boot: "has dataset `demo` been
  seeded? if yes, skip the whole set." Zero per-row ceremony, mirrors
  the Rails `db:seed` / Ecto `seeds.exs` contract, and needs no natural
  key on the rows. The richer **per-row upsert by a declared natural
  key** (for *reference* data that ships once but is later corrected in
  place) is deliberately **deferred** — it's a second idempotency
  mechanism serving a secondary case, and the marker covers the
  quick-start demo entirely. See §10.

---

## 3. Surface syntax

`seed` is a new **ContextMember** (peer to `aggregate`, `repository`,
`workflow`, `view`) — it lives inside the `context` whose aggregates it
populates, so it inherits that context's scope exactly like a workflow
body does. Two forms share one keyword.

### 3.1 Declarative form (the common case)

A `seed` block names a **dataset** and lists **typed records**, one per
aggregate instance. Each record is the existing object-literal surface
(`{ field: expr }`), type-checked against the aggregate's `create`
parameters (or, with `raw`, its wire shape).

```ddd
context Catalog {
  aggregate Product with crudish {
    sku: string
    price: Money
    invariant sku.length > 0
  }

  seed demo {
    Product { sku: "DEMO-1", price: { amount: 9.99,  currency: "USD" } }
    Product { sku: "DEMO-2", price: { amount: 19.99, currency: "USD" } }
  }
}
```

**Cross-aggregate references** use a local handle (`@name`) that
resolves to the created instance's id — the seed builder topologically
orders by these edges exactly as the migration builder orders tables by
FK:

```ddd
context Sales {
  seed demo {
    Customer @acme { name: "Acme Corp", email: "ops@acme.test" }
    Order { customerId: @acme, status: Draft, placedAt: now() }
  }
}
```

`@acme` lowers to a `SeedRef` in the IR; the Order row's `customerId`
carries a dependency edge on the Customer row. (`now()` and the other
pure stdlib builtins already legal in default-value position are legal
here.)

### 3.2 Record shape and id resolution

A seed record is the aggregate's **`create`-parameter shape, not its
wire shape** — so it has **no `id` field**. The framework owns id
minting (the lifecycle-operations rule), so the author never writes
one. For `Product with crudish` the canonical create is
`create({ sku, price })`, hence `Product { sku, price }`. Value objects
nest as object literals (`price: { amount, currency }`), enums are bare
values (`status: Draft`), and optional params may be omitted.

Object graphs assembled by *operations* rather than create params —
`Order.contains lines: OrderLine[]` populated through `addLine` — are
deliberately **out of reach for the declarative form**; that is exactly
what the imperative body (§3.3) is for.

**Id access is therefore never a literal — it flows through the
`@handle`** — and whether a handle yields a *known, stable* id depends
on the aggregate's `ids` kind:

| `ids` kind | Id source | Handle resolution |
|---|---|---|
| `guid` (default) | app-minted before insert | deterministic **UUIDv5(`dataset`, `aggregate`, `handle`)** — same id every run; safe to reference from stable URLs / e2e assertions |
| `string` | author-supplied natural key (a create param) | the id *is* a written field; the handle is that value |
| `int` / `long` | DB sequence/identity, unknown until insert | the handle binds to the id **captured at runtime** from `create`'s return — consistent within a run, not stable across fresh DBs; an id cannot be hard-coded (use `guid` if a stable id is needed) |

The payoff: for the two kinds where the app knows the id before insert
(`guid`, `string`), cross-row *and* cross-block references resolve to a
deterministic id, so deep links and test fixtures get a stable, known
id for free. For DB-generated `int`/`long`, an id is inherently
unknowable until insert, so a runtime-captured handle is the correct
(and only possible) answer — `SeedRef` lowers to "look up the id minted
for `@acme` in this run", which every backend already expresses (a
local variable in `db/seed.ts`, the `ISeeder`, and `seeds.exs`).

### 3.3 Imperative form (relational graphs)

When a seed needs control flow or multi-step aggregate operations, the
block takes a **workflow-shaped body** instead of a record list — the
*same* `Statement*` surface a `workflow` uses (`let`, calls,
`Aggregate.create(...)`, operation calls), with the same scope and the
same mutation restrictions:

```ddd
context Catalog {
  seed demo {
    let p = Product.create({ sku: "DEMO-1", price: { amount: 9.99, currency: "USD" } })
    p.restock(100)
  }
}
```

This is the form sketched in the quickstart proposal, preserved
verbatim so that doc's example keeps compiling. The parser picks the
form by lookahead: a `{`-body whose first token is a record head
(`TypeName {`) is declarative; anything else is a statement body.

### 3.4 Datasets and environments

The name after `seed` is the **dataset** (default: `default`). Datasets
gate *when* a set runs:

| Dataset | Runs when |
|---|---|
| `default` | always, on first boot |
| `dev` / `demo` | only when `LOOM_SEED` includes the name (compose injects `LOOM_SEED=demo` for the quick-start stack; production omits it) |
| `test` | only under the e2e / conformance harness |

This keeps demo rows out of production by construction — the analogue
of migrations being unconditional but seeds being opt-in per
environment. Multiple `seed <same-dataset>` blocks across contexts
compose into one ordered set per deployable.

---

## 4. Grammar additions (`src/language/ddd.langium`)

Add `Seed` to `ContextMember` (line ~637) and the rule:

```langium
ContextMember:
    EnumDecl | ValueObject | Aggregate | EventDecl | PayloadDecl
    | Repository | Workflow | View | Seed
    | Criterion | FilterDecl | StampDecl | ImplementsDecl;

Seed:
    'seed' (dataset=ID)? (raw?='raw')? '{'
        ( rows+=SeedRow* | body+=Statement* )
    '}';

SeedRow:
    aggregate=[Aggregate:ID] ('@' handle=ID)? value=ObjectLit ;
```

(A future `key Country.code` clause for the deferred upsert path — §10
— slots in after `dataset` without touching the row rule.)

`@handle` reuses the `SeedRef` resolution noted below; `ObjectLit` and
`Statement` are existing rules — no new expression syntax. `seed` is a
soft keyword everywhere except `ContextMember` position (the same
pattern `workflow` / `view` already use, per the grammar's
`ContextMember`-hardening comments).

---

## 5. IR — `SeedIR` (the data twin of `MigrationsIR`)

New file `src/ir/types/seed-ir.ts`, deliberately parallel to
`migrations-ir.ts`:

```typescript
export interface SeedIR {
  /** Owning module — keyed identically to MigrationsIR so the same
   *  per-deployable distribution loop applies. */
  module: string;
  /** Dataset name; "default" runs unconditionally, others gate on
   *  LOOM_SEED / the test harness. */
  dataset: string;
  /** Through the domain `create` (default) or straight to tables. */
  path: "domain" | "raw";
  /** Ordered records, topologically sorted by SeedRef edges. */
  rows: SeedRowIR[];
  /** Imperative form: lowered workflow statements (mutually exclusive
   *  with rows). */
  body?: StmtIR[];
}

export interface SeedRowIR {
  aggregate: string;
  handle?: string;                 // @name, if bound
  /** Field initialisers, fully-resolved ExprIR (SeedRef for @refs). */
  fields: { name: string; value: ExprIR }[];
}
```

A new `ExprIR` variant `SeedRef { handle: string; aggregate: string }`
carries cross-row dependencies; the builder uses it both to topo-sort
and to emit "look up the id created for `@acme`" in each backend.

### Where it is built

`src/system/seed-builder.ts` — sibling of `migrations-builder.ts`,
called from `emitSystem` in `src/system/index.ts` right after
`buildMigrations`. It:

1. Filters to modules where `module.migrationsOwner` is set (frontend-
   only modules seed nothing — same gate as migrations).
2. Collects every `seed` block in the module's contexts, groups by
   dataset, concatenates in declaration order.
3. Topologically sorts rows by `SeedRef` edges (cycle ⇒ a validation
   error, same class as the FK-cycle guards).
4. Returns `SeedIR[]`, distributed per deployable by the existing
   `migrationsForDeployable` machinery (renamed conceptually to "DB
   artifacts for deployable").

A `.loom/seed-spec.json` artifact (sibling of `wire-spec.json`, built
in phase ⑨ by `src/system/seed-spec.ts`) snapshots the resolved seed
sets for diff-based change detection — the data analogue of the wire
contract.

---

## 6. Per-platform emission

`PlatformSurface.emitProject(...)` gains a `seeds?: SeedIR[]` arg
alongside the existing `migrations?: MigrationsIR[]`
(`src/platform/surface.ts`). Frontend platforms ignore it.

### 6.1 TypeScript / Hono (Drizzle)

`db/seed.ts`, run via a new `npm run db:seed` script and (for the
quick-start) the container entrypoint after `db:migrate`.

- **domain path** → calls the generated repository `create` per row
  inside a transaction; `@handle` ids captured in a local map.
- **raw path** → Drizzle `insert(...).values(...)`, guarded by the
  `__loom_seed` marker row for the dataset.

### 6.2 .NET / EF Core

A runtime `ISeeder` resolved at boot after `Database.Migrate()` — *not*
`HasData` (HasData is PK-bound, can't go through the domain, and forces
a migration on every data edit). The seeder:

- **domain path** → dispatches the aggregate's create command through
  the existing Mediator pipeline (invariants + handlers run).
- **raw path** → `context.Set<T>().AddRange(...)` guarded by the
  dataset marker.

### 6.3 Phoenix / Ash

`priv/repo/seeds.exs`, wired into `mix ecto.setup`.

- **domain path** → `Ash.create!/2` per row (the changeset enforces the
  resource's validations — Ash's native seed idiom).
- **raw path** → `Repo.insert_all/3`, marker-guarded.

### 6.4 React / static

No-op (no DB). The arg is dropped exactly like `migrations` is.

### 6.5 Compose wiring

The generated `docker-compose.yml` runs the seeder as a **one-shot
step after migrations** in the owning deployable's entrypoint (or a
dedicated `<deployable>-seed` init service that exits 0), reading
`LOOM_SEED` from the environment. Idempotency makes re-runs across
`compose up` cycles safe.

---

## 7. Idempotency & re-seeding semantics

**v1 is ship-once per dataset.** A `__loom_seed` table holds one row
per applied dataset; the seeder checks it on boot and skips the whole
set if present. First boot seeds; every subsequent boot is a no-op.

Editing an already-applied seed therefore has **no effect** on a DB
that has seen it — you re-seed by clearing the marker (a `ddd seed
--reset <dataset>`, §10) or against a fresh DB. This matches the Rails
`db:seed` / Ecto `seeds.exs` contract and keeps v1 free of content
hashing, per-row upsert, and any retraction logic.

The marker table is created by the same migration pass that owns the
module (a synthetic `createTable` step), so no manual DDL. Seeding is
**forward-only**, matching the migrations stance. Per-row upsert by a
declared natural key — the path for reference data corrected in place —
is the deferred follow-up (§10).

---

## 8. Validation rules (new)

| Situation | Diagnostic (`loom.seed-*`) |
|---|---|
| `seed` row for an aggregate outside the enclosing context | Error: cross-context seed (same scoping as a workflow body). `loom.seed-foreign-aggregate` |
| Record field set fails the aggregate `create` param type-check | Error, reusing the call-arg type checker. `loom.seed-shape-mismatch` |
| `@handle` referenced before it is bound, or unknown | Error. `loom.seed-unresolved-ref` |
| `SeedRef` cycle across rows | Error: "seed rows form a dependency cycle." `loom.seed-cycle` |
| `raw` + a value that an invariant would reject | **Warning** (raw deliberately bypasses the domain). `loom.seed-raw-unchecked` |
| `seed` in a context whose module has no `migrationsOwner` (frontend-only) | Error: "nothing to seed — no database-owning deployable hosts this context." `loom.seed-no-db` |

---

## 9. Pipeline integration (the ten phases)

| Phase | Change |
|---|---|
| ① parse | `Seed` rule + `ContextMember` arm |
| ③ scope | seed body / record fields resolve in the context scope (reuse workflow scoping); `@handle` is a new local binding kind |
| ④ AST validate | `src/language/validators/seed.ts` — the table in §8 |
| ⑤ lower | `lower.ts` lowers `Seed` → `SeedIR` (records) or reuses statement-lowering (body); new `SeedRef` ExprIR in `lower-expr.ts` |
| ⑥ enrich | none — reuses `migrationsOwner` |
| ⑦ IR validate | cross-row cycle + dependency checks in `validate.ts` |
| ⑧ codegen | `seeds?:` consumed by each backend's emitter (`emit/seed.ts` per platform) |
| ⑨ system compose | `buildSeeds(sys)` in `seed-builder.ts`; `seed-spec.ts` artifact; compose seed step |
| ⑩ write | `db/seed.ts` / `Seeder.cs` / `seeds.exs` + `.loom/seed-spec.json` |

### CLI

`ddd generate system` emits the seeders inline. A thin
`ddd seed <file> -o <out> [--dataset demo]` affordance (mirrors
`ddd snapshot` / `ddd verify`) can run the resolved set against a live
DB for local dev, but the v1 deliverable is **emission**, not a runner.

---

## 10. Open questions

1. **D-SEED-PATH** — domain-create default vs. raw default. (Recommend
   domain; `raw` opt-out.)
2. **D-SEED-IDEMPOTENCY** — confirm ship-once-marker for v1, with
   per-row natural-key upsert deferred. The deferred path adds a `key
   Aggregate.field` clause and an `upsert`/`onConflict` emission branch
   per backend; it earns its keep only once a model has *reference*
   data that ships once but is corrected in place. Until then the
   marker covers every case the quick-start needs.
3. **Event emission.** Should the domain path *emit* the events a
   `create` would (populating an event-log aggregate's stream), or
   suppress them? Lean: **suppress by default** (seeding is state, not
   history), `seed emitting { … }` to opt in for event-sourced demos.
4. **Retraction / reset.** v1 is forward-only. A `seed --reset` that
   truncates marker + rows for a dataset is a natural follow-up; needs
   the same care as a migration `Down`.
5. **Large / external datasets.** Inline records suit demo + reference
   data. Bulk fixtures (CSV/NDJSON import) are deferred — likely a
   `seed from "file.ndjson"` source clause feeding the `raw` path.
6. **Faker / generated volume.** Out of scope for v1; a `seed gen N
   Product { … }` with stdlib generators could follow once the static
   surface lands.

---

## 11. Build order (strictly additive)

1. Grammar + AST validators + `SeedIR` + lowering (declarative form
   only). One parsing test, the §8 negative tests, one lowering test.
2. Hono emitter + `db:seed` script + `__loom_seed` marker migration
   step. `LOOM_TS_BUILD` gate.
3. .NET seeder + Phoenix `seeds.exs`. Per-backend build gates.
4. Imperative (workflow-body) form — reuses statement lowering.
5. `seed-spec.json` artifact + compose seed step + `LOOM_SEED`
   dataset gating; quick-start `saas` template consumes it (closes the
   quickstart proposal's §5.4 dependency).
6. `ddd seed` runner + `--reset`; then (only on demand) the `key:`
   upsert path for evolving reference data (§10).

A model with no `seed` block emits byte-identically at every phase —
the existing fixtures and conformance baselines do not move until a
seed is actually declared.
