# Database seeding — a Loomish `seed` declaration

> Status: **PARTIAL** — Phase 1 (declarative `seed` surface → `SeedIR` →
> lowering + validators, #803) **and all three per-backend emitters**
> shipped: Hono/Drizzle `db/seed.ts` (Phase 2, #804), .NET/EF `Seed.cs`
> (Phase 3a, #805), Phoenix `seeds.exs` (Phase 3b, #806; see note below — the
> Ash create-action seed idiom it shipped against was removed with the Ash
> foundation, the elixir seeder now goes through plain `Ecto.Changeset`), CI build
> gates compiling the generated seeders (#808), and `D-SEED-XREF`
> explicit-id cross-references (#828). The `__loom_seed` ship-once
> marker (D-SEED-IDEMPOTENCY) and the `raw` direct-INSERT path are
> **emitted on all three backends** (see `emit/seed.ts` on TS/.NET and
> `seeds-emit.ts` on elixir). Remaining phases (the imperative
> workflow-shaped body, per-row natural-key upsert, create-shape
> validation of seed rows) tracked in §11.
> Graduates the `seed {}` sketch from
> [`quickstart-and-day-one-batteries.md` §5.4](./quickstart-and-day-one-batteries.md)
> into a full, platform-neutral design that mirrors the migrations
> pipeline.
>
> **Shipped in Phase 1:** the `Seed` / `SeedRow` grammar rules
> (`ddd.langium`), `SeedIR` / `SeedRowIR` on `BoundedContextIR`
> (`src/ir/types/loom-ir.ts`), `lowerSeed` (`src/ir/lower/lower.ts`),
> the `checkSeeds` validator (`src/language/validators/seed.ts`:
> `loom.seed-foreign-aggregate`, `loom.seed-duplicate-field`), and
> parsing / lowering / negative-validator tests.
>
> **Pinned decisions affecting this proposal**
> - The DB-owning deployable per module is already chosen by the
>   `migrationsOwner` enrichment
>   (`src/ir/enrich/enrichments.ts`). Seeding reuses that owner verbatim —
>   it does not introduce a second ownership rule.
> - Two decisions are now **PINNED** in [`../decisions.md`](../../decisions.md):
>   **D-SEED-PATH** (seed through the domain `create`; `raw` opt-out) and
>   **D-SEED-IDEMPOTENCY** (v1 = ship-once applied-marker; per-row
>   upsert-by-natural-key deferred until reference data needs it).

> **[2026-06-20 status audit]** The `seed` emitter now spans FIVE backends — Python (`python/emit/seed.ts`) and Java (`java/emit/seed.ts`) added beyond the original Hono/.NET/Phoenix three.

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
Drizzle and a seed row written against Ecto must describe the *same*
domain fact, validated *once*, ordered *once*, and made idempotent
*once*. That is precisely the `MigrationsIR` value proposition applied
to data instead of schema.

---

## 2. Prior art (what each target framework wants as output)

| Framework | Idiomatic seed home | Idempotency mechanism | Through domain? |
|---|---|---|---|
| Drizzle / Hono | `db/seed.ts`, run via `npm run db:seed` | `onConflictDoNothing` / `onConflictDoUpdate` on a natural key | no — raw insert |
| EF Core / .NET | `HasData(...)` (migration-bound) **or** a runtime `ISeeder` | PK identity (HasData) / `AnyAsync()` guard (seeder) | optional |
| Ecto / Phoenix | `priv/repo/seeds.exs`, run via `mix run` / `mix ecto.setup` | `Repo.insert` with `on_conflict:` + `conflict_target:` on an identity | optional — through the context `create` |

Two tensions fall out, and they become the two requested decisions:

- **D-SEED-PATH.** EF `HasData` and Drizzle inserts go *straight to
  tables*; the domain path goes *through the context `create`* (enforcing changesets). Loom must
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

**Cross-aggregate references use explicit ids** (D-SEED-XREF) — the
declarative-fixture model of Django, EF Core `HasData`, and raw SQL —
**not** a bespoke handle abstraction. The default domain `create` path
mints ids (you cannot reference an id that does not exist yet), so
related/cross-referenced seed data uses the **`raw` path**: each row is
a literal record — an explicit `id` and literal FK columns — inserted
directly, bypassing `create`. The author writes the same literal id in
the referenced row and the referencing FK, and orders rows so a
referenced row precedes its referrer:

```ddd
context Sales {
  seed reference raw {
    Customer { id: "acme", name: "Acme Corp", email: "ops@acme.test" }
    Order { id: "ord-1", customerId: "acme", status: "Draft" }
  }
}
```

There is no `@handle`, no `SeedRef`, no topological reorder — id
consistency and ordering are the author's, exactly as in `HasData` /
`seeds.rb` with explicit ids / a SQL fixture. (A bespoke `@handle`
symbolic-reference form was considered and **dropped**: no concrete
stack has it; the relational-graph case it targeted is better served by
explicit ids here, or by the imperative body (§3.3) whose `let`
bindings *are* the handle, for free.)

### 3.2 Record shape

A **domain-path** record (the default, §3.1) is the aggregate's
**`create`-parameter shape, not its wire shape** — so it has **no `id`
field** (the framework mints ids) and therefore no cross-references.
For `Product with crudish` the canonical create is `create({ sku,
price })`, hence `Product { sku, price }`. Value objects nest as object
literals (`price: { amount, currency }`), enums are bare values
(`status: Draft`), optionals may be omitted. Object graphs assembled by
*operations* (`Order.contains lines: OrderLine[]` via `addLine`) are out
of reach for the declarative domain form — that is the imperative body
(§3.3).

A **`raw`-path** record is the **table-column shape**: it may set an
explicit `id` and writes FK columns as literal id values. This is the
home for explicit ids and the cross-references built on them. Per `ids`
kind the explicit id is just a column literal — a uuid for `guid`, the
natural-key string for `string`, an integer for `int`/`long` (you own
uniqueness). v1 raw supports scalar / enum / id-reference columns;
value-object and containment columns route through the domain path.

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
    aggregate=[Aggregate:ID] value=ObjectLit ;
```

(A future `key Country.code` clause for the deferred upsert path — §10
— slots in after `dataset` without touching the row rule.)

`ObjectLit` and
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
  /** Through the domain `create` (default) or straight to tables (`raw`:
   *  explicit `id` + literal FK columns → direct insert). */
  path: "domain" | "raw";
  /** Records in source order — the author orders parents before children
   *  (no topological reorder; cross-refs are explicit literal ids). */
  rows: SeedRowIR[];
  /** Imperative form: lowered workflow statements (mutually exclusive
   *  with rows). */
  body?: StmtIR[];
}

export interface SeedRowIR {
  aggregate: string;
  /** Field initialisers, fully-resolved ExprIR.  On the `raw` path these
   *  include an explicit `id` and literal FK columns. */
  fields: { name: string; value: ExprIR }[];
}
```

### Where it is built

`src/system/seed-builder.ts` — sibling of `migrations-builder.ts`,
called from `emitSystem` in `src/system/index.ts` right after
`buildMigrations`. It:

1. Filters to modules where `module.migrationsOwner` is set (frontend-
   only modules seed nothing — same gate as migrations).
2. Collects every `seed` block in the module's contexts, groups by
   dataset, concatenates in declaration order (author order is preserved
   — explicit-id cross-refs need no reorder).
3. Returns `SeedIR[]`, distributed per deployable by the existing
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
  inside a transaction (framework-minted ids).
- **raw path** → a direct Postgres `INSERT` (explicit `id` + literal FK
  columns) run via `db.execute(sql…)`, guarded by the `__loom_seed`
  marker row for the dataset.

### 6.2 .NET / EF Core

A runtime `ISeeder` resolved at boot after `Database.Migrate()` — *not*
`HasData` (HasData is PK-bound, can't go through the domain, and forces
a migration on every data edit). The seeder:

- **domain path** → dispatches the aggregate's create command through
  the existing Mediator pipeline (invariants + handlers run).
- **raw path** → `context.Set<T>().AddRange(...)` guarded by the
  dataset marker.

### 6.3 Phoenix / Ecto

`priv/repo/seeds.exs`, wired into `mix ecto.setup`.

- **domain path** → the context `create/1` per row (the `Ecto.Changeset`
  enforces the schema's validations).
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
| Record field set fails the aggregate `create` param type-check (domain path) | Error, reusing the call-arg type checker. `loom.seed-shape-mismatch` |
| `id` / value-object / containment column on a `raw` row that v1 can't insert | Error: "raw seed supports scalar / enum / id columns only." `loom.seed-raw-unsupported-column` |
| `seed` in a context whose module has no `migrationsOwner` (frontend-only) | Error: "nothing to seed — no database-owning deployable hosts this context." `loom.seed-no-db` |

---

## 9. Pipeline integration (the ten phases)

| Phase | Change |
|---|---|
| ① parse | `Seed` rule + `ContextMember` arm |
| ③ scope | seed body / record fields resolve in the context scope (reuse workflow scoping) |
| ④ AST validate | `src/language/validators/seed.ts` — the table in §8 |
| ⑤ lower | `lower.ts` lowers `Seed` → `SeedIR` (records) or reuses statement-lowering (body) |
| ⑥ enrich | none — reuses `migrationsOwner` |
| ⑦ IR validate | cross-aggregate / raw-column checks in `validate.ts` |
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

1. ~~**D-SEED-PATH**~~ — **PINNED**: domain-create default, `raw`
   opt-out. See [`../decisions.md`](../../decisions.md#d-seed-path--seed-rows-go-through-the-domain-create).
2. ~~**D-SEED-IDEMPOTENCY**~~ — **PINNED**: ship-once dataset marker for
   v1; per-row natural-key upsert deferred (the deferred path adds a
   `key Aggregate.field` clause and an `upsert`/`onConflict` emission
   branch per backend, earning its keep only once a model has
   *reference* data corrected in place). See [`../decisions.md`](../../decisions.md#d-seed-idempotency--v1-is-ship-once-via-a-dataset-marker).
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

1. ✅ **Done.** Grammar (`Seed`/`SeedRow`) + `SeedIR`/`SeedRowIR` on
   `BoundedContextIR` + `lowerSeed` + `checkSeeds`
   (`loom.seed-foreign-aggregate`, `loom.seed-duplicate-field`) +
   parsing / lowering / negative-validator tests. Declarative form
   only; create-param shape-checking is a follow-up.
2. ✅ **Done.** Hono emitter (`src/generator/typescript/emit/seed.ts`):
   `db/seed.ts` going through the domain `create` + repository `save`
   (D-SEED-PATH), ship-once per dataset via the `__loom_seed` marker
   (D-SEED-IDEMPOTENCY), `LOOM_SEED` dataset gating, the `db:seed`
   script, and the `runSeeds(db)` boot call after migrations. Two
   deviations from the spec, both noted in the emitter: the marker
   table is created by `seed.ts` (`CREATE TABLE IF NOT EXISTS`) rather
   than a synthetic migration step, and `raw` blocks still route
   through the domain `create` (true table-insert `raw` is a follow-up).
3. **.NET ✅ Done** (`src/generator/dotnet/emit/seed.ts`):
   `Infrastructure/Persistence/Seed.cs` going through the positional
   `<Agg>.Create(…)` (fields ordered to the factory's required-field
   order) + DI-resolved `I<Agg>Repository.SaveAsync`, ship-once
   `__loom_seed` marker (ADO `ExecuteScalar`), `LOOM_SEED` gating, and a
   `Seed.RunSeeds(…)` boot call after `Database.Migrate()`. **Phoenix ✅
   Done** (`src/generator/phoenix-live-view/seeds-emit.ts`):
   `priv/repo/seeds.exs` going through the context create function
   (`<Ctx>.create_<agg>!(%{ … })`), ship-once `__loom_seed` marker (via
   `Ecto.Adapters.SQL`), `LOOM_SEED` gating, and a `run priv/repo/seeds.exs`
   step appended to the `ecto.setup` mix alias. This required first fixing
   the Phoenix `value-object-ctor` renderer, which emitted *positional*
   struct args (`%Ctx.Money{9.99, "USD"}` — invalid Elixir): lowering now
   carries the value object's declared field order in `argNames` (TS/.NET
   ignore it; Phoenix emits `%Ctx.Money{amount: …, currency: …}`), which
   also fixes the same latent bug for VO construction in Phoenix
   *operation bodies*.
4. **`raw` explicit-id path ✅ Done** — the home for **cross-references**
   (D-SEED-XREF). A shared `renderSeedRowInsert` (`src/generator/sql-pg.ts`)
   turns a `raw` row (explicit `id` + literal FK columns) into a direct
   Postgres `INSERT`, emitted **bit-identically** by all three backends
   and executed via their raw-SQL channels (Drizzle `db.execute(sql.raw)`,
   EF `ExecuteSqlRawAsync`, Ecto `Ecto.Adapters.SQL`), bypassing `create`.
   Table/column naming mirrors the migration builder
   (`plural(snake(agg))` / `snake(field)`). v1 = scalar / enum / id
   columns; value-object + containment columns stay on the domain path
   (`loom.seed-raw-unsupported-column`). An explicit `id` on the domain
   path is rejected (`loom.seed-id-needs-raw`). Author orders parents
   before children — no topological reorder.
5. Imperative (workflow-body) form — reuses statement lowering.
   Deferred: grammar disambiguation is proven feasible, but the
   statement-execution + auto-save semantics are a standalone project.
6. `seed-spec.json` artifact + compose seed step; quick-start `saas`
   template (closes the quickstart proposal's §5.4 dependency).
7. `ddd seed` runner + `--reset`; then (only on demand) the `key:`
   upsert path for evolving reference data (§10).

A model with no `seed` block emits byte-identically at every phase —
the existing fixtures and conformance baselines do not move until a
seed is actually declared.

**Build-gate coverage.** `examples/seeding.ddd` (top-level context, for the
TS + .NET legacy `generate` gates) and its system-wrapped twin
`test/e2e/fixtures/phoenix-build/seeding.ddd` are wired into the
`LOOM_TS_BUILD` / `LOOM_DOTNET_BUILD` / `LOOM_PHOENIX_BUILD` matrices, so the
emitted `db/seed.ts` / `Seed.cs` / `seeds.exs` are actually **compiled**
(tsc + tsup, `dotnet build /warnaserror`, `mix compile --warnings-as-errors`)
rather than only content-asserted. The fixture uses scalar + enum fields
(no value objects / `X id` refs) so it compiles trivially on all three;
VO/money construction in seeds stays covered by the per-backend unit tests.
The legacy per-context `generate dotnet` path emits the seeder too (mirroring
`generate ts`), since that's the command the .NET gate runs.
